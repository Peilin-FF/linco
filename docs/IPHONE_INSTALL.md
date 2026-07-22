# 在真实 iPhone 上安装 Linco

Linco 的正式安装包由 Xcode 26 或更新版本在 macOS 上构建并经 Apple 签名。Windows 不能运行 Xcode，也不能单独生成可在 iPhone 上安装的签名 IPA。

## 最快的两条路径

### 1. 仅本人临时测试：Mac + Personal Team

免费 Apple Account 可以在 Xcode 中选择 Personal Team，并把 App 直接运行到连接的本人 iPhone。这条路径不产生可长期分发的安装包，签名通常 7 天后失效，也不能用于 TestFlight 或 App Store。

### 2. 可重复安装的 IPA：Ad Hoc（推荐当前阶段）

需要有效的 Apple Developer Program 会员，并在 Apple Developer 后台准备：

1. 一个尚未用于其他产品的正式 Bundle ID。
2. 测试 iPhone 的 UDID，并把设备注册到该 Team。
3. `Apple Distribution` 证书及其私钥，从创建证书的 Mac 钥匙串导出为有密码的 `.p12`。
4. 与上述 Bundle ID、证书和 iPhone 对应的 Ad Hoc provisioning profile。

不要把 Apple ID 密码、证书、私钥或 profile 发到聊天、工单或仓库。

## 配置 GitHub 受保护签名环境

在 GitHub 仓库的 **Settings → Environments** 创建 `ios-signing` 环境，并添加以下 environment secrets：

| Secret | 内容 |
|---|---|
| `IOS_CERTIFICATE_BASE64` | `.p12` 文件的单行 Base64 |
| `IOS_CERTIFICATE_PASSWORD` | 导出 `.p12` 时设置的密码 |
| `IOS_PROVISIONING_PROFILE_BASE64` | Ad Hoc `.mobileprovision` 文件的单行 Base64 |
| `IOS_TEAM_ID` | 10 位 Apple Developer Team ID |
| `IOS_BUNDLE_ID` | profile 对应的完整 Bundle ID |
| `IOS_DEVICE_UDID` | 要安装这份 IPA 的 iPhone UDID，且必须已包含在 profile 中 |
| `IOS_SIGNING_IDENTITY` | `.p12` 中证书的完整名称，例如 `Apple Distribution: Name (TEAMID)` |
| `IOS_ARTIFACT_PASSWORD` | 至少 20 位的随机强口令；用于加密公开仓库中的安装产物 |

在 Mac 上可以把文件编码后直接复制到剪贴板，再粘贴进 GitHub secret：

```sh
base64 -i LincoDistribution.p12 | tr -d '\n' | pbcopy
base64 -i Linco-AdHoc.mobileprovision | tr -d '\n' | pbcopy
```

每个 secret 保存后立即清空剪贴板，不要把 Base64 中间文件留在项目目录。`IOS_ARTIFACT_PASSWORD` 必须同时保存在你自己的密码管理器中；GitHub secret 保存后无法再次显示，聊天中也不应发送这个口令。

因为本仓库是公开仓库，必须把 `ios-signing` 环境限制为只允许 `main` 分支部署，并配置 required reviewer。workflow 本身也会拒绝从 `main` 以外的 ref 读取签名环境。

## 生成安装包

1. 确认 `Native CI` 已在 `native-iphone-rc` 分支全绿，并在审查后合并到受保护的 `main`。
2. 打开 GitHub **Actions → iPhone Install Package → Run workflow**。
3. 选择 `main` 分支并运行。
4. 构建成功后下载 `Linco-iPhone-<run number>` artifact。
5. artifact 只包含加密文件和它的 SHA-256；公开仓库不会保存明文 IPA。

先验证下载密文的 SHA-256，再在受控的 Mac 上解密：

```sh
shasum -a 256 -c Linco-<run number>-adhoc.tar.gz.enc.sha256
openssl enc -d -aes-256-cbc -pbkdf2 -iter 600000 -md sha256 \
  -in Linco-<run number>-adhoc.tar.gz.enc \
  -out Linco-install-package.tar.gz
tar -xzf Linco-install-package.tar.gz
```

OpenSSL 会安全地提示输入 `IOS_ARTIFACT_PASSWORD`；不要把口令写在命令行参数或脚本里。解压后会得到签名 IPA 及其内部 SHA-256 校验文件。

流水线会拒绝通配符 App ID、过期或非 Ad Hoc profile、错误 Team/Bundle ID、目标 UDID 不在 profile 中、证书不属于 profile、签名或 entitlements 不匹配，以及 Xcode/iOS SDK 低于 26 的构建机。证书只导入 runner 的临时钥匙串，任务结束时会删除；明文 IPA 会在上传前删除。

## 安装到手机

测试 iPhone 必须包含在 Ad Hoc profile 中，并开启 Developer Mode。在 Mac 上使用 Xcode 的 **Devices and Simulators** 或 Apple Configurator 安装导出的 IPA。安装后先完成服务器扫码配对，再执行真机验收清单。

## 真机验收最低清单

- 首次启动、相机授权和 Secure Enclave 配对。
- Shell、Claude Code、Codex 会话的启动、输入、滚动和重连。
- Wi-Fi 与蜂窝网络互切，无重复输入或输出缺口。
- 前后台切换、锁屏恢复和服务器重启恢复。
- 大文件浏览、编辑冲突保护与隔离预览。
- 终端长时间输出的温度、耗电、帧率和触控响应。

真机验收通过后，再把同一 Bundle ID 接入 App Store Connect/TestFlight；此时必须使用新的递增 build number，并完成隐私、出口合规、年龄分级、截图和审核信息。

Apple 官方参考：

- [Xcode 系统要求](https://developer.apple.com/xcode/system-requirements/)
- [注册设备分发](https://developer.apple.com/documentation/xcode/distributing-your-app-to-registered-devices)
- [创建 Ad Hoc provisioning profile](https://developer.apple.com/help/account/provisioning-profiles/create-an-ad-hoc-provisioning-profile/)
- [TestFlight 概览](https://developer.apple.com/help/app-store-connect/test-a-beta-version/testflight-overview/)
- [当前 App Store Connect 工具链要求](https://developer.apple.com/news/upcoming-requirements/?id=02032026a)
