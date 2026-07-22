import Foundation
import Security

enum KeychainStore {
    static func read(service: String, account: String) throws -> Data? {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecMatchLimit as String: kSecMatchLimitOne,
            kSecReturnData as String: true
        ]
        var result: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &result)
        switch status {
        case errSecSuccess:
            guard let data = result as? Data else { throw KeychainError.unexpectedResult }
            return data
        case errSecItemNotFound:
            return nil
        default:
            throw KeychainError.status(status)
        }
    }

    static func write(_ data: Data, service: String, account: String) throws {
        let selector: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account
        ]
        let attributes: [String: Any] = [
            kSecValueData as String: data,
            kSecAttrAccessible as String: kSecAttrAccessibleWhenUnlockedThisDeviceOnly
        ]

        let updateStatus = SecItemUpdate(selector as CFDictionary, attributes as CFDictionary)
        if updateStatus == errSecSuccess { return }
        guard updateStatus == errSecItemNotFound else { throw KeychainError.status(updateStatus) }

        var insertion = selector
        attributes.forEach { insertion[$0.key] = $0.value }
        let addStatus = SecItemAdd(insertion as CFDictionary, nil)
        guard addStatus == errSecSuccess else { throw KeychainError.status(addStatus) }
    }

    static func delete(service: String, account: String) throws {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account
        ]
        let status = SecItemDelete(query as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else {
            throw KeychainError.status(status)
        }
    }
}
enum KeychainError: LocalizedError {
    case status(OSStatus)
    case unexpectedResult

    var errorDescription: String? {
        switch self {
        case let .status(status):
            SecCopyErrorMessageString(status, nil) as String? ?? "钥匙串错误（\(status)）"
        case .unexpectedResult:
            "钥匙串返回了无法识别的数据"
        }
    }
}

enum ServerProfileStore {
    private static let service = "app.linco.iphone"
    private static let account = "paired-server-v1"

    static func load() throws -> ServerProfile? {
        guard let data = try KeychainStore.read(service: service, account: account) else { return nil }
        return try JSONDecoder().decode(ServerProfile.self, from: data)
    }

    static func save(_ profile: ServerProfile) throws {
        let data = try JSONEncoder().encode(profile)
        try KeychainStore.write(data, service: service, account: account)
    }

    static func remove() throws {
        try KeychainStore.delete(service: service, account: account)
    }
}
