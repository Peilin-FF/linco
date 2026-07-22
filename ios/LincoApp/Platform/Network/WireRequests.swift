import Foundation
import LincoCore

struct SessionStartWireRequest: Sendable, Equatable {
    let sessionID: UUID
    let idempotencyKey: UUID
    let workspaceID: String
    let kind: SessionKind

    init(
        sessionID: UUID = UUID(),
        idempotencyKey: UUID = UUID(),
        workspaceID: String,
        kind: SessionKind
    ) {
        self.sessionID = sessionID
        self.idempotencyKey = idempotencyKey
        self.workspaceID = workspaceID
        self.kind = kind
    }

    var params: JSONValue {
        .object([
            "workspace_id": .string(workspaceID),
            "session_id": .string(sessionID.uuidString.lowercased()),
            "kind": .string(kind.rawValue),
            "cwd": .string("."),
            "rows": .unsignedInteger(24),
            "columns": .unsignedInteger(80),
            "pixel_width": .unsignedInteger(0),
            "pixel_height": .unsignedInteger(0),
            "environment": .object([:]),
            "agent_arguments": .array([])
        ])
    }

    func reconciles<S: Sequence>(sessionIDs: S) -> Bool where S.Element == UUID {
        sessionIDs.contains(sessionID)
    }
}

struct SessionStartAttemptStore: Sendable, Equatable {
    struct Context: Sendable, Hashable {
        let workspaceID: String
        let kind: SessionKind
    }

    private(set) var pending: [Context: SessionStartWireRequest] = [:]

    mutating func request(workspaceID: String, kind: SessionKind) -> SessionStartWireRequest {
        let context = Context(workspaceID: workspaceID, kind: kind)
        if let pending = pending[context] {
            return pending
        }
        let request = SessionStartWireRequest(workspaceID: workspaceID, kind: kind)
        pending[context] = request
        return request
    }

    mutating func markCompleted(_ request: SessionStartWireRequest) {
        let context = Context(workspaceID: request.workspaceID, kind: request.kind)
        guard pending[context] == request else { return }
        pending.removeValue(forKey: context)
    }

    mutating func markFailed(_ request: SessionStartWireRequest, definitive: Bool) {
        if definitive { markCompleted(request) }
    }
}

struct TerminalDetachWireRequest: Sendable, Equatable {
    let streamID: UInt32
    let generation: UInt64

    var params: JSONValue {
        .object([
            "stream_id": .unsignedInteger(UInt64(streamID)),
            "generation": .unsignedInteger(generation)
        ])
    }
}

struct FileListWireRequest: Sendable, Equatable {
    static let mobilePageSize: UInt64 = 150

    let workspaceID: String
    let path: String
    let cursor: String?

    var params: JSONValue {
        var fields: [String: JSONValue] = [
            "workspace_id": .string(workspaceID),
            "path": .string(path),
            "limit": .unsignedInteger(Self.mobilePageSize)
        ]
        if let cursor { fields["cursor"] = .string(cursor) }
        return .object(fields)
    }
}

struct FileListPage: Sendable, Equatable {
    let path: String
    let entries: [RemoteFile]
    let nextCursor: String?

    init(response: JSONValue) throws {
        guard let object = response.objectValue,
              let path = object["path"]?.stringValue,
              let values = object["entries"]?.arrayValue else {
            throw WireResponseError.invalidFileList
        }
        let nextCursor: String?
        switch object["next_cursor"] {
        case .none, .some(.null): nextCursor = nil
        case let .some(.string(value)) where !value.isEmpty: nextCursor = value
        default: throw WireResponseError.invalidFileList
        }
        let entries = try values.map(Self.decodeEntry)
        self.path = path
        self.entries = entries
        self.nextCursor = nextCursor
    }

    private static func decodeEntry(_ value: JSONValue) throws -> RemoteFile {
        guard let object = value.objectValue,
              let path = object["path"]?.stringValue,
              let name = object["name"]?.stringValue,
              let rawKind = object["kind"]?.stringValue,
              let kind = RemoteFileKind(rawValue: rawKind) else {
            throw WireResponseError.invalidFileList
        }
        return RemoteFile(
            path: path,
            name: name,
            kind: kind,
            size: object["size"]?.uint64Value,
            modifiedAt: object["modified_at"]?.uint64Value,
            entityTag: object["etag"]?.stringValue
        )
    }
}

struct FilePaginationState: Sendable, Equatable {
    struct Context: Sendable, Equatable {
        let workspaceID: String
        let path: String
    }

    private(set) var context: Context?
    private(set) var entries: [RemoteFile] = []
    private(set) var nextCursor: String?

    var hasMore: Bool { nextCursor != nil }

    mutating func reset(workspaceID: String, path: String) {
        context = Context(workspaceID: workspaceID, path: path)
        entries = []
        nextCursor = nil
    }

    @discardableResult
    mutating func apply(_ page: FileListPage, workspaceID: String, path: String, appending: Bool) -> Bool {
        guard context == Context(workspaceID: workspaceID, path: path), page.path == path else { return false }
        if appending {
            let existing = Set(entries.map(\.path))
            entries.append(contentsOf: page.entries.filter { !existing.contains($0.path) })
        } else {
            entries = page.entries
        }
        nextCursor = page.nextCursor
        return true
    }
}

enum WireResponseError: LocalizedError, Sendable, Equatable {
    case invalidFileList

    var errorDescription: String? {
        switch self {
        case .invalidFileList: "服务器返回了无效的文件列表。"
        }
    }
}
