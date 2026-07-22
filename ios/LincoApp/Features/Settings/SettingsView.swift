import SwiftUI

struct SettingsView: View {
    @EnvironmentObject private var model: AppModel
    @State private var confirmForget = false

    var body: some View {
        NavigationStack {
            List {
                Section("连接") {
                    HStack {
                        Label("状态", systemImage: "network")
                        Spacer()
                        ConnectionPill(status: model.connectionStatus)
                    }
                    if let profile = model.profile {
                        LabeledContent("服务器", value: profile.endpoint.host ?? profile.endpoint.absoluteString)
                        LabeledContent("设备授权", value: "\(profile.permissions.count) 项权限")
                    }
                    Button(model.connectionStatus.isReady ? "断开连接" : "重新连接") {
                        Task {
                            if model.connectionStatus.isReady { await model.disconnect() }
                            else { await model.connect() }
                        }
                    }
                }

                Section("安全") {
                    Label("P-256 私钥保存在安全隔区", systemImage: "lock.shield.fill")
                    Label("控制与预览凭证不会写入 URL", systemImage: "eye.slash.fill")
                    if !model.ambiguousInputStreams.isEmpty {
                        Button("处理未确认的终端输入") {
                            model.isAmbiguousInputAlertPresented = true
                        }
                        .foregroundStyle(LincoTheme.warning)
                    }
                    Button(
                        model.isForgettingServer ? "正在移除服务器…" : "移除此服务器",
                        role: .destructive
                    ) { confirmForget = true }
                    .disabled(model.isForgettingServer)
                }

                Section("关于") {
                    LabeledContent("协议", value: "Linco v1")
                    LabeledContent("最低系统", value: "iOS 17")
                    Text("Linco 不会通过 SSH 连接服务器；App 仅连接已配对的 Linco Server。")
                        .font(.footnote)
                        .foregroundStyle(LincoTheme.muted)
                }
            }
            .scrollContentBackground(.hidden)
            .background(LincoTheme.background)
            .navigationTitle("设置")
            .confirmationDialog("移除服务器并放弃待确认输入？", isPresented: $confirmForget, titleVisibility: .visible) {
                Button("移除并放弃", role: .destructive) { Task { await model.forgetServer() } }
                Button("取消", role: .cancel) {}
            } message: {
                Text("这会立即断开连接，放弃所有排队中或结果尚未确认的终端输入，并删除配对资料与设备私钥。重新连接需要在服务器上生成新的配对二维码。")
            }
        }
    }
}
