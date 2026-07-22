import XCTest
@testable import Linco

final class FileEditorExitDecisionTests: XCTestCase {
    func testCleanEditorDismissesImmediately() {
        XCTAssertEqual(
            FileEditorExitDecision.resolve(currentText: "saved", savedText: "saved"),
            .dismiss
        )
    }

    func testDirtyEditorRequiresDiscardConfirmation() {
        XCTAssertEqual(
            FileEditorExitDecision.resolve(currentText: "changed", savedText: "saved"),
            .confirmDiscard
        )
    }
}
