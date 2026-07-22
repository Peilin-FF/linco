#!/usr/bin/env bash
set -euo pipefail

umask 022

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "A re-signable iPhone package can only be built on macOS with Xcode." >&2
  exit 2
fi

for command_name in xcodebuild xcrun xcodegen python3 ditto shasum lipo codesign unzip; do
  command -v "$command_name" >/dev/null 2>&1 || {
    echo "Required command is unavailable: $command_name" >&2
    exit 2
  }
done

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
ios_dir="$(cd -- "$script_dir/.." && pwd)"
repo_root="$(cd -- "$ios_dir/.." && pwd)"
output_dir="${LINCO_OUTPUT_DIR:-$repo_root/artifacts/iphone-experience}"
build_number="${IOS_BUILD_NUMBER:-1}"
bundle_id="${IOS_BUNDLE_ID:-app.linco.iphone}"

if [[ ! "$build_number" =~ ^[1-9][0-9]*$ ]]; then
  echo "IOS_BUILD_NUMBER must be a positive integer." >&2
  exit 2
fi
if [[ ! "$bundle_id" =~ ^[A-Za-z0-9][A-Za-z0-9.-]+$ ]] || [[ "$bundle_id" == *"*"* ]]; then
  echo "IOS_BUNDLE_ID must be an explicit reverse-DNS identifier without wildcards." >&2
  exit 2
fi

xcode_version="$(xcodebuild -version | awk '/^Xcode / { print $2; exit }')"
ios_sdk_version="$(xcrun --sdk iphoneos --show-sdk-version)"
if (( ${xcode_version%%.*} < 26 || ${ios_sdk_version%%.*} < 26 )); then
  echo "Xcode 26+ and the iOS 26+ SDK are required; found Xcode $xcode_version / iOS SDK $ios_sdk_version." >&2
  exit 2
fi

python3 - "$ios_dir/Resources/Linco.entitlements" <<'PY'
import plistlib
import sys

with open(sys.argv[1], "rb") as source:
    entitlements = plistlib.load(source)
if entitlements:
    raise SystemExit(
        "The re-signable package only supports an empty entitlement set; "
        f"found: {', '.join(sorted(entitlements))}"
    )
PY

validate_resignable_code_tree() {
  python3 - "$1" <<'PY'
from pathlib import Path
import plistlib
import re
import subprocess
import sys

root = Path(sys.argv[1])
candidates = [root]
for path in root.rglob("*"):
    if path.is_dir() and path.suffix in {".app", ".appex", ".framework", ".xpc"}:
        candidates.append(path)
    elif path.is_file() and path.suffix == ".dylib":
        candidates.append(path)

for candidate in candidates:
    display = candidate.relative_to(root.parent)
    inspection = subprocess.run(
        ["codesign", "-dvv", str(candidate)],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        check=False,
    )
    details = inspection.stdout + inspection.stderr
    if inspection.returncode != 0:
        if "not signed at all" in details.lower():
            continue
        raise SystemExit(f"Unable to establish signing state for {display}: {details.strip()}")

    if not re.search(r"(?m)^Signature=adhoc$", details):
        raise SystemExit(f"{display} contains a non-ad-hoc code signature")
    if re.search(r"(?m)^Authority=", details):
        raise SystemExit(f"{display} contains an Apple signing authority")
    team = re.search(r"(?m)^TeamIdentifier=(.+)$", details)
    if team and team.group(1).strip() != "not set":
        raise SystemExit(f"{display} contains signing TeamIdentifier {team.group(1).strip()}")

    entitlement_check = subprocess.run(
        ["codesign", "-d", "--entitlements", ":-", str(candidate)],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        check=False,
    )
    if entitlement_check.returncode != 0:
        raise SystemExit(f"Unable to inspect embedded entitlements for {display}")
    payload = entitlement_check.stdout.strip()
    if payload:
        try:
            entitlements = plistlib.loads(payload)
        except Exception as error:
            raise SystemExit(f"Invalid embedded entitlements in {display}: {error}") from error
        if entitlements:
            raise SystemExit(
                f"{display} contains entitlements before local re-signing: "
                f"{', '.join(sorted(entitlements))}"
            )
PY
}

