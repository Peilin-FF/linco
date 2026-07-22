import Foundation
@testable import LincoCore

struct V1ConformanceFixture: Decodable {
    struct BinaryCase: Decodable {
        struct Header: Decodable {
            let kind: String
            let flags: UInt16
            let streamID: UInt32
            let sequence: UInt64

            enum CodingKeys: String, CodingKey {
                case kind, flags, sequence
                case streamID = "stream_id"
            }
        }

        let name: String
        let channel: String
        let header: Header
        let payloadHex: String
        let encodedHex: String

        enum CodingKeys: String, CodingKey {
            case name, channel, header
            case payloadHex = "payload_hex"
            case encodedHex = "encoded_hex"
        }
    }

    struct ControlCase: Decodable {
        let name: String
        let json: JSONValue
    }

    struct RPCContractCase: Decodable {
        let method: String
        let permission: String
        let mutating: Bool
        let request: JSONValue
        let response: JSONValue
    }

    let protocolVersion: UInt8
    let binaryCases: [BinaryCase]
    let controlCases: [ControlCase]
    let serverEventCases: [ControlCase]
    let rpcContractCases: [RPCContractCase]

    enum CodingKeys: String, CodingKey {
        case protocolVersion = "protocol_version"
        case binaryCases = "binary_cases"
        case controlCases = "control_cases"
        case serverEventCases = "server_event_cases"
        case rpcContractCases = "rpc_contract_cases"
    }

    static func load(filePath: String = #filePath) throws -> Self {
        var directory = URL(fileURLWithPath: filePath).deletingLastPathComponent()
        while directory.path != directory.deletingLastPathComponent().path {
            let fixture = directory
                .appendingPathComponent("crates/linco-protocol/fixtures/v1-conformance.json")
            if FileManager.default.fileExists(atPath: fixture.path) {
                return try JSONDecoder().decode(Self.self, from: Data(contentsOf: fixture))
            }
            directory.deleteLastPathComponent()
        }
        throw ConformanceFixtureError.repositoryRootNotFound
    }
}

enum ConformanceFixtureError: Error {
    case repositoryRootNotFound
}
