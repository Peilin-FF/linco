import CryptoKit
import Foundation
import Security

actor DeviceIdentity {
    static let shared = DeviceIdentity()

    private let keyService = "app.linco.iphone.device-identity"
    private let keyAccount = "secure-enclave-p256-v1"
    private var cachedKey: SecureEnclave.P256.Signing.PrivateKey?

    func publicKey() throws -> Data {
        try key().publicKey.x963Representation
    }

    func signature(for transcript: Data) throws -> Data {
        try key().signature(for: transcript).derRepresentation
    }

    func delete() throws {
        cachedKey = nil
        try KeychainStore.delete(service: keyService, account: keyAccount)
    }

    private func key() throws -> SecureEnclave.P256.Signing.PrivateKey {
        if let cachedKey { return cachedKey }

        if let representation = try KeychainStore.read(service: keyService, account: keyAccount) {
            let restored = try SecureEnclave.P256.Signing.PrivateKey(dataRepresentation: representation)
            cachedKey = restored
            return restored
        }

        guard SecureEnclave.isAvailable else { throw DeviceIdentityError.secureEnclaveUnavailable }
        var accessControlError: Unmanaged<CFError>?
        guard let accessControl = SecAccessControlCreateWithFlags(
            nil,
            kSecAttrAccessibleWhenUnlockedThisDeviceOnly,
            [.privateKeyUsage],
            &accessControlError
        ) else {
            if let accessControlError {
                throw accessControlError.takeRetainedValue()
            }
            throw DeviceIdentityError.accessControlCreationFailed
        }

        let generated = try SecureEnclave.P256.Signing.PrivateKey(
            compactRepresentable: false,
            accessControl: accessControl
        )
        try KeychainStore.write(generated.dataRepresentation, service: keyService, account: keyAccount)
        cachedKey = generated
        return generated
    }
}

enum DeviceIdentityError: LocalizedError {
    case secureEnclaveUnavailable
    case accessControlCreationFailed

    var errorDescription: String? {
        switch self {
        case .secureEnclaveUnavailable:
            "这台设备不支持安全隔区，无法创建 Linco 设备身份。"
        case .accessControlCreationFailed:
            "无法创建受保护的设备密钥。"
        }
    }
}
