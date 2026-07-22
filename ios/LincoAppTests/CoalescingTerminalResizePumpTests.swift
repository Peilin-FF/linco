import XCTest
@testable import Linco

@MainActor
final class CoalescingTerminalResizePumpTests: XCTestCase {
    func testBurstKeepsOnlyNewestSizeBehindInFlightResize() async {
        let firstEntered = ResizePumpLatch()
        let releaseFirst = ResizePumpLatch()
        let recorder = ResizePumpRecorder()
        let first = TerminalGridSize(columns: 80, rows: 24)
        let newest = TerminalGridSize(columns: 132, rows: 42)
        let pump = CoalescingTerminalResizePump { size in
            await recorder.append(size)
            if size == first {
                await firstEntered.open()
                await releaseFirst.wait()
            }
        }

        pump.enqueue(columns: first.columns, rows: first.rows)
        await firstEntered.wait()
        pump.enqueue(columns: 96, rows: 28)
        pump.enqueue(columns: 110, rows: 34)
        pump.enqueue(columns: newest.columns, rows: newest.rows)
        pump.enqueue(columns: newest.columns, rows: newest.rows)

        await releaseFirst.open()
        await pump.waitUntilDrained()

        let values = await recorder.snapshot()
        XCTAssertEqual(values, [first, newest])
    }

    func testLatestValueMatchingInFlightSizeSuppressesRedundantSend() async {
        let firstEntered = ResizePumpLatch()
        let releaseFirst = ResizePumpLatch()
        let recorder = ResizePumpRecorder()
        let original = TerminalGridSize(columns: 80, rows: 24)
        let pump = CoalescingTerminalResizePump { size in
            await recorder.append(size)
            if size == original {
                await firstEntered.open()
                await releaseFirst.wait()
            }
        }

        pump.enqueue(columns: original.columns, rows: original.rows)
        await firstEntered.wait()
        pump.enqueue(columns: 100, rows: 30)
        pump.enqueue(columns: original.columns, rows: original.rows)
        pump.closeDiscardingPending()
        pump.enqueue(columns: 140, rows: 50)

        await releaseFirst.open()
        await pump.waitUntilDrained()

        let values = await recorder.snapshot()
        XCTAssertEqual(values, [original])
        XCTAssertFalse(pump.isAccepting)
    }

    func testReplacementSurfaceWinsAfterOldInFlightResize() async {
        let streamCoordinator = TerminalResizeStreamCoordinator()
        let oldEntered = ResizePumpLatch()
        let releaseOld = ResizePumpLatch()
        let recorder = ResizePumpRecorder()
        let oldInitial = TerminalGridSize(columns: 80, rows: 24)
        let oldPending = TerminalGridSize(columns: 96, rows: 28)
        let replacementFinal = TerminalGridSize(columns: 132, rows: 42)

        let oldSurface = CoalescingTerminalResizePump { size in
            try? await streamCoordinator.perform(streamID: 7) {
                await recorder.append(size)
                await oldEntered.open()
                await releaseOld.wait()
            }
        }
        let replacementSurface = CoalescingTerminalResizePump { size in
            try? await streamCoordinator.perform(streamID: 7) {
                await recorder.append(size)
            }
        }

        oldSurface.enqueue(columns: oldInitial.columns, rows: oldInitial.rows)
        await oldEntered.wait()
        oldSurface.enqueue(columns: oldPending.columns, rows: oldPending.rows)
        oldSurface.closeDiscardingPending()
        replacementSurface.enqueue(columns: replacementFinal.columns, rows: replacementFinal.rows)

        await releaseOld.open()
        await oldSurface.waitUntilDrained()
        await replacementSurface.waitUntilDrained()

        let values = await recorder.snapshot()
        XCTAssertEqual(values, [oldInitial, replacementFinal])
    }
}

private actor ResizePumpLatch {
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

private actor ResizePumpRecorder {
    private var values: [TerminalGridSize] = []

    func append(_ value: TerminalGridSize) { values.append(value) }
    func snapshot() -> [TerminalGridSize] { values }
}
