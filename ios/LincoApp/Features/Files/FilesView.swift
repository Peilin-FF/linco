import SwiftUI

struct FilesView: View {
    @EnvironmentObject private var model: AppModel
    @State private var workspaceID: String?
    @State private var path = ""

    var body: some View {
        NavigationStack {
            Group {
                if model.workspaces.isEmpty {
                    LincoEmptyState(
                        symbol: model.connectionStatus.isReady ? "folder.badge.questionmark" : "wifi.slash",
                        title: model.connectionStatus.isReady ? "没有可用工作区" : "服务器未连接",
                        message: model.connectionStatus.isReady
                            ? "请先在 Linco Server 中授权一个工作区。App 只会访问已授权目录。"
                            : "文件列表会在安全连接恢复后加载。",
                        actionTitle: model.connectionStatus.isReady ? "刷新" : "重新连接",
                        action: {
                            Task {
                                if model.connectionStatus.isReady { await model.refreshWorkspaces() }
                                else { await model.connect() }
                            }
                        }
                    )
                } else if model.isLoadingFiles {
                    ProgressView("正在读取文件…")
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                } else if model.files.isEmpty {
                    LincoEmptyState(
                        symbol: "folder",
                        title: path.isEmpty ? "工作区为空" : "此文件夹为空",
                        message: "没有从服务器返回任何文件。",
                        actionTitle: "刷新",
                        action: { loadFiles() }
                    )
                } else {
                    List {
                        ForEach(model.files) { file in
                            if file.isDirectory {
                                Button {
                                    path = file.path
                                    loadFiles()
                                } label: {
                                    FileRow(file: file)
                                }
                                .buttonStyle(.plain)
                                .listRowBackground(LincoTheme.elevated)
                            } else if let workspaceID {
                                NavigationLink {
                                    FileEditorScreen(workspaceID: workspaceID, file: file)
                                } label: {
                                    FileRow(file: file)
                                }
                                .listRowBackground(LincoTheme.elevated)
                            }
                        }
                        if model.hasMoreFiles {
                            HStack {
                                Spacer()
                                ProgressView(model.isLoadingMoreFiles ? "正在加载更多…" : "继续加载")
                                Spacer()
                            }
                            .listRowBackground(LincoTheme.elevated)
                            .onAppear { loadNextPage() }
                        }
                    }
                    .scrollContentBackground(.hidden)
                    .refreshable {
                        guard let workspaceID else { return }
                        await model.refreshFiles(workspaceID: workspaceID, path: path)
                    }
                }
            }
            .background(LincoTheme.background)
            .navigationTitle("文件")
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    if !path.isEmpty {
                        Button {
                            path = (path as NSString).deletingLastPathComponent
                            loadFiles()
                        } label: {
                            Label("上一级", systemImage: "chevron.left")
                        }
                    }
                }
                ToolbarItem(placement: .topBarTrailing) {
                    Menu {
                        ForEach(model.workspaces) { workspace in
                            Button {
                                workspaceID = workspace.id
                                path = ""
                                loadFiles()
                            } label: {
                                if workspace.id == workspaceID {
                                    Label(workspace.name, systemImage: "checkmark")
                                } else {
                                    Text(workspace.name)
                                }
                            }
                        }
                    } label: {
                        Label(selectedWorkspace?.name ?? "工作区", systemImage: "externaldrive.fill")
                    }
                }
            }
            .task {
                if workspaceID == nil { workspaceID = model.workspaces.first?.id }
                loadFiles()
            }
            .onChange(of: model.workspaces) { _, workspaces in
                if workspaceID == nil { workspaceID = workspaces.first?.id; loadFiles() }
            }
        }
    }

    private var selectedWorkspace: RemoteWorkspace? {
        model.workspaces.first { $0.id == workspaceID }
    }

    private func loadFiles() {
        guard let workspaceID else { return }
        Task { await model.refreshFiles(workspaceID: workspaceID, path: path) }
    }

    private func loadNextPage() {
        guard let workspaceID else { return }
        Task { await model.loadNextFilesPage(workspaceID: workspaceID, path: path) }
    }
}

private struct FileRow: View {
    let file: RemoteFile

    var body: some View {
        HStack(spacing: 12) {
            Image(systemName: file.isDirectory ? "folder.fill" : symbol)
                .foregroundStyle(file.isDirectory ? LincoTheme.secondary : LincoTheme.primary)
                .frame(width: 28)
            VStack(alignment: .leading, spacing: 3) {
                Text(file.name).font(.subheadline.weight(.medium)).foregroundStyle(.white).lineLimit(1)
                if let size = file.size, !file.isDirectory {
                    Text(ByteCountFormatter.string(fromByteCount: Int64(clamping: size), countStyle: .file))
                        .font(.caption2)
                        .foregroundStyle(LincoTheme.muted)
                }
            }
        }
        .padding(.vertical, 5)
    }

    private var symbol: String {
        switch (file.name as NSString).pathExtension.lowercased() {
        case "swift": "swift"
        case "js", "ts", "tsx", "jsx": "curlybraces"
        case "md": "doc.richtext"
        case "json", "toml", "yaml", "yml": "slider.horizontal.3"
        default: "doc.text"
        }
    }
}
