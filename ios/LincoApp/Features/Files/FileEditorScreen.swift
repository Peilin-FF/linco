import SwiftUI

struct FileEditorScreen: View {
    @EnvironmentObject private var model: AppModel
    @Environment(\.dismiss) private var dismiss
    let workspaceID: String
    let file: RemoteFile

    @State private var text = ""
    @State private var revision: String?
    @State private var loadedText = ""
    @State private var isLoading = true
    @State private var isSaving = false
    @State private var loadError: String?
    @State private var saveConflict = false
    @State private var confirmDiscard = false

    private var isDirty: Bool {
        FileEditorExitDecision.resolve(currentText: text, savedText: loadedText) == .confirmDiscard
    }

    var body: some View {
        Group {
            if isLoading {
                ProgressView("正在读取文件…")
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                    .background(LincoTheme.background)
            } else if let loadError {
                LincoEmptyState(
                    symbol: "doc.badge.exclamationmark",
                    title: "无法打开文件",
                    message: loadError,
                    actionTitle: "重试",
                    action: { Task { await load() } }
                )
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .background(LincoTheme.background)
            } else {
                CodeEditorView(
                    text: $text,
                    isEditable: !isSaving && model.hasPermission(.write),
                    filePath: file.path
                )
                    .background(LincoTheme.background)
            }
        }
        .navigationTitle(file.name)
        .navigationBarTitleDisplayMode(.inline)
        .navigationBarBackButtonHidden(isDirty)
        .toolbar {
            if isDirty {
                ToolbarItem(placement: .topBarLeading) {
                    Button {
                        confirmDiscard = true
                    } label: {
                        Label("返回", systemImage: "chevron.left")
                    }
                }
            }
            ToolbarItem(placement: .topBarTrailing) {
                Button {
                    Task { await save() }
                } label: {
                    if isSaving { ProgressView() }
                    else { Text("保存").fontWeight(.semibold) }
                }
                .disabled(isLoading || isSaving || text == loadedText || !model.hasPermission(.write))
                .accessibilityIdentifier("save-file")
            }
        }
        .task { await load() }
        .confirmationDialog("放弃未保存的修改？", isPresented: $confirmDiscard, titleVisibility: .visible) {
            Button("放弃修改", role: .destructive) { dismiss() }
            Button("继续编辑", role: .cancel) {}
        } message: {
            Text("当前文件的本地修改尚未保存。")
        }
        .alert("文件已在服务器上更新", isPresented: $saveConflict) {
            Button("重新加载", role: .destructive) { Task { await load() } }
            Button("保留本地内容", role: .cancel) {}
        } message: {
            Text("Linco 没有覆盖远端版本。重新加载会丢弃当前未保存内容。")
        }
    }

    private func load() async {
        isLoading = true
        loadError = nil
        do {
            let content = try await model.readFile(workspaceID: workspaceID, path: file.path)
            text = content.text
            loadedText = content.text
            revision = content.revision
        } catch {
            loadError = error.localizedDescription
        }
        isLoading = false
    }

    private func save() async {
        isSaving = true
        defer { isSaving = false }
        do {
            revision = try await model.writeFile(workspaceID: workspaceID, path: file.path, text: text, revision: revision)
            loadedText = text
        } catch HTTPTransferError.editConflict {
            saveConflict = true
        } catch {
            model.presentedError = "保存失败：\(error.localizedDescription)"
        }
    }
}

enum FileEditorExitDecision: Sendable, Equatable {
    case dismiss
    case confirmDiscard

    static func resolve(currentText: String, savedText: String) -> FileEditorExitDecision {
        currentText == savedText ? .dismiss : .confirmDiscard
    }
}
