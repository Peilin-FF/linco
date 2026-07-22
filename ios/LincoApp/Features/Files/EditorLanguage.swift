@preconcurrency import Runestone
import TreeSitterBashRunestone
import TreeSitterCSSRunestone
import TreeSitterHTMLRunestone
import TreeSitterJavaScriptRunestone
import TreeSitterJSONRunestone
import TreeSitterMarkdownRunestone
import TreeSitterPythonRunestone
import TreeSitterRustRunestone
import TreeSitterSwiftRunestone
import TreeSitterTOMLRunestone
import TreeSitterTSXRunestone
import TreeSitterTypeScriptRunestone
import TreeSitterYAMLRunestone

enum EditorLanguage: String, CaseIterable, Sendable {
    case bash
    case css
    case html
    case javaScript
    case json
    case markdown
    case python
    case rust
    case swift
    case toml
    case tsx
    case typeScript
    case yaml

    static func resolve(path: String) -> EditorLanguage? {
        let normalized = path.replacingOccurrences(of: "\\", with: "/").lowercased()
        let fileName = normalized.split(separator: "/").last.map(String.init) ?? normalized
        let fileExtension = fileName.split(separator: ".").last.map(String.init) ?? ""

        switch fileName {
        case ".bashrc", ".bash_profile", ".zshrc", ".profile":
            return .bash
        default:
            break
        }

        switch fileExtension {
        case "sh", "bash", "zsh": return .bash
        case "css": return .css
        case "html", "htm": return .html
        case "js", "mjs", "cjs", "jsx": return .javaScript
        case "json", "jsonc": return .json
        case "md", "markdown": return .markdown
        case "py", "pyw": return .python
        case "rs": return .rust
        case "swift": return .swift
        case "toml": return .toml
        case "tsx": return .tsx
        case "ts", "mts", "cts": return .typeScript
        case "yaml", "yml": return .yaml
        default: return nil
        }
    }

    var treeSitterLanguage: TreeSitterLanguage {
        switch self {
        case .bash: return .bash
        case .css: return .css
        case .html: return .html
        case .javaScript: return .javaScript
        case .json: return .json
        case .markdown: return .markdown
        case .python: return .python
        case .rust: return .rust
        case .swift: return .swift
        case .toml: return .toml
        case .tsx: return .tsx
        case .typeScript: return .typeScript
        case .yaml: return .yaml
        }
    }
}
