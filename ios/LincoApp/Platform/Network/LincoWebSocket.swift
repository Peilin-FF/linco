import Foundation
import LincoCore

actor LincoWebSocket {
    enum Incoming: Sendable {
        case control(ServerEnvelope)
        case binary(Data)
    }

    private let endpoint: URL
    private let lane: LogicalChannel
    private let outbound = WebSocketOutboundCoordinator()
    private var session: URLSession?
    private var task: URLSessionWebSocketTask?

    init(baseURL: URL, lane: LogicalChannel) throws {
        self.endpoint = try ServiceEndpoint.webSocketURL(baseURL: baseURL, lane: lane)
        self.lane = lane
    }

    func open() throws {
        guard task == nil else { return }

        let configuration = URLSessionConfiguration.ephemeral
        configuration.waitsForConnectivity = true
        configuration.timeoutIntervalForRequest = 15
        configuration.urlCache = nil
        configuration.requestCachePolicy = .reloadIgnoringLocalCacheData

        let session = URLSession(configuration: configuration)
        let task = session.webSocketTask(with: endpoint)
        task.maximumMessageSize = switch lane {
        case .control: ControlProtocol.maximumMessageBytes
        case .interactive: BinaryKind.terminalSnapshot.maximumPayloadBytes + BinaryFrame.headerLength
        }
        self.session = session
        self.task = task
        task.resume()
    }

    func sendControl<T: Encodable & Sendable>(_ message: T) async throws {
        guard let task else { throw WebSocketError.notOpen }
        let data = try ControlCodec.encode(message)
        guard let text = String(data: data, encoding: .utf8) else {
            throw WebSocketError.invalidUTF8
        }
        try await outbound.performOrdered {
            try await task.send(.string(text))
        }
    }

    func sendBinary(_ frame: BinaryFrame) async throws {
        guard let task else { throw WebSocketError.notOpen }
        let data = frame.encoded()
        try await outbound.performOrdered {
            try await task.send(.data(data))
        }
    }

    func sendPing() async throws {
        guard let task else { throw WebSocketError.notOpen }
        try await outbound.performPing {
            try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, any Error>) in
                task.sendPing { error in
                    if let error {
                        continuation.resume(throwing: error)
                    } else {
                        continuation.resume()
                    }
                }
            }
        }
    }

    func receive() async throws -> Incoming {
        guard let task else { throw WebSocketError.notOpen }
        switch try await task.receive() {
        case let .string(text):
            guard let data = text.data(using: .utf8) else { throw WebSocketError.invalidUTF8 }
            return .control(try ControlCodec.decodeServer(data))
        case let .data(data):
            return .binary(data)
        @unknown default:
            throw WebSocketError.unsupportedMessage
        }
    }

    func close() {
        task?.cancel(with: .goingAway, reason: nil)
        task = nil
        session?.invalidateAndCancel()
        session = nil
    }
}

enum WebSocketError: LocalizedError, Sendable {
    case notOpen
    case invalidUTF8
    case unsupportedMessage

    var errorDescription: String? {
        switch self {
        case .notOpen: "连接尚未建立。"
        case .invalidUTF8: "服务器发来了无效的控制消息。"
        case .unsupportedMessage: "服务器发来了不支持的消息类型。"
        }
    }
}
