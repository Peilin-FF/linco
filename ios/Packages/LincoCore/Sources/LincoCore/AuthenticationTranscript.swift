import Foundation

public enum AuthenticationTranscript {
    private static let domain = Data("linco-auth-v1\0".utf8)

    public static func encode(
        connectionID: UUID,
        deviceID: UUID,
        serverEpoch: UUID,
        clientNonce: Data,
        challenge: Data,
        serverIdentity: Data
    ) throws -> Data {
        guard challenge.count == 32 else {
            throw AuthenticationTranscriptError.invalidChallengeLength(challenge.count)
        }
        guard clientNonce.count == 32 else {
            throw AuthenticationTranscriptError.invalidClientNonceLength(clientNonce.count)
        }
        guard serverIdentity.count == 32 else {
            throw AuthenticationTranscriptError.invalidServerIdentityLength(serverIdentity.count)
        }

        var result = Data(capacity: 158)
        result.append(domain)
        [connectionID, deviceID, serverEpoch].forEach { identifier in
            var uuid = identifier.uuid
            Swift.withUnsafeBytes(of: &uuid) { result.append(contentsOf: $0) }
        }
        result.append(clientNonce)
        result.append(challenge)
        result.append(serverIdentity)
        return result
    }
}

public enum AuthenticationTranscriptError: Error, Sendable, Equatable {
    case invalidChallengeLength(Int)
    case invalidClientNonceLength(Int)
    case invalidServerIdentityLength(Int)
}
