# Release Checklist

Linco uses Tauri's signed updater artifacts plus GitHub Releases. The app checks:

```text
https://github.com/Peilin-FF/linco/releases/latest/download/latest.json
```

When a newer release exists, the header shows the update button immediately to the left of the SSH connection picker.

## One-Time Setup

1. Generate an updater signing key. The public key goes in `src-tauri/tauri.conf.json`; the private key never goes into git.

```sh
npx tauri signer generate --ci --password '<strong-password>' -w ~/.tauri/linco-updater.key
```

This workspace currently has a generated key at `~/.tauri/linco-updater.key`, and its public key is already committed in `src-tauri/tauri.conf.json`. Rotate it before a public launch if you want a password-protected key.

2. Add GitHub Secrets for updater signing:

```sh
gh secret set TAURI_SIGNING_PRIVATE_KEY < ~/.tauri/linco-updater.key
# only if the key has a password
gh secret set TAURI_SIGNING_PRIVATE_KEY_PASSWORD
```

If the key has no password, skip `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`.

3. Export the Apple Developer ID Application certificate from Keychain Access as a `.p12`, then add these GitHub Secrets:

```sh
base64 -i DeveloperIDApplication.p12 | gh secret set APPLE_CERTIFICATE
gh secret set APPLE_CERTIFICATE_PASSWORD
gh secret set APPLE_SIGNING_IDENTITY
gh secret set APPLE_ID
gh secret set APPLE_PASSWORD
gh secret set APPLE_TEAM_ID
```

Use an app-specific password for `APPLE_PASSWORD`. `APPLE_SIGNING_IDENTITY` is usually `Developer ID Application: Your Name (TEAMID)`.

## Publishing

1. Bump all app versions together:

```sh
npm version patch --no-git-tag-version
```

Then update `src-tauri/Cargo.toml` and `src-tauri/tauri.conf.json` to the same version.

2. Commit the version bump.

3. Create and push a tag:

```sh
git tag v0.1.1
git push origin main --tags
```

4. GitHub Actions creates a draft release with signed macOS universal artifacts and `latest.json`.

5. Review the draft release, then publish it.
