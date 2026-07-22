import SwiftUI

struct SessionsView: View {
    @EnvironmentObject private var model: AppModel
    @State private var isNewSessionPresented = false

    var body: some View {
        NavigationStack {
            Group {
                if model.sessions.isEmpty {
                    LincoEmptyState(
                        symbol: model.connectionStatus.isReady ? "terminal" : "wifi.slash",
                        title: model.connectionStatus.isReady ? "没有运行中的会话" : "服务器未连接",
                        message: model.connectionStatus.isReady
                            ? "在服务器上启动 Shell、Claude Code 或 Codex 后，会话会立即出现在这里。"
                            : "连接恢复后，现有 PTY 会话会自动重放，不会因为 App 离线而结束。",
                        actionTitle: model.connectionStatus.isReady ? nil : "重新连接",
                        action: model.connectionStatus.isReady ? nil : { Task { await model.connect() } }
                    )
                } else {
                    ScrollView {
                        LazyVStack(spacing: 12) {
                            ForEach(model.sessions) { session in
                                NavigationLink(value: session) {
                                    SessionRow(session: session)
                                }
                                .buttonStyle(.plain)
                            }
                        }
                        .padding(.horizontal)
                        .padding(.bottom, 24)
                    }
                    .refreshable { await model.refreshSessions() }
                }
            }
            .background(LincoTheme.background)
            .navigationTitle("会话")
            .navigationDestination(for: RemoteSession.self) { session in
                SessionDetailView(session: session)
            }
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button {
                        isNewSessionPresented = true
                    } label: {
                        Label("新会话", systemImage: "plus")
                    }
                    .disabled(!model.connectionStatus.isReady || !model.hasPermission(.terminal))
                    .accessibilityIdentifier("new-session")
                }
                ToolbarItem(placement: .topBarTrailing) {
                    ConnectionPill(status: model.connectionStatus)
                }
            }
            .sheet(isPresented: $isNewSessionPresented) {
                NewSessionSheet()
            }
        }
    }
}

private struct NewSessionSheet: View {
    @EnvironmentObject private var model: AppModel
    @Environment(\.dismiss) private var dismiss
    @State private var kind: SessionKind = .shell
    @State private var workspaceID: String?
    @State private var isStarting = false

    var body: some View {
        NavigationStack {
            Form {
                Section("会话类型") {
                    Picker("类型", selection: $kind) {
                        Label("Shell", systemImage: "terminal").tag(SessionKind.shell)
                        Label("Claude Code", systemImage: "sparkles").tag(SessionKind.claude)
                        Label("Codex", systemImage: "chevron.left.forwardslash.chevron.right").tag(SessionKind.codex)
                    }
                    .pickerStyle(.inline)
                }
                Section("工作区") {
                    if model.workspaces.isEmpty {
                        Text("服务器没有已授权工作区。")
                            .foregroundStyle(LincoTheme.muted)
                    } else {
                        Picker("工作区", selection: $workspaceID) {
                            ForEach(model.workspaces) { Text($0.name).tag(Optional($0.id)) }
                        }
                    }
                }
                Section {
                    Text("Agent 将直接在服务器 PTY 中启动，无需等待 Shell 提示符，也不会创建 SSH 连接。")
                        .font(.footnote)
                        .foregroundStyle(LincoTheme.muted)
                }
            }
            .scrollContentBackground(.hidden)
            .background(LincoTheme.background)
            .navigationTitle("新建会话")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("取消") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button {
                        guard let workspaceID else { return }
                        isStarting = true
                        Task {
                            if await model.startSession(kind: kind, workspaceID: workspaceID) { dismiss() }
                            isStarting = false
                        }
                    } label: {
                        if isStarting { ProgressView() } else { Text("启动").fontWeight(.semibold) }
                    }
                    .disabled(workspaceID == nil || isStarting)
                }
            }
            .task { if workspaceID == nil { workspaceID = model.workspaces.first?.id } }
        }
    }
}

private struct SessionRow: View {
    let session: RemoteSession

    var body: some View {
        HStack(spacing: 14) {
            Image(systemName: session.kind.symbol)
                .font(.system(size: 18, weight: .semibold))
                .foregroundStyle(stateColor)
                .frame(width: 44, height: 44)
                .background(stateColor.opacity(0.10), in: RoundedRectangle(cornerRadius: 14))
            VStack(alignment: .leading, spacing: 5) {
                HStack(spacing: 7) {
                    Text(session.title.isEmpty ? session.kind.displayName : session.title)
                        .font(.headline)
                        .foregroundStyle(.white)
                        .lineLimit(1)
                    Circle().fill(stateColor).frame(width: 6, height: 6)
                }
                HStack(spacing: 6) {
                    Text(session.workspaceName)
                    Text("·")
                    Text(session.state.label)
                }
                .font(.caption)
                .foregroundStyle(LincoTheme.muted)
                .lineLimit(1)
            }
            Spacer()
            Image(systemName: "chevron.right")
                .font(.caption.weight(.bold))
                .foregroundStyle(Color.white.opacity(0.25))
        }
        .lincoCard()
    }

    private var stateColor: Color {
        switch session.state {
        case .ready: LincoTheme.primary
        case .exited, .failed: LincoTheme.danger
        }
    }
}
