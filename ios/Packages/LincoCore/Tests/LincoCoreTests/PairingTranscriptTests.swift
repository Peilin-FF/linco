import Foundation
import Testing
@testable import LincoCore

@Suite("Pairing transcript")
struct PairingTranscriptTests {
    @Test("Canonical transcript has fixed layout without JSON or length prefixes")
    func canonicalLayout() throws {
        let pairingID = try #require(UUID(uuidString: "00112233-4455-6677-8899-aabbccddeeff"))
        let transcript = try PairingTranscript.encode(
            pairingID: pairingID,
            clientNonce: Data(repeating: 0x11, count: 32),
            serverChallenge: Data(repeating: 0x22, count: 32),
            devicePublicKey: Data([0x04]) + Data(repeating: 0x33, count: 64),
            serverIdentity: Data(repeating: 0x44, count: 32)
        )

        #expect(transcript.count == 191)
        #expect(transcript.prefix(14) == Data("linco-pair-v1\0".utf8))
        #expect(transcript[14..<30] == Data([0x00, 0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77, 0x88, 0x99, 0xaa, 0xbb, 0xcc, 0xdd, 0xee, 0xff]))
        #expect(transcript[30..<62] == Data(repeating: 0x11, count: 32))
        #expect(transcript[62..<94] == Data(repeating: 0x22, count: 32))
    }

    @Test("Rejects malformed fixed-size fields")
    func rejectsMalformedField() {
        #expect(throws: PairingTranscriptError.invalidServerChallengeLength(31)) {
            try PairingTranscript.encode(
                pairingID: UUID(),
                clientNonce: Data(repeating: 0, count: 32),
                serverChallenge: Data(repeating: 0, count: 31),
                devicePublicKey: Data([0x04]) + Data(repeating: 0, count: 64),
                serverIdentity: Data(repeating: 0, count: 32)
            )
        }
    }
}
