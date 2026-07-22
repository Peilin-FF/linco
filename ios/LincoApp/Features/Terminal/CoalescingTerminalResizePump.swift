import Foundation

struct TerminalGridSize: Sendable, Equatable {
    let columns: Int
    let rows: Int
}

/// Serializes terminal resize RPCs while collapsing animation bursts to the
/// newest requested grid. Unlike terminal input, intermediate sizes carry no
/// user data and must not be replayed after a more recent size is known.
@MainActor
final class CoalescingTerminalResizePump {
    typealias Sender = @Sendable (TerminalGridSize) async -> Void

    private let sender: Sender
    private var desiredSize: TerminalGridSize?
    private var completedSize: TerminalGridSize?
    private var inFlightSize: TerminalGridSize?
    private var worker: Task<Void, Never>?
    private(set) var isAccepting = true

    init(sender: @escaping Sender) {
        self.sender = sender
    }

    func enqueue(columns: Int, rows: Int) {
        guard isAccepting, columns > 0, rows > 0 else { return }
        let size = TerminalGridSize(columns: columns, rows: rows)
        guard desiredSize != size else { return }
        desiredSize = size
        startWorkerIfNeeded()
    }

    /// Stop accepting UIKit callbacks and discard sizes that have not entered
    /// the stream-level serial gate. An already in-flight resize is allowed to
    /// finish; the next TerminalSurface waits behind it and sends the final size.
    func closeDiscardingPending() {
        isAccepting = false
        desiredSize = inFlightSize ?? completedSize
    }

    func waitUntilDrained() async {
        await worker?.value
    }

    private func startWorkerIfNeeded() {
        guard worker == nil else { return }
        worker = Task { [self] in
            while let size = nextSize() {
                inFlightSize = size
                await sender(size)
                completedSize = size
                inFlightSize = nil
            }
            worker = nil
        }
    }

    private func nextSize() -> TerminalGridSize? {
        guard desiredSize != completedSize else { return nil }
        return desiredSize
    }
}

/// Preserves resize completion order across successive TerminalSurface
/// coordinators for the same server stream. This prevents an old UIKit view's
/// in-flight resize from completing after its replacement's final dimensions.
actor TerminalResizeStreamCoordinator {
    private var gates: [UInt32: AsyncSerialGate] = [:]

    func perform<Value: Sendable>(
        streamID: UInt32,
        operation: @escaping @Sendable () async throws -> Value
    ) async throws -> Value {
        let gate: AsyncSerialGate
        if let existing = gates[streamID] {
            gate = existing
        } else {
            let created = AsyncSerialGate()
            gates[streamID] = created
            gate = created
        }
        return try await gate.perform(operation)
    }
}
