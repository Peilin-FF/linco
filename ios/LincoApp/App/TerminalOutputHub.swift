import Foundation

struct TerminalOutputUpdate: Sendable, Equatable {
    let data: Data
    let reset: Bool
}

struct TerminalOutputSubscription: Sendable, Hashable {
    fileprivate let streamID: UInt32
    fileprivate let id: UUID
}

/// Delivers terminal bytes directly to the visible terminal surface.
///
/// There is deliberately no asynchronous buffer here: `deliver` returns only
/// after every active terminal surface has parsed the bytes. That acknowledgement
/// propagates through AppModel and RemoteService to the WebSocket receive loop,
/// applying transport backpressure instead of accumulating terminal output in
/// process memory.
@MainActor
final class TerminalOutputHub {
    typealias Consumer = @MainActor (TerminalOutputUpdate) -> Void

    private var subscribers: [UInt32: [UUID: Consumer]] = [:]

    func subscribe(to streamID: UInt32, consumer: @escaping Consumer) -> TerminalOutputSubscription {
        let subscription = TerminalOutputSubscription(streamID: streamID, id: UUID())
        subscribers[streamID, default: [:]][subscription.id] = consumer
        return subscription
    }

    /// Returns false when no surface currently owns the stream. Navigation
    /// teardown may briefly unsubscribe while its accepted input is still
    /// draining, so the caller records a required replay but leaves lifecycle
    /// detachment to that surface's drain-completion callback.
    @discardableResult
    func deliver(_ data: Data, for streamID: UInt32, reset: Bool) -> Bool {
        guard let consumers = subscribers[streamID], !consumers.isEmpty else { return false }
        let update = TerminalOutputUpdate(data: data, reset: reset)
        for consumer in consumers.values {
            consumer(update)
        }
        return true
    }

    func reset(_ streamID: UInt32) {
        _ = deliver(Data(), for: streamID, reset: true)
    }

    func unsubscribe(_ subscription: TerminalOutputSubscription) {
        subscribers[subscription.streamID]?.removeValue(forKey: subscription.id)
        if subscribers[subscription.streamID]?.isEmpty == true {
            subscribers.removeValue(forKey: subscription.streamID)
        }
    }

    func finishStream(_ streamID: UInt32) {
        subscribers.removeValue(forKey: streamID)
    }

    func finishAllStreams() {
        subscribers.removeAll(keepingCapacity: false)
    }

    func subscriberCount(for streamID: UInt32) -> Int {
        subscribers[streamID]?.count ?? 0
    }
}
