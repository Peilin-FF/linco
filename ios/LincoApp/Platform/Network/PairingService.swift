import CryptoKit
import Foundation
import LincoCore
import Security
import UIKit

struct PairingService: Sendable {
    private let identity: DeviceIdentity

    init(identity: DeviceIdentity = .shared) {
        self.identity = identity
    }

    func pair(payload: PairingPayload) async throws -> ServerProfile {
        guard payload.expiresAt > Date() else { throw PairingServiceError.expired }

        let socket = try LincoWebSocket(baseURL: payload.endpoint, lane: .control)
        try await socket.open()
        defer { Task { await socket.close() } }

        return try await withLincoTimeout(.seconds(15), onTimeout: {
            await socket.close()
        }) {
            try await self.performPair(payload: payload, socket: socket)
        }
    }

    private func performPair(payload: PairingPayload, socket: LincoWebSocket) async throws -> ServerProfile {
        let clientNonce = try SecureRandom.bytes(count: 32)
        try await socket.sendControl(HelloMessage(lane: .control, clientNonce: clientNonce))

        let hello = try await receiveControl(from: socket, expecting: "hello")
        guard hello.uint64("protocol_version") == UInt64(ControlProtocol.version) else {
            throw PairingServiceError.unsupportedVersion
        }
        guard let encodedIdentity = hello.string("server_identity_b64"),
              Data(base64URL: encodedIdentity) == payload.serverIdentity else {
            throw PairingServiceError.serverIdentityMismatch
        }
        try verifyServerHello(hello, expectedIdentity: payload.serverIdentity, clientNonce: clientNonce)

        let devicePublicKey = try await identity.publicKey()
        let deviceName = await MainActor.run { UIDevice.current.name }
        try await socket.sendControl(PairStartMessage(
            pairingID: payload.pairingID,
            deviceName: String(deviceName.prefix(80)),
            devicePublicKey: devicePublicKey,
            clientNonce: clientNonce
        ))

        let challengeMessage = try await receiveControl(from: socket, expecting: "pair_challenge")
        guard challengeMessage.uuid("pairing_id") == payload.pairingID,
              let challengeEncoded = challengeMessage.string("challenge_b64"),
              let challenge = Data(base64URL: challengeEncoded),
              let challengeExpiry = challengeMessage.uint64("expires_at_ms"),
              challengeExpiry > UInt64(Date().timeIntervalSince1970 * 1_000) else {
            throw PairingServiceError.invalidChallenge
        }

        let transcript = try PairingTranscript.encode(
            pairingID: payload.pairingID,
            clientNonce: clientNonce,
            serverChallenge: challenge,
            devicePublicKey: devicePublicKey,
            serverIdentity: payload.serverIdentity
        )
        let proof = Data(HMAC<SHA256>.authenticationCode(
            for: transcript,
            using: SymmetricKey(data: payload.secret)
        ))
        let signature = try await identity.signature(for: transcript)
        try await socket.sendControl(PairFinishMessage(
            pairingID: payload.pairingID,
            proof: proof,
            deviceSignature: signature
        ))

        let accepted = try await receiveControl(from: socket, expecting: "pair_accepted")
        guard let deviceID = accepted.uuid("device_id") else { throw PairingServiceError.invalidAcceptance }
        let permissions = Set((accepted.fields["permissions"]?.arrayValue ?? []).compactMap {
            $0.stringValue.flatMap(Permission.init(rawValue:))
        })
        return ServerProfile(
            endpoint: payload.endpoint,
            serverIdentity: payload.serverIdentity,
            deviceID: deviceID,
            permissions: permissions,
            pairedAt: Date()
        )
    }

    private func receiveControl(from socket: LincoWebSocket, expecting type: String) async throws -> ServerEnvelope {
        guard case let .control(message) = try await socket.receive() else {
            throw PairingServiceError.unexpectedMessage
        }
        if message.type == "error" {
            throw PairingServiceError.server(message.string("message") ?? "服务器拒绝了配对请求。")
        }
        guard message.type == type else { throw PairingServiceError.unexpectedMessage }
        return message
    }

    private func verifyServerHello(_ message: ServerEnvelope, expectedIdentity: Data, clientNonce: Data) throws {
        guard message.string("lane") == LogicalChannel.control.rawValue,
              let connectionID = message.uuid("connection_id"),
              let serverEpoch = message.uuid("server_epoch"),
              let challenge = message.string("auth_challenge_b64").flatMap({ Data(base64URL: $0) }),
              let signature = message.string("server_signature_b64").flatMap({ Data(base64URL: $0) }),
              try ServerHelloProof.verify(
                signature: signature,
                protocolVersion: ControlProtocol.version,
                lane: .control,
                connectionID: connectionID,
                serverEpoch: serverEpoch,
                clientNonce: clientNonce,
                challenge: challenge,
                serverIdentity: expectedIdentity
              ) else {
            throw PairingServiceError.serverIdentityMismatch
        }
    }
}

private enum SecureRandom {
    static func bytes(count: Int) throws -> Data {
        var data = Data(repeating: 0, count: count)
        let status = data.withUnsafeMutableBytes { buffer in
            SecRandomCopyBytes(kSecRandomDefault, count, buffer.baseAddress!)
        }
        guard status == errSecSuccess else { throw PairingServiceError.randomGenerationFailed }
        return data
    }
}

enum PairingServiceError: LocalizedError, Sendable {
    case expired
    case unsupportedVersion
    case serverIdentityMismatch
    case invalidChallenge
    case invalidAcceptance
    case unexpectedMessage
    case randomGenerationFailed
    case server(String)

    var errorDescription: String? {
        switch self {
        case .expired: "配对二维码已过期，请在服务器上重新生成。"
        case .unsupportedVersion: "服务器协议版本与此 App 不兼容。"
        case .serverIdentityMismatch: "服务器身份与二维码不一致，连接已中止。"
        case .invalidChallenge: "服务器的配对质询无效。"
        case .invalidAcceptance: "服务器没有返回有效的设备授权。"
        case .unexpectedMessage: "服务器返回了意外的配对消息。"
        case .randomGenerationFailed: "无法生成安全随机数。"
        case let .server(message): message
        }
    }
}
