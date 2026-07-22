import XCTest
@testable import Linco

final class ConnectionLivenessPolicyTests: XCTestCase {
    func testHydrationCanOnlyCommitTheStillActiveConnection() {
        let committed = UUID()
        XCTAssertTrue(
            ConnectionLivenessPolicy.isLive(
                committedID: committed,
                activeID: committed,
                statusIsReady: true
            )
        )
        XCTAssertFalse(
            ConnectionLivenessPolicy.isLive(
                committedID: committed,
                activeID: nil,
                statusIsReady: true
            )
        )
        XCTAssertFalse(
            ConnectionLivenessPolicy.isLive(
                committedID: committed,
                activeID: committed,
                statusIsReady: false
            )
        )
    }

    func testDelayedEventsFromAReplacedTransportAreDropped() {
        let old = UUID()
        let current = UUID()

        XCTAssertFalse(
            RemoteEventAcceptancePolicy.shouldAccept(
                eventTransportID: old,
                activeTransportID: current
            )
        )
        XCTAssertTrue(
            RemoteEventAcceptancePolicy.shouldAccept(
                eventTransportID: current,
                activeTransportID: current
            )
        )
        XCTAssertFalse(
            RemoteEventAcceptancePolicy.shouldAccept(
                eventTransportID: old,
                activeTransportID: nil
            )
        )
    }
}
