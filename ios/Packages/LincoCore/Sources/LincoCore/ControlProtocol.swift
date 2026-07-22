import Foundation

public enum ControlProtocol {
    public static let version: UInt8 = 1
    public static let maximumMessageBytes = 64 * 1_024
}

public enum ConnectionPath: String, Sendable, Equatable, Codable {
    case direct
}

public struct ResumeCursor: Sendable, Equatable, Codable {
    public var streams: [String: UInt64]

    public init(streams: [UInt32: UInt64] = [:]) {
        self.streams = Dictionary(uniqueKeysWithValues: streams.map { (String($0.key), $0.value) })
    }

    public func streamSequence(for streamID: UInt32) -> UInt64? {
        streams[String(streamID)]
    }
}

public struct HelloMessage: Sendable, Equatable, Codable {
    public let type = "hello"
    public let protocolVersion: UInt8
    public let lane: LogicalChannel
    public let connectionID: UUID?
    public let deviceID: UUID?
    public let clientNonceBase64: String
    public let resume: ResumeCursor

    public init(
        lane: LogicalChannel,
        connectionID: UUID? = nil,
        deviceID: UUID? = nil,
        clientNonce: Data,
        resume: ResumeCursor = ResumeCursor()
    ) {
        self.protocolVersion = ControlProtocol.version
        self.lane = lane
        self.connectionID = connectionID
        self.deviceID = deviceID
        self.clientNonceBase64 = clientNonce.base64URLString
        self.resume = resume
    }

    enum CodingKeys: String, CodingKey {
        case type
        case protocolVersion = "protocol_version"
        case lane
        case connectionID = "connection_id"
        case deviceID = "device_id"
        case clientNonceBase64 = "client_nonce_b64"
        case resume
    }
}

public struct AuthenticateMessage: Sendable, Equatable, Codable {
    public let type = "authenticate"
    public let connectionID: UUID
    public let deviceID: UUID
    public let challengeSignatureBase64: String

    public init(connectionID: UUID, deviceID: UUID, challengeSignature: Data) {
        self.connectionID = connectionID
        self.deviceID = deviceID
        self.challengeSignatureBase64 = challengeSignature.base64URLString
    }

    enum CodingKeys: String, CodingKey {
        case type
        case connectionID = "connection_id"
        case deviceID = "device_id"
        case challengeSignatureBase64 = "challenge_signature_b64"
    }
}

public struct AttachLaneMessage: Sendable, Equatable, Codable {
    public let type = "attach_lane"
    public let connectionID: UUID
    public let lane: LogicalChannel
    public let ticketBase64: String
    public let clientNonceBase64: String

    public init(connectionID: UUID, lane: LogicalChannel, ticket: Data, clientNonce: Data) {
        self.connectionID = connectionID
        self.lane = lane
        self.ticketBase64 = ticket.base64URLString
        self.clientNonceBase64 = clientNonce.base64URLString
    }

    enum CodingKeys: String, CodingKey {
        case type
        case connectionID = "connection_id"
        case lane
        case ticketBase64 = "ticket_b64"
        case clientNonceBase64 = "client_nonce_b64"
    }
}

public struct PairStartMessage: Sendable, Equatable, Codable {
    public let type = "pair_start"
    public let pairingID: UUID
    public let deviceName: String
    public let deviceKeyAlgorithm: KeyAlgorithm
    public let devicePublicKeyBase64: String
    public let clientNonceBase64: String

    public init(pairingID: UUID, deviceName: String, devicePublicKey: Data, clientNonce: Data) {
        self.pairingID = pairingID
        self.deviceName = deviceName
        self.deviceKeyAlgorithm = .p256
        self.devicePublicKeyBase64 = devicePublicKey.base64URLString
        self.clientNonceBase64 = clientNonce.base64URLString
    }

    enum CodingKeys: String, CodingKey {
        case type
        case pairingID = "pairing_id"
        case deviceName = "device_name"
        case deviceKeyAlgorithm = "device_key_algorithm"
        case devicePublicKeyBase64 = "device_public_key_b64"
        case clientNonceBase64 = "client_nonce_b64"
    }
}

public enum KeyAlgorithm: String, Sendable, Equatable, Codable {
    case p256
}

public struct PairFinishMessage: Sendable, Equatable, Codable {
    public let type = "pair_finish"
    public let pairingID: UUID
    public let proofBase64: String
    public let deviceSignatureBase64: String

