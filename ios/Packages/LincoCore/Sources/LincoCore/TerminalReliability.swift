import Foundation

public struct TerminalInputLedger: Sendable, Equatable {
    public enum EpochTransition: Sendable, Equatable {
        case firstConnection
        case unchanged(framesToResend: [BinaryFrame])
        case changed
        case ambiguous(streamIDs: Set<UInt32>)
    }

    private struct StreamState: Sendable, Equatable {
        var nextOffset: UInt64 = 0
        var acknowledgedThrough: UInt64 = 0
        var pending: [BinaryFrame] = []
        var pendingBytes = 0
        var hasAuthoritativeBaseline = false
    }

    public let maximumPendingBytesPerStream: Int
    public private(set) var serverEpoch: UUID?
    private var streams: [UInt32: StreamState] = [:]
    private var ambiguousStreams: Set<UInt32> = []

    public init(maximumPendingBytesPerStream: Int = 1 * 1_024 * 1_024) {
        self.maximumPendingBytesPerStream = maximumPendingBytesPerStream
    }

    /// Clears every cursor, pending frame, epoch, and ambiguity marker when the
    /// user removes a paired server. Reliability state is scoped to one server
    /// identity and must never be offered to a subsequently paired server, even
    /// if that server happens to reuse the same stream identifiers.
    public mutating func resetForServerIdentityChange() {
        serverEpoch = nil
        streams.removeAll(keepingCapacity: false)
        ambiguousStreams.removeAll(keepingCapacity: false)
    }

    /// Reconciles the server-authoritative next input byte offset announced by
    /// `stream_opened`. A fresh client can safely start at that offset. Existing
    /// unacknowledged bytes are only trimmed when the server offset lies inside
    /// the locally-known acknowledgement window; a rollback or jump beyond
    /// pending data is ambiguous and permanently blocks input until the user
    /// explicitly discards it and obtains a new baseline.
    @discardableResult
    public mutating func synchronizeServerInputThrough(
        streamID: UInt32,
        through serverThrough: UInt64
    ) throws -> InputBaselineOutcome {
        guard !ambiguousStreams.contains(streamID) else { return .ambiguous }
        guard var state = streams[streamID] else {
            streams[streamID] = StreamState(
                nextOffset: serverThrough,
                acknowledgedThrough: serverThrough,
                pending: [],
                pendingBytes: 0,
                hasAuthoritativeBaseline: true
            )
            return .ready
        }

        guard serverThrough >= state.acknowledgedThrough else {
            ambiguousStreams.insert(streamID)
            return .ambiguous
        }

        if state.pending.isEmpty {
            let baseline = max(state.nextOffset, serverThrough)
            state.nextOffset = baseline
            state.acknowledgedThrough = baseline
            state.hasAuthoritativeBaseline = true
            streams[streamID] = state
            return .ready
        }

        guard serverThrough <= state.nextOffset else {
            ambiguousStreams.insert(streamID)
            return .ambiguous
        }
        try acknowledge(streamID: streamID, through: serverThrough)
        streams[streamID]?.hasAuthoritativeBaseline = true
        return .ready
    }

    public mutating func enqueue(streamID: UInt32, payload: Data) throws -> BinaryFrame {
        guard payload.count <= BinaryKind.terminalInput.maximumPayloadBytes else {
            throw BinaryProtocolError.payloadTooLarge(
                actual: payload.count,
                maximum: BinaryKind.terminalInput.maximumPayloadBytes
            )
        }
        return try enqueueBatch(streamID: streamID, payload: payload)[0]
    }

