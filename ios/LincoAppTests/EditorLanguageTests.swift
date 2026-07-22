import XCTest
@testable import Linco

final class EditorLanguageTests: XCTestCase {
    func testRequiredLanguageExtensionsResolveToRealParsers() {
        let cases: [(String, EditorLanguage)] = [
            ("src/main.rs", .rust),
            ("Sources/App.swift", .swift),
            ("tools/release.py", .python),
            ("web/app.js", .javaScript),
            ("web/component.tsx", .tsx),
            ("web/api.ts", .typeScript),
            ("config/settings.json", .json),
            ("scripts/deploy.sh", .bash),
            ("public/index.html", .html),
            ("public/app.css", .css),
            ("README.md", .markdown),
            ("Cargo.toml", .toml),
            (".github/workflows/release.yml", .yaml)
        ]

        for (path, expected) in cases {
            XCTAssertEqual(EditorLanguage.resolve(path: path), expected, path)
        }
    }

    func testShellDotfilesResolveWithoutExtensions() {
        XCTAssertEqual(EditorLanguage.resolve(path: "/home/user/.bashrc"), .bash)
        XCTAssertEqual(EditorLanguage.resolve(path: "/home/user/.zshrc"), .bash)
    }

    func testUnknownFilesRemainPlainText() {
        XCTAssertNil(EditorLanguage.resolve(path: "Assets/logo.bin"))
        XCTAssertNil(EditorLanguage.resolve(path: "LICENSE"))
    }

    func testCommonTreeSitterCapturesHavePaletteRoles() {
        let expected: [String: EditorHighlightRole] = [
            "comment.documentation": .comment,
            "string.special": .string,
            "keyword.function": .keyword,
            "constant.builtin": .literal,
            "function.method": .function,
            "type.builtin": .type,
            "property": .property,
            "tag": .tag,
            "attribute": .attribute,
            "operator": .operatorColor,
            "punctuation.bracket": .punctuation,
            "markup.heading": .markup
        ]

        for (capture, role) in expected {
            XCTAssertEqual(EditorHighlightRole.resolve(capture: capture), role, capture)
        }
        XCTAssertNil(EditorHighlightRole.resolve(capture: "unrecognized.capture"))
    }
}
