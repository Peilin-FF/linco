import Foundation

public struct PairingPayload: Sendable, Equatable, Codable {
    public static let currentVersion = 1
    public static let maximumLifetime: TimeInterval = 120

    public let version: Int
    public let endpoint: URL
    public let serverIdentity: Data
    public let pairingID: UUID
    public let secret: Data
    public let expiresAt: Date

    public init(qrCode: String, now: Date = Date()) throws {
        guard let data = qrCode.data(using: .utf8) else {
            throw PairingPayloadError.invalidEncoding
        }
        let wire: WirePayload
        do {
            wire = try JSONDecoder().decode(WirePayload.self, from: data)
        } catch {
            throw PairingPayloadError.invalidEncoding
        }

        guard wire.version == Self.currentVersion else {
            throw PairingPayloadError.unsupportedVersion(wire.version)
        }
        guard let endpoint = URL(string: wire.endpoint),
              endpoint.scheme?.lowercased() == "https",
              endpoint.host != nil,
              endpoint.user == nil,
              endpoint.password == nil,
              endpoint.query == nil,
              endpoint.fragment == nil else {
            throw PairingPayloadError.insecureOrInvalidEndpoint
        }
        guard let serverIdentity = Data(base64URL: wire.serverIdentity), serverIdentity.count == 32 else {
            throw PairingPayloadError.invalidServerIdentity
        }
        guard let secret = Data(base64URL: wire.secret), secret.count == 32 else {
            throw PairingPayloadError.invalidSecret
        }

        let expiresAt = Date(timeIntervalSince1970: TimeInterval(wire.expiresAtMilliseconds) / 1_000)
        guard expiresAt > now else { throw PairingPayloadError.expired }
        guard expiresAt.timeIntervalSince(now) <= Self.maximumLifetime else {
            throw PairingPayloadError.excessiveLifetime
        }

        self.version = wire.version
        self.endpoint = endpoint
        self.serverIdentity = serverIdentity
        self.pairingID = wire.pairingID
        self.secret = secret
        self.expiresAt = expiresAt
    }

    private struct WirePayload: Codable {
        let version: Int
        let endpoint: String
        let serverIdentity: String
        let pairingID: UUID
        let secret: String
        let expiresAtMilliseconds: UInt64

        enum CodingKeys: String, CodingKey {
            case version = "protocol_version"
            case endpoint
            case serverIdentity = "server_identity_b64"
            case pairingID = "pairing_id"
            case secret = "pairing_secret_b64"
            case expiresAtMilliseconds = "expires_at_ms"
        }
    }
}

public enum PairingPayloadError: LocalizedError, Sendable, Equatable {
    case invalidEncoding
    case unsupportedVersion(Int)
    case insecureOrInvalidEndpoint
    case invalidServerIdentity
    case invalidSecret
    case expired
    case excessiveLifetime

    public var errorDescription: String? {
        switch self {
        case .invalidEncoding: "二维码不是有效的 Linco 配对内容。"
        case let .unsupportedVersion(version): "二维码协议版本 \(version) 不受支持。"
        case .insecureOrInvalidEndpoint: "二维码必须包含不带凭证或查询参数的 HTTPS 服务器地址。"
        case .invalidServerIdentity: "二维码中的服务器身份无效。"
        case .invalidSecret: "二维码中的一次性配对密钥无效。"
        case .expired: "配对二维码已过期，请在服务器上重新生成。"
        case .excessiveLifetime: "二维码有效期超过 120 秒，已按安全策略拒绝。"
        }
    }
}

public extension Data {
    init?(base64URL value: String) {
        var base64 = value.replacingOccurrences(of: "-", with: "+")
            .replacingOccurrences(of: "_", with: "/")
        let remainder = base64.count % 4
        if remainder != 0 {
            base64.append(String(repeating: "=", count: 4 - remainder))
        }
        self.init(base64Encoded: base64)
    }

    var base64URLString: String {
        base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }
}
