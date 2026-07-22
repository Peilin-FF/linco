import Testing
@testable import LincoCore

@Suite("Mobile connection timing")
struct ConnectionTimingTests {
    @Test("Reconnect backoff grows, caps, and resets after success")
    func reconnectBackoff() {
        var backoff = ReconnectBackoff()
        let delays = (0..<7).map { _ in backoff.next(jitterSample: 0.5).delayMilliseconds }

        #expect(delays == [350, 750, 1_500, 3_000, 5_000, 5_000, 5_000])
        #expect(backoff.consecutiveFailures == 7)
        backoff.registerSuccess()
        let scheduleAfterReset = backoff.next(jitterSample: 0.5)
        #expect(scheduleAfterReset == ReconnectSchedule(attempt: 1, delayMilliseconds: 350))
    }

    @Test("Jitter is bounded and cannot exceed the mobile cap")
    func boundedJitter() {
        var low = ReconnectBackoff()
        var high = ReconnectBackoff()
        let lowSchedule = low.next(jitterSample: -100)
        let initialHighSchedule = high.next(jitterSample: 100)
        #expect(lowSchedule.delayMilliseconds == 315)
        #expect(initialHighSchedule.delayMilliseconds == 385)
        for _ in 0..<8 { _ = high.next(jitterSample: 100) }
        let cappedHighSchedule = high.next(jitterSample: 100)
        #expect(cappedHighSchedule.delayMilliseconds == 5_000)
    }

    @Test("Heartbeat clamps the server cadence before applying the safety margin")
    func heartbeatClamp() {
        #expect(HeartbeatCadence.pingIntervalMilliseconds(advertisedHeartbeatMilliseconds: nil) == 12_000)
        #expect(HeartbeatCadence.pingIntervalMilliseconds(advertisedHeartbeatMilliseconds: 500) == 4_000)
        #expect(HeartbeatCadence.pingIntervalMilliseconds(advertisedHeartbeatMilliseconds: 120_000) == 48_000)
    }
}
