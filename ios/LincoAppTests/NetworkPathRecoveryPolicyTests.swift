import XCTest
@testable import Linco

final class NetworkPathRecoveryPolicyTests: XCTestCase {
    func testInitialSatisfiedPathDoesNotCauseAReconnect() {
        XCTAssertEqual(
            NetworkPathRecoveryPolicy.decision(
                previous: nil,
                current: .init(isSatisfied: true, interface: .wifi)
            ),
            .none
        )
    }

    func testInterfaceSwitchTriggersAnImmediateProbe() {
        XCTAssertEqual(
            NetworkPathRecoveryPolicy.decision(
                previous: .init(isSatisfied: true, interface: .wifi),
                current: .init(isSatisfied: true, interface: .cellular)
            ),
            .probe
        )
    }

    func testUnsatisfiedPathDisconnectsWithoutWaitingForHeartbeat() {
        XCTAssertEqual(
            NetworkPathRecoveryPolicy.decision(
                previous: .init(isSatisfied: true, interface: .wifi),
                current: .init(isSatisfied: false, interface: nil)
            ),
            .disconnect
        )
    }
}
