# Native release checklist

Linco 的正式发布目标仅包含 iPhone App 与 Linux `linco-server`。

## 1. 质量门槛

合并发布提交前，GitHub Actions 的 `Native CI` 必须全部通过：

- Rust 1.85 格式、Clippy `-D warnings`、完整 workspace tests。
- LincoCore Swift tests 与已校验的 SwiftPM 精确锁定版本。
- XcodeGen 生成工程、无签名 Debug Simulator build、无签名 Release iPhone SDK build、iPhone unit/UI tests。

本地 Rust 验证命令：

```sh
cargo +1.85.0 fmt --all -- --check
cargo +1.85.0 clippy --workspace --all-targets --all-features --locked -- -D warnings
cargo +1.85.0 test --workspace --all-targets --all-features --locked
```

## 2. 版本号

同步更新：

- `ios/Config/Base.xcconfig` 中的 `MARKETING_VERSION` 和 `CURRENT_PROJECT_VERSION`。
- `apps/linco-server/Cargo.toml`、`crates/linco-core/Cargo.toml`、`crates/linco-protocol/Cargo.toml` 中的 crate 版本。
- 若 wire 不再向后兼容，必须升级协议版本；不能只改 App 版本。

`Native CI` 会阻止三份 crate 版本、iOS `MARKETING_VERSION` 或 tag 不一致的发布。提交版本变更并确认 `main` 的 CI 全绿后，创建并推送签名 tag；tag 自身的 `Native CI` 也必须通过：

```sh
git tag -s v1.0.0 -m 'Linco 1.0.0'
git push origin refs/tags/v1.0.0
```

## 3. iPhone / TestFlight

先生成注册设备可安装的 Ad Hoc IPA 时，按 [`IPHONE_INSTALL.md`](IPHONE_INSTALL.md) 配置受保护的 `ios-signing` 环境并运行 `iPhone Install Package` workflow。证书、profile 和私钥不得提交到仓库。

在受控的 macOS + Xcode 26（或更高版本）与 iOS 26 SDK 构建机上操作。Apple 自 2026 年 4 月 28 日起要求 App Store Connect 上传使用这一代或更新的工具链，因此旧 Xcode 构建不得作为 TestFlight / App Store 发布件：

```sh
cd ios
xcodegen generate --spec project.yml
bash Scripts/install-package-lock.sh
xcodebuild test \
  -project Linco.xcodeproj \
  -scheme Linco \
  -disableAutomaticPackageResolution \
  -onlyUsePackageVersionsFromResolvedFile \
  -destination 'platform=iOS Simulator,name=iPhone 17 Pro,OS=latest' \
  CODE_SIGNING_ALLOWED=NO
```

随后在 Xcode 中选择真实开发团队，使用 `Any iOS Device (arm64)` Archive。上传前确认：

- Release 使用正确的 App Store provisioning profile。
- App 图标、隐私清单、相机用途说明和版本号均通过 Organizer validation。
- 在真实 iPhone 上完成 Secure Enclave 配对、蜂窝/Wi‑Fi 切换、后台恢复、终端输入与文件冲突测试。
- TestFlight 内测通过后再提交 App Review。

Apple 证书、App Store Connect API key 和 provisioning profile 只能保存在 Apple Keychain/CI secret store，不能提交到仓库。tag/校验和签名私钥同样只能保存在硬件密钥或受控的签名环境中。

## 4. Linux daemon

从同一个 tag 构建锁定依赖的 release binary：

```sh
cargo +1.85.0 build --release -p linco-server --locked
release_tag="$(git describe --tags --exact-match)"
git verify-tag "$release_tag"
checksum_file="linco-server-${release_tag}-linux-$(uname -m).sha256"
sha256sum target/release/linco-server > "$checksum_file"
gpg --armor --detach-sign "$checksum_file"
```

在与生产环境兼容的 Linux/glibc 基线上构建，发布二进制、SHA-256 校验和、校验和签名与目标架构，并按 [`DEPLOYMENT.md`](DEPLOYMENT.md) 原子替换服务端二进制。升级必须保留 `LINCO_STATE_DIR`，否则已固定的服务器身份和设备配对都会失效。

## 5. 发布后烟雾测试

- 公网域名只开放 80/443；7337 仍为 loopback。
- `/healthz` 正常，Caddy 证书链有效。
- 新二维码能完成一次配对，重复使用被拒绝。
- 新建 Shell/Claude/Codex 会话均能即时显示首屏。
- 断网后恢复无重复输入；文件版本冲突不会覆盖远端内容。
- 服务重启后已配对设备仍可连接；撤销设备后，两个 WebSocket 通道与已签发的 HTTP 能力会在 5 秒内失效。
