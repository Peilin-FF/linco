import SwiftUI
import VisionKit

struct OnboardingView: View {
    @EnvironmentObject private var model: AppModel
    @State private var isScannerPresented = false
    @State private var isManualEntryPresented = false

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 30) {
                HStack {
                    LincoMark(size: 48)
                    Spacer()
                    Text("设备级安全")
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(LincoTheme.primary)
                        .padding(.horizontal, 11)
                        .padding(.vertical, 7)
                        .background(LincoTheme.primary.opacity(0.09), in: Capsule())
                }

                VStack(alignment: .leading, spacing: 12) {
                    Text("你的服务器，\n现在就在手边。")
                        .font(.system(size: 40, weight: .bold, design: .rounded))
                        .tracking(-1.1)
                        .foregroundStyle(.white)
                    Text("Linco 直接连接你自己的远程服务器。终端、Agent、文件和实时预览，全部在原生 iPhone 体验中完成。")
                        .font(.body)
                        .foregroundStyle(LincoTheme.muted)
                        .lineSpacing(5)
                }

                VStack(spacing: 0) {
                    SecurityPoint(symbol: "lock.shield.fill", title: "设备身份", detail: "私钥只存在于 iPhone 安全隔区")
                    Divider().overlay(LincoTheme.border).padding(.leading, 54)
                    SecurityPoint(symbol: "bolt.horizontal.fill", title: "低延迟直连", detail: "控制与终端采用独立 WSS 通道")
                    Divider().overlay(LincoTheme.border).padding(.leading, 54)
                    SecurityPoint(symbol: "server.rack", title: "无需 SSH", detail: "Linco Server 驻留在你的 Linux 主机")
                }
                .lincoCard()

                pairingAction

                Button("无法使用相机？粘贴配对内容") {
                    isManualEntryPresented = true
                }
                .disabled(model.isPairingInProgress)
                .font(.footnote.weight(.medium))
                .foregroundStyle(LincoTheme.muted)
                .frame(maxWidth: .infinity)
            }
            .padding(.horizontal, 22)
            .padding(.top, 24)
            .padding(.bottom, 38)
        }
        .background(LincoTheme.background)
        .fullScreenCover(isPresented: $isScannerPresented) {
            PairingScannerScreen { code in
                isScannerPresented = false
                Task { await model.pair(qrCode: code) }
            }
        }
        .sheet(isPresented: $isManualEntryPresented) {
            ManualPairingSheet { code in
                isManualEntryPresented = false
                Task { await model.pair(qrCode: code) }
            }
            .presentationDetents([.medium, .large])
        }
    }

    @ViewBuilder
    private var pairingAction: some View {
        switch model.pairingState {
        case .idle:
            Button {
                isScannerPresented = true
            } label: {
                Label("扫描服务器二维码", systemImage: "qrcode.viewfinder")
                    .font(.headline)
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 15)
            }
            .buttonStyle(.borderedProminent)
            .tint(LincoTheme.primary)
            .foregroundStyle(.black)
            .clipShape(RoundedRectangle(cornerRadius: 16, style: .continuous))
            .accessibilityIdentifier("pair-server")

        case .validating, .pairing:
            HStack(spacing: 12) {
                ProgressView().tint(LincoTheme.primary)
                Text(model.pairingState == .validating ? "正在验证二维码…" : "正在建立安全设备身份…")
                    .font(.subheadline.weight(.semibold))
            }
            .frame(maxWidth: .infinity)
            .padding(.vertical, 16)
            .background(LincoTheme.surface, in: RoundedRectangle(cornerRadius: 16))

        case let .failed(message):
            VStack(alignment: .leading, spacing: 12) {
                Label("配对未完成", systemImage: "exclamationmark.shield.fill")
                    .font(.headline)
                    .foregroundStyle(LincoTheme.warning)
                Text(message)
                    .font(.footnote)
                    .foregroundStyle(LincoTheme.muted)
                Button("重新扫描") { isScannerPresented = true }
                    .buttonStyle(.borderedProminent)
                    .tint(LincoTheme.primary)
                    .foregroundStyle(.black)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .lincoCard()
        }
    }
}

private struct SecurityPoint: View {
    let symbol: String
    let title: String
    let detail: String

    var body: some View {
        HStack(spacing: 14) {
            Image(systemName: symbol)
                .font(.system(size: 17, weight: .semibold))
                .foregroundStyle(LincoTheme.primary)
                .frame(width: 38, height: 38)
                .background(LincoTheme.primary.opacity(0.09), in: RoundedRectangle(cornerRadius: 12))
            VStack(alignment: .leading, spacing: 3) {
                Text(title).font(.subheadline.weight(.semibold)).foregroundStyle(.white)
                Text(detail).font(.caption).foregroundStyle(LincoTheme.muted)
            }
            Spacer()
        }
        .padding(.vertical, 10)
    }
}

private struct ManualPairingSheet: View {
    @Environment(\.dismiss) private var dismiss
    @State private var code = ""
    let submit: (String) -> Void

    var body: some View {
        NavigationStack {
            VStack(alignment: .leading, spacing: 14) {
                Text("粘贴服务器终端输出的完整 JSON 配对内容。配对密钥只会在内存中短暂使用。")
                    .font(.footnote)
                    .foregroundStyle(LincoTheme.muted)
                TextEditor(text: $code)
                    .font(.system(.footnote, design: .monospaced))
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .scrollContentBackground(.hidden)
                    .padding(10)
                    .background(LincoTheme.elevated, in: RoundedRectangle(cornerRadius: 14))
                    .overlay { RoundedRectangle(cornerRadius: 14).stroke(LincoTheme.border) }
            }
            .padding()
            .background(LincoTheme.background.ignoresSafeArea())
            .navigationTitle("手动配对")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("取消") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button("继续") { submit(code.trimmingCharacters(in: .whitespacesAndNewlines)) }
                        .disabled(code.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                }
            }
        }
    }
}
