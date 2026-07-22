import XCTest
@testable import Linco

final class AsyncSerialGateTests: XCTestCase {
    @MainActor
    func testAsyncOperationsRemainFIFOAcrossSuspension() async throws {
        let gate = AsyncSerialGate()
        let firstEntered = SerialGateLatch()
        let releaseFirst = SerialGateLatch()
        let recorder = SerialGateRecorder()

        let first = Task {
            try await gate.perform {
                await recorder.append("detach-start")
                await firstEntered.open()
                await releaseFirst.wait()
                await recorder.append("detach-end")
            }
        }
        await firstEntered.wait()

        let second = Task {
            try await gate.perform {
                await recorder.append("resume")
            }
        }
        await Task.yield()
        let whileBlocked = await recorder.snapshot()
        XCTAssertEqual(whileBlocked, ["detach-start"])

        await releaseFirst.open()
        try await first.value
        try await second.value
        let completed = await recorder.snapshot()
        XCTAssertEqual(completed, ["detach-start", "detach-end", "resume"])
    }

    @MainActor
    func testPendingPingNeverBlocksApplicationSend() async throws {
        let outbound = WebSocketOutboundCoordinator()
        let pingEntered = SerialGateLatch()
        let releasePing = SerialGateLatch()

        let ping = Task {
            try await outbound.performPing {
                await pingEntered.open()
                await releasePing.wait()
            }
        }
        await pingEntered.wait()

        let applicationSend = Task {
            try await outbound.performOrdered { "terminal-input-sent" }
        }
        let result = try await withLincoTimeout(.seconds(1)) {
            try await applicationSend.value
        }
        XCTAssertEqual(result, "terminal-input-sent")

        await releasePing.open()
        try await ping.value
    }

    @MainActor
    func testCancelledWaiterDoesNotSendOrPoisonQueue() async throws {
        let gate = AsyncSerialGate()
        let firstEntered = SerialGateLatch()
        let releaseFirst = SerialGateLatch()
        let recorder = SerialGateRecorder()

        let first = Task {
            try await gate.perform {
                await firstEntered.open()
                await releaseFirst.wait()
            }
        }
        await firstEntered.wait()

        let cancelled = Task {
            try await gate.perform {
                await recorder.append("cancelled-body")
            }
        }
        await Task.yield()
        cancelled.cancel()
        await releaseFirst.open()
        try await first.value
        do {
            try await cancelled.value
            XCTFail("A cancelled queued send must not execute")
        } catch is CancellationError {
        }

        try await gate.perform {
            await recorder.append("later-send")
        }
        let values = await recorder.snapshot()
        XCTAssertEqual(values, ["later-send"])
    }
}

private actor SerialGateLatch {
    private var isOpen = false
    private var waiters: [CheckedContinuation<Void, Never>] = []

    func wait() async {
        guard !isOpen else { return }
        await withCheckedContinuation { waiters.append($0) }
    }

    func open() {
        guard !isOpen else { return }
        isOpen = true
        let waiters = self.waiters
        self.waiters.removeAll()
        waiters.forEach { $0.resume() }
    }
}

private actor SerialGateRecorder {
    private var values: [String] = []

    func append(_ value: String) { values.append(value) }
    func snapshot() -> [String] { values }
}
