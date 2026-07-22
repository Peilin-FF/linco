import SwiftUI

struct RootView: View {
    @EnvironmentObject private var model: AppModel

    var body: some View {
        ZStack(alignment: .top) {
            LincoTheme.background.ignoresSafeArea()
            Group {
                if model.profile == nil {
                    OnboardingView()
                        .transition(.opacity.combined(with: .scale(scale: 0.98)))
                } else {
                    MainTabView()
                        .transition(.opacity)
                }
            }
            .animation(.easeOut(duration: 0.28), value: model.profile == nil)

            if let error = model.presentedError {
                ErrorBanner(message: error) { model.presentedError = nil }
                    .padding(.top, 6)
                    .transition(.move(edge: .top).combined(with: .opacity))
                    .zIndex(10)
            }
        }
        .tint(LincoTheme.primary)
        .alert("上次输入状态无法确认", isPresented: $model.isAmbiguousInputAlertPresented) {
            Button("保持暂停", role: .cancel) {}
            Button("放弃未确认输入", role: .destructive) {
                Task { await model.discardAmbiguousInput() }
            }
        } message: {
            Text("服务器确认位置与本地待发送输入无法安全对齐，或远端写入结果无法确定。为避免重复执行命令，Linco 已暂停 \(model.ambiguousInputStreams.count) 个终端流，等待你确认。")
        }
    }
}

struct MainTabView: View {
    @EnvironmentObject private var model: AppModel

    var body: some View {
        TabView {
            SessionsView()
                .tabItem { Label("会话", systemImage: "rectangle.stack.fill") }
            FilesView()
                .tabItem { Label("文件", systemImage: "folder.fill") }
            PreviewHomeView()
                .tabItem { Label("预览", systemImage: "safari.fill") }
            SettingsView()
                .tabItem { Label("设置", systemImage: "gearshape.fill") }
        }
        .toolbarBackground(LincoTheme.background.opacity(0.96), for: .tabBar)
        .toolbarBackground(.visible, for: .tabBar)
    }
}
