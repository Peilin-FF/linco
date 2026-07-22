import XCTest
@testable import Linco

final class SessionStartAttemptStoreTests: XCTestCase {
    func testDefinitiveFailureCreatesFreshIdentifiersOnNextTap() {
        var store = SessionStartAttemptStore()
        let first = store.request(workspaceID: "workspace", kind: .codex)

        store.markFailed(first, definitive: true)
        let retry = store.request(workspaceID: "workspace", kind: .codex)

        XCTAssertNotEqual(retry.sessionID, first.sessionID)
        XCTAssertNotEqual(retry.idempotencyKey, first.idempotencyKey)
        XCTAssertTrue(RemoteServiceError.server(code: "bad_request", message: "invalid").isDefinitiveRPCFailure)
    }

    func testTransportAmbiguityRetainsIdentifiersForSafeReconciliation() {
        var store = SessionStartAttemptStore()
        let first = store.request(workspaceID: "workspace", kind: .codex)

        store.markFailed(first, definitive: false)
        let retry = store.request(workspaceID: "workspace", kind: .codex)

        XCTAssertEqual(retry, first)
        XCTAssertFalse(RemoteServiceError.disconnected.isDefinitiveRPCFailure)
        XCTAssertFalse(RemoteServiceError.server(code: "ambiguous", message: "unknown").isDefinitiveRPCFailure)
    }

    func testAmbiguousAttemptsRemainKeyedAcrossOtherSessionStarts() {
        var store = SessionStartAttemptStore()
        let workspaceA = store.request(workspaceID: "workspace-a", kind: .codex)
        store.markFailed(workspaceA, definitive: false)

        let workspaceB = store.request(workspaceID: "workspace-b", kind: .claude)
        store.markFailed(workspaceB, definitive: false)
        let retriedA = store.request(workspaceID: "workspace-a", kind: .codex)

        XCTAssertEqual(retriedA.sessionID, workspaceA.sessionID)
        XCTAssertEqual(retriedA.idempotencyKey, workspaceA.idempotencyKey)
        XCTAssertNotEqual(retriedA.sessionID, workspaceB.sessionID)
    }

    func testDefinitiveFailureClearsOnlyItsOwnContext() {
        var store = SessionStartAttemptStore()
        let workspaceA = store.request(workspaceID: "workspace-a", kind: .shell)
        let workspaceB = store.request(workspaceID: "workspace-b", kind: .shell)

        store.markFailed(workspaceA, definitive: true)

        let newA = store.request(workspaceID: "workspace-a", kind: .shell)
        let retriedB = store.request(workspaceID: "workspace-b", kind: .shell)
        XCTAssertNotEqual(newA.idempotencyKey, workspaceA.idempotencyKey)
        XCTAssertEqual(retriedB, workspaceB)
    }
}
