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

        let acceptedBeforeOpen = handshake.acceptsResult(baseline)
        let registered = handshake.registerOpened(baseline)
        let acceptedAfterOpen = handshake.acceptsResult(baseline)

        XCTAssertFalse(acceptedBeforeOpen)
        XCTAssertTrue(registered)
        XCTAssertTrue(acceptedAfterOpen)
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

        let registered = handshake.registerOpened(stale)
        let accepted = handshake.acceptsResult(stale)

        XCTAssertFalse(registered)
        XCTAssertFalse(accepted)
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

        let registered = handshake.registerOpened(opened)
        let accepted = handshake.acceptsResult(mismatchedResult)

        XCTAssertTrue(registered)
        XCTAssertFalse(accepted)
    }
}
