import SwiftUI

enum LincoTheme {
    static let background = Color(red: 0.025, green: 0.032, blue: 0.043)
    static let elevated = Color(red: 0.055, green: 0.067, blue: 0.086)
    static let surface = Color(red: 0.078, green: 0.091, blue: 0.113)
    static let border = Color.white.opacity(0.09)
    static let primary = Color(red: 0.37, green: 0.95, blue: 0.82)
    static let secondary = Color(red: 0.43, green: 0.64, blue: 1.0)
    static let warning = Color(red: 1.0, green: 0.72, blue: 0.30)
    static let danger = Color(red: 1.0, green: 0.38, blue: 0.43)
    static let muted = Color.white.opacity(0.58)
}

struct LincoCardModifier: ViewModifier {
    func body(content: Content) -> some View {
        content
            .padding(16)
            .background(LincoTheme.elevated, in: RoundedRectangle(cornerRadius: 20, style: .continuous))
            .overlay {
                RoundedRectangle(cornerRadius: 20, style: .continuous)
                    .stroke(LincoTheme.border, lineWidth: 1)
            }
    }
}

extension View {
    func lincoCard() -> some View { modifier(LincoCardModifier()) }
}