temporary_parent="${TMPDIR:-/tmp}"
temporary_parent="${temporary_parent%/}"
temporary_root="$(mktemp -d "$temporary_parent/linco-resignable.XXXXXX")"
derived_data="$temporary_root/DerivedData"
package_cache="$temporary_root/SourcePackages"
package_root="$temporary_root/package"
verification_root="$temporary_root/verification"

cleanup() {
  status=$?
  trap - EXIT INT TERM
  case "$temporary_root" in
    "$temporary_parent"/linco-resignable.*) rm -rf -- "$temporary_root" ;;
    *) echo "Refusing to remove unexpected temporary path: $temporary_root" >&2 ;;
  esac
  exit "$status"
}
trap cleanup EXIT INT TERM

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

xcodebuild \
  -quiet \
  -project "$ios_dir/Linco.xcodeproj" \
  -scheme Linco \
  -configuration Release \
  -sdk iphoneos \
  -destination 'generic/platform=iOS' \
  -derivedDataPath "$derived_data" \
  -clonedSourcePackagesDirPath "$package_cache" \
  -disableAutomaticPackageResolution \
  -onlyUsePackageVersionsFromResolvedFile \
  PRODUCT_BUNDLE_IDENTIFIER="$bundle_id" \
  CURRENT_PROJECT_VERSION="$build_number" \
  CODE_SIGNING_ALLOWED=NO \
  CODE_SIGNING_REQUIRED=NO \
  CODE_SIGN_IDENTITY= \
  COMPILER_INDEX_STORE_ENABLE=NO \
  build

app_path="$derived_data/Build/Products/Release-iphoneos/Linco.app"
if [[ ! -d "$app_path" || ! -f "$app_path/Info.plist" ]]; then
  echo "Xcode completed without producing the expected Release iPhone application." >&2
  exit 1
fi

actual_bundle="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$app_path/Info.plist")"
actual_build="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleVersion' "$app_path/Info.plist")"
minimum_ios="$(/usr/libexec/PlistBuddy -c 'Print :MinimumOSVersion' "$app_path/Info.plist")"
platform_name="$(/usr/libexec/PlistBuddy -c 'Print :DTPlatformName' "$app_path/Info.plist")"
executable_name="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleExecutable' "$app_path/Info.plist")"
executable_path="$app_path/$executable_name"

if [[ "$actual_bundle" != "$bundle_id" || "$actual_build" != "$build_number" ]]; then
  echo "Built application metadata does not match the requested bundle/build." >&2
  exit 1
fi
if [[ "$minimum_ios" != "17.0" || "$platform_name" != "iphoneos" ]]; then
  echo "Built application targets an unexpected platform or minimum iOS version." >&2
  exit 1
fi
if [[ ! -x "$executable_path" ]]; then
  echo "Built application has no executable iPhone binary." >&2
  exit 1
fi

architectures="$(lipo -archs "$executable_path")"
case " $architectures " in
  *" arm64 "*) ;;
  *) echo "Built application does not contain the required arm64 architecture." >&2; exit 1 ;;
esac
case " $architectures " in
  *" x86_64 "*|*" i386 "*)
    echo "Built application unexpectedly contains a simulator architecture." >&2
    exit 1
    ;;
esac

mach_o_build="$(xcrun vtool -show-build "$executable_path")"
if ! grep -Eq '^[[:space:]]*platform IOS[[:space:]]*$' <<<"$mach_o_build"; then
  echo "Built executable is not an iOS device Mach-O." >&2
  exit 1
fi
if ! grep -Eq '^[[:space:]]*minos 17(\.0+)?[[:space:]]*$' <<<"$mach_o_build"; then
  echo "Built executable has an unexpected Mach-O minimum iOS version." >&2
  exit 1
