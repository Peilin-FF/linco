import Foundation
import Testing
@testable import LincoCore

@Suite("Binary protocol")
struct BinaryProtocolTests {
    @Test("Rust v1 conformance vector decodes byte-for-byte")
    func conformanceVector() throws {
        let fixture = try V1ConformanceFixture.load()
        let vector = try #require(fixture.binaryCases.first { $0.name == "terminal_output_replay" })
        let bytes = try #require(Data(hexadecimal: vector.encodedHex))
        let payload = try #require(Data(hexadecimal: vector.payloadHex))
        let channel = try #require(LogicalChannel(rawValue: vector.channel))
        let frame = try BinaryFrame.decode(bytes, on: channel)

        #expect(frame.kind == .terminalOutput)
        #expect(frame.flags.rawValue == vector.header.flags)
        #expect(frame.streamID == vector.header.streamID)
        #expect(frame.sequence == vector.header.sequence)
        #expect(frame.payload == payload)
        #expect(frame.encoded() == bytes)
        #expect(fixture.protocolVersion == BinaryFrame.protocolVersion)
    }

    @Test("Arbitrary terminal bytes round-trip without base64")
    func binaryRoundTrip() throws {
        let payload = Data((0...255).map { UInt8($0) })
        let frame = try BinaryFrame(
            kind: .terminalInput,
            streamID: UInt32.max,
            sequence: UInt64.max,
            payload: payload
        )
        #expect(try BinaryFrame.decode(frame.encoded(), on: .interactive) == frame)
    }

    @Test("Rejects unknown flags")
    func unknownFlags() {
        #expect(throws: BinaryProtocolError.unknownFlags(0x8000)) {
            try BinaryFrame(kind: .terminalInput, flags: BinaryFlags(rawValue: 0x8000), streamID: 1, sequence: 0, payload: Data())
        }
    }

    @Test("Rejects terminal payloads above 32 KiB")
    func maximumPayload() {
        let size = BinaryKind.terminalOutput.maximumPayloadBytes + 1
        #expect(throws: BinaryProtocolError.payloadTooLarge(actual: size, maximum: 32 * 1_024)) {
            try BinaryFrame(kind: .terminalOutput, streamID: 1, sequence: 0, payload: Data(repeating: 0, count: size))
        }
    }
}

private extension Data {
    init?(hexadecimal: String) {
        guard hexadecimal.count.isMultiple(of: 2) else { return nil }
        var result = Data(capacity: hexadecimal.count / 2)
        var index = hexadecimal.startIndex
        while index < hexadecimal.endIndex {
            let next = hexadecimal.index(index, offsetBy: 2)
            guard let byte = UInt8(hexadecimal[index..<next], radix: 16) else { return nil }
            result.append(byte)
            index = next
        }
        self = result
    }
}