    /// Atomically reserves an entire delegate input item before any frame is
    /// exposed to the transport. A large paste therefore cannot be partially
    /// executed merely because the local reliability window fills mid-item.
    public mutating func enqueueBatch(streamID: UInt32, payload: Data) throws -> [BinaryFrame] {
        guard !ambiguousStreams.contains(streamID) else { throw TerminalReliabilityError.ambiguousInput }
        guard !payload.isEmpty else { throw TerminalReliabilityError.emptyInput }
        guard var state = streams[streamID], state.hasAuthoritativeBaseline else {
            throw TerminalReliabilityError.inputBaselineRequired(streamID: streamID)
        }
        guard state.pendingBytes + payload.count <= maximumPendingBytesPerStream else {
            throw TerminalReliabilityError.inputBackpressure(streamID: streamID)
        }

        var frames: [BinaryFrame] = []
        frames.reserveCapacity(
            (payload.count + BinaryKind.terminalInput.maximumPayloadBytes - 1)
                / BinaryKind.terminalInput.maximumPayloadBytes
        )
        var start = 0
        while start < payload.count {
            let end = min(start + BinaryKind.terminalInput.maximumPayloadBytes, payload.count)
            let chunk = payload.subdata(in: start..<end)
            let frame = try BinaryFrame(
                kind: .terminalInput,
                streamID: streamID,
                sequence: state.nextOffset,
                payload: chunk
            )
            state.nextOffset += UInt64(chunk.count)
            state.pending.append(frame)
            frames.append(frame)
            start = end
        }
        state.pendingBytes += payload.count
        streams[streamID] = state
        return frames
    }

    public mutating func acknowledge(streamID: UInt32, through offset: UInt64) throws {
        guard var state = streams[streamID] else { return }
        guard offset >= state.acknowledgedThrough else { return }
        guard offset <= state.nextOffset else {
            throw TerminalReliabilityError.invalidAcknowledgement(streamID: streamID, through: offset)
        }

        state.acknowledgedThrough = offset
        var remaining: [BinaryFrame] = []
        var remainingBytes = 0
        for frame in state.pending {
            let end = frame.sequence + UInt64(frame.payload.count)
            if end <= offset { continue }
            if frame.sequence < offset {
                let consumed = Int(offset - frame.sequence)
                let suffix = frame.payload.subdata(in: consumed..<frame.payload.count)
                let trimmed = try BinaryFrame(
                    kind: .terminalInput,
                    streamID: streamID,
                    sequence: offset,
                    payload: suffix
                )
                remaining.append(trimmed)
                remainingBytes += suffix.count
            } else {
                remaining.append(frame)
                remainingBytes += frame.payload.count
            }
        }
        state.pending = remaining
        state.pendingBytes = remainingBytes
        streams[streamID] = state
    }

    public mutating func beginServerEpoch(_ epoch: UUID) -> EpochTransition {
        requireFreshBaselines()
        guard let previous = serverEpoch else {
            serverEpoch = epoch
            return .firstConnection
        }
        guard previous != epoch else {
            let frames = streams.keys.sorted().flatMap { streamID in
                ambiguousStreams.contains(streamID) ? [] : (streams[streamID]?.pending ?? [])
            }
            return .unchanged(framesToResend: frames)
        }

        serverEpoch = epoch
        let pendingStreams = Set(streams.compactMap { $0.value.pending.isEmpty ? nil : $0.key })
        if pendingStreams.isEmpty {
            streams.removeAll(keepingCapacity: true)
            ambiguousStreams.removeAll(keepingCapacity: true)
            return .changed
        }
        for streamID in Array(streams.keys) where !pendingStreams.contains(streamID) {
            streams.removeValue(forKey: streamID)
        }
        ambiguousStreams.formIntersection(pendingStreams)
        ambiguousStreams.formUnion(pendingStreams)
        return .ambiguous(streamIDs: pendingStreams)
    }

    @discardableResult
    public mutating func discardAmbiguousInput() -> Set<UInt32> {
        let discarded = ambiguousStreams
        for streamID in discarded {
            streams.removeValue(forKey: streamID)
        }
        ambiguousStreams.removeAll(keepingCapacity: true)
        return discarded
    }

    /// Removes reliability state for exactly one terminal. This is only safe for
    /// a definitive stream-lifecycle outcome such as end-of-stream or a server
    /// `not_found` rejection. Ambiguous input must never use this path.
    public mutating func discardStream(streamID: UInt32) {
        streams.removeValue(forKey: streamID)
        ambiguousStreams.remove(streamID)
    }

    /// Applies a lifecycle retirement only when it cannot erase evidence that
    /// still requires explicit user resolution.
    @discardableResult
    public mutating func discardStreamIfUnambiguous(streamID: UInt32) -> Bool {
        guard !ambiguousStreams.contains(streamID) else { return false }
        discardStream(streamID: streamID)
        return true
    }

