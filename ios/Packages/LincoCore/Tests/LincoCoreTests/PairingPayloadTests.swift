import Foundation
import Testing
@testable import LincoCore

@Suite("Pairing QR")
struct PairingPayloadTests {
    private let now = Date(timeIntervalSince1970: 1_750_000_000)

    @Test("Accepts a short-lived WSS payload")
    func validPayload() throws {
        let qr = makeQR(endpoint: "https://dev.example.com/linco", expiryOffset: 90)
        let payload = try PairingPayload(qrCode: qr, now: now)

        #expect(payload.endpoint.host == "dev.example.com")
        #expect(payload.secret.count == 32)
        #expect(payload.serverIdentity == Data(repeating: 0xab, count: 32))
    }

    @Test("Rejects cleartext endpoints")
    func rejectsCleartext() {
        let qr = makeQR(endpoint: "http://dev.example.com/linco", expiryOffset: 90)
        #expect(throws: PairingPayloadError.insecureOrInvalidEndpoint) {
            try PairingPayload(qrCode: qr, now: now)
        }
    }

    @Test("Rejects replayable long-lived QR codes")
    func rejectsExcessiveLifetime() {
        let qr = makeQR(endpoint: "https://dev.example.com/linco", expiryOffset: 121)
        #expect(throws: PairingPayloadError.excessiveLifetime) {
            try PairingPayload(qrCode: qr, now: now)
        }
    }

    private func makeQR(endpoint: String, expiryOffset: TimeInterval) -> String {
        let object: [String: Any] = [
            "protocol_version": 1,
            "endpoint": endpoint,
            "server_identity_b64": Data(repeating: 0xab, count: 32).base64URLString,
            "pairing_id": "01922b1c-42a0-7000-8000-000000000001",
            "pairing_secret_b64": Data(repeating: 0xcd, count: 32).base64URLString,
            "expires_at_ms": UInt64((now.timeIntervalSince1970 + expiryOffset) * 1_000)
        ]
        let data = try! JSONSerialization.data(withJSONObject: object, options: [.sortedKeys])
        return String(decoding: data, as: UTF8.self)
    }
}
