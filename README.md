# Linco

Linco 是一个面向 iPhone 的原生远程开发客户端。iPhone 直接连接部署在 Linux 服务器上的 `linco-server`，无需 SSH 会话，也不需要常驻桌面中转程序。

正式发布路径只有三部分：

- `ios/`：iOS 17+ 原生 SwiftUI App，包含安全扫码配对、会话管理、低延迟终端、文件编辑和隔离预览。
- `apps/linco-server/`：Linux 无界面守护进程，负责鉴权、PTY 会话、文件能力授权与预览。
- `crates/`：跨端二进制协议和可测试的终端/工作区核心。

## 为什么响应快

- 终端使用独立的交互 WebSocket，控制消息不会阻塞输入和输出。
- 原始终端字节使用 16-byte 固定头二进制帧传输，不经过 Base64。
- 文件和预览走带 Range/ETag 的 HTTPS，不占用实时通道。
- 服务端始终排空 PTY 并保留有界重放环；iPhone 断线重连后按绝对偏移补齐，避免重复和缺口。
- WebSocket 禁用大块聚合等待，TCP 开启 `TCP_NODELAY`。

## 安全边界

- 二维码固定服务器 Ed25519 身份；每次握手都必须验证服务端签名。
- iPhone 使用 Secure Enclave P-256 私钥，私钥不可导出。
- 配对密钥和 HTTP capability 均为短时、最小权限凭证；上传与预览引导凭证只能消费一次，下载凭证仅在有效期内复用，且凭证不会出现在 URL 或日志中。
- 文件写入使用强 SHA-256 ETag、`If-Match` 和同目录原子替换；服务端会串行化同一路径的 Linco 提交，并在最终版本不匹配时拒绝覆盖。工作区内其他进程不参与这把跨请求锁，具体边界见部署文档。
- 服务端只允许访问显式配置的工作区，并拒绝绝对路径、`..` 与符号链接逃逸。

## 本地验证

Rust 工作区固定用 Rust 1.85.0 验证：

```sh
cargo +1.85.0 fmt --all -- --check
cargo +1.85.0 clippy --workspace --all-targets --all-features --locked -- -D warnings
cargo +1.85.0 test --workspace --all-targets --all-features --locked
```

iPhone 工程由 XcodeGen 2.45.4 从 `ios/project.yml` 生成。具体构建方式见 [`ios/README.md`](ios/README.md)，Linux 正式部署见 [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md)，正式发布门禁见 [`docs/release.md`](docs/release.md)。

## 支持的正式拓扑

```text
iPhone ── HTTPS/WSS ── Caddy ── loopback HTTP/WS ── linco-server ── PTY / workspace
```

公网部署必须由 Caddy（或等价的可信 TLS 终止层）提供 HTTPS/WSS。`linco-server` 默认只监听 `127.0.0.1:7337`，不应把明文端口暴露到公网。
