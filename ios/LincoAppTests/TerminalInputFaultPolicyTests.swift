import XCTest
@testable import Linco

final class TerminalInputFaultPolicyTests: XCTestCase {
    func testInputCannotCreateOwnershipAfterExplicitDisconnect() {
        XCTAssertEqual(
            TerminalInputAdmissionPolicy.disposition(
                expectedGeneration: nil,
                requestedGeneration: 4
            ),
            .notResumed
        )
        XCTAssertEqual(
            TerminalInputAdmissionPolicy.disposition(
                expectedGeneration: 5,
                requestedGeneration: 4
            ),
            .superseded
        )
        XCTAssertEqual(
            TerminalInputAdmissionPolicy.disposition(
                expectedGeneration: 4,
                requestedGeneration: 4
            ),
            .ready
        )
    }

    func testOverloadedPreservesPendingAndRecoversOnANewLane() {
        XCTAssertEqual(
            TerminalInputFaultPolicy.disposition(code: "overloaded", discardPending: false),
            .retryAfterReconnect
        )
    }

    func testDefinitiveAndAmbiguousFaultsCannotBeConfused() {
        XCTAssertEqual(
            TerminalInputFaultPolicy.disposition(code: "session_exited", discardPending: true),
            .discardStream
        )
        XCTAssertEqual(
            TerminalInputFaultPolicy.disposition(code: "ambiguous", discardPending: false),
            .quarantine
        )
        XCTAssertEqual(
            TerminalInputFaultPolicy.disposition(code: "ambiguous", discardPending: true),
            .invalid
        )
    }
}
