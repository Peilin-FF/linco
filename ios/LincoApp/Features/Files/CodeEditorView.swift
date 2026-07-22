import SwiftUI
@preconcurrency import Runestone
import UIKit

@MainActor
struct CodeEditorView: UIViewRepresentable {
    @Binding var text: String
    let isEditable: Bool
    let filePath: String

    func makeCoordinator() -> Coordinator {
        Coordinator { text = $0 }
    }

    func makeUIView(context: Context) -> TextView {
        let editor = TextView(frame: .zero)
        editor.editorDelegate = context.coordinator
        editor.backgroundColor = LincoEditorTheme.background
        editor.showLineNumbers = true
        editor.isLineWrappingEnabled = false
        editor.isFindInteractionEnabled = true
        editor.textContainerInset = UIEdgeInsets(top: 14, left: 8, bottom: 28, right: 16)
        editor.lineHeightMultiplier = 1.12
        editor.autocapitalizationType = .none
        editor.autocorrectionType = .no
        editor.smartDashesType = .no
        editor.smartQuotesType = .no
        editor.keyboardAppearance = .dark
        let language = EditorLanguage.resolve(path: filePath)
        editor.setState(makeState(text: text, language: language))
        editor.isEditable = isEditable
        context.coordinator.lastAppliedText = text
        context.coordinator.lastAppliedLanguage = language
        return editor
    }

    func updateUIView(_ editor: TextView, context: Context) {
        editor.isEditable = isEditable
        let language = EditorLanguage.resolve(path: filePath)
        let languageChanged = language != context.coordinator.lastAppliedLanguage
        guard languageChanged || (text != context.coordinator.lastAppliedText && text != editor.text) else { return }
        context.coordinator.lastAppliedText = text
        context.coordinator.lastAppliedLanguage = language
        editor.setState(makeState(text: text, language: language))
    }

    private func makeState(text: String, language: EditorLanguage?) -> TextViewState {
        if let language {
            return TextViewState(
                text: text,
                theme: LincoEditorTheme.shared,
                language: language.treeSitterLanguage
            )
        }
        return TextViewState(text: text, theme: LincoEditorTheme.shared)
    }

    @MainActor
    final class Coordinator: NSObject, @preconcurrency TextViewDelegate {
        var lastAppliedText = ""
        var lastAppliedLanguage: EditorLanguage?
        private let changed: (String) -> Void

        init(changed: @escaping (String) -> Void) { self.changed = changed }

        func textViewDidChange(_ textView: TextView) {
            lastAppliedText = textView.text
            changed(textView.text)
        }
    }
}

final class LincoEditorTheme: Theme, @unchecked Sendable {
    static let shared = LincoEditorTheme()
    static let background = UIColor(red: 0.025, green: 0.032, blue: 0.043, alpha: 1)

    let font = UIFont.monospacedSystemFont(ofSize: 14, weight: .regular)
    let textColor = UIColor(white: 0.88, alpha: 1)
    let gutterBackgroundColor = LincoEditorTheme.background
    let gutterHairlineColor = UIColor.white.withAlphaComponent(0.07)
    let lineNumberColor = UIColor.white.withAlphaComponent(0.30)
    let lineNumberFont = UIFont.monospacedSystemFont(ofSize: 11, weight: .regular)
    let selectedLineBackgroundColor = UIColor.white.withAlphaComponent(0.035)
    let selectedLinesLineNumberColor = UIColor(red: 0.37, green: 0.95, blue: 0.82, alpha: 1)
    let selectedLinesGutterBackgroundColor = LincoEditorTheme.background
    let invisibleCharactersColor = UIColor.white.withAlphaComponent(0.18)
    let pageGuideHairlineColor = UIColor.white.withAlphaComponent(0.08)
    let pageGuideBackgroundColor = UIColor.white.withAlphaComponent(0.02)
    let markedTextBackgroundColor = UIColor(red: 0.37, green: 0.95, blue: 0.82, alpha: 0.16)

    func textColor(for highlightName: String) -> UIColor? {
        switch EditorHighlightRole.resolve(capture: highlightName) {
        case .comment: return LincoSyntaxColor.comment
        case .string: return LincoSyntaxColor.string
        case .keyword: return LincoSyntaxColor.keyword
        case .literal: return LincoSyntaxColor.literal
        case .function: return LincoSyntaxColor.function
        case .type: return LincoSyntaxColor.type
        case .property: return LincoSyntaxColor.property
        case .tag: return LincoSyntaxColor.tag
        case .attribute: return LincoSyntaxColor.attribute
        case .operatorColor: return LincoSyntaxColor.operatorColor
        case .punctuation: return LincoSyntaxColor.punctuation
        case .markup: return LincoSyntaxColor.markup
        case nil: return nil
        }
    }
}

enum EditorHighlightRole: Sendable, Equatable {
    case comment
    case string
    case keyword
    case literal
    case function
    case type
    case property
    case tag
    case attribute
    case operatorColor
    case punctuation
    case markup

    static func resolve(capture: String) -> EditorHighlightRole? {
        let normalized = capture.lowercased()
        let root = normalized.split(separator: ".").first.map(String.init) ?? normalized

        if normalized.contains("builtin") {
            switch root {
            case "function": return .function
            case "type": return .type
            case "variable", "constant": return .literal
            default: break
            }
        }

        switch root {
        case "comment": return .comment
        case "string", "character", "escape": return .string
        case "keyword", "conditional", "repeat", "exception", "include", "label": return .keyword
        case "number", "float", "boolean", "constant": return .literal
        case "function", "method": return .function
        case "constructor", "type", "namespace", "module": return .type
        case "property", "field", "variable", "parameter": return .property
        case "tag": return .tag
        case "attribute": return .attribute
        case "operator": return .operatorColor
        case "punctuation": return .punctuation
        case "text", "markup": return .markup
        default: return nil
        }
    }
}

private enum LincoSyntaxColor {
    static let comment = UIColor(red: 0.45, green: 0.59, blue: 0.56, alpha: 1)
    static let string = UIColor(red: 0.58, green: 0.86, blue: 0.74, alpha: 1)
    static let keyword = UIColor(red: 0.79, green: 0.61, blue: 0.96, alpha: 1)
    static let literal = UIColor(red: 0.94, green: 0.70, blue: 0.46, alpha: 1)
    static let function = UIColor(red: 0.45, green: 0.77, blue: 1.00, alpha: 1)
    static let type = UIColor(red: 0.45, green: 0.84, blue: 0.82, alpha: 1)
    static let property = UIColor(red: 0.84, green: 0.88, blue: 0.94, alpha: 1)
    static let tag = UIColor(red: 1.00, green: 0.53, blue: 0.61, alpha: 1)
    static let attribute = UIColor(red: 0.96, green: 0.76, blue: 0.49, alpha: 1)
    static let operatorColor = UIColor(red: 0.84, green: 0.66, blue: 1.00, alpha: 1)
    static let punctuation = UIColor(red: 0.66, green: 0.71, blue: 0.78, alpha: 1)
    static let markup = UIColor(red: 0.49, green: 0.78, blue: 0.95, alpha: 1)
}