    /// Forces every known stream to obtain a fresh server-authoritative input
    /// offset before accepting more bytes. Pending suffixes remain intact.
    public mutating func requireFreshBaselines() {
        for streamID in Array(streams.keys) {
            streams[streamID]?.hasAuthoritativeBaseline = false
        }
    }

    public mutating func markInputAmbiguous() -> Set<UInt32> {
        let affected = Set(streams.compactMap { $0.value.pending.isEmpty ? nil : $0.key })
        ambiguousStreams.formUnion(affected)
        return affected
    }

    @discardableResult
    public mutating func markInputAmbiguous(streamID: UInt32) -> Set<UInt32> {
        ambiguousStreams.insert(streamID)
        streams[streamID]?.hasAuthoritativeBaseline = false
        return [streamID]
    }

    public func pendingFrames(streamID: UInt32) -> [BinaryFrame] {
        streams[streamID]?.pending ?? []
    }

    public func isInputAmbiguous(streamID: UInt32) -> Bool {
        ambiguousStreams.contains(streamID)
    }
}

public enum InputBaselineOutcome: Sendable, Equatable {
    case ready
    case ambiguous
}

public struct TerminalOutputLedger: Sendable, Equatable {
    public enum Outcome: Sendable, Equatable {
        case deliver(BinaryFrame, reset: Bool, endOfStream: Bool)
        case endOfStream(streamID: UInt32, offset: UInt64)
        case duplicate
        case gap(expected: UInt64, received: UInt64)
    }

    private var cursors: [UInt32: UInt64] = [:]
    private var endedStreams: Set<UInt32> = []

    public init() {}

    /// Output offsets are meaningful only for the paired server that issued
    /// them. Removing that server starts a completely new replay namespace.
    public mutating func resetForServerIdentityChange() {
        cursors.removeAll(keepingCapacity: false)
        endedStreams.removeAll(keepingCapacity: false)
    }

    public mutating func accept(_ frame: BinaryFrame) throws -> Outcome {
        guard frame.kind == .terminalOutput || frame.kind == .terminalSnapshot else {
            throw TerminalReliabilityError.unexpectedOutputKind
        }
        let isEndOfStream = frame.flags.contains(.endOfStream)
        if frame.kind == .terminalSnapshot {
            cursors[frame.streamID] = frame.sequence + UInt64(frame.payload.count)
            if isEndOfStream { endedStreams.insert(frame.streamID) }
            return .deliver(frame, reset: true, endOfStream: isEndOfStream)
        }

        let expected = cursors[frame.streamID, default: frame.sequence]
        if frame.sequence > expected {
            return .gap(expected: expected, received: frame.sequence)
        }
        let overlap = expected - frame.sequence
        guard overlap < UInt64(frame.payload.count) else {
            guard isEndOfStream, !endedStreams.contains(frame.streamID) else { return .duplicate }
            endedStreams.insert(frame.streamID)
            return .endOfStream(streamID: frame.streamID, offset: expected)
        }
        if overlap == 0 {
            cursors[frame.streamID] = expected + UInt64(frame.payload.count)
            if isEndOfStream { endedStreams.insert(frame.streamID) }
            return .deliver(frame, reset: false, endOfStream: isEndOfStream)
        }

        let suffix = frame.payload.subdata(in: Int(overlap)..<frame.payload.count)
        let trimmed = try BinaryFrame(
            kind: .terminalOutput,
            flags: frame.flags,
            streamID: frame.streamID,
            sequence: expected,
            payload: suffix
        )
        cursors[frame.streamID] = expected + UInt64(suffix.count)
        if isEndOfStream { endedStreams.insert(frame.streamID) }
        return .deliver(trimmed, reset: false, endOfStream: isEndOfStream)
    }

    public func cursor(for streamID: UInt32) -> UInt64 {
        cursors[streamID, default: 0]
    }

    public mutating func setCursor(_ offset: UInt64, for streamID: UInt32) {
        cursors[streamID] = offset
        endedStreams.remove(streamID)
    }
}

public enum TerminalReliabilityError: Error, Sendable, Equatable {
    case emptyInput
    case ambiguousInput
    case inputBaselineRequired(streamID: UInt32)
    case inputBackpressure(streamID: UInt32)
    case invalidAcknowledgement(streamID: UInt32, through: UInt64)
    case unexpectedOutputKind
}
