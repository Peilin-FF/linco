import Foundation
import XCTest
@testable import Linco

final class RemoteEventRelayTests: XCTestCase {
    @MainActor
    func testDeliveryWaitsForConsumerAcknowledgement() async {
        let relay = RemoteEventRelay()
        let entered = AsyncLatch()
        let release = AsyncLatch()
        let recorder = AsyncRecorder()

        await relay.install { _ in
            await recorder.append("handler-start")
            await entered.open()
            await release.wait()
            await recorder.append("handler-end")
        }

        let delivery = Task {
            await relay.deliver(.init(
                transportID: UUID(),
                event: .disconnected("test")
            ))
            await recorder.append("producer-end")
        }

        await entered.wait()
        let beforeRelease = await recorder.values
        XCTAssertEqual(beforeRelease, ["handler-start"])

        await release.open()
        await delivery.value
        let afterRelease = await recorder.values
        XCTAssertEqual(afterRelease, ["handler-start", "handler-end", "producer-end"])
    }
}

private actor AsyncLatch {
    private var isOpen = false
    private var waiters: [CheckedContinuation<Void, Never>] = []

    func wait() async {
        guard !isOpen else { return }
        await withCheckedContinuation { continuation in
            waiters.append(continuation)
        }
    }

    func open() {
        guard !isOpen else { return }
        isOpen = true
        let waiters = self.waiters
        self.waiters.removeAll()
        waiters.forEach { $0.resume() }
    }
}

private actor AsyncRecorder {
    private(set) var values: [String] = []

    func append(_ value: String) {
        values.append(value)
    }
}
