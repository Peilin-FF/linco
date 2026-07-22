import Foundation
import XCTest
@testable import Linco

final class TerminalReplayPolicyTests: XCTestCase {
    func testBackgroundRaceAlwaysForcesOffsetZeroReplay() {
        var terminals: [UInt32: ActiveTerminal] = [
            7: ActiveTerminal(
                sessionID: UUID(),
                generation: 3,
                ownerID: UUID(),
                requiresFullReplay: false
            )
        ]

        TerminalReplayPolicy.prepareForBackground(&terminals)

        // Even if a frame arrives before the queued detach and advances the
        // transport receive cursor, foreground reattachment must ignore that
        // cursor because SwiftTerm did not render the frame while backgrounded.
        XCTAssertTrue(terminals[7]?.requiresFullReplay == true)
        XCTAssertEqual(
            TerminalReplayPolicy.resumeOffset(
                requiresFullReplay: terminals[7]?.requiresFullReplay == true
            ),
            UInt64(0)
        )
    }

    func testContinuouslyRenderedTerminalCanResumeFromLedgerCursor() {
        XCTAssertNil(TerminalReplayPolicy.resumeOffset(requiresFullReplay: false))
    }

    func testTransportReplacementCannotResumePastTagRejectedOutput() {
        var terminals: [UInt32: ActiveTerminal] = [
            4: ActiveTerminal(
                sessionID: UUID(),
                generation: 2,
                ownerID: UUID(),
                requiresFullReplay: false
            )
        ]

        TerminalReplayPolicy.prepareForTransportReplacement(&terminals)

        XCTAssertEqual(
            TerminalReplayPolicy.resumeOffset(
                requiresFullReplay: terminals[4]?.requiresFullReplay == true
            ),
            UInt64(0)
        )
    }

    func testUnsubscribedOutputMarksReplayWithoutStealingDetachOwnership() {
        let terminal = ActiveTerminal(
            sessionID: UUID(),
            generation: 4,
            ownerID: UUID(),
            requiresFullReplay: false
        )
        var terminals: [UInt32: ActiveTerminal] = [18: terminal]

        TerminalReplayPolicy.recordUnrenderedOutput(streamID: 18, terminals: &terminals)

        XCTAssertEqual(terminals[18]?.ownerID, terminal.ownerID)
        XCTAssertTrue(terminals[18]?.requiresFullReplay == true)
    }

    func testForegroundTransitionInvalidatesBlockedBackgroundDrain() {
        let background = UUID()

        XCTAssertTrue(SceneLifecyclePolicy.shouldFinishBackgroundDrain(
            capturedGeneration: background,
            currentGeneration: background,
            isSceneActive: false
        ))
        XCTAssertFalse(SceneLifecyclePolicy.shouldFinishBackgroundDrain(
            capturedGeneration: background,
            currentGeneration: UUID(),
            isSceneActive: true
        ))
    }

    func testPairingCannotStartWhileForgetCleanupIsInFlight() {
        XCTAssertFalse(PairingLifecyclePolicy.canBeginPair(
            isForgettingServer: true,
            isPairingInProgress: false
        ))
        XCTAssertFalse(PairingLifecyclePolicy.canBeginPair(
            isForgettingServer: false,
            isPairingInProgress: true
        ))
        XCTAssertFalse(PairingLifecyclePolicy.canBeginForget(isForgettingServer: true))
        XCTAssertTrue(PairingLifecyclePolicy.canBeginPair(
            isForgettingServer: false,
            isPairingInProgress: false
        ))
    }

    func testOldSurfaceCannotTargetNewServerEvenWhenWireIDsCollide() {
        let oldOwner = UUID()
        let newOwner = UUID()
        let reusedSession = UUID()
        let replacement = ActiveTerminal(
            sessionID: reusedSession,
            generation: 5,
            ownerID: newOwner,
            requiresFullReplay: false
        )

        XCTAssertFalse(TerminalOperationOwnershipPolicy.accepts(
            active: replacement,
            sessionID: reusedSession,
            generation: 5,
            ownerID: oldOwner
        ))
        XCTAssertTrue(TerminalOperationOwnershipPolicy.accepts(
            active: replacement,
            sessionID: reusedSession,
            generation: 5,
            ownerID: newOwner
        ))
    }

    func testSupersededSessionSnapshotCannotReconcileTerminalOwnership() {
        XCTAssertFalse(SessionRefreshPolicy.shouldApply(
            responseVersion: 8,
            latestRequestedVersion: 9
        ))
        XCTAssertTrue(SessionRefreshPolicy.shouldApply(
            responseVersion: 9,
            latestRequestedVersion: 9
        ))
    }
}
