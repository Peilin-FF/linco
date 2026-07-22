import Foundation
import LincoCore
import XCTest

final class ProtocolPerformanceTests: XCTestCase {
    func testBinaryTerminalFrameDecodePerformance() throws {
        let payload = Data(repeating: 0x61, count: 32 * 1_024)
        let encoded = try BinaryFrame(
            kind: .terminalOutput,
            streamID: 42,
            sequence: 1_024,
            payload: payload
        ).encoded()

        measure(metrics: [XCTClockMetric(), XCTMemoryMetric()]) {
            for _ in 0..<1_000 {
                _ = try! BinaryFrame.decode(encoded, on: .interactive)
            }
        }
    }

    func testOutputDeduplicationPerformance() throws {
        let payload = Data(repeating: 0x1b, count: 8 * 1_024)
        measure(metrics: [XCTClockMetric(), XCTMemoryMetric()]) {
            var ledger = TerminalOutputLedger()
            for index in 0..<2_000 {
                let offset = UInt64(index * payload.count)
                let frame = try! BinaryFrame(
                    kind: .terminalOutput,
                    streamID: 9,
                    sequence: offset,
                    payload: payload
                )
                _ = try! ledger.accept(frame)
            }
        }
    }
}
