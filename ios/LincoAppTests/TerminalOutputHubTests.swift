import Foundation
import XCTest
@testable import Linco

@MainActor
final class TerminalOutputHubTests: XCTestCase {
    func testSnapshotResetReachesActiveSubscriberSynchronously() {
        let hub = TerminalOutputHub()
        var received: [TerminalOutputUpdate] = []
        let subscription = hub.subscribe(to: 7) { received.append($0) }

        XCTAssertTrue(hub.deliver(Data("old".utf8), for: 7, reset: false))
        XCTAssertTrue(hub.deliver(Data("snapshot".utf8), for: 7, reset: true))

        XCTAssertEqual(received, [
            TerminalOutputUpdate(data: Data("old".utf8), reset: false),
            TerminalOutputUpdate(data: Data("snapshot".utf8), reset: true)
        ])
        hub.unsubscribe(subscription)
    }

    func testDeliveryAcknowledgesConsumerBeforeProducerContinues() {
        let hub = TerminalOutputHub()
        var order: [String] = []
        let subscription = hub.subscribe(to: 9) { _ in
            order.append("consumer")
        }

        order.append("producer-before")
        XCTAssertTrue(hub.deliver(Data([0x41]), for: 9, reset: false))
        order.append("producer-after")

        XCTAssertEqual(order, ["producer-before", "consumer", "producer-after"])
        XCTAssertEqual(hub.subscriberCount(for: 9), 1)
        hub.unsubscribe(subscription)
    }

    func testInactiveStreamHasNoBufferAndReportsUndeliveredBytes() {
        let hub = TerminalOutputHub()

        XCTAssertFalse(hub.deliver(Data(repeating: 0x41, count: 256 * 1_024), for: 11, reset: false))
        XCTAssertEqual(hub.subscriberCount(for: 11), 0)
    }

    func testUnsubscribeStopsDelivery() {
        let hub = TerminalOutputHub()
        let subscription = hub.subscribe(to: 13) { _ in
            XCTFail("Unsubscribed consumers must never receive output")
        }
        hub.unsubscribe(subscription)

        XCTAssertFalse(hub.deliver(Data([0x41]), for: 13, reset: false))
    }
}
