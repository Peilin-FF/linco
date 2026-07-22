import XCTest
@testable import Linco

final class TerminalResumeHandshakeTests: XCTestCase {
    func testReadinessRequiresMatchingOpenedAndResultBaselines() {
        var handshake = TerminalResumeHandshake(
            streamID: 7,
            generation: 3,
            openedBaseline: nil
        )
        let baseline = TerminalResumeBaseline(
            streamID: 7,
            generation: 3,
            startingOffset: 4_096,
            inputThrough: 98_304
        )

        XCTAssertFalse(handshake.acceptsResult(baseline))
        XCTAssertTrue(handshake.registerOpened(baseline))
        XCTAssertTrue(handshake.acceptsResult(baseline))
    }

    func testStaleGenerationCannotSatisfyANewerResume() {
        var handshake = TerminalResumeHandshake(
            streamID: 7,
            generation: 4,
            openedBaseline: nil
        )
        let stale = TerminalResumeBaseline(
            streamID: 7,
            generation: 3,
            startingOffset: 0,
            inputThrough: 10
        )

        XCTAssertFalse(handshake.registerOpened(stale))
        XCTAssertFalse(handshake.acceptsResult(stale))
    }

    func testResultMustMatchTheExactOpenedInputCursor() {
        var handshake = TerminalResumeHandshake(
            streamID: 9,
            generation: 2,
            openedBaseline: nil
        )
        let opened = TerminalResumeBaseline(
            streamID: 9,
            generation: 2,
            startingOffset: 500,
            inputThrough: 700
        )
        let mismatchedResult = TerminalResumeBaseline(
            streamID: 9,
            generation: 2,
            startingOffset: 500,
            inputThrough: 701
        )

        XCTAssertTrue(handshake.registerOpened(opened))
        XCTAssertFalse(handshake.acceptsResult(mismatchedResult))
    }
}