    public init(pairingID: UUID, proof: Data, deviceSignature: Data) {
        self.pairingID = pairingID
        self.proofBase64 = proof.base64URLString
        self.deviceSignatureBase64 = deviceSignature.base64URLString
    }

    enum CodingKeys: String, CodingKey {
        case type
        case pairingID = "pairing_id"
        case proofBase64 = "proof_b64"
        case deviceSignatureBase64 = "device_signature_b64"
    }
}

public enum RPCPermission: String, Sendable, Codable, CaseIterable, Hashable {
    case read
    case terminal
    case write
}

public enum RPCMethod: String, Sendable, Codable, CaseIterable {
    case systemInfo = "system_info"
    case workspaceList = "workspace_list"
    case sessionList = "session_list"
    case sessionStart = "session_start"
    case sessionStop = "session_stop"
    case sessionResume = "session_resume"
    case terminalDetach = "terminal_detach"
    case terminalResize = "terminal_resize"
    case fileList = "file_list"
    case fileRead = "file_read"
    case fileWrite = "file_write"
    case previewResolve = "preview_resolve"

    public var isMutating: Bool {
        self == .sessionStart
    }

    public var requiredPermission: RPCPermission {
        switch self {
        case .systemInfo, .workspaceList, .sessionList, .fileList, .fileRead, .previewResolve:
            .read
        case .sessionStart, .sessionStop, .sessionResume, .terminalDetach, .terminalResize:
            .terminal
        case .fileWrite:
            .write
        }
    }
}

public struct CallMessage: Sendable, Equatable, Codable {
    public let type = "call"
    public let id: UUID
    public let method: RPCMethod
    public let params: JSONValue
    public let idempotencyKey: UUID?
    public let deadlineMilliseconds: UInt64

    public init(
        id: UUID = UUID(),
        method: RPCMethod,
        params: JSONValue = .object([:]),
        idempotencyKey: UUID? = nil,
        deadlineMilliseconds: UInt64 = 5_000
    ) throws {
        guard (1...60_000).contains(deadlineMilliseconds) else {
            throw ControlProtocolError.invalidDeadline
        }
        guard !method.isMutating || idempotencyKey != nil else {
            throw ControlProtocolError.missingIdempotencyKey
        }
        self.id = id
        self.method = method
        self.params = params
        self.idempotencyKey = idempotencyKey
        self.deadlineMilliseconds = deadlineMilliseconds
    }

    enum CodingKeys: String, CodingKey {
        case type, id, method, params
        case idempotencyKey = "idempotency_key"
        case deadlineMilliseconds = "deadline_ms"
    }
}

public struct CancelMessage: Sendable, Equatable, Codable {
    public let type = "cancel"
    public let id: UUID

    public init(id: UUID) {
        self.id = id
    }

    enum CodingKeys: String, CodingKey {
        case type, id
    }
}

public struct ServerEnvelope: Sendable, Equatable {
    public let type: String
    public let fields: [String: JSONValue]

    public func string(_ key: String) -> String? { fields[key]?.stringValue }
    public func uint64(_ key: String) -> UInt64? { fields[key]?.uint64Value }
    public func uuid(_ key: String) -> UUID? { string(key).flatMap(UUID.init(uuidString:)) }
}

public enum ControlCodec {
    public static func encode<T: Encodable>(_ message: T) throws -> Data {
        let data = try JSONEncoder().encode(message)
        guard data.count <= ControlProtocol.maximumMessageBytes else {
            throw ControlProtocolError.messageTooLarge(actual: data.count)
        }
        return data
    }

    public static func decodeServer(_ data: Data) throws -> ServerEnvelope {
        guard data.count <= ControlProtocol.maximumMessageBytes else {
            throw ControlProtocolError.messageTooLarge(actual: data.count)
        }
        let root = try JSONDecoder().decode(JSONValue.self, from: data)
        guard case var .object(fields) = root,
              case let .string(type)? = fields.removeValue(forKey: "type") else {
            throw ControlProtocolError.invalidEnvelope
        }
        return ServerEnvelope(type: type, fields: fields)
    }
}

public enum ControlProtocolError: Error, Sendable, Equatable {
    case messageTooLarge(actual: Int)
    case invalidEnvelope
    case invalidDeadline
    case missingIdempotencyKey
}
