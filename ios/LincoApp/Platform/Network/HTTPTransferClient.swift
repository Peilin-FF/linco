import Foundation
import LincoCore

struct HTTPCapability: Sendable, Equatable {
    let url: URL
    let scheme: String
    let token: String
    let expiresInMilliseconds: UInt64

    init(response: JSONValue, urlField: String = "url") throws {
        guard let object = response.objectValue,
              let rawURL = object[urlField]?.stringValue,
              let url = URL(string: rawURL),
              url.scheme?.lowercased() == "https",
              url.user == nil,
              url.password == nil,
              url.query == nil,
              url.fragment == nil,
              let scheme = object["authorization_scheme"]?.stringValue,
              scheme == "LincoCapability",
              let token = object["capability"]?.stringValue,
              !token.isEmpty,
              let expiresInMilliseconds = object["expires_in_ms"]?.uint64Value,
              (1...300_000).contains(expiresInMilliseconds) else {
            throw HTTPTransferError.invalidCapability
        }
        self.url = url
        self.scheme = scheme
        self.token = token
        self.expiresInMilliseconds = expiresInMilliseconds
    }

    var authorizationValue: String { "\(scheme) \(token)" }
}

struct HTTPUploadCapability: Sendable, Equatable {
    let access: HTTPCapability
    let expectedEntityTag: String
    let contentLength: UInt64
    let maximumBytes: UInt64

    init(response: JSONValue) throws {
        guard let object = response.objectValue,
              object["method"]?.stringValue == "PUT",
              let expectedEntityTag = object["if_match"]?.stringValue,
              !expectedEntityTag.isEmpty,
              let contentLength = object["content_length"]?.uint64Value,
              let maximumBytes = object["max_bytes"]?.uint64Value,
              contentLength <= maximumBytes,
              maximumBytes > 0 else {
            throw HTTPTransferError.invalidCapability
        }
        self.access = try HTTPCapability(response: response)
        self.expectedEntityTag = expectedEntityTag
        self.contentLength = contentLength
        self.maximumBytes = maximumBytes
    }
}

struct FileWriteWireRequest: Sendable, Equatable {
    let workspaceID: String
    let path: String
    let contentLength: UInt64
    let expectedRevision: String

    var json: JSONValue {
        .object([
            "workspace_id": .string(workspaceID),
            "path": .string(path),
            "content_length": .unsignedInteger(contentLength),
            "expected_revision": .string(expectedRevision)
        ])
    }
}

actor HTTPTransferClient {
    struct Download: Sendable {
        let data: Data
        let entityTag: String?
    }
    private let session: URLSession
    private let redirectDelegate: RejectRedirectDelegate

    init() {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.urlCache = nil
        configuration.requestCachePolicy = .reloadIgnoringLocalCacheData
        configuration.timeoutIntervalForRequest = 20
        configuration.timeoutIntervalForResource = 60
        let redirectDelegate = RejectRedirectDelegate()
        self.redirectDelegate = redirectDelegate
        session = URLSession(configuration: configuration, delegate: redirectDelegate, delegateQueue: nil)
    }

    func download(_ capability: HTTPCapability, maximumBytes: Int = 8 * 1_024 * 1_024) async throws -> Download {
        var request = URLRequest(url: capability.url)
        request.setValue(capability.authorizationValue, forHTTPHeaderField: "Authorization")
        let result = try await BoundedDownloadDelegate(maximumBytes: maximumBytes).run(request)
        guard let entityTag = result.entityTag, Self.isStrongEntityTag(entityTag) else {
            throw HTTPTransferError.invalidResponse
        }
        return Download(data: result.data, entityTag: entityTag)
    }

    func upload(
        _ data: Data,
        to capability: HTTPUploadCapability,
        maximumBytes: Int = 8 * 1_024 * 1_024
    ) async throws -> String {
        let serverMaximum = Int(clamping: capability.maximumBytes)
        guard data.count <= min(maximumBytes, serverMaximum) else { throw HTTPTransferError.uploadTooLarge }
        guard UInt64(data.count) == capability.contentLength else { throw HTTPTransferError.invalidCapability }
        var request = URLRequest(url: capability.access.url)
        request.httpMethod = "PUT"
        request.setValue(capability.access.authorizationValue, forHTTPHeaderField: "Authorization")
        request.setValue("text/plain; charset=utf-8", forHTTPHeaderField: "Content-Type")
        request.setValue(String(data.count), forHTTPHeaderField: "Content-Length")
        request.setValue(capability.expectedEntityTag, forHTTPHeaderField: "If-Match")
        let (_, response) = try await session.upload(for: request, from: data)
        guard let http = response as? HTTPURLResponse else { throw HTTPTransferError.invalidResponse }
        try Self.validateUploadStatus(http.statusCode)
        guard let entityTag = http.value(forHTTPHeaderField: "ETag"), Self.isStrongEntityTag(entityTag) else {
            throw HTTPTransferError.invalidResponse
        }
        return entityTag
    }

    static func validateUploadStatus(_ statusCode: Int) throws {
        if statusCode == 409 || statusCode == 412 { throw HTTPTransferError.editConflict }
        guard (200..<300).contains(statusCode) else { throw HTTPTransferError.status(statusCode) }
    }

    static func isStrongEntityTag(_ value: String) -> Bool {
        value.count >= 2 && value.first == "\"" && value.last == "\"" && !value.hasPrefix("W/")
    }
}

struct BoundedDataAccumulator: Sendable {
    let maximumBytes: Int
    private(set) var data = Data()

