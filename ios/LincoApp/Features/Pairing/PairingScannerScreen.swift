import SwiftUI
import VisionKit

struct PairingScannerScreen: View {
    @Environment(\.dismiss) private var dismiss
    @State private var scannerError: String?
    let recognized: (String) -> Void

    var body: some View {
        ZStack {
            Color.black.ignoresSafeArea()
            if DataScannerViewController.isSupported && DataScannerViewController.isAvailable {
                QRScannerView(recognized: recognized, error: { scannerError = $0.localizedDescription })
                    .ignoresSafeArea()
                scannerGuide
            } else {
                LincoEmptyState(
                    symbol: "camera.fill",
                    title: "此设备无法使用扫码器",
                    message: "请返回并选择“粘贴配对内容”。"
                )
            }

            VStack {
                HStack {
                    Button { dismiss() } label: {
                        Image(systemName: "xmark")
                            .font(.headline)
                            .frame(width: 42, height: 42)
                            .background(.ultraThinMaterial, in: Circle())
                    }
                    Spacer()
                    Text("扫描 Linco Server")
                        .font(.subheadline.weight(.semibold))
                        .padding(.horizontal, 14)
                        .padding(.vertical, 9)
                        .background(.ultraThinMaterial, in: Capsule())
                    Spacer()
                    Color.clear.frame(width: 42, height: 42)
                }
                .padding()
                Spacer()
            }
        }
        .alert("无法启动相机", isPresented: Binding(
            get: { scannerError != nil },
            set: { if !$0 { scannerError = nil } }
        )) {
            Button("返回") { dismiss() }
        } message: {
            Text(scannerError ?? "未知错误")
        }
    }

    private var scannerGuide: some View {
        VStack(spacing: 22) {
            Spacer()
            RoundedRectangle(cornerRadius: 28, style: .continuous)
                .stroke(LincoTheme.primary, style: StrokeStyle(lineWidth: 3, lineCap: .round, dash: [42, 18]))
                .frame(width: 260, height: 260)
                .shadow(color: LincoTheme.primary.opacity(0.45), radius: 12)
            Text("将服务器上的一次性二维码置于框内")
                .font(.footnote.weight(.medium))
                .foregroundStyle(.white)
                .padding(.horizontal, 16)
                .padding(.vertical, 10)
                .background(.ultraThinMaterial, in: Capsule())
            Spacer()
        }
    }
}
private struct QRScannerView: UIViewControllerRepresentable {
    let recognized: (String) -> Void
    let error: (Error) -> Void

    func makeCoordinator() -> Coordinator { Coordinator(recognized: recognized) }

    func makeUIViewController(context: Context) -> DataScannerViewController {
        let controller = DataScannerViewController(
            recognizedDataTypes: [.barcode(symbologies: [.qr])],
            qualityLevel: .accurate,
            recognizesMultipleItems: false,
            isHighFrameRateTrackingEnabled: true,
            isPinchToZoomEnabled: true,
            isGuidanceEnabled: false,
            isHighlightingEnabled: true
        )
        controller.delegate = context.coordinator
        return controller
    }

    func updateUIViewController(_ controller: DataScannerViewController, context: Context) {
        guard !controller.isScanning else { return }
        do { try controller.startScanning() } catch { self.error(error) }
    }

    static func dismantleUIViewController(_ controller: DataScannerViewController, coordinator: Coordinator) {
        controller.stopScanning()
    }

    final class Coordinator: NSObject, DataScannerViewControllerDelegate {
        private let recognized: (String) -> Void
        private var completed = false

        init(recognized: @escaping (String) -> Void) { self.recognized = recognized }

        func dataScanner(_ dataScanner: DataScannerViewController, didAdd addedItems: [RecognizedItem], allItems: [RecognizedItem]) {
            guard !completed else { return }
            for item in addedItems {
                guard case let .barcode(barcode) = item,
                      let payload = barcode.payloadStringValue else { continue }
                completed = true
                dataScanner.stopScanning()
                recognized(payload)
                return
            }
        }
    }
}
