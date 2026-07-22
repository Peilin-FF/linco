import Foundation
import XCTest
@testable import Linco

final class TerminalOutputHubTests: XCTestCase {
    @MainActor
    func testSnapshotResetReachesActiveSubscriberSynchronously() {
        let hub = TerminalOutputHub()
        var received: [TerminalOutputUpdate] = []
        let subscription = hub.subscribe(to: 7) { received.append($0) }

        let deliveredOld = hub.deliver(Data("old".utf8), for: 7, reset: false)
        let deliveredSnapshot = hub.deliver(Data("snapshot".utf8), for: 7, reset: true)

        XCTAssertTrue(deliveredOld)
        XCTAssertTrue(deliveredSnapshot)

        XCTAssertEqual(received, [
            TerminalOutputUpdate(data: Data("old".utf8), reset: false),
            TerminalOutputUpdate(data: Data("snapshot".utf8), reset: true)
        ])
        hub.unsubscribe(subscription)
    }

    @MainActor
    func testDeliveryAcknowledgesConsumerBeforeProducerContinues() {
        let hub = TerminalOutputHub()
        var order: [String] = []
        let subscription = hub.subscribe(to: 9) { _ in
            order.append("consumer")
        }

        order.append("producer-before")
        let delivered = hub.deliver(Data([0x41]), for: 9, reset: false)
        order.append("producer-after")

        XCTAssertTrue(delivered)
        XCTAssertEqual(order, ["producer-before", "consumer", "producer-after"])
        let subscriberCount = hub.subscriberCount(for: 9)
        XCTAssertEqual(subscriberCount, 1)
        hub.unsubscribe(subscription)
    }

    @MainActor
    func testInactiveStreamHasNoBufferAndReportsUndeliveredBytes() {
        let hub = TerminalOutputHub()

        let delivered = hub.deliver(
            Data(repeating: 0x41, count: 256 * 1_024),
            for: 11,
            reset: false
        )
        let subscriberCount = hub.subscriberCount(for: 11)

        XCTAssertFalse(delivered)
        XCTAssertEqual(subscriberCount, 0)
    }

    @MainActor
    func testUnsubscribeStopsDelivery() {
        let hub = TerminalOutputHub()
        let subscription = hub.subscribe(to: 13) { _ in
            XCTFail("Unsubscribed consumers must never receive output")
        }
        hub.unsubscribe(subscription)

        let delivered = hub.deliver(Data([0x41]), for: 13, reset: false)
        XCTAssertFalse(delivered)
    }
}
