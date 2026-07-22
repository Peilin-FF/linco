import Foundation

func withLincoTimeout<Value: Sendable>(
    _ duration: Duration,
    onTimeout: @escaping @Sendable () async -> Void = {},
    operation: @escaping @Sendable () async throws -> Value
) async throws -> Value {
    try await withThrowingTaskGroup(of: Value.self) { group in
        group.addTask { try await operation() }
        group.addTask {
            try await Task.sleep(for: duration)
            try Task.checkCancellation()
            await onTimeout()
            throw NetworkTimeoutError.timedOut
        }
        defer { group.cancelAll() }
        guard let value = try await group.next() else { throw CancellationError() }
        return value
    }
}

enum NetworkTimeoutError: LocalizedError, Sendable, Equatable {
    case timedOut

    var errorDescription: String? { "连接等待超时。" }
}
