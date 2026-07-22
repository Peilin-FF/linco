import Foundation

public enum ServiceEndpoint {
    public static func webSocketURL(baseURL: URL, lane: LogicalChannel) throws -> URL {
        guard lane == .control || lane == .interactive,
              var components = URLComponents(url: baseURL, resolvingAgainstBaseURL: false),
              components.scheme?.lowercased() == "https",
              components.host != nil,
              components.user == nil,
              components.password == nil,
              components.query == nil,
              components.fragment == nil else {
            throw ServiceEndpointError.invalidHTTPSBaseURL
        }

        components.scheme = "wss"
        let suffix: String
        switch lane {
        case .control: suffix = "v1/ws/control"
        case .interactive: suffix = "v1/ws/interactive"
        }
        let basePath = components.percentEncodedPath.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        components.percentEncodedPath = basePath.isEmpty ? "/\(suffix)" : "/\(basePath)/\(suffix)"
        guard let result = components.url else { throw ServiceEndpointError.invalidHTTPSBaseURL }
        return result
    }
}

public enum ServiceEndpointError: Error, Sendable, Equatable {
    case invalidHTTPSBaseURL
}
