import Foundation
import Testing
@testable import LincoCore

@Suite("Terminal reliability")
struct TerminalReliabilityTests {
    @Test("Cold restart starts new input at the server-authoritative offset")
    func coldRestartInputBaseline() throws {
        var ledger = TerminalInputLedger()

        #expect(try ledger.synchronizeServerInputThrough(streamID: 7, through: 4_096) == .ready)
        let input = try ledger.enqueue(streamID: 7, payload: Data("x".utf8))

        #expect(input.sequence == 4_096)
    }

    @Test("Server baseline trims only acknowledged pending bytes")
    func pendingInputBaselinePreservesUnknownSuffix() throws {
        var ledger = TerminalInputLedger()
        _ = try ledger.synchronizeServerInputThrough(streamID: 7, through: 0)
        _ = try ledger.enqueue(streamID: 7, payload: Data("abcdef".utf8))
        try ledger.acknowledge(streamID: 7, through: 2)

        #expect(try ledger.synchronizeServerInputThrough(streamID: 7, through: 4) == .ready)
        let pending = ledger.pendingFrames(streamID: 7)
        #expect(pending.count == 1)
        #expect(pending[0].sequence == 4)
        #expect(pending[0].payload == Data("ef".utf8))
        let next = try ledger.enqueue(streamID: 7, payload: Data("g".utf8))
        #expect(next.sequence == 6)
    }

