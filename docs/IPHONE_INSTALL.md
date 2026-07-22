# 在真实 iPhone 上安装 Linco

Linco 的 iPhone 二进制由 Xcode 26 或更新版本在 macOS 上构建。Windows 不能运行 Xcode，但可以下载 GitHub Mac 构建的 Release 体验包，再使用个人 Apple Account 在本地重签并安装，因此第一次真机测试不要求付费开发者会员或自备 Mac。

## 三条安装路径

### 1. Windows + AltStore：个人真机体验（当前最快）

GitHub 的 Mac 生成与正式版本相同 Release 配置、仅缺 Apple 身份签名的 `resignable.ipa`。Windows 上的 AltServer/AltStore 使用你的个人 Apple Account 为它添加仅限本人设备的开发签名，然后安装到 iPhone。

这条路径不需要付费 Apple Developer Program，也不需要在本机安装 Xcode。免费 Personal Team 的 App ID、设备注册和 provisioning profile 只有 7 天有效期；每台设备最多同时安装 3 个个人签名 App，并且这个数量包含 AltStore 自身，因此通常还能安装 Linco 和另一个 App。AltStore 可以在电脑和手机处于同一网络时刷新签名。它仅适合验收，不用于客户分发、TestFlight 或 App Store。

AltStore 是第三方开源项目，不是 Apple 产品。它需要代表你向 Apple 申请个人开发签名；若不接受第三方工具处理 Apple Account，请不要使用这条路径，改用下方的 Ad Hoc 或 TestFlight 流程。

### 2. 仅本人临时测试：Mac + Personal Team

免费 Apple Account 可以在 Xcode 中选择 Personal Team，并把 App 直接运行到连接的本人 iPhone。这条路径不产生可长期分发的安装包，签名通常 7 天后失效，也不能用于 TestFlight 或 App Store。

### 3. 可重复安装的 IPA：Ad Hoc（正式内测推荐）

需要有效的 Apple Developer Program 会员，并在 Apple Developer 后台准备：

1. 一个尚未用于其他产品的正式 Bundle ID。
2. 测试 iPhone 的 UDID，并把设备注册到该 Team。
3. `Apple Distribution` 证书及其私钥，从创建证书的 Mac 钥匙串导出为有密码的 `.p12`。
4. 与上述 Bundle ID、证书和 iPhone 对应的 Ad Hoc provisioning profile。

不要把 Apple ID 密码、证书、私钥或 profile 发到聊天、工单或仓库。

## 生成 Windows 真机体验包

1. 打开 GitHub **Actions → iPhone Experience Package → Run workflow**。
2. 选择 `main` 分支并运行。
3. 下载 `Linco-iPhone-Experience-<run number>` artifact 并解压；包内同时附带版本清单、SHA-256 和离线安装说明。
4. 用 PowerShell 验证 IPA；只有输出 `OK` 才继续：

```powershell
$files = @(Get-ChildItem .\*.ipa -File)
if ($files.Count -ne 1) { throw "Expected exactly one IPA" }
$ipa = $files[0]
$expected = ((Get-Content "$($ipa.FullName).sha256") -split '\s+')[0].ToLowerInvariant()
$actual = (Get-FileHash $ipa.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
if ($actual -ne $expected) { throw "IPA SHA-256 mismatch" } else { "OK" }
```

如已安装并登录 GitHub CLI，可进一步验证 Sigstore/SLSA 构建来源：

```powershell
gh attestation verify $ipa.FullName --repo Peilin-FF/linco `
  --signer-workflow Peilin-FF/linco/.github/workflows/ios-experience-package.yml
