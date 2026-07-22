import Foundation
import Testing
@testable import LincoCore

@Suite("Service endpoint construction")
struct ServiceEndpointTests {
    @Test("Builds distinct WSS lane paths from an HTTPS origin")
    func rootDeployment() throws {
        let base = try #require(URL(string: "https://server.example:8443"))
        #expect(try ServiceEndpoint.webSocketURL(baseURL: base, lane: .control).absoluteString == "wss://server.example:8443/v1/ws/control")
        #expect(try ServiceEndpoint.webSocketURL(baseURL: base, lane: .interactive).absoluteString == "wss://server.example:8443/v1/ws/interactive")
    }

    @Test("Preserves a reverse-proxy deployment base path")
    func basePath() throws {
        let base = try #require(URL(string: "https://server.example/tools/linco/"))
        let result = try ServiceEndpoint.webSocketURL(baseURL: base, lane: .control)
        #expect(result.absoluteString == "wss://server.example/tools/linco/v1/ws/control")
    }

    @Test("Rejects cleartext, credentials, and query-bearing bases")
    func rejectsUnsafeBases() throws {
        for value in [
            "http://server.example",
            "https://user:pass@server.example",
            "https://server.example?ticket=secret"
        ] {
            let url = try #require(URL(string: value))
            #expect(throws: ServiceEndpointError.invalidHTTPSBaseURL) {
                try ServiceEndpoint.webSocketURL(baseURL: url, lane: .control)
            }
        }
    }
}