    @Test("Conflicting pending baseline becomes ambiguous without rebasing")
    func conflictingPendingInputBaselineIsAmbiguous() throws {
        var ledger = TerminalInputLedger()
        _ = try ledger.synchronizeServerInputThrough(streamID: 7, through: 0)
        _ = try ledger.enqueue(streamID: 7, payload: Data("abc".utf8))

        #expect(try ledger.synchronizeServerInputThrough(streamID: 7, through: 9) == .ambiguous)
        #expect(ledger.pendingFrames(streamID: 7).first?.sequence == 0)
        #expect(throws: TerminalReliabilityError.ambiguousInput) {
            try ledger.enqueue(streamID: 7, payload: Data("d".utf8))
        }
    }

    @Test("Discarded ambiguity must obtain a fresh baseline before new input")
    func discardThenRebaseline() throws {
        var ledger = TerminalInputLedger()
        _ = try ledger.synchronizeServerInputThrough(streamID: 7, through: 0)
        _ = try ledger.enqueue(streamID: 7, payload: Data("abc".utf8))
        #expect(try ledger.synchronizeServerInputThrough(streamID: 7, through: 9) == .ambiguous)

        #expect(ledger.isInputAmbiguous(streamID: 7))
        #expect(ledger.discardAmbiguousInput() == [7])
        #expect(throws: TerminalReliabilityError.inputBaselineRequired(streamID: 7)) {
            try ledger.enqueue(streamID: 7, payload: Data("d".utf8))
        }
        #expect(try ledger.synchronizeServerInputThrough(streamID: 7, through: 9) == .ready)
        let next = try ledger.enqueue(streamID: 7, payload: Data("d".utf8))
        #expect(next.sequence == 9)
    }

    @Test("A second client can advance an idle local stream baseline")
    func idleInputBaselineCanAdvance() throws {
        var ledger = TerminalInputLedger()
        _ = try ledger.synchronizeServerInputThrough(streamID: 7, through: 0)
        _ = try ledger.enqueue(streamID: 7, payload: Data("abc".utf8))
        try ledger.acknowledge(streamID: 7, through: 3)

        #expect(try ledger.synchronizeServerInputThrough(streamID: 7, through: 12) == .ready)
        let next = try ledger.enqueue(streamID: 7, payload: Data("d".utf8))
        #expect(next.sequence == 12)
    }

    @Test("Keeps input until monotonic server ACK")
    func inputAcknowledgement() throws {
        var ledger = TerminalInputLedger()
        _ = try ledger.synchronizeServerInputThrough(streamID: 7, through: 0)
        let first = try ledger.enqueue(streamID: 7, payload: Data("abc".utf8))
        let second = try ledger.enqueue(streamID: 7, payload: Data("def".utf8))
        #expect(first.sequence == 0)
        #expect(second.sequence == 3)

        try ledger.acknowledge(streamID: 7, through: 3)
        #expect(ledger.pendingFrames(streamID: 7) == [second])
        try ledger.acknowledge(streamID: 7, through: 2)
        #expect(ledger.pendingFrames(streamID: 7) == [second])
    }

    @Test("Same epoch reconnect replays only unacknowledged frames")
    func sameEpochReplay() throws {
        let epoch = UUID()
        var ledger = TerminalInputLedger()
        #expect(ledger.beginServerEpoch(epoch) == .firstConnection)
        _ = try ledger.synchronizeServerInputThrough(streamID: 3, through: 0)
        let pending = try ledger.enqueue(streamID: 3, payload: Data([1, 2]))
        #expect(ledger.beginServerEpoch(epoch) == .unchanged(framesToResend: [pending]))
    }

    @Test("New epoch makes pending input ambiguous and blocks automatic resend")
    func epochChange() throws {
        var ledger = TerminalInputLedger()
        _ = ledger.beginServerEpoch(UUID())
        _ = try ledger.synchronizeServerInputThrough(streamID: 9, through: 0)
        _ = try ledger.enqueue(streamID: 9, payload: Data([0x0d]))
        #expect(ledger.beginServerEpoch(UUID()) == .ambiguous(streamIDs: [9]))
        #expect(throws: TerminalReliabilityError.ambiguousInput) {
            try ledger.enqueue(streamID: 9, payload: Data([1]))
        }
        #expect(ledger.isInputAmbiguous(streamID: 9))
        #expect(ledger.pendingFrames(streamID: 9).count == 1)
        #expect(ledger.discardAmbiguousInput() == [9])
        #expect(throws: TerminalReliabilityError.inputBaselineRequired(streamID: 9)) {
            try ledger.enqueue(streamID: 9, payload: Data([1]))
        }
        _ = try ledger.synchronizeServerInputThrough(streamID: 9, through: 14)
        #expect(try ledger.enqueue(streamID: 9, payload: Data([1])).sequence == 14)
    }

    @Test("Interactive ambiguity explicitly blocks further input")
    func explicitAmbiguity() throws {
        var ledger = TerminalInputLedger()
        _ = try ledger.synchronizeServerInputThrough(streamID: 12, through: 0)
        _ = try ledger.enqueue(streamID: 12, payload: Data([1]))

        #expect(ledger.markInputAmbiguous() == [12])
        #expect(throws: TerminalReliabilityError.ambiguousInput) {
            try ledger.enqueue(streamID: 12, payload: Data([2]))
        }
    }

    @Test("A definitive terminal end discards only that stream")
    func discardStreamPreservesOtherPendingInput() throws {
        var ledger = TerminalInputLedger()
        _ = try ledger.synchronizeServerInputThrough(streamID: 3, through: 0)
        _ = try ledger.synchronizeServerInputThrough(streamID: 4, through: 10)
        _ = try ledger.enqueue(streamID: 3, payload: Data("gone".utf8))
        let surviving = try ledger.enqueue(streamID: 4, payload: Data("keep".utf8))

        ledger.discardStream(streamID: 3)

        #expect(ledger.pendingFrames(streamID: 3).isEmpty)
        #expect(ledger.pendingFrames(streamID: 4) == [surviving])
        #expect(throws: TerminalReliabilityError.inputBaselineRequired(streamID: 3)) {
            try ledger.enqueue(streamID: 3, payload: Data("x".utf8))
        }
        #expect(try ledger.enqueue(streamID: 4, payload: Data("!".utf8)).sequence == 14)
    }

    @Test("Terminal EOS cannot erase unresolved ambiguous input")
    func terminalEndPreservesAmbiguousEvidenceUntilExplicitDiscard() throws {
        var ledger = TerminalInputLedger()
        _ = try ledger.synchronizeServerInputThrough(streamID: 11, through: 0)
        let pending = try ledger.enqueue(streamID: 11, payload: Data("uncertain".utf8))
        ledger.markInputAmbiguous(streamID: 11)

        // Output EOS retires the terminal lifecycle, but cannot prove whether
        // an unacknowledged input item executed before that terminal exited.
        #expect(!ledger.discardStreamIfUnambiguous(streamID: 11))
        #expect(ledger.pendingFrames(streamID: 11) == [pending])
        #expect(ledger.isInputAmbiguous(streamID: 11))

        #expect(ledger.discardAmbiguousInput() == [11])
        #expect(ledger.pendingFrames(streamID: 11).isEmpty)
    }

    @Test("Removing server A prevents its input from entering server B")
    func serverIdentityResetClearsReplayAndAmbiguityNamespace() throws {
        let serverA = UUID()
        let serverB = UUID()
        var input = TerminalInputLedger()
        var output = TerminalOutputLedger()

        #expect(input.beginServerEpoch(serverA) == .firstConnection)
        _ = try input.synchronizeServerInputThrough(streamID: 7, through: 40)
        _ = try input.enqueue(streamID: 7, payload: Data("possibly-ran".utf8))
        input.markInputAmbiguous(streamID: 7)
        output.setCursor(9_999, for: 7)

        input.resetForServerIdentityChange()
        output.resetForServerIdentityChange()

        #expect(input.serverEpoch == nil)
        #expect(input.pendingFrames(streamID: 7).isEmpty)
        #expect(!input.isInputAmbiguous(streamID: 7))
        #expect(output.cursor(for: 7) == 0)
        #expect(input.beginServerEpoch(serverB) == .firstConnection)
        _ = try input.synchronizeServerInputThrough(streamID: 7, through: 3)
        #expect(try input.enqueue(streamID: 7, payload: Data("B".utf8)).sequence == 3)
    }

    @Test("A paste is reserved as one atomic reliability item")
    func batchReservationIsAtomicAtBackpressureBoundary() throws {
        let limit = BinaryKind.terminalInput.maximumPayloadBytes * 2
        var ledger = TerminalInputLedger(maximumPendingBytesPerStream: limit)
        _ = try ledger.synchronizeServerInputThrough(streamID: 5, through: 100)
        let firstPayload = Data(repeating: 0x61, count: limit - 1)
        let firstFrames = try ledger.enqueueBatch(streamID: 5, payload: firstPayload)
        #expect(firstFrames.count == 2)

        #expect(throws: TerminalReliabilityError.inputBackpressure(streamID: 5)) {
            try ledger.enqueueBatch(streamID: 5, payload: Data([0x62, 0x63]))
        }
        let pendingAfterRejection = ledger.pendingFrames(streamID: 5)
        #expect(pendingAfterRejection == firstFrames)

        try ledger.acknowledge(streamID: 5, through: 100 + UInt64(firstPayload.count))
        let retried = try ledger.enqueueBatch(streamID: 5, payload: Data([0x62, 0x63]))
        #expect(retried.count == 1)
        #expect(retried[0].sequence == 100 + UInt64(firstPayload.count))
    }

    @Test("A reconnect requires a fresh baseline before new input")
    func unchangedEpochRequiresFreshBaseline() throws {
        let epoch = UUID()
        var ledger = TerminalInputLedger()
        _ = ledger.beginServerEpoch(epoch)
        _ = try ledger.synchronizeServerInputThrough(streamID: 8, through: 20)
        _ = try ledger.enqueue(streamID: 8, payload: Data("x".utf8))

        _ = ledger.beginServerEpoch(epoch)

        #expect(throws: TerminalReliabilityError.inputBaselineRequired(streamID: 8)) {
            try ledger.enqueue(streamID: 8, payload: Data("y".utf8))
        }
        #expect(try ledger.synchronizeServerInputThrough(streamID: 8, through: 20) == .ready)
        #expect(try ledger.enqueue(streamID: 8, payload: Data("y".utf8)).sequence == 21)
    }

    @Test("Same-epoch replay excludes only quarantined streams")
    func sameEpochReplaySkipsAmbiguousStream() throws {
        let epoch = UUID()
        var ledger = TerminalInputLedger()
        _ = ledger.beginServerEpoch(epoch)
        _ = try ledger.synchronizeServerInputThrough(streamID: 1, through: 0)
        _ = try ledger.synchronizeServerInputThrough(streamID: 2, through: 50)
        _ = try ledger.enqueue(streamID: 1, payload: Data("uncertain".utf8))
        let safe = try ledger.enqueue(streamID: 2, payload: Data("safe".utf8))
        ledger.markInputAmbiguous(streamID: 1)

        #expect(ledger.beginServerEpoch(epoch) == .unchanged(framesToResend: [safe]))
        #expect(throws: TerminalReliabilityError.ambiguousInput) {
            try ledger.enqueue(streamID: 1, payload: Data("!".utf8))
        }
    }

    @Test("A clean epoch change removes stale ambiguity markers")
    func cleanEpochChangeClearsGhostAmbiguity() throws {
        var ledger = TerminalInputLedger()
        _ = ledger.beginServerEpoch(UUID())
        _ = try ledger.synchronizeServerInputThrough(streamID: 6, through: 0)
        ledger.markInputAmbiguous(streamID: 6)
        ledger.discardStream(streamID: 6)

        #expect(ledger.beginServerEpoch(UUID()) == .changed)
        #expect(try ledger.synchronizeServerInputThrough(streamID: 6, through: 100) == .ready)
        #expect(try ledger.enqueue(streamID: 6, payload: Data("x".utf8)).sequence == 100)
    }

    @Test("A new epoch drops clean offsets while quarantining pending streams")
    func mixedEpochChangeDropsCleanStreamState() throws {
        var ledger = TerminalInputLedger()
        _ = ledger.beginServerEpoch(UUID())
        _ = try ledger.synchronizeServerInputThrough(streamID: 1, through: 40)
        _ = try ledger.enqueue(streamID: 1, payload: Data("done".utf8))
        try ledger.acknowledge(streamID: 1, through: 44)
        _ = try ledger.synchronizeServerInputThrough(streamID: 2, through: 0)
        _ = try ledger.enqueue(streamID: 2, payload: Data("pending".utf8))

        #expect(ledger.beginServerEpoch(UUID()) == .ambiguous(streamIDs: [2]))
        #expect(try ledger.synchronizeServerInputThrough(streamID: 1, through: 0) == .ready)
        #expect(try ledger.enqueue(streamID: 1, payload: Data("new".utf8)).sequence == 0)
        #expect(ledger.pendingFrames(streamID: 2).count == 1)
    }

    @Test("Output overlap is trimmed and a forward gap is surfaced")
    func outputOrdering() throws {
        var ledger = TerminalOutputLedger()
        let first = try BinaryFrame(kind: .terminalOutput, streamID: 1, sequence: 10, payload: Data("abcd".utf8))
        #expect(ledger.accept(first) == .deliver(first, reset: false, endOfStream: false))

        let overlap = try BinaryFrame(kind: .terminalOutput, streamID: 1, sequence: 12, payload: Data("cdef".utf8))
        guard case let .deliver(trimmed, reset, endOfStream) = try ledger.accept(overlap) else {
            Issue.record("Expected trimmed delivery")
            return
        }
        #expect(!reset)
        #expect(!endOfStream)
        #expect(trimmed.sequence == 14)
        #expect(trimmed.payload == Data("ef".utf8))

        let gap = try BinaryFrame(kind: .terminalOutput, streamID: 1, sequence: 20, payload: Data([1]))
        #expect(try ledger.accept(gap) == .gap(expected: 16, received: 20))
    }

    @Test("Empty end-of-stream frame is delivered exactly once")
    func emptyEndOfStream() throws {
        var ledger = TerminalOutputLedger()
        let output = try BinaryFrame(
            kind: .terminalOutput,
            streamID: 4,
            sequence: 0,
            payload: Data("done".utf8)
        )
        _ = try ledger.accept(output)
        let end = try BinaryFrame(
            kind: .terminalOutput,
            flags: .endOfStream,
            streamID: 4,
            sequence: 4,
            payload: Data()
        )

        #expect(try ledger.accept(end) == .endOfStream(streamID: 4, offset: 4))
        #expect(try ledger.accept(end) == .duplicate)
    }

    @Test("Tail data and end-of-stream are preserved together")
    func tailDataEndOfStream() throws {
        var ledger = TerminalOutputLedger()
        let end = try BinaryFrame(
            kind: .terminalOutput,
            flags: .endOfStream,
            streamID: 8,
            sequence: 12,
            payload: Data("tail".utf8)
        )

        #expect(try ledger.accept(end) == .deliver(end, reset: false, endOfStream: true))
    }
}
