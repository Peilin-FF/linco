import CryptoKit
import Foundation

public enum ServerHelloProof {
    private static let domain = Data("linco-server-hello-v1\0".utf8)

    public static func transcript(
        protocolVersion: UInt8,
        lane: LogicalChannel,
        connectionID: UUID,
        serverEpoch: UUID,
        clientNonce: Data,
        challenge: Data,
        serverIdentity: Data
    ) throws -> Data {
        guard clientNonce.count == 32 else { throw ServerHelloProofError.invalidClientNonceLength(clientNonce.count) }
        guard challenge.count == 32 else { throw ServerHelloProofError.invalidChallengeLength(challenge.count) }
        guard serverIdentity.count == 32 else { throw ServerHelloProofError.invalidIdentityLength(serverIdentity.count) }

        var result = Data(capacity: 152)
        result.append(domain)
        result.append(protocolVersion)
        result.append(lane.wireValue)
        [connectionID, serverEpoch].forEach { identifier in
            var uuid = identifier.uuid
            Swift.withUnsafeBytes(of: &uuid) { result.append(contentsOf: $0) }
        }
        result.append(clientNonce)
        result.append(challenge)
        result.append(serverIdentity)
        return result
    }

    public static func verify(
        signature: Data,
        protocolVersion: UInt8,
        lane: LogicalChannel,
        connectionID: UUID,
        serverEpoch: UUID,
        clientNonce: Data,
        challenge: Data,
        serverIdentity: Data
    ) throws -> Bool {
        guard signature.count == 64 else { throw ServerHelloProofError.invalidSignatureLength(signature.count) }
        let transcript = try transcript(
            protocolVersion: protocolVersion,
            lane: lane,
            connectionID: connectionID,
            serverEpoch: serverEpoch,
            clientNonce: clientNonce,
            challenge: challenge,
            serverIdentity: serverIdentity
        )
        let key = try Curve25519.Signing.PublicKey(rawRepresentation: serverIdentity)
        return key.isValidSignature(signature, for: transcript)
    }
}

public enum ServerHelloProofError: Error, Sendable, Equatable {
    case invalidClientNonceLength(Int)
    case invalidChallengeLength(Int)
    case invalidIdentityLength(Int)
    case invalidSignatureLength(Int)
}
