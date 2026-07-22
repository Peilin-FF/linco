import Foundation

public struct ReconnectSchedule: Sendable, Equatable {
    public let attempt: Int
    public let delayMilliseconds: UInt64
}

public struct ReconnectBackoff: Sendable, Equatable {
    public private(set) var consecutiveFailures = 0

    public init() {}

    public mutating func next(jitterSample: Double) -> ReconnectSchedule {
        consecutiveFailures += 1
        let bases: [UInt64] = [350, 750, 1_500, 3_000, 5_000]
        let base = bases[min(consecutiveFailures - 1, bases.count - 1)]
        let sample = min(max(jitterSample, 0), 1)
        let factor = 0.9 + (sample * 0.2)
        let jittered = UInt64((Double(base) * factor).rounded())
        return ReconnectSchedule(
            attempt: consecutiveFailures,
            delayMilliseconds: min(jittered, 5_000)
        )
    }

    public mutating func registerSuccess() {
        consecutiveFailures = 0
    }
}

public enum HeartbeatCadence {
    public static let defaultAdvertisedMilliseconds: UInt64 = 15_000

    public static func pingIntervalMilliseconds(advertisedHeartbeatMilliseconds: UInt64?) -> UInt64 {
        let advertised = advertisedHeartbeatMilliseconds ?? defaultAdvertisedMilliseconds
        let clamped = min(max(advertised, 5_000), 60_000)
        return clamped * 4 / 5
    }
}
