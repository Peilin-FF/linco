import CryptoKit
import Foundation
import Testing
@testable import LincoCore

@Suite("Server hello identity proof")
struct ServerHelloProofTests {
    @Test("Accepts only the pinned Ed25519 identity")
    func validProof() throws {
        let key = Curve25519.Signing.PrivateKey()
        let fields = Fields(identity: key.publicKey.rawRepresentation)
        let transcript = try fields.transcript()
        let signature = try key.signature(for: transcript)

        #expect(try fields.verify(signature: signature))
    }

    @Test("Rejects a tampered challenge")
    func tampering() throws {
        let key = Curve25519.Signing.PrivateKey()
        let fields = Fields(identity: key.publicKey.rawRepresentation)
        let signature = try key.signature(for: fields.transcript())
        var tampered = fields
        tampered.challenge[0] ^= 0xff

        #expect(try !tampered.verify(signature: signature))
    }

    @Test("Rejects a signature from another server identity")
    func wrongKey() throws {
        let pinned = Curve25519.Signing.PrivateKey()
        let attacker = Curve25519.Signing.PrivateKey()
        let fields = Fields(identity: pinned.publicKey.rawRepresentation)
        let signature = try attacker.signature(for: fields.transcript())

        #expect(try !fields.verify(signature: signature))
    }

    private struct Fields {
        var identity: Data
        var challenge = Data(repeating: 0x22, count: 32)
        let nonce = Data(repeating: 0x11, count: 32)
        let connectionID = UUID(uuidString: "00112233-4455-6677-8899-aabbccddeeff")!
        let epoch = UUID(uuidString: "ffeeddcc-bbaa-9988-7766-554433221100")!

        func transcript() throws -> Data {
            try ServerHelloProof.transcript(
                protocolVersion: 1,
                lane: .control,
                connectionID: connectionID,
                serverEpoch: epoch,
                clientNonce: nonce,
                challenge: challenge,
                serverIdentity: identity
            )
        }

        func verify(signature: Data) throws -> Bool {
            try ServerHelloProof.verify(
                signature: signature,
                protocolVersion: 1,
                lane: .control,
                connectionID: connectionID,
                serverEpoch: epoch,
                clientNonce: nonce,
                challenge: challenge,
                serverIdentity: identity
            )
        }
    }
}
