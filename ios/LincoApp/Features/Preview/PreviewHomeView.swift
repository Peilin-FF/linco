import SwiftUI

struct PreviewHomeView: View {
    @EnvironmentObject private var model: AppModel
    @State private var workspaceID: String?
    @State private var path = ""

    var body: some View {
        NavigationStack {
            Group {
                if let capability = model.previewCapability {
                    IsolatedPreviewWebView(capability: capability)
                } else {
                    VStack(spacing: 18) {
                        LincoEmptyState(
                            symbol: "safari",
                            title: "打开服务器预览",
                            message: "输入已授权工作区内的 HTML 文件或目录。服务器会签发 5 分钟内有效的一次性引导凭证。"
                        )
                        if !model.workspaces.isEmpty {
                            VStack(spacing: 12) {
                                Picker("工作区", selection: $workspaceID) {
                                    ForEach(model.workspaces) { Text($0.name).tag(Optional($0.id)) }
                                }
                                .pickerStyle(.menu)
                                TextField("例如 dist/index.html", text: $path)
                                    .textInputAutocapitalization(.never)
                                    .autocorrectionDisabled()
                                    .font(.system(.body, design: .monospaced))
                                    .padding(13)
                                    .background(LincoTheme.elevated, in: RoundedRectangle(cornerRadius: 14))
                                Button("安全打开") {
                                    guard let workspaceID else { return }
                                    Task { await model.resolvePreview(workspaceID: workspaceID, path: path) }
                                }
                                .buttonStyle(.borderedProminent)
                                .tint(LincoTheme.primary)
                                .foregroundStyle(.black)
                                .disabled(workspaceID == nil || path.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                            }
                            .padding(.horizontal, 24)
                        }
                    }
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .background(LincoTheme.background)
            .navigationTitle("预览")
            .toolbar {
                if model.previewCapability != nil {
                    ToolbarItem(placement: .topBarTrailing) {
                        Button("关闭") { model.previewCapability = nil }
                    }
                }
            }
            .task { if workspaceID == nil { workspaceID = model.workspaces.first?.id } }
        }
    }
}
