/// A FIFO asynchronous critical section used to preserve WebSocket message order
/// across actor reentrancy. Waiting operations are resumed one at a time and no
/// operation can enter until the previous asynchronous send has completed.
actor AsyncSerialGate {
    private var isLocked = false
    private var waiters: [CheckedContinuation<Void, Never>] = []
    private var firstWaiterIndex = 0

    func perform<Value: Sendable>(
        _ operation: @Sendable () async throws -> Value
    ) async throws -> Value {
        await acquire()
        defer { release() }
        try Task.checkCancellation()
        return try await operation()
    }

    private func acquire() async {
        if !isLocked {
            isLocked = true
            return
        }
        await withCheckedContinuation { continuation in
            waiters.append(continuation)
        }
    }

    private func release() {
        guard firstWaiterIndex < waiters.count else {
            isLocked = false
            waiters.removeAll(keepingCapacity: true)
            firstWaiterIndex = 0
            return
        }
        let continuation = waiters[firstWaiterIndex]
        firstWaiterIndex += 1
        if firstWaiterIndex > 64, firstWaiterIndex * 2 > waiters.count {
            waiters.removeFirst(firstWaiterIndex)
            firstWaiterIndex = 0
        }
        continuation.resume()
    }
}

actor WebSocketOutboundCoordinator {
    private let applicationGate = AsyncSerialGate()
    private let pingGate = AsyncSerialGate()

    func performOrdered<Value: Sendable>(
        _ operation: @Sendable () async throws -> Value
    ) async throws -> Value {
        try await applicationGate.perform(operation)
    }

    /// Ping completion represents a round trip, so it must never occupy the
    /// application-message FIFO while terminal input is ready to send.
    func performPing<Value: Sendable>(
        _ operation: @Sendable () async throws -> Value
    ) async throws -> Value {
        try await pingGate.perform(operation)
    }
}
