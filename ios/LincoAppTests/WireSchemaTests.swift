import Foundation
import LincoCore
import XCTest
@testable import Linco

final class WireSchemaTests: XCTestCase {
    func testTerminalDetachRequestMatchesInteractiveContract() {
        let request = TerminalDetachWireRequest(streamID: 7, generation: 1)

        XCTAssertEqual(request.params, .object([
            "stream_id": .unsignedInteger(7),
            "generation": .unsignedInteger(1)
        ]))
        XCTAssertFalse(RPCMethod.terminalDetach.isMutating)
        XCTAssertEqual(RPCMethod.terminalDetach.requiredPermission, .terminal)
    }

    func testFileListRequestAndIncrementalPaginationState() throws {
        let workspaceID = "4e356877-8957-4537-a47b-efaceed973c7"
        let firstRequest = FileListWireRequest(workspaceID: workspaceID, path: "Sources", cursor: nil)
        XCTAssertEqual(firstRequest.params, .object([
            "workspace_id": .string(workspaceID),
            "path": .string("Sources"),
            "limit": .unsignedInteger(150)
        ]))

        let first = try FileListPage(response: .object([
            "path": .string("Sources"),
            "entries": .array([.object([
                "name": .string("App.swift"),
                "path": .string("Sources/App.swift"),
                "kind": .string("file"),
                "size": .unsignedInteger(42),
                "modified_at": .null,
                "etag": .string("\"sha256-a\"")
            ])]),
            "next_cursor": .string("cursor-1")
        ]))
        let second = try FileListPage(response: .object([
            "path": .string("Sources"),
            "entries": .array([
                .object([
                    "name": .string("App.swift"),
                    "path": .string("Sources/App.swift"),
                    "kind": .string("file"),
                    "size": .unsignedInteger(42),
                    "modified_at": .null,
                    "etag": .string("\"sha256-a\"")
                ]),
                .object([
                    "name": .string("Model.swift"),
                    "path": .string("Sources/Model.swift"),
                    "kind": .string("file"),
                    "size": .unsignedInteger(84),
                    "modified_at": .null,
                    "etag": .string("\"sha256-b\"")
                ])
            ]),
            "next_cursor": .null
        ]))
        var state = FilePaginationState()
        state.reset(workspaceID: workspaceID, path: "Sources")

        let appliedFirst = state.apply(
            first,
            workspaceID: workspaceID,
            path: "Sources",
            appending: false
        )
        XCTAssertTrue(appliedFirst)
        XCTAssertTrue(state.hasMore)
        let appliedSecond = state.apply(
            second,
            workspaceID: workspaceID,
            path: "Sources",
            appending: true
        )
        XCTAssertTrue(appliedSecond)
        XCTAssertEqual(state.entries.map(\.name), ["App.swift", "Model.swift"])
        XCTAssertFalse(state.hasMore)
    }

    func testSessionStartCarriesStableSessionAndIdempotencyIdentifiers() {
        let sessionID = UUID(uuidString: "b8ce74b4-7753-413c-bba3-6c9469112ecb")!
        let idempotencyKey = UUID(uuidString: "2815039b-53e6-421b-a1a8-7924172e5cef")!
        let request = SessionStartWireRequest(
            sessionID: sessionID,
            idempotencyKey: idempotencyKey,
            workspaceID: "4e356877-8957-4537-a47b-efaceed973c7",
            kind: .codex
        )

        XCTAssertEqual(request.idempotencyKey, idempotencyKey)
        XCTAssertEqual(request.params, .object([
            "workspace_id": .string("4e356877-8957-4537-a47b-efaceed973c7"),
            "session_id": .string(sessionID.uuidString.lowercased()),
            "kind": .string("codex"),
            "cwd": .string("."),
            "rows": .unsignedInteger(24),
            "columns": .unsignedInteger(80),
            "pixel_width": .unsignedInteger(0),
            "pixel_height": .unsignedInteger(0),
            "environment": .object([:]),
            "agent_arguments": .array([])
        ]))
        XCTAssertTrue(request.reconciles(sessionIDs: [sessionID]))
        XCTAssertFalse(request.reconciles(sessionIDs: [UUID()]))
    }

    func testFileWriteRequestMatchesReservedUploadSchemaExactly() {
        let request = FileWriteWireRequest(
            workspaceID: "fa4f67c4-f76b-42cc-a41f-c38ca387cf3a",
            path: "Sources/App.swift",
            contentLength: 42,
            expectedRevision: "\"sha256-deadbeef\""
        )

        XCTAssertEqual(request.json, .object([
            "workspace_id": .string("fa4f67c4-f76b-42cc-a41f-c38ca387cf3a"),
            "path": .string("Sources/App.swift"),
            "content_length": .unsignedInteger(42),
            "expected_revision": .string("\"sha256-deadbeef\"")
        ]))
        XCTAssertNil(request.json.objectValue?["expected_etag"])
    }

    func testUploadCapabilityBindsLengthAndRevision() throws {
        let response = JSONValue.object([
            "url": .string("https://server.example/v1/upload"),
            "method": .string("PUT"),
            "authorization_scheme": .string("LincoCapability"),
            "capability": .string("opaque-secret"),
            "if_match": .string("\"sha256-deadbeef\""),
            "content_length": .unsignedInteger(42),
            "max_bytes": .unsignedInteger(8 * 1_024 * 1_024),
            "expires_in_ms": .unsignedInteger(60_000)
        ])

        let capability = try HTTPUploadCapability(response: response)

        XCTAssertEqual(capability.expectedEntityTag, "\"sha256-deadbeef\"")
        XCTAssertEqual(capability.contentLength, 42)
    }

    func testSessionDecodesServerEpochMilliseconds() throws {
        let payload = Data(
            """
            {
              "id": "5bfc81e8-0e51-4b17-b96c-b5e8d407dfdb",
              "stream_id": 42,
              "generation": 7,
              "title": "Codex",
              "workspace_name": "Linco",
              "kind": "codex",
              "state": "ready",
              "updated_at": 1721622896123
            }
            """.utf8
        )
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .millisecondsSince1970

        let session = try decoder.decode(RemoteSession.self, from: payload)

        XCTAssertEqual(session.streamID, 42)
        XCTAssertEqual(session.generation, 7)
        XCTAssertEqual(session.updatedAt.timeIntervalSince1970, 1_721_622_896.123, accuracy: 0.001)
    }

    func testFileListEntryUsesServerKindAndEpochMilliseconds() {
        let value = JSONValue.object([
            "name": .string("Sources"),
            "path": .string("Sources"),
            "kind": .string("directory"),
            "modified_at": .unsignedInteger(1_721_622_896_123)
        ])
        guard let object = value.objectValue,
              let path = object["path"]?.stringValue,
              let name = object["name"]?.stringValue,
              let rawKind = object["kind"]?.stringValue,
              let kind = RemoteFileKind(rawValue: rawKind) else {
            return XCTFail("fixture must match file_list schema")
        }

        let file = RemoteFile(
            path: path,
            name: name,
            kind: kind,
            size: object["size"]?.uint64Value,
            modifiedAt: object["modified_at"]?.uint64Value,
            entityTag: object["etag"]?.stringValue
        )

        XCTAssertTrue(file.isDirectory)
        XCTAssertEqual(file.modifiedAt, 1_721_622_896_123)
    }
}