fi

if find "$app_path" -name embedded.mobileprovision -print -quit | grep -q .; then
  echo "The re-signable package unexpectedly contains a provisioning profile." >&2
  exit 1
fi
validate_resignable_code_tree "$app_path"

marketing_version="$(sed -nE 's/^[[:space:]]*MARKETING_VERSION[[:space:]]*=[[:space:]]*([^[:space:]]+).*$/\1/p' "$ios_dir/Config/Base.xcconfig")"
if [[ -z "$marketing_version" ]]; then
  echo "Unable to determine MARKETING_VERSION." >&2
  exit 1
fi

mkdir -p -- "$package_root/Payload" "$verification_root" "$output_dir"
ditto "$app_path" "$package_root/Payload/Linco.app"

final_ipa="$output_dir/Linco-${marketing_version}-${build_number}-resignable.ipa"
final_checksum="$final_ipa.sha256"
final_manifest="$output_dir/Linco-${marketing_version}-${build_number}-resignable.json"
final_instructions="$output_dir/Linco-${marketing_version}-${build_number}-INSTALL.txt"
rm -f -- "$final_ipa" "$final_checksum" "$final_manifest" "$final_instructions"
ditto -c -k --sequesterRsrc --keepParent "$package_root/Payload" "$final_ipa"
chmod 0644 "$final_ipa"
unzip -tqq "$final_ipa"
ditto -x -k "$final_ipa" "$verification_root"

verified_app="$verification_root/Payload/Linco.app"
app_count="$(find "$verification_root/Payload" -mindepth 1 -maxdepth 1 -type d -name '*.app' | wc -l | tr -d '[:space:]')"
if [[ "$app_count" != "1" || ! -d "$verified_app" || ! -x "$verified_app/$executable_name" ]]; then
  echo "Packaged IPA does not contain the expected application bundle." >&2
  exit 1
fi
verified_bundle="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$verified_app/Info.plist")"
verified_build="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleVersion' "$verified_app/Info.plist")"
verified_minimum_ios="$(/usr/libexec/PlistBuddy -c 'Print :MinimumOSVersion' "$verified_app/Info.plist")"
verified_platform="$(/usr/libexec/PlistBuddy -c 'Print :DTPlatformName' "$verified_app/Info.plist")"
verified_executable="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleExecutable' "$verified_app/Info.plist")"
if [[ "$verified_bundle" != "$bundle_id" || "$verified_build" != "$build_number" || \
      "$verified_minimum_ios" != "17.0" || "$verified_platform" != "iphoneos" || \
      "$verified_executable" != "$executable_name" ]]; then
  echo "Packaged IPA changed the verified application metadata." >&2
  exit 1
fi
verified_executable_path="$verified_app/$verified_executable"
if [[ "$(lipo -archs "$verified_executable_path")" != "$architectures" ]]; then
  echo "Packaged IPA changed the executable architecture set." >&2
  exit 1
fi
verified_mach_o_build="$(xcrun vtool -show-build "$verified_executable_path")"
if ! grep -Eq '^[[:space:]]*platform IOS[[:space:]]*$' <<<"$verified_mach_o_build" || \
   ! grep -Eq '^[[:space:]]*minos 17(\.0+)?[[:space:]]*$' <<<"$verified_mach_o_build"; then
  echo "Packaged IPA changed the verified Mach-O platform metadata." >&2
  exit 1
fi
if find "$verified_app" -name embedded.mobileprovision -print -quit | grep -q .; then
  echo "Packaged IPA unexpectedly contains a provisioning profile." >&2
  exit 1
fi
validate_resignable_code_tree "$verified_app"

