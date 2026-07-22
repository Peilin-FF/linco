import Foundation
import Testing
@testable import LincoCore

@Suite("Device authentication transcript")
struct AuthenticationTranscriptTests {
    @Test("Binds the connection, server challenge, and client nonce")
    func canonicalLayout() throws {
        let connectionID = try #require(UUID(uuidString: "00112233-4455-6677-8899-aabbccddeeff"))
        let deviceID = try #require(UUID(uuidString: "10213243-5465-7687-98a9-bacbdcedfe0f"))
        let serverEpoch = try #require(UUID(uuidString: "ffeeddcc-bbaa-9988-7766-554433221100"))
        let transcript = try AuthenticationTranscript.encode(
            connectionID: connectionID,
            deviceID: deviceID,
            serverEpoch: serverEpoch,
            clientNonce: Data(repeating: 0xbb, count: 32),
            challenge: Data(repeating: 0xaa, count: 32),
            serverIdentity: Data(repeating: 0xcc, count: 32)
        )

        #expect(transcript.prefix(14) == Data("linco-auth-v1\0".utf8))
        #expect(transcript[14..<30] == Data([0x00, 0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77, 0x88, 0x99, 0xaa, 0xbb, 0xcc, 0xdd, 0xee, 0xff]))
        #expect(transcript.count == 158)
    }
}
