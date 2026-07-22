import XCTest
@testable import Linco

final class TerminalRendererPolicyTests: XCTestCase {
    func testMetalStartsOnlyAfterWindowAttachmentAndOnlyOnce() {
        XCTAssertFalse(
            TerminalRendererPolicy.shouldAttemptMetal(
                isAttachedToWindow: false,
                hasAttempted: false
            )
        )
        XCTAssertTrue(
            TerminalRendererPolicy.shouldAttemptMetal(
                isAttachedToWindow: true,
                hasAttempted: false
            )
        )
        XCTAssertFalse(
            TerminalRendererPolicy.shouldAttemptMetal(
                isAttachedToWindow: true,
                hasAttempted: true
            )
        )
    }
}
