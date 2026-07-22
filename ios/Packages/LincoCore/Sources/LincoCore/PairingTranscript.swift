import Foundation

public enum PairingTranscript {
    private static let domain = Data([0x6c, 0x69, 0x6e, 0x63, 0x6f, 0x2d, 0x70, 0x61, 0x69, 0x72, 0x2d, 0x76, 0x31, 0x00])

    public static func encode(
        pairingID: UUID,
        clientNonce: Data,
        serverChallenge: Data,
        devicePublicKey: Data,
        serverIdentity: Data
    ) throws -> Data {
        guard clientNonce.count == 32 else {
            throw PairingTranscriptError.invalidClientNonceLength(clientNonce.count)
        }
        guard serverChallenge.count == 32 else {
            throw PairingTranscriptError.invalidServerChallengeLength(serverChallenge.count)
        }
        guard devicePublicKey.count == 65, devicePublicKey.first == 0x04 else {
            throw PairingTranscriptError.invalidDevicePublicKey
        }
        guard serverIdentity.count == 32 else {
            throw PairingTranscriptError.invalidServerIdentityLength(serverIdentity.count)
        }

        var transcript = Data(capacity: 14 + 16 + 32 + 32 + 65 + 32)
        transcript.append(domain)
        var uuid = pairingID.uuid
        Swift.withUnsafeBytes(of: &uuid) { transcript.append(contentsOf: $0) }
        transcript.append(clientNonce)
        transcript.append(serverChallenge)
        transcript.append(devicePublicKey)
        transcript.append(serverIdentity)
        return transcript
    }
}

public enum PairingTranscriptError: Error, Sendable, Equatable {
    case invalidClientNonceLength(Int)
    case invalidServerChallengeLength(Int)
    case invalidDevicePublicKey
    case invalidServerIdentityLength(Int)
}