(
  cd "$output_dir"
  shasum -a 256 "$(basename "$final_ipa")" > "$(basename "$final_checksum")"
)
ipa_sha256="$(awk '{ print $1 }' "$final_checksum")"
source_commit="${GITHUB_SHA:-$(git -C "$repo_root" rev-parse HEAD 2>/dev/null || printf unknown)}"

python3 - \
  "$final_manifest" \
  "$final_instructions" \
  "$marketing_version" \
  "$build_number" \
  "$bundle_id" \
  "$minimum_ios" \
  "$architectures" \
  "$xcode_version" \
  "$ios_sdk_version" \
  "$source_commit" \
  "$ipa_sha256" <<'PY'
import json
import sys

(
    destination,
    instructions_destination,
    version,
    build,
    bundle,
    minimum_ios,
    architectures,
    xcode,
    sdk,
    commit,
    sha256,
) = sys.argv[1:]
manifest = {
    "application": "Linco",
    "version": version,
    "build": int(build),
    "bundle_id_before_resigning": bundle,
    "minimum_ios": minimum_ios,
    "architectures": architectures.split(),
    "configuration": "Release",
    "xcode": xcode,
    "iphoneos_sdk": sdk,
    "source_commit": commit,
    "ipa_sha256": sha256,
    "signing": "re-signable; no provisioning profile or Apple identity included",
}
with open(destination, "w", encoding="utf-8") as output:
    json.dump(manifest, output, ensure_ascii=False, indent=2, sort_keys=True)
    output.write("\n")

instructions = f"""Linco iPhone 真机体验包

版本：{version} ({build})
源码提交：{commit}
IPA SHA-256：{sha256}

这是一份经过校验的 Release/iphoneos/arm64 可重签名 IPA，不能直接在 iPhone 上运行。
它不包含 Apple 身份签名、provisioning profile 或账户凭据。

Windows 免费体验（签名 7 天有效）：
1. 在解压目录打开 PowerShell，运行以下命令；只有输出 OK 才继续：

   $files = @(Get-ChildItem ./*.ipa -File)
   if ($files.Count -ne 1) {{ throw "Expected exactly one IPA" }}
   $ipa = $files[0]
   $expected = ((Get-Content "$($ipa.FullName).sha256") -split '\\s+')[0].ToLowerInvariant()
   $actual = (Get-FileHash $ipa.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
   if ($actual -ne $expected) {{ throw "IPA SHA-256 mismatch" }} else {{ "OK" }}

   可选来源验证（需安装并登录 GitHub CLI）：
   gh attestation verify $ipa.FullName --repo Peilin-FF/linco `
     --signer-workflow Peilin-FF/linco/.github/workflows/ios-experience-package.yml

2. 只从 AltStore 项目官网安装 AltServer：
   https://faq.altstore.io/altstore-classic/how-to-install-altstore-windows
3. 用 AltServer 把 AltStore 安装到自己的 iPhone，开启 Developer Mode。
4. 在 AltStore 的 My Apps 中选择本 IPA；AltStore 会使用你的个人 Apple Account 重签并安装。
5. 让手机与 AltServer 定期处于同一网络，在 7 天到期前刷新。

AltStore 是第三方开源项目，不是 Apple 产品。若不接受第三方工具处理 Apple Account，
请改用付费 Apple Developer Program 的 Ad Hoc 包或 TestFlight。
"""
with open(instructions_destination, "w", encoding="utf-8") as output:
    output.write(instructions)
PY

if [[ -n "${GITHUB_OUTPUT:-}" ]]; then
  printf 'ipa_path=%s\n' "$final_ipa" >> "$GITHUB_OUTPUT"
  printf 'checksum_path=%s\n' "$final_checksum" >> "$GITHUB_OUTPUT"
  printf 'manifest_path=%s\n' "$final_manifest" >> "$GITHUB_OUTPUT"
  printf 'instructions_path=%s\n' "$final_instructions" >> "$GITHUB_OUTPUT"
fi

echo "Validated re-signable iPhone package: $final_ipa"
echo "SHA-256: $ipa_sha256"