```

然后严格从 [AltStore 官方 Windows 安装页](https://faq.altstore.io/altstore-classic/how-to-install-altstore-windows) 安装 AltServer：

1. 按官方说明安装 Apple 官网版本的 iTunes 和 iCloud，以及 AltServer；不要从第三方下载站获取安装程序。
2. 用 USB 连接并解锁 iPhone，选择信任电脑，在 iTunes 中开启 Wi-Fi 同步。
3. 以管理员身份启动 AltServer，选择 **Install AltStore → 你的 iPhone**，按提示用 Apple Account 完成个人签名。若不希望把主账号用于开发测试，可使用专门的测试 Apple Account。
4. 在 iPhone 的 **设置 → 通用 → VPN 与设备管理** 中信任对应开发者；在 **设置 → 隐私与安全性 → 开发者模式** 中开启 Developer Mode 并按提示重启。
5. 把校验通过的 IPA 放入 iCloud Drive 或 iPhone“文件”App，在 AltStore 的 **My Apps** 中点 `+` 并选择该 IPA。
6. 安装后让 iPhone 与运行 AltServer 的 Windows 电脑定期处于同一网络，或至少每 7 天手动刷新一次。

体验包不携带证书、Apple ID 或 provisioning profile；源 App 不请求额外 capability entitlement，AltStore 重签时会注入 Personal Team 所需的标准开发签名 entitlement。流水线会先要求同一提交的 `Native CI` 全绿，再验证 Release 配置、Info.plist 与 Mach-O 的 `iphoneos` 平台、最低 iOS 17、arm64 架构、唯一 App 目录、Bundle/Build 元数据、嵌套代码签名、ZIP 完整性和 SHA-256，并为 IPA 生成 Sigstore 签名的 SLSA provenance，最后才允许上传。

## 配置 GitHub 受保护签名环境（Ad Hoc）

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

## 生成 Ad Hoc 安装包

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
shasum -a 256 -c ./*.ipa.sha256
```

OpenSSL 会安全地提示输入 `IOS_ARTIFACT_PASSWORD`；不要把口令写在命令行参数或脚本里。解压后会得到签名 IPA 及其内部 SHA-256 校验文件；只有最后一条校验命令报告 `OK` 才继续安装。

流水线会拒绝通配符 App ID、过期或非 Ad Hoc profile、错误 Team/Bundle ID、目标 UDID 不在 profile 中、证书不属于 profile、签名或 entitlements 不匹配，以及 Xcode/iOS SDK 低于 26 的构建机。证书只导入 runner 的临时钥匙串，任务结束时会删除；明文 IPA 会在上传前删除。

## 安装 Ad Hoc 包到手机

测试 iPhone 必须运行 iOS 17.0 或更新版本、包含在 Ad Hoc profile 中，并开启 Developer Mode。在 Mac 上使用 Xcode 的 **Devices and Simulators** 或 Apple Configurator 安装导出的 IPA。安装后先完成服务器扫码配对，再执行真机验收清单。

## 真机验收最低清单

- 首次启动、相机授权和 Secure Enclave 配对。
- Shell、Claude Code、Codex 会话的启动、输入、滚动和重连。
- Wi-Fi 与蜂窝网络互切，无重复输入或输出缺口。
- 前后台切换、锁屏恢复和服务器重启恢复。
- 大文件浏览、编辑冲突保护与隔离预览。
- 终端长时间输出的温度、耗电、帧率和触控响应。

真机验收通过后，再把同一 Bundle ID 接入 App Store Connect/TestFlight；此时必须使用新的递增 build number，并完成隐私、出口合规、年龄分级、截图和审核信息。

Apple 官方参考：

- [免费 Apple Account / Personal Team 限制](https://developer.apple.com/help/account/basics/about-your-developer-account/)
- [Xcode 系统要求](https://developer.apple.com/xcode/system-requirements/)
- [注册设备分发](https://developer.apple.com/documentation/xcode/distributing-your-app-to-registered-devices)
- [创建 Ad Hoc provisioning profile](https://developer.apple.com/help/account/provisioning-profiles/create-an-ad-hoc-provisioning-profile/)
- [TestFlight 概览](https://developer.apple.com/help/app-store-connect/test-a-beta-version/testflight-overview/)
- [当前 App Store Connect 工具链要求](https://developer.apple.com/news/upcoming-requirements/?id=02032026a)
