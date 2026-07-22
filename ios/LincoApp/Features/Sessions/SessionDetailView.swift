import SwiftUI

struct SessionDetailView: View {
    @EnvironmentObject private var model: AppModel
    let session: RemoteSession
    @State private var confirmStop = false

    var body: some View {
        Group {
            if currentSession.state.keepsTerminalStreamOpen {
                TerminalScreen(session: currentSession, streamID: currentSession.streamID)
            } else {
                LincoEmptyState(
                    symbol: currentSession.state == .exited ? "checkmark.circle.fill" : "exclamationmark.triangle.fill",
                    title: currentSession.state == .exited ? "会话已结束" : "会话异常退出",
                    message: "服务器 PTY 已关闭，终端输出已完整收尾。"
                )
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .background(LincoTheme.background)
            }
        }
        .navigationTitle(currentSession.title.isEmpty ? currentSession.kind.displayName : currentSession.title)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            if currentSession.state.keepsTerminalStreamOpen {
                ToolbarItem(placement: .topBarTrailing) {
                    Menu {
                        Button("停止会话", systemImage: "stop.fill", role: .destructive) { confirmStop = true }
                    } label: {
                        Image(systemName: "ellipsis.circle")
                    }
                }
            }
        }
        .confirmationDialog("停止这个服务器会话？", isPresented: $confirmStop, titleVisibility: .visible) {
            Button("停止", role: .destructive) { Task { _ = await model.stopSession(currentSession) } }
            Button("取消", role: .cancel) {}
        } message: {
            Text("PTY 进程会在服务器上结束，未保存的交互状态无法恢复。")
        }
    }

    private var currentSession: RemoteSession {
        model.sessions.first { $0.id == session.id } ?? session
    }
}
