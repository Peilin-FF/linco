#!/usr/bin/env bash
set -euo pipefail

umask 077

required_environment=(
  IOS_CERTIFICATE_BASE64
  IOS_CERTIFICATE_PASSWORD
  IOS_PROVISIONING_PROFILE_BASE64
  IOS_TEAM_ID
  IOS_BUNDLE_ID
  IOS_DEVICE_UDID
  IOS_SIGNING_IDENTITY
)

missing=()
for name in "${required_environment[@]}"; do
  if [[ -z "${!name:-}" ]]; then
    missing+=("$name")
  fi
done
if (( ${#missing[@]} > 0 )); then
  printf 'Missing required signing environment: %s\n' "${missing[*]}" >&2
  exit 2
fi

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "A signed iPhone package can only be built on macOS with Xcode." >&2
  exit 2
fi

for command_name in xcodebuild xcrun xcodegen security codesign python3 openssl ditto shasum; do
  command -v "$command_name" >/dev/null 2>&1 || {
    echo "Required command is unavailable: $command_name" >&2
    exit 2
  }
done

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
ios_dir="$(cd -- "$script_dir/.." && pwd)"
repo_root="$(cd -- "$ios_dir/.." && pwd)"
output_dir="${LINCO_OUTPUT_DIR:-$repo_root/artifacts/iphone}"
build_number="${IOS_BUILD_NUMBER:-1}"
team_id="$IOS_TEAM_ID"
bundle_id="$IOS_BUNDLE_ID"
device_udid="$IOS_DEVICE_UDID"
signing_identity="$IOS_SIGNING_IDENTITY"
certificate_password="$IOS_CERTIFICATE_PASSWORD"
export_method="${IOS_EXPORT_METHOD:-release-testing}"

if [[ ! "$build_number" =~ ^[1-9][0-9]*$ ]]; then
  echo "IOS_BUILD_NUMBER must be a positive integer." >&2
  exit 2
fi
if [[ "$export_method" != "release-testing" ]]; then
  echo "Only the registered-device release-testing export method is accepted by this installer workflow." >&2
  exit 2
fi
if [[ ! "$team_id" =~ ^[A-Z0-9]{10}$ ]]; then
  echo "IOS_TEAM_ID must be a 10-character Apple Team ID." >&2
  exit 2
fi
if [[ ! "$bundle_id" =~ ^[A-Za-z0-9][A-Za-z0-9.-]+$ ]] || [[ "$bundle_id" == *"*"* ]]; then
  echo "IOS_BUNDLE_ID must be an explicit reverse-DNS identifier without wildcards." >&2
  exit 2
fi
if [[ ! "$device_udid" =~ ^[A-Fa-f0-9-]{20,64}$ ]]; then
  echo "IOS_DEVICE_UDID must be the registered target iPhone UDID." >&2
  exit 2
fi

xcode_version="$(xcodebuild -version | awk '/^Xcode / { print $2; exit }')"
ios_sdk_version="$(xcrun --sdk iphoneos --show-sdk-version)"
if (( ${xcode_version%%.*} < 26 || ${ios_sdk_version%%.*} < 26 )); then
  echo "Xcode 26+ and the iOS 26+ SDK are required; found Xcode $xcode_version / iOS SDK $ios_sdk_version." >&2
  exit 2
fi

temporary_parent="${TMPDIR:-/tmp}"
temporary_parent="${temporary_parent%/}"
temporary_root="$(mktemp -d "$temporary_parent/linco-sign.XXXXXX")"
keychain_path="$temporary_root/linco-signing.keychain-db"
certificate_path="$temporary_root/signing-certificate.p12"
profile_source="$temporary_root/install.mobileprovision"
profile_plist="$temporary_root/profile.plist"
archive_path="$temporary_root/Linco.xcarchive"
export_path="$temporary_root/export"
derived_data="$temporary_root/DerivedData"
package_cache="$temporary_root/SourcePackages"
export_options="$temporary_root/ExportOptions.plist"
verification_dir="$temporary_root/verify"
embedded_profile_plist="$temporary_root/embedded-profile.plist"
signed_entitlements_plist="$temporary_root/signed-entitlements.plist"
exported_certificate_prefix="$temporary_root/exported-signing-certificate"
keychain_password="$(openssl rand -hex 32)"
installed_profile=""
original_keychains=()

cleanup() {
  status=$?
  trap - EXIT INT TERM
  set +e
  if [[ -n "$installed_profile" ]]; then
    rm -f -- "$installed_profile"
  fi
  if (( ${#original_keychains[@]} > 0 )); then
    security list-keychains -d user -s "${original_keychains[@]}" >/dev/null 2>&1 || true
  fi
  security delete-keychain "$keychain_path" >/dev/null 2>&1 || true
  case "$temporary_root" in
    "$temporary_parent"/linco-sign.*) rm -rf -- "$temporary_root" ;;
    *) echo "Refusing to remove unexpected temporary path: $temporary_root" >&2 ;;
  esac
  exit "$status"
}
trap cleanup EXIT INT TERM

decode_secret() {
  environment_name="$1"
  destination="$2"
  python3 - "$environment_name" "$destination" <<'PY'
import base64
import os
import sys

name, destination = sys.argv[1:]
payload = "".join(os.environ[name].split())
try:
    decoded = base64.b64decode(payload, validate=True)
except Exception as error:
    raise SystemExit(f"{name} is not valid base64: {error}")
if not decoded:
    raise SystemExit(f"{name} decoded to an empty file")
with open(destination, "wb") as output:
    output.write(decoded)
PY
}

decode_secret IOS_CERTIFICATE_BASE64 "$certificate_path"
decode_secret IOS_PROVISIONING_PROFILE_BASE64 "$profile_source"
unset IOS_CERTIFICATE_BASE64 IOS_PROVISIONING_PROFILE_BASE64

security cms -D -i "$profile_source" > "$profile_plist"
python3 - "$profile_plist" "$team_id" "$bundle_id" "$device_udid" <<'PY'
from datetime import datetime, timezone
import plistlib
import sys

path, expected_team, expected_bundle, expected_device = sys.argv[1:]
with open(path, "rb") as source:
    profile = plistlib.load(source)

team_ids = profile.get("TeamIdentifier") or []
if expected_team not in team_ids:
    raise SystemExit("Provisioning profile TeamIdentifier does not match IOS_TEAM_ID")

entitlements = profile.get("Entitlements") or {}
application_identifier = entitlements.get("application-identifier")
expected_suffix = f".{expected_bundle}"
if not isinstance(application_identifier, str) or not application_identifier.endswith(expected_suffix):
    raise SystemExit("Provisioning profile application-identifier does not end with IOS_BUNDLE_ID")
application_prefix = application_identifier[: -len(expected_suffix)]
if application_prefix not in (profile.get("ApplicationIdentifierPrefix") or []):
    raise SystemExit("Provisioning profile application-identifier has an invalid App ID prefix")
if entitlements.get("get-task-allow") is not False:
    raise SystemExit("The profile is not an Ad Hoc distribution profile (get-task-allow must be false)")

devices = profile.get("ProvisionedDevices") or []
if not devices:
    raise SystemExit("The profile contains no registered iPhone devices")
if expected_device.upper() not in {device.upper() for device in devices}:
    raise SystemExit("The profile does not authorize IOS_DEVICE_UDID")
if profile.get("ProvisionsAllDevices"):
    raise SystemExit("Enterprise profiles are not accepted by this release-testing workflow")

expiration = profile.get("ExpirationDate")
if not isinstance(expiration, datetime):
    raise SystemExit("Provisioning profile has no valid ExpirationDate")
if expiration.tzinfo is None:
    expiration = expiration.replace(tzinfo=timezone.utc)
if expiration <= datetime.now(timezone.utc):
    raise SystemExit("Provisioning profile has expired")

for required in ("UUID", "Name"):
    if not profile.get(required):
        raise SystemExit(f"Provisioning profile is missing {required}")

print(f"Validated Ad Hoc profile for {len(devices)} registered device(s); expires {expiration.isoformat()}.")
PY

profile_uuid="$(/usr/libexec/PlistBuddy -c 'Print :UUID' "$profile_plist")"
profile_name="$(/usr/libexec/PlistBuddy -c 'Print :Name' "$profile_plist")"
application_identifier="$(/usr/libexec/PlistBuddy -c 'Print :Entitlements:application-identifier' "$profile_plist")"
if [[ "${GITHUB_ACTIONS:-}" == "true" ]]; then
  echo "::add-mask::$profile_uuid"
  echo "::add-mask::$profile_name"
fi
profiles_dir="$HOME/Library/Developer/Xcode/UserData/Provisioning Profiles"
mkdir -p -- "$profiles_dir"
installed_profile="$profiles_dir/$profile_uuid.mobileprovision"
install -m 0600 "$profile_source" "$installed_profile"

security create-keychain -p "$keychain_password" "$keychain_path"
security set-keychain-settings -lut 21600 "$keychain_path"
security unlock-keychain -p "$keychain_password" "$keychain_path"
while IFS= read -r keychain; do
  keychain="${keychain//\"/}"
  [[ -n "$keychain" ]] && original_keychains+=("$keychain")
done < <(security list-keychains -d user)
security list-keychains -d user -s "$keychain_path" "${original_keychains[@]}"
security import "$certificate_path" \
  -k "$keychain_path" \
  -P "$certificate_password" \
  -T /usr/bin/codesign \
  -T /usr/bin/security >/dev/null
security set-key-partition-list \
  -S apple-tool:,apple:,codesign: \
  -s \
  -k "$keychain_password" \
  "$keychain_path" >/dev/null

available_identities="$(security find-identity -v -p codesigning "$keychain_path")"
identity_hashes="$(printf '%s\n' "$available_identities" | grep -F "$signing_identity" | sed -nE 's/^[[:space:]]*[0-9]+\)[[:space:]]+([0-9A-Fa-f]{40})[[:space:]].*$/\1/p' || true)"
identity_count="$(printf '%s\n' "$identity_hashes" | sed '/^$/d' | wc -l | tr -d '[:space:]')"
if [[ "$identity_count" != "1" ]]; then
  echo "The imported certificate does not provide the requested signing identity: $signing_identity" >&2
  exit 2
fi
signing_identity_hash="$(printf '%s\n' "$identity_hashes" | sed -n '1p' | tr '[:lower:]' '[:upper:]')"
if [[ "${GITHUB_ACTIONS:-}" == "true" ]]; then
  echo "::add-mask::$signing_identity_hash"
fi
python3 - "$profile_plist" "$signing_identity_hash" <<'PY'
import hashlib
import plistlib
import sys

path, expected_sha1 = sys.argv[1:]
with open(path, "rb") as source:
    profile = plistlib.load(source)
certificate_hashes = {
    hashlib.sha1(certificate).hexdigest().upper()
    for certificate in profile.get("DeveloperCertificates", [])
}
if expected_sha1 not in certificate_hashes:
    raise SystemExit("The imported signing certificate is not authorized by the provisioning profile")
PY
certificate_password=""
unset \
  IOS_CERTIFICATE_PASSWORD \
  IOS_TEAM_ID \
  IOS_BUNDLE_ID \
  IOS_DEVICE_UDID \
  IOS_SIGNING_IDENTITY
rm -f -- "$certificate_path" "$profile_source"

(
  cd "$ios_dir"
  xcodegen generate --spec project.yml
)
bash "$ios_dir/Scripts/install-package-lock.sh"

xcodebuild \
  -quiet \
  -project "$ios_dir/Linco.xcodeproj" \
  -scheme Linco \
  -clonedSourcePackagesDirPath "$package_cache" \
  -disableAutomaticPackageResolution \
  -onlyUsePackageVersionsFromResolvedFile \
  -resolvePackageDependencies

xcodebuild archive \
  -quiet \
  -project "$ios_dir/Linco.xcodeproj" \
  -scheme Linco \
  -configuration Release \
  -destination 'generic/platform=iOS' \
  -archivePath "$archive_path" \
  -derivedDataPath "$derived_data" \
  -clonedSourcePackagesDirPath "$package_cache" \
  -disableAutomaticPackageResolution \
  -onlyUsePackageVersionsFromResolvedFile \
  DEVELOPMENT_TEAM="$team_id" \
  PRODUCT_BUNDLE_IDENTIFIER="$bundle_id" \
  CURRENT_PROJECT_VERSION="$build_number" \
  CODE_SIGN_STYLE=Manual \
  CODE_SIGN_IDENTITY="$signing_identity_hash" \
  PROVISIONING_PROFILE_SPECIFIER="$profile_name" \
  OTHER_CODE_SIGN_FLAGS="--keychain $keychain_path" \
  COMPILER_INDEX_STORE_ENABLE=NO

python3 - "$export_options" "$team_id" "$bundle_id" "$profile_name" "$signing_identity_hash" <<'PY'
import plistlib
import sys

destination, team, bundle, profile, identity = sys.argv[1:]
options = {
    "destination": "export",
    "method": "release-testing",
    "provisioningProfiles": {bundle: profile},
    "signingCertificate": identity,
    "signingStyle": "manual",
    "stripSwiftSymbols": True,
    "teamID": team,
}
with open(destination, "wb") as output:
    plistlib.dump(options, output, sort_keys=True)
PY

xcodebuild -exportArchive \
  -quiet \
  -archivePath "$archive_path" \
  -exportPath "$export_path" \
  -exportOptionsPlist "$export_options"

ipa_path="$(find "$export_path" -maxdepth 1 -type f -name '*.ipa' -print -quit)"
if [[ -z "$ipa_path" ]]; then
  echo "Xcode completed without producing an IPA." >&2
  exit 1
fi

mkdir -p -- "$verification_dir"
ditto -x -k "$ipa_path" "$verification_dir"
app_path="$(find "$verification_dir/Payload" -maxdepth 1 -type d -name '*.app' -print -quit)"
if [[ -z "$app_path" ]]; then
  echo "The exported archive contains no iPhone application bundle." >&2
  exit 1
fi
codesign --verify --deep --strict "$app_path"
codesign -d --extract-certificates "$exported_certificate_prefix" "$app_path" 2>/dev/null
if [[ ! -f "${exported_certificate_prefix}0" ]]; then
  echo "The exported application did not expose its signing certificate for verification." >&2
  exit 1
fi
exported_identity_hash="$(shasum -a 1 "${exported_certificate_prefix}0" | awk '{ print toupper($1) }')"
if [[ "$exported_identity_hash" != "$signing_identity_hash" ]]; then
  echo "The exported application was signed by an unexpected certificate." >&2
  exit 1
fi
actual_bundle="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$app_path/Info.plist")"
actual_build="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleVersion' "$app_path/Info.plist")"
if [[ "$actual_bundle" != "$bundle_id" || "$actual_build" != "$build_number" ]]; then
  echo "Exported application metadata does not match the requested bundle/build." >&2
  exit 1
fi

embedded_profile="$app_path/embedded.mobileprovision"
if [[ ! -f "$embedded_profile" ]]; then
  echo "The exported application has no embedded provisioning profile." >&2
  exit 1
fi
security cms -D -i "$embedded_profile" > "$embedded_profile_plist"
embedded_uuid="$(/usr/libexec/PlistBuddy -c 'Print :UUID' "$embedded_profile_plist")"
if [[ "$embedded_uuid" != "$profile_uuid" ]]; then
  echo "The exported application embedded an unexpected provisioning profile." >&2
  exit 1
fi
codesign -d --entitlements :- "$app_path" > "$signed_entitlements_plist" 2>/dev/null
python3 - \
  "$embedded_profile_plist" \
  "$signed_entitlements_plist" \
  "$team_id" \
  "$application_identifier" \
  "$device_udid" <<'PY'
import plistlib
import sys

profile_path, signed_path, expected_team, expected_application, expected_device = sys.argv[1:]
with open(profile_path, "rb") as source:
    profile = plistlib.load(source)
with open(signed_path, "rb") as source:
    signed = plistlib.load(source)

profile_entitlements = profile.get("Entitlements") or {}
if signed.get("application-identifier") != expected_application:
    raise SystemExit("Signed application-identifier does not match the requested Team and Bundle ID")
if signed.get("com.apple.developer.team-identifier") != expected_team:
    raise SystemExit("Signed team identifier does not match IOS_TEAM_ID")
if signed.get("get-task-allow", False) is not False:
    raise SystemExit("Exported application unexpectedly allows debugger attachment")
if profile_entitlements.get("application-identifier") != expected_application:
    raise SystemExit("Embedded profile application-identifier changed during export")
devices = {device.upper() for device in profile.get("ProvisionedDevices") or []}
if expected_device.upper() not in devices:
    raise SystemExit("Embedded profile does not authorize IOS_DEVICE_UDID")
PY

marketing_version="$(sed -nE 's/^[[:space:]]*MARKETING_VERSION[[:space:]]*=[[:space:]]*([^[:space:]]+).*$/\1/p' "$ios_dir/Config/Base.xcconfig")"
mkdir -p -- "$output_dir"
final_ipa="$output_dir/Linco-${marketing_version}-${build_number}-adhoc.ipa"
install -m 0600 "$ipa_path" "$final_ipa"
(
  cd "$output_dir"
  shasum -a 256 "$(basename "$final_ipa")" > "$(basename "$final_ipa").sha256"
)

if [[ -n "${GITHUB_OUTPUT:-}" ]]; then
  printf 'ipa_path=%s\n' "$final_ipa" >> "$GITHUB_OUTPUT"
  printf 'checksum_path=%s\n' "$final_ipa.sha256" >> "$GITHUB_OUTPUT"
fi

echo "Validated signed iPhone package: $final_ipa"
echo "SHA-256: $(awk '{ print $1 }' "$final_ipa.sha256")"
