import SwiftUI

struct LincoMark: View {
    var size: CGFloat = 42

    var body: some View {
        ZStack {
            RoundedRectangle(cornerRadius: size * 0.28, style: .continuous)
                .fill(
                    LinearGradient(
                        colors: [
                            Color(red: 0.012, green: 0.020, blue: 0.075),
                            Color(red: 0.015, green: 0.035, blue: 0.13)
                        ],
                        startPoint: .topLeading,
                        endPoint: .bottomTrailing
                    )
                )
                .overlay {
                    RadialGradient(
                        colors: [Color.blue.opacity(0.18), .clear],
                        center: .center,
                        startRadius: 0,
                        endRadius: size * 0.62
                    )
                    .clipShape(RoundedRectangle(cornerRadius: size * 0.28, style: .continuous))
                }

            Canvas { context, canvasSize in
                let point: (CGFloat, CGFloat) -> CGPoint = { x, y in
                    CGPoint(x: canvasSize.width * x, y: canvasSize.height * y)
                }
                var path = Path()
                path.move(to: point(0.38, 0.35))
                path.addCurve(
                    to: point(0.29, 0.47),
                    control1: point(0.28, 0.32),
                    control2: point(0.23, 0.42)
                )
                path.addCurve(
                    to: point(0.63, 0.38),
                    control1: point(0.37, 0.57),
                    control2: point(0.55, 0.49)
                )
                path.addCurve(
                    to: point(0.64, 0.17),
                    control1: point(0.73, 0.25),
                    control2: point(0.72, 0.16)
                )
                path.addCurve(
                    to: point(0.43, 0.46),
                    control1: point(0.54, 0.15),
                    control2: point(0.48, 0.29)
                )
                path.addCurve(
                    to: point(0.27, 0.78),
                    control1: point(0.38, 0.61),
                    control2: point(0.34, 0.73)
                )
                path.addCurve(
                    to: point(0.18, 0.74),
                    control1: point(0.20, 0.84),
                    control2: point(0.14, 0.79)
                )
                path.addCurve(
                    to: point(0.43, 0.78),
                    control1: point(0.23, 0.67),
                    control2: point(0.34, 0.73)
                )
                path.addCurve(
                    to: point(0.81, 0.68),
                    control1: point(0.58, 0.87),
                    control2: point(0.79, 0.87)
                )

                context.stroke(
                    path,
                    with: .linearGradient(
                        Gradient(colors: [
                            Color(red: 0.25, green: 0.58, blue: 1.00),
                            Color(red: 0.00, green: 0.34, blue: 1.00),
                            Color(red: 1.00, green: 0.35, blue: 0.20)
                        ]),
                        startPoint: CGPoint(x: canvasSize.width * 0.18, y: canvasSize.height * 0.3),
                        endPoint: CGPoint(x: canvasSize.width * 0.82, y: canvasSize.height * 0.76)
                    ),
                    style: StrokeStyle(
                        lineWidth: size * 0.072,
                        lineCap: .round,
                        lineJoin: .round
                    )
                )
            }
            .padding(size * 0.02)
        }
        .frame(width: size, height: size)
        .shadow(color: Color.blue.opacity(0.16), radius: size * 0.18, y: size * 0.06)
        .accessibilityHidden(true)
    }
}

struct ConnectionPill: View {
    let status: AppConnectionStatus

    private var presentation: (String, Color, String) {
        switch status {
        case .disconnected: ("离线", LincoTheme.muted, "circle")
        case .connecting: ("连接中", LincoTheme.warning, "arrow.triangle.2.circlepath")
        case .authenticating: ("验证设备", LincoTheme.warning, "lock")
        case let .ready(path, latency):
            (latency.map { "\(path) · \($0) ms" } ?? path, LincoTheme.primary, "bolt.fill")
        case let .reconnecting(attempt): ("重连 \(attempt)", LincoTheme.warning, "arrow.clockwise")
        case .failed: ("连接失败", LincoTheme.danger, "exclamationmark.triangle.fill")
        }
    }

    var body: some View {
        let value = presentation
        Label(value.0, systemImage: value.2)
            .font(.caption.weight(.semibold))
            .foregroundStyle(value.1)
            .padding(.horizontal, 10)
            .padding(.vertical, 6)
            .background(value.1.opacity(0.10), in: Capsule())
            .overlay { Capsule().stroke(value.1.opacity(0.22), lineWidth: 1) }
    }
}

struct LincoEmptyState: View {
    let symbol: String
    let title: String
    let message: String
    var actionTitle: String?
    var action: (() -> Void)?

    var body: some View {
        VStack(spacing: 14) {
            ZStack(alignment: .bottomTrailing) {
                LincoMark(size: 58)
                Image(systemName: symbol)
                    .font(.system(size: 11, weight: .bold))
                    .foregroundStyle(.white)
                    .frame(width: 23, height: 23)
                    .background(LincoTheme.elevated, in: Circle())
                    .overlay { Circle().stroke(Color.white.opacity(0.16), lineWidth: 1) }
                    .offset(x: 5, y: 5)
            }
            Text(title)
                .font(.headline)
                .foregroundStyle(.white)
            Text(message)
                .font(.subheadline)
                .foregroundStyle(LincoTheme.muted)
                .multilineTextAlignment(.center)
                .lineSpacing(3)
                .frame(maxWidth: 290)
            if let actionTitle, let action {
                Button(actionTitle, action: action)
                    .buttonStyle(.borderedProminent)
                    .tint(LincoTheme.primary)
                    .foregroundStyle(.black)
            }
        }
        .padding(28)
    }
}

struct ErrorBanner: View {
    let message: String
    let dismiss: () -> Void

    var body: some View {
        HStack(spacing: 12) {
            Image(systemName: "exclamationmark.triangle.fill")
                .foregroundStyle(LincoTheme.warning)
            Text(message)
                .font(.footnote)
                .foregroundStyle(.white)
                .frame(maxWidth: .infinity, alignment: .leading)
            Button(action: dismiss) {
                Image(systemName: "xmark")
            }
            .foregroundStyle(LincoTheme.muted)
        }
        .padding(12)
        .background(LincoTheme.surface, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
        .overlay { RoundedRectangle(cornerRadius: 14).stroke(LincoTheme.warning.opacity(0.25)) }
        .padding(.horizontal)
    }
}