    mutating func append(_ chunk: Data) throws {
        guard chunk.count <= maximumBytes - data.count else { throw HTTPTransferError.downloadTooLarge }
        data.append(chunk)
    }
}

private struct BoundedDownloadResult: Sendable {
    let data: Data
    let entityTag: String?
}

struct DownloadCancellationGate: Sendable {
    private(set) var isCancelled = false

    mutating func cancel() { isCancelled = true }
    func allowsStart(taskIsCancelled: Bool) -> Bool { !isCancelled && !taskIsCancelled }
}

private final class BoundedDownloadDelegate: NSObject, URLSessionDataDelegate, @unchecked Sendable {
    private let lock = NSLock()
    private let maximumBytes: Int
    private var accumulator: BoundedDataAccumulator
    private var entityTag: String?
    private var terminalError: (any Error)?
    private var continuation: CheckedContinuation<BoundedDownloadResult, any Error>?
    private var task: URLSessionDataTask?
    private var session: URLSession?
    private var cancellationGate = DownloadCancellationGate()

    init(maximumBytes: Int) {
        self.maximumBytes = maximumBytes
        self.accumulator = BoundedDataAccumulator(maximumBytes: maximumBytes)
    }

    func run(_ request: URLRequest) async throws -> BoundedDownloadResult {
        try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { continuation in
                let configuration = URLSessionConfiguration.ephemeral
                configuration.urlCache = nil
                configuration.requestCachePolicy = .reloadIgnoringLocalCacheData
                configuration.timeoutIntervalForRequest = 20
                configuration.timeoutIntervalForResource = 60
                let session = URLSession(configuration: configuration, delegate: self, delegateQueue: nil)
                let task = session.dataTask(with: request)

                lock.lock()
                guard cancellationGate.allowsStart(taskIsCancelled: Task.isCancelled) else {
                    lock.unlock()
                    session.invalidateAndCancel()
                    continuation.resume(throwing: CancellationError())
                    return
                }
                self.continuation = continuation
                self.session = session
                self.task = task
                task.resume()
                lock.unlock()
            }
        } onCancel: {
            self.cancel()
        }
    }

    func urlSession(
        _ session: URLSession,
        dataTask: URLSessionDataTask,
        didReceive response: URLResponse,
        completionHandler: @escaping @Sendable (URLSession.ResponseDisposition) -> Void
    ) {
        let failure: (any Error)?
        if let http = response as? HTTPURLResponse {
            if !(200..<300).contains(http.statusCode) {
                failure = HTTPTransferError.status(http.statusCode)
            } else if http.expectedContentLength > Int64(maximumBytes) {
                failure = HTTPTransferError.downloadTooLarge
            } else {
                failure = nil
            }

            lock.lock()
            entityTag = http.value(forHTTPHeaderField: "ETag")
            if let failure { terminalError = failure }
            lock.unlock()
        } else {
            failure = HTTPTransferError.invalidResponse
            lock.lock()
            terminalError = failure
            lock.unlock()
        }
        completionHandler(failure == nil ? .allow : .cancel)
    }

    func urlSession(
        _ session: URLSession,
        task: URLSessionTask,
        willPerformHTTPRedirection response: HTTPURLResponse,
        newRequest request: URLRequest,
        completionHandler: @escaping @Sendable (URLRequest?) -> Void
    ) {
        completionHandler(nil)
    }

    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
        var shouldCancel = false
        lock.lock()
        if terminalError == nil {
            do {
                try accumulator.append(data)
            } catch {
                terminalError = error
                shouldCancel = true
            }
        }
        lock.unlock()
        if shouldCancel { dataTask.cancel() }
    }

    func urlSession(
        _ session: URLSession,
        task: URLSessionTask,
        didCompleteWithError error: (any Error)?
    ) {
        lock.lock()
        let continuation = self.continuation
        let terminalError = self.terminalError ?? error
        let result = BoundedDownloadResult(data: accumulator.data, entityTag: entityTag)
        self.continuation = nil
        self.task = nil
        self.session = nil
        lock.unlock()

        session.finishTasksAndInvalidate()
        if let terminalError {
            continuation?.resume(throwing: terminalError)
        } else {
            continuation?.resume(returning: result)
        }
    }

    private func cancel() {
        lock.lock()
        cancellationGate.cancel()
        if continuation != nil { terminalError = CancellationError() }
        let task = self.task
        lock.unlock()
        task?.cancel()
    }
}

private final class RejectRedirectDelegate: NSObject, URLSessionTaskDelegate, @unchecked Sendable {
    func urlSession(
        _ session: URLSession,
        task: URLSessionTask,
        willPerformHTTPRedirection response: HTTPURLResponse,
        newRequest request: URLRequest,
        completionHandler: @escaping @Sendable (URLRequest?) -> Void
    ) {
        completionHandler(nil)
    }
}

enum HTTPTransferError: LocalizedError, Sendable, Equatable {
    case invalidCapability
    case invalidResponse
    case status(Int)
    case downloadTooLarge
    case uploadTooLarge
    case editConflict

    var errorDescription: String? {
        switch self {
        case .invalidCapability: "服务器返回了无效的短期下载凭证。"
        case .invalidResponse: "文件服务器返回了无效响应。"
        case let .status(code): "文件服务器返回 HTTP \(code)。"
        case .downloadTooLarge: "该文件超过移动端编辑器的 8 MB 安全上限。"
        case .uploadTooLarge: "该文件超过移动端保存的 8 MB 安全上限。"
        case .editConflict: "服务器上的文件已发生变化；为避免覆盖他人的修改，请重新加载后再编辑。"
        }
    }
}
