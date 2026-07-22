import Foundation
import Testing
@testable import LincoCore

@Suite("Control protocol")
struct ControlProtocolTests {
    @Test("Cancel envelope preserves the call identifier")
    func cancelEnvelope() throws {
        let id = UUID(uuidString: "04c7e76d-7e5f-4ad2-9b3b-57f1f2438764")!

        let encoded = try ControlCodec.encode(CancelMessage(id: id))
        let value = try JSONDecoder().decode(JSONValue.self, from: encoded)

        #expect(value == .object([
            "type": .string("cancel"),
            "id": .string(id.uuidString.uppercased())
        ]))
    }

    @Test("Read calls encode a null idempotency key")
    func readCallConformance() throws {
        let fixture = try V1ConformanceFixture.load()
        let vector = try #require(fixture.controlCases.first { $0.name == "read_call" })
        let object = try #require(vector.json.objectValue)
        let params = try #require(object["params"])
        let call = try CallMessage(
            id: try #require(object["id"]?.stringValue.flatMap(UUID.init(uuidString:))),
            method: .fileRead,
            params: params,
            deadlineMilliseconds: try #require(object["deadline_ms"]?.uint64Value)
        )
        let encoded = try ControlCodec.encode(call)
        let encodedObject = try #require(try JSONSerialization.jsonObject(with: encoded) as? [String: Any])

        #expect(encodedObject["type"] as? String == "call")
        #expect(encodedObject["method"] as? String == "file_read")
        #expect(encodedObject["idempotency_key"] is NSNull)
        #expect(encodedObject["deadline_ms"] as? Int == 5_000)
    }

    @Test("Server terminal input faults remain stream scoped and machine readable")
    func terminalInputFaultConformance() throws {
        let fixture = try V1ConformanceFixture.load()
        let vector = try #require(
            fixture.serverEventCases.first { $0.name == "terminal_input_fault" }
        )
        let encoded = try JSONEncoder().encode(vector.json)
        let envelope = try ControlCodec.decodeServer(encoded)

        #expect(envelope.type == "terminal_input_fault")
        #expect(envelope.uint64("stream_id") == 7)
        #expect(envelope.uint64("generation") == 3)
        #expect(envelope.string("code") == "session_exited")
        #expect(envelope.uint64("authoritative_through") == 98_304)
        guard case let .bool(discardPending)? = envelope.fields["discard_pending"] else {
            Issue.record("Expected discard_pending boolean")
            return
        }
        #expect(discardPending)
    }

    @Test("Overloaded terminal input remains retryable and retains pending bytes")
    func terminalInputOverloadedConformance() throws {
        let fixture = try V1ConformanceFixture.load()
        let vector = try #require(
            fixture.serverEventCases.first { $0.name == "terminal_input_overloaded" }
        )
        let envelope = try ControlCodec.decodeServer(JSONEncoder().encode(vector.json))

        #expect(envelope.type == "terminal_input_fault")
        #expect(envelope.uint64("stream_id") == 8)
        #expect(envelope.uint64("generation") == 4)
        #expect(envelope.string("code") == "overloaded")
        #expect(envelope.uint64("authoritative_through") == 65_536)
        guard case let .bool(discardPending)? = envelope.fields["discard_pending"] else {
            Issue.record("Expected discard_pending boolean")
            return
        }
        #expect(!discardPending)
    }

    @Test("Mutating calls require an idempotency key")
    func mutationRequiresIdempotency() {
        #expect(throws: ControlProtocolError.missingIdempotencyKey) {
            try CallMessage(method: .sessionStart)
        }
    }

    @Test("Deadlines are bounded")
    func deadlineBounds() {
        #expect(throws: ControlProtocolError.invalidDeadline) {
            try CallMessage(method: .fileRead, deadlineMilliseconds: 0)
        }
        #expect(throws: ControlProtocolError.invalidDeadline) {
            try CallMessage(method: .fileRead, deadlineMilliseconds: 60_001)
        }
    }

    @Test("Large control messages are rejected before transport")
    func maximumControlSize() {
        let fields = ["payload": JSONValue.string(String(repeating: "x", count: ControlProtocol.maximumMessageBytes))]
        do {
            _ = try ControlCodec.encode(fields)
            Issue.record("Expected an oversized control-message error")
        } catch let error as ControlProtocolError {
            guard case .messageTooLarge = error else {
                Issue.record("Unexpected control error: \(error)")
                return
            }
        } catch {
            Issue.record("Unexpected error type: \(error)")
        }
    }
}
