import Foundation

/// A single-worker FIFO for bytes accepted by SwiftTerm's synchronous delegate.
/// Closing stops new input but intentionally drains everything already accepted;
/// RemoteService then owns acknowledgement, replay, and ambiguity semantics.
@MainActor
final class OrderedTerminalInputPump {
    typealias Sender = @Sendable (Data) async -> Void
    typealias RejectionHandler = @MainActor @Sendable (Rejection) -> Void

    struct Rejection: Sendable, Equatable {
        enum Reason: Sendable, Equatable {
            case capacity
            case acceptancePaused
        }

        let itemBytes: Int
        let maximumQueuedBytes: Int
        let reason: Reason

        init(
            itemBytes: Int,
            maximumQueuedBytes: Int,
            reason: Reason = .capacity
        ) {
            self.itemBytes = itemBytes
            self.maximumQueuedBytes = maximumQueuedBytes
            self.reason = reason
        }
    }

    private enum AcceptanceState: Equatable {
        case accepting
        case paused
        case closed
    }

    private let sender: Sender
    private let maximumQueuedBytes: Int
    private let onRejected: RejectionHandler
    private var pending: [Data] = []
    private var firstPendingIndex = 0
    private var queuedBytes = 0
    private var worker: Task<Void, Never>?
    private var acceptanceState = AcceptanceState.accepting
    var isAccepting: Bool { acceptanceState == .accepting }

    init(
        maximumQueuedBytes: Int = 1 * 1_024 * 1_024,
        onRejected: @escaping RejectionHandler = { _ in },
        sender: @escaping Sender
    ) {
        self.maximumQueuedBytes = max(1, maximumQueuedBytes)
        self.onRejected = onRejected
        self.sender = sender
    }

    func enqueue(_ data: Data) {
        guard !data.isEmpty else { return }
        guard isAccepting else {
            onRejected(.init(
                itemBytes: data.count,
                maximumQueuedBytes: maximumQueuedBytes,
                reason: .acceptancePaused
            ))
            return
        }
        guard data.count <= maximumQueuedBytes,
              queuedBytes <= maximumQueuedBytes - data.count else {
            onRejected(.init(itemBytes: data.count, maximumQueuedBytes: maximumQueuedBytes))
            return
        }
        queuedBytes += data.count
        pending.append(data)
        startWorkerIfNeeded()
    }

    /// Establishes a synchronous scene/transport boundary: no later delegate
    /// callback can enter the queue, while every item accepted before this call
    /// remains owned by the worker and drains normally.
    func pauseAcceptance() {
        guard acceptanceState == .accepting else { return }
        acceptanceState = .paused
    }

    func resumeAcceptance() {
        guard acceptanceState == .paused else { return }
        acceptanceState = .accepting
    }

    func closeAndDrain() {
        acceptanceState = .closed
    }

    func waitUntilDrained() async {
        await worker?.value
    }

    private func startWorkerIfNeeded() {
        guard worker == nil else { return }
        worker = Task { [self] in
            while !Task.isCancelled, let data = takeNext() {
                await sender(data)
                queuedBytes -= data.count
            }
            pending.removeAll(keepingCapacity: false)
            firstPendingIndex = 0
            queuedBytes = 0
            worker = nil
        }
    }

    private func takeNext() -> Data? {
        guard firstPendingIndex < pending.count else { return nil }
        let data = pending[firstPendingIndex]
        firstPendingIndex += 1
        if firstPendingIndex > 64, firstPendingIndex * 2 > pending.count {
            pending.removeFirst(firstPendingIndex)
            firstPendingIndex = 0
        }
        return data
    }
}

/// Lets scene and navigation lifecycle code wait until every byte already
/// accepted by a visible SwiftTerm surface has entered the reliability layer.
@MainActor
final class TerminalInputDrainRegistry {
    typealias Pause = @MainActor @Sendable () -> Void
    typealias Resume = @MainActor @Sendable () -> Void
    typealias Drain = @MainActor @Sendable () async -> Void

    private struct Entry {
        let pause: Pause
        let resume: Resume
        let drain: Drain
    }

    private var entries: [UInt32: [UUID: Entry]] = [:]

    func register(
        streamID: UInt32,
        token: UUID,
        pause: @escaping Pause,
        resume: @escaping Resume,
        drain: @escaping Drain
    ) {
        entries[streamID, default: [:]][token] = Entry(
            pause: pause,
            resume: resume,
            drain: drain
        )
    }

    func unregister(streamID: UInt32, token: UUID) {
        entries[streamID]?.removeValue(forKey: token)
        if entries[streamID]?.isEmpty == true { entries.removeValue(forKey: streamID) }
    }

    func pauseAcceptance(streamIDs: Set<UInt32>) {
        callbacks(for: streamIDs, keyPath: \.pause).forEach { $0() }
    }

    func resumeAcceptance(streamIDs: Set<UInt32>) {
        callbacks(for: streamIDs, keyPath: \.resume).forEach { $0() }
    }

    func waitUntilDrained(streamIDs: Set<UInt32>) async {
        let callbacks = callbacks(for: streamIDs, keyPath: \.drain)
        for callback in callbacks { await callback() }
    }

    private func callbacks<Value>(
        for streamIDs: Set<UInt32>,
        keyPath: KeyPath<Entry, Value>
    ) -> [Value] {
        streamIDs.sorted().flatMap { streamID in
            entries[streamID]?.values.map { $0[keyPath: keyPath] } ?? []
        }
    }
}
