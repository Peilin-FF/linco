import Foundation
import XCTest
@testable import Linco

final class OrderedTerminalInputPumpTests: XCTestCase {
    @MainActor
    func testPasteBurstsStayOrderedAndAcceptedBytesDrainAfterClose() async {
        let firstEntered = InputPumpLatch()
        let releaseFirst = InputPumpLatch()
        let recorder = InputPumpRecorder()
        let pump = OrderedTerminalInputPump { data in
            let value = String(decoding: data, as: UTF8.self)
            if value == "A" {
                await firstEntered.open()
                await releaseFirst.wait()
            }
            await recorder.append(value)
        }

        pump.enqueue(Data("A".utf8))
        await firstEntered.wait()
        pump.enqueue(Data("B".utf8))
        pump.enqueue(Data("C".utf8))
        pump.closeAndDrain()
        pump.enqueue(Data("D".utf8))

        await releaseFirst.open()
        await pump.waitUntilDrained()

        let values = await recorder.snapshot()
        let isAccepting = pump.isAccepting
        XCTAssertEqual(values, ["A", "B", "C"])
        XCTAssertFalse(isAccepting)
    }

    @MainActor
    func testSceneDrainRegistryWaitsForAcceptedInput() async {
        let entered = InputPumpLatch()
        let release = InputPumpLatch()
        let completed = InputPumpLatch()
        let registry = TerminalInputDrainRegistry()
        let token = UUID()
        let pump = OrderedTerminalInputPump { _ in
            await entered.open()
            await release.wait()
        }
        registry.register(
            streamID: 7,
            token: token,
            pause: { pump.pauseAcceptance() },
            resume: { pump.resumeAcceptance() },
            drain: { await pump.waitUntilDrained() }
        )
        pump.enqueue(Data("accepted".utf8))
        await entered.wait()

        let drain = Task { @MainActor in
            await registry.waitUntilDrained(streamIDs: [7])
            await completed.open()
        }
        let completedBeforeRelease = await completed.isOpened()
        XCTAssertFalse(completedBeforeRelease)

        await release.open()
        await drain.value
        let completedAfterRelease = await completed.isOpened()
        XCTAssertTrue(completedAfterRelease)
    }

    @MainActor
    func testSceneBoundaryDrainsEarlierInputAndRejectsLaterDelegateItem() async {
        let entered = InputPumpLatch()
        let release = InputPumpLatch()
        let sent = InputPumpRecorder()
        let rejected = InputPumpRejectionRecorder()
        let registry = TerminalInputDrainRegistry()
        let token = UUID()
        let pump = OrderedTerminalInputPump(onRejected: { rejected.append($0) }) { data in
            let value = String(decoding: data, as: UTF8.self)
            if value == "before-background" {
                await entered.open()
                await release.wait()
            }
            await sent.append(value)
        }
        registry.register(
            streamID: 12,
            token: token,
            pause: { pump.pauseAcceptance() },
            resume: { pump.resumeAcceptance() },
            drain: { await pump.waitUntilDrained() }
        )

        pump.enqueue(Data("before-background".utf8))
        await entered.wait()
        registry.pauseAcceptance(streamIDs: [12])
        pump.enqueue(Data("after-background".utf8))

        let rejectionReasons = rejected.values.map(\.reason)
        XCTAssertEqual(rejectionReasons, [.acceptancePaused])
        await release.open()
        await registry.waitUntilDrained(streamIDs: [12])
        let backgroundValues = await sent.snapshot()
        XCTAssertEqual(backgroundValues, ["before-background"])

        registry.resumeAcceptance(streamIDs: [12])
        pump.enqueue(Data("foreground".utf8))
        await pump.waitUntilDrained()
        let foregroundValues = await sent.snapshot()
        XCTAssertEqual(foregroundValues, ["before-background", "foreground"])
    }

    @MainActor
    func testQueueBudgetIncludesInFlightBytesAndRejectsWholeNewItem() async {
        let entered = InputPumpLatch()
        let release = InputPumpLatch()
        let sent = InputPumpRecorder()
        let rejected = InputPumpRejectionRecorder()
        let pump = OrderedTerminalInputPump(
            maximumQueuedBytes: 4,
            onRejected: { rejected.append($0) }
        ) { data in
            let value = String(decoding: data, as: UTF8.self)
            if value == "ABC" {
                await entered.open()
                await release.wait()
            }
            await sent.append(value)
        }

        pump.enqueue(Data("ABC".utf8))
        await entered.wait()
        pump.enqueue(Data("DE".utf8))
        pump.enqueue(Data("F".utf8))
        pump.closeAndDrain()

        let rejections = rejected.values
        XCTAssertEqual(rejections, [.init(itemBytes: 2, maximumQueuedBytes: 4)])
        await release.open()
        await pump.waitUntilDrained()
        let sentValues = await sent.snapshot()
        XCTAssertEqual(sentValues, ["ABC", "F"])
    }
}

private actor InputPumpLatch {
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

    func isOpened() -> Bool { isOpen }
}

private actor InputPumpRecorder {
    private var values: [String] = []

    func append(_ value: String) { values.append(value) }
    func snapshot() -> [String] { values }
}

@MainActor
private final class InputPumpRejectionRecorder {
    private(set) var values: [OrderedTerminalInputPump.Rejection] = []

    func append(_ rejection: OrderedTerminalInputPump.Rejection) {
        values.append(rejection)
    }
}
