# Linco for iPhone

Native iOS 17+ client for a paired Linco Server. The app uses two authenticated WebSocket lanes (control and interactive), authenticated HTTPS for file/preview bytes, SwiftTerm for terminal rendering, Runestone for editing, VisionKit for QR pairing, and Secure Enclave P-256 device keys.

## Generate and build

The checked-in source of truth is `project.yml`; do not commit a generated `.xcodeproj`.

1. On macOS with Xcode 26 or newer and the iOS 26 SDK, install XcodeGen **2.45.4**. Apple requires this toolchain generation for App Store Connect uploads beginning April 28, 2026.
2. From this directory, generate the project and install the committed SwiftPM lock:

   ```sh
   xcodegen generate --spec project.yml
   bash Scripts/install-package-lock.sh
   ```

3. Resolve only the seven locked direct/transitive package revisions:

   ```sh
   xcodebuild -resolvePackageDependencies \
     -project Linco.xcodeproj \
     -scheme Linco \
     -disableAutomaticPackageResolution \
     -onlyUsePackageVersionsFromResolvedFile
   ```

4. Open `Linco.xcodeproj`, choose a development team, then run the `Linco` scheme on an iPhone running iOS 17 or newer.
5. Run the full unit/UI suite with:

   ```sh
   xcodebuild test \
     -project Linco.xcodeproj \
     -scheme Linco \
     -disableAutomaticPackageResolution \
     -onlyUsePackageVersionsFromResolvedFile \
     -destination 'platform=iOS Simulator,name=iPhone 17 Pro,OS=latest'
   ```

6. Run the platform-independent protocol/reliability suite directly with:

   ```sh
   swift test --package-path Packages/LincoCore
   ```

The Secure Enclave pairing path must additionally be verified on a physical iPhone; the simulator is suitable for protocol, URL construction, reconnect/heartbeat timing, and UI tests.

For a Windows-side, locally re-signable Release IPA, use the `iPhone Experience Package` workflow. For a signed registered-device IPA, use the protected `iPhone Install Package` workflow. Follow [`../docs/IPHONE_INSTALL.md`](../docs/IPHONE_INSTALL.md) for both routes. Signing material must remain in the `ios-signing` GitHub environment and must never be committed.

## Dependency lock

`Package.resolved` is the reviewed source of truth for SwiftTerm 1.14.0, Runestone 0.5.2, TreeSitterLanguages 0.1.10, and four transitive packages. Every pin includes a full 40-character tag commit. `Scripts/verify-package-lock.py` rejects package-set, URL, version, revision, and `project.yml` direct-requirement drift. CI copies this lock into the generated Xcode workspace and disables automatic package resolution for resolve, build, and test.

## Verification inventory

- `LincoCoreTests`: fixed pairing/authentication/server-proof transcripts, 12-method shared RPC contract, binary framing, terminal ACK/replay/snapshot/EOS behavior, endpoint construction, and reconnect timing.
- `LincoAppTests`: exact wire schemas, bounded HTTPS capabilities, timeout/cancellation behavior, WebSocket FIFO and ping isolation, rendezvous terminal output, lossless input order, cross-surface coalesced resize order, background full replay, session-start idempotency, file pagination/conflict policy, and editor language/highlight mapping.
- `LincoUITests`: launch and primary navigation smoke coverage.
- CI: Swift 6/Xcode 26+ Debug simulator build, unsigned Release device-SDK build, and iPhone simulator unit/UI tests with package resolution locked. The workflow rejects an Xcode or iOS SDK major version below 26 so its output remains eligible for current App Store Connect uploads.

## Security invariants

- QR payloads expire within 120 seconds and must contain an HTTPS base URL.
- The server's Ed25519 identity is pinned by QR and signs every server hello.
- Device signatures use a non-exportable Secure Enclave P-256 key.
- Pairing and ongoing-auth transcripts are fixed binary layouts with conformance tests.
- Capability tokens are sent in `Authorization`, never URL queries.
- File reads are streamed in bounded chunks; writes reserve an exact content length and strong revision before upload.
- Preview uses an isolated, nonpersistent `WKWebView` restricted to its bootstrap origin.
- Unacknowledged terminal input is resent only when `server_epoch` is unchanged. An epoch change requires explicit user action.
- The control and interactive lanes are kept alive independently and are probed immediately whenever the app returns to the foreground.
