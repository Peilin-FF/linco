import Testing
@testable import LincoCore

@Suite("Shared RPC v1 contract")
struct RPCContractTests {
    @Test("Every Swift RPC policy is sourced from the shared Rust fixture")
    func policiesMatchFixture() throws {
        let fixture = try V1ConformanceFixture.load()
        let fixtureMethods = Set(fixture.rpcContractCases.map(\.method))
        let swiftMethods = Set(RPCMethod.allCases.map(\.rawValue))

        #expect(fixtureMethods == swiftMethods)
        #expect(fixture.rpcContractCases.count == 12)
        for contract in fixture.rpcContractCases {
            let method = try #require(RPCMethod(rawValue: contract.method))
            #expect(method.isMutating == contract.mutating)
            #expect(method.requiredPermission.rawValue == contract.permission)
            #expect(contract.request.objectValue != nil)
            #expect(contract.response.objectValue != nil)
        }
    }

    @Test("File capability schemas decode from the shared fixture")
    func fileCapabilitySchemas() throws {
        let fixture = try V1ConformanceFixture.load()
        let read = try #require(fixture.rpcContractCases.first { $0.method == "file_read" })
        let write = try #require(fixture.rpcContractCases.first { $0.method == "file_write" })

        #expect(read.response.objectValue?["authorization_scheme"]?.stringValue == "LincoCapability")
        #expect(write.request.objectValue?["content_length"]?.uint64Value == 18)
        #expect(write.response.objectValue?["content_length"]?.uint64Value == 18)

        let expectedRevision = try #require(
            write.request.objectValue?["expected_revision"]?.stringValue
        )
        let capabilityIfMatch = try #require(
            write.response.objectValue?["if_match"]?.stringValue
        )
        #expect(expectedRevision == capabilityIfMatch)
        #expect(expectedRevision.hasPrefix("\"sha256-"))
        #expect(expectedRevision.hasSuffix("\""))

        let digest = expectedRevision.dropFirst(8).dropLast()
        let lowercaseHex = Set("0123456789abcdef")
        #expect(digest.count == 64)
        #expect(digest.allSatisfy { lowercaseHex.contains($0) })
    }
}
