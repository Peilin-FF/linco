import Foundation
import LincoCore

struct ServerProfile: Codable, Hashable, Sendable {
    let endpoint: URL
    let serverIdentity: Data
    let deviceID: UUID
    let permissions: Set<Permission>
    let pairedAt: Date
}

typealias Permission = RPCPermission

enum SessionKind: String, Codable, Sendable, Hashable {
    case shell
    case claude
    case codex

    var displayName: String {
        switch self {
        case .shell: "Shell"
        case .claude: "Claude Code"
        case .codex: "Codex"
        }
    }

    var symbol: String {
        switch self {
        case .shell: "terminal"
        case .claude: "sparkles"
        case .codex: "chevron.left.forwardslash.chevron.right"
        }
    }
}

enum SessionState: String, Codable, Sendable, Hashable {
    case ready
    case exited
    case failed

    var label: String {
        switch self {
        case .ready: "就绪"
        case .exited: "已结束"
        case .failed: "异常退出"
        }
    }

    var keepsTerminalStreamOpen: Bool {
        switch self {
        case .ready: true
        case .exited, .failed: false
        }
    }
}

struct RemoteSession: Identifiable, Decodable, Hashable, Sendable {
    let id: UUID
    let streamID: UInt32
    let generation: UInt64
    let title: String
    let workspaceName: String
    let kind: SessionKind
    let state: SessionState
    let updatedAt: Date

    enum CodingKeys: String, CodingKey {
        case id
        case streamID = "stream_id"
        case generation
        case title
        case workspaceName = "workspace_name"
        case kind, state
        case updatedAt = "updated_at"
    }
}

enum RemoteFileKind: String, Hashable, Sendable {
    case directory
    case file
    case other
}

struct RemoteFile: Identifiable, Hashable, Sendable {
    var id: String { path }
    let path: String
    let name: String
    let kind: RemoteFileKind
    let size: UInt64?
    let modifiedAt: UInt64?
    let entityTag: String?

    var isDirectory: Bool { kind == .directory }
}

struct RemoteWorkspace: Identifiable, Hashable, Sendable {
    let id: String
    let name: String
}

struct RemoteFileContent: Sendable, Equatable {
    let text: String
    let revision: String?
}

enum AppConnectionStatus: Equatable, Sendable {
    case disconnected
    case connecting
    case authenticating
    case ready(path: String, latencyMilliseconds: Int?)
    case reconnecting(attempt: Int)
    case failed(message: String)

    var isReady: Bool {
        if case .ready = self { return true }
        return false
    }

    var isConnecting: Bool {
        switch self {
        case .connecting, .authenticating: true
        default: false
        }
    }
}
