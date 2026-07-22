import Foundation
import LincoCore
import SwiftUI

@MainActor
final class AppModel: ObservableObject {
    enum PairingState: Equatable {
        case idle
        case validating
        case pairing
        case failed(String)
    }

    @Published private(set) var profile: ServerProfile?
    @Published private(set) var connectionStatus: AppConnectionStatus = .disconnected
    @Published private(set) var sessions: [RemoteSession] = []
    @Published private(set) var workspaces: [RemoteWorkspace] = []
    @Published private(set) var files: [RemoteFile] = []
    @Published private(set) var isLoadingFiles = false
    @Published private(set) var isLoadingMoreFiles = false
    @Published private(set) var hasMoreFiles = false
    @Published var previewCapability: HTTPCapability?
    @Published private(set) var pairingState: PairingState = .idle
    @Published var ambiguousInputStreams: Set<UInt32> = []
    @Published var isAmbiguousInputAlertPresented = false
    @Published var presentedError: String?
    @Published private(set) var terminalInputReadyStreams: Set<UInt32> = []
    @Published private(set) var isForgettingServer = false

    var isPairingInProgress: Bool {
        pairingState == .validating || pairingState == .pairing
    }

    let terminalOutput = TerminalOutputHub()
    let terminalInputDrains = TerminalInputDrainRegistry()
    let remote: RemoteService

    private let pairingService: PairingService
    private let http = HTTPTransferClient()
    private var reconnectTask: Task<Void, Never>?
    private var latencyProbeTask: Task<Void, Never>?
    private var reconnectGeneration: UUID?
    private var connectAttemptGeneration: UUID?
    private var activeConnectionID: UUID?
    private var activeTransportID: UUID?
    private var activeServerScopeID: UUID?
    private var sessionStartAttempts = SessionStartAttemptStore()
    private var sessionRefreshTask: Task<Void, Never>?
    private var sessionRefreshWorkerID: UUID?
    private var sessionRefreshRequestVersion: UInt64 = 0
    private var filePagination = FilePaginationState()
    private let terminalResizeCoordinator = TerminalResizeStreamCoordinator()
    private var fileListRequestID: UUID?
    private var activeTerminals: [UInt32: ActiveTerminal] = [:]
    private var pendingTerminalDetaches: [UInt32: PendingTerminalDetach] = [:]
    private var isSceneActive = true
    private var sceneTransitionGeneration = UUID()
    private var serverLifecycleGeneration = UUID()
    private var didStart = false

    init(remote: RemoteService = RemoteService(), pairingService: PairingService = PairingService()) {
        self.remote = remote
        self.pairingService = pairingService
        do {
            self.profile = try ServerProfileStore.load()
        } catch {
            self.profile = nil
            self.presentedError = "无法读取已配对的服务器：\(error.localizedDescription)"
        }
    }

    func start() async {
        guard !didStart else { return }
        didStart = true
        await remote.setEventHandler { [weak self] packet in
            await self?.handle(packet)
        }
        if profile != nil { await connect() }
    }

    func hasPermission(_ permission: Permission) -> Bool {
        profile?.permissions.contains(permission) == true
    }

    func pair(qrCode: String) async {
        guard PairingLifecyclePolicy.canBeginPair(
            isForgettingServer: isForgettingServer,
            isPairingInProgress: isPairingInProgress
        ) else {
            return
        }
        pairingState = .validating
        do {
            let payload = try PairingPayload(qrCode: qrCode)
            pairingState = .pairing
            let newProfile = try await pairingService.pair(payload: payload)
            guard !isForgettingServer else { return }
            serverLifecycleGeneration = UUID()
            try ServerProfileStore.save(newProfile)
            profile = newProfile
            pairingState = .idle
            await connect()
        } catch {
            pairingState = .failed(error.localizedDescription)
        }
    }

    func connect() async {
        guard !isForgettingServer,
              let profile,
              !connectionStatus.isReady,
              !connectionStatus.isConnecting else { return }
        cancelReconnectLoop()
        let connectionID = await connectOnce(profile: profile, retryAttempt: nil)
        if connectionID == nil, self.profile == profile, connectionStatus != .disconnected {
            startReconnectLoop(message: nil)
        }
    }

    private func connectOnce(profile: ServerProfile, retryAttempt: Int?) async -> UUID? {
        let attempt = UUID()
        connectAttemptGeneration = attempt
        // The previous reader can advance its receive cursor before its tagged
        // event reaches AppModel. During transport replacement that old tag is
        // intentionally rejected, so the next terminal resume must start from
        // zero/snapshot rather than an optimistic possibly-unrendered cursor.
        TerminalReplayPolicy.prepareForTransportReplacement(&activeTerminals)
        latencyProbeTask?.cancel()
        latencyProbeTask = nil
        activeConnectionID = nil
        activeTransportID = nil
        if let retryAttempt {
            connectionStatus = .reconnecting(attempt: retryAttempt)
        } else {
            connectionStatus = .connecting
        }
        do {
            if retryAttempt == nil { connectionStatus = .authenticating }
            let connected = try await withLincoTimeout(.seconds(15), onTimeout: { [remote] in
                await remote.cancelConnectionAttempt()
            }) { [remote] in
                try await remote.connect(profile: profile)
            }
            guard connectAttemptGeneration == attempt, self.profile == profile else {
                if connectAttemptGeneration == attempt {
                    connectAttemptGeneration = nil
                    await remote.disconnect()
                }
                return nil
            }
            activeTransportID = connected.transportID
            activeConnectionID = connected.connectionID
            activeServerScopeID = connected.serverScopeID
            guard await remote.isTransportActive(connected.transportID),
                  connectAttemptGeneration == attempt else {
                activeTransportID = nil
                activeConnectionID = nil
                if connectAttemptGeneration == attempt { connectAttemptGeneration = nil }
                return nil
            }
            connectAttemptGeneration = nil
            connectionStatus = .ready(
                path: connected.connectionPath.displayName,
                latencyMilliseconds: nil
            )
            if !connected.ambiguousInputStreams.isEmpty {
                ambiguousInputStreams.formUnion(connected.ambiguousInputStreams)
                terminalInputReadyStreams.subtract(connected.ambiguousInputStreams)
                terminalInputDrains.pauseAcceptance(
                    streamIDs: connected.ambiguousInputStreams
                )
                isAmbiguousInputAlertPresented = true
            }
            startLatencyProbe(connectionID: connected.connectionID)
            // Reconnect the cached, generation-bound terminal before waiting
            // for list hydration. A stale cache is rejected by session_resume
            // without compromising the newly committed transport.
            await resumeActiveTerminals()
            async let sessions: Void = refreshSessions()
            async let workspaces: Void = refreshWorkspaces()
            _ = await (sessions, workspaces)
            guard await remote.isTransportActive(connected.transportID),
                  ConnectionLivenessPolicy.isLive(
                committedID: connected.connectionID,
                activeID: activeConnectionID,
                  statusIsReady: connectionStatus.isReady
            ), activeTransportID == connected.transportID else { return nil }
            return connected.connectionID
        } catch {
            guard connectAttemptGeneration == attempt else { return nil }
            connectAttemptGeneration = nil
            if retryAttempt == nil {
                connectionStatus = .failed(message: error.localizedDescription)
                presentedError = error.localizedDescription
            }
            return nil
        }
    }

    func disconnect() async {
        cancelReconnectLoop()
        connectAttemptGeneration = nil
        latencyProbeTask?.cancel()
        latencyProbeTask = nil
        activeConnectionID = nil
        activeTransportID = nil
        TerminalReplayPolicy.prepareForTransportReplacement(&activeTerminals)
        terminalInputDrains.pauseAcceptance(streamIDs: Set(activeTerminals.keys))
        terminalInputReadyStreams.removeAll(keepingCapacity: true)
        connectionStatus = .disconnected
        await remote.disconnect()
    }

    func refreshSessions() async {
        guard connectionStatus.isReady else { return }
        sessionRefreshRequestVersion &+= 1
        if let sessionRefreshTask {
            await sessionRefreshTask.value
            return
        }
        let lifecycle = serverLifecycleGeneration
        let workerID = UUID()
        sessionRefreshWorkerID = workerID
        let task = Task { @MainActor [weak self] in
            guard let self else { return }
            await self.runSessionRefreshLoop(
                lifecycle: lifecycle,
                workerID: workerID
            )
        }
        sessionRefreshTask = task
        await task.value
    }

    func startSession(kind: SessionKind, workspaceID: String) async -> Bool {
        let lifecycle = serverLifecycleGeneration
        let request = sessionStartAttempts.request(workspaceID: workspaceID, kind: kind)
        if request.reconciles(sessionIDs: sessions.map(\.id)) {
            sessionStartAttempts.markCompleted(request)
            return true
        }
        do {
            _ = try await callRemote(
                .sessionStart,
                params: request.params,
                idempotencyKey: request.idempotencyKey,
                deadlineMilliseconds: 15_000
            )
            guard lifecycle == serverLifecycleGeneration else { return false }
            sessionStartAttempts.markCompleted(request)
            await refreshSessions()
            return true
        } catch {
            guard lifecycle == serverLifecycleGeneration else { return false }
            let definitive = error.isDefinitiveRPCFailure
            sessionStartAttempts.markFailed(request, definitive: definitive)
            if definitive {
                presentedError = "会话启动失败：\(error.localizedDescription)"
                return false
            }
            if await reconcileSessionStart(request) {
                sessionStartAttempts.markCompleted(request)
                return true
            }
            presentedError = "会话启动失败：\(error.localizedDescription)"
            return false
        }
    }

    func stopSession(_ session: RemoteSession) async -> Bool {
        let lifecycle = serverLifecycleGeneration
        do {
            _ = try await callRemote(
                .sessionStop,
                params: .object([
                    "session_id": .string(session.id.uuidString.lowercased()),
                    "generation": .unsignedInteger(session.generation)
                ]),
                deadlineMilliseconds: 5_000
            )
            guard lifecycle == serverLifecycleGeneration else { return false }
            await refreshSessions()
            return true
        } catch {
            guard lifecycle == serverLifecycleGeneration else { return false }
            presentedError = "会话停止失败：\(error.localizedDescription)"
            return false
        }
    }

    func sendTerminalInput(
        streamID: UInt32,
        sessionID: UUID,
        generation: UInt64,
        ownerID: UUID,
        data: Data
    ) async {
        let lifecycle = serverLifecycleGeneration
        guard TerminalOperationOwnershipPolicy.accepts(
            active: activeTerminals[streamID],
            sessionID: sessionID,
            generation: generation,
            ownerID: ownerID
        ) else {
            presentedError = "终端已切换到新的运行实例，本次输入未发送。"
            return
        }
        guard let serverScopeID = activeServerScopeID else {
            presentedError = "终端连接尚未就绪，本次输入未发送。"
            return
        }
        do {
            try await remote.sendTerminalInput(
                streamID: streamID,
                generation: generation,
                bytes: data,
                serverScopeID: serverScopeID
            )
        } catch {
            guard lifecycle == serverLifecycleGeneration else { return }
            presentedError = "终端输入发送失败：\(error.localizedDescription)"
        }
    }

    func reportTerminalInputRejection(_ rejection: OrderedTerminalInputPump.Rejection) {
        switch rejection.reason {
        case .capacity:
            presentedError = "终端输入队列正忙；为避免只执行部分命令，本次 \(rejection.itemBytes) 字节输入未发送（上限 \(rejection.maximumQueuedBytes) 字节）。"
        case .acceptancePaused:
            presentedError = "终端正在切换连接状态，本次输入未发送；请在输入就绪后重试。"
        }
    }

    func activateTerminal(_ session: RemoteSession, ownerID: UUID) async {
        guard session.state.keepsTerminalStreamOpen else { return }
        let lifecycle = serverLifecycleGeneration
        guard let serverScopeID = activeServerScopeID else { return }
        activeTerminals[session.streamID] = ActiveTerminal(
            sessionID: session.id,
            generation: session.generation,
            ownerID: ownerID,
            requiresFullReplay: true
        )
        // A newly-created SwiftTerm view has no prior emulator state. Replaying
        // from zero lets the server provide either retained bytes or a bounded
        // terminal snapshot, so inactive output is never presented as a partial
        // terminal history.
        terminalOutput.reset(session.streamID)
        terminalInputReadyStreams.remove(session.streamID)
        guard isSceneActive else { return }
        await waitForPendingTerminalDetach(streamID: session.streamID)
        guard lifecycle == serverLifecycleGeneration,
              isSceneActive,
              activeTerminals[session.streamID]?.ownerID == ownerID,
              activeTerminals[session.streamID]?.generation == session.generation else { return }
        do {
            try await remote.resumeTerminal(
                streamID: session.streamID,
                generation: session.generation,
                offset: 0,
                serverScopeID: serverScopeID
            )
            if connectionStatus.isReady,
               lifecycle == serverLifecycleGeneration,
               isSceneActive,
               activeTerminals[session.streamID]?.ownerID == ownerID,
               activeTerminals[session.streamID]?.generation == session.generation {
                activeTerminals[session.streamID]?.requiresFullReplay = false
                terminalInputReadyStreams.insert(session.streamID)
                terminalInputDrains.resumeAcceptance(streamIDs: [session.streamID])
            }
        } catch is CancellationError {
        } catch {
            guard lifecycle == serverLifecycleGeneration else { return }
            presentedError = "无法恢复终端：\(error.localizedDescription)"
        }
    }

    func deactivateTerminal(streamID: UInt32, ownerID: UUID) async {
        guard let active = activeTerminals[streamID], active.ownerID == ownerID else { return }
        activeTerminals.removeValue(forKey: streamID)
        terminalInputReadyStreams.remove(streamID)
        await detachTerminal(streamID: streamID, generation: active.generation)
    }

    func refreshWorkspaces() async {
        guard connectionStatus.isReady else { return }
        let lifecycle = serverLifecycleGeneration
        do {
            let value = try await callRemote(.workspaceList)
            guard lifecycle == serverLifecycleGeneration else { return }
            guard let values = value.objectValue?["workspaces"]?.arrayValue else {
                throw AppModelError.invalidWorkspaceList
            }
            workspaces = try values.map { item in
                guard let object = item.objectValue,
                      let id = object["id"]?.stringValue,
                      UUID(uuidString: id) != nil,
                      let name = object["name"]?.stringValue,
                      !name.isEmpty else { throw AppModelError.invalidWorkspaceList }
                return RemoteWorkspace(id: id, name: name)
            }
        } catch {
            guard lifecycle == serverLifecycleGeneration else { return }
            presentedError = "无法读取工作区：\(error.localizedDescription)"
        }
    }

    func refreshFiles(workspaceID: String, path: String = "") async {
        guard connectionStatus.isReady else { return }
        let lifecycle = serverLifecycleGeneration
        let requestID = UUID()
        fileListRequestID = requestID
        filePagination.reset(workspaceID: workspaceID, path: path)
        files = []
        hasMoreFiles = false
        isLoadingFiles = true
        defer { if fileListRequestID == requestID { isLoadingFiles = false } }
        do {
            let request = FileListWireRequest(workspaceID: workspaceID, path: path, cursor: nil)
            let value = try await callRemote(.fileList, params: request.params)
            let page = try FileListPage(response: value)
            guard lifecycle == serverLifecycleGeneration,
                  fileListRequestID == requestID,
                  filePagination.apply(page, workspaceID: workspaceID, path: path, appending: false) else { return }
            files = filePagination.entries
            hasMoreFiles = filePagination.hasMore
        } catch {
            guard lifecycle == serverLifecycleGeneration,
                  fileListRequestID == requestID else { return }
            files = []
            presentedError = "无法读取文件：\(error.localizedDescription)"
        }
    }

    func loadNextFilesPage(workspaceID: String, path: String) async {
        guard connectionStatus.isReady,
              !isLoadingFiles,
              !isLoadingMoreFiles,
              filePagination.context == .init(workspaceID: workspaceID, path: path),
              let cursor = filePagination.nextCursor else { return }
        let lifecycle = serverLifecycleGeneration
        isLoadingMoreFiles = true
        defer { isLoadingMoreFiles = false }
        do {
            let request = FileListWireRequest(workspaceID: workspaceID, path: path, cursor: cursor)
            let value = try await callRemote(.fileList, params: request.params)
            let page = try FileListPage(response: value)
            guard lifecycle == serverLifecycleGeneration,
                  filePagination.nextCursor == cursor,
                  filePagination.apply(page, workspaceID: workspaceID, path: path, appending: true) else { return }
            files = filePagination.entries
            hasMoreFiles = filePagination.hasMore
        } catch {
            guard lifecycle == serverLifecycleGeneration else { return }
            presentedError = "无法继续加载文件：\(error.localizedDescription)"
        }
    }

    func readFile(workspaceID: String, path: String) async throws -> RemoteFileContent {
        let value = try await callRemote(.fileRead, params: .object([
            "workspace_id": .string(workspaceID),
            "path": .string(path)
        ]), deadlineMilliseconds: 10_000)
        let capability = try HTTPCapability(response: value)
        let download = try await http.download(capability)
        guard let text = String(data: download.data, encoding: .utf8) else { throw AppModelError.fileIsNotUTF8 }
        return RemoteFileContent(text: text, revision: download.entityTag)
    }

    func resolvePreview(workspaceID: String, path: String) async {
        let lifecycle = serverLifecycleGeneration
        do {
            let value = try await callRemote(.previewResolve, params: .object([
                "workspace_id": .string(workspaceID),
                "path": .string(path)
            ]))
            let capability = try HTTPCapability(response: value, urlField: "bootstrap_url")
            guard lifecycle == serverLifecycleGeneration else { return }
            previewCapability = capability
        } catch {
            guard lifecycle == serverLifecycleGeneration else { return }
            presentedError = "无法打开预览：\(error.localizedDescription)"
        }
    }

    func writeFile(workspaceID: String, path: String, text: String, revision: String?) async throws -> String? {
        guard let revision, !revision.isEmpty else { throw AppModelError.missingFileRevision }
        let data = Data(text.utf8)
        do {
            let value = try await callRemote(
                .fileWrite,
                params: FileWriteWireRequest(
                    workspaceID: workspaceID,
                    path: path,
                    contentLength: UInt64(data.count),
                    expectedRevision: revision
                ).json,
                deadlineMilliseconds: 15_000
            )
            let capability = try HTTPUploadCapability(response: value)
            guard capability.expectedEntityTag == revision else {
                throw HTTPTransferError.invalidCapability
            }
            return try await http.upload(data, to: capability)
        } catch let error as RemoteServiceError {
            if case .server(code: "conflict", message: _) = error {
                throw HTTPTransferError.editConflict
            }
            throw error
        }
    }

    func resizeTerminal(
        streamID: UInt32,
        sessionID: UUID,
        generation: UInt64,
        ownerID: UUID,
        columns: Int,
        rows: Int
    ) async {
        guard columns > 0, rows > 0 else { return }
        let lifecycle = serverLifecycleGeneration
        guard ownsTerminal(
            streamID: streamID,
            sessionID: sessionID,
            generation: generation,
            ownerID: ownerID,
            lifecycle: lifecycle
        ) else { return }
        do {
            guard let serverScopeID = activeServerScopeID else { return }
            try await terminalResizeCoordinator.perform(streamID: streamID) { [weak self, remote] in
                guard let self,
                      await self.ownsTerminal(
                        streamID: streamID,
                        sessionID: sessionID,
                        generation: generation,
                        ownerID: ownerID,
                        lifecycle: lifecycle
                      ) else { return }
                _ = try await remote.call(
                    .terminalResize,
                    serverScopeID: serverScopeID,
                    params: .object([
                        "session_id": .string(sessionID.uuidString.lowercased()),
                        "generation": .unsignedInteger(generation),
                        "columns": .unsignedInteger(UInt64(columns)),
                        "rows": .unsignedInteger(UInt64(rows)),
                        "pixel_width": .unsignedInteger(0),
                        "pixel_height": .unsignedInteger(0)
                    ]),
                    deadlineMilliseconds: 2_000
                )
            }
        } catch is CancellationError {
        } catch {
            presentedError = "无法同步终端尺寸：\(error.localizedDescription)"
        }
    }

    private func ownsTerminal(
        streamID: UInt32,
        sessionID: UUID,
        generation: UInt64,
        ownerID: UUID,
        lifecycle: UUID
    ) -> Bool {
        lifecycle == serverLifecycleGeneration
            && TerminalOperationOwnershipPolicy.accepts(
                active: activeTerminals[streamID],
                sessionID: sessionID,
                generation: generation,
                ownerID: ownerID
            )
    }

    func forgetServer() async {
        guard PairingLifecyclePolicy.canBeginForget(isForgettingServer: isForgettingServer) else {
            return
        }
        isForgettingServer = true
        defer {
            profile = nil
            isForgettingServer = false
        }
        serverLifecycleGeneration = UUID()
        sceneTransitionGeneration = UUID()
        sessionRefreshRequestVersion &+= 1
        let staleSessionRefreshTask = sessionRefreshTask
        staleSessionRefreshTask?.cancel()
        sessionRefreshTask = nil
        sessionRefreshWorkerID = nil
        cancelReconnectLoop()
        connectAttemptGeneration = nil
        latencyProbeTask?.cancel()
        latencyProbeTask = nil
        activeConnectionID = nil
        activeTransportID = nil
        activeServerScopeID = nil
        connectionStatus = .disconnected

        let streamIDs = Set(activeTerminals.keys)
        terminalInputDrains.pauseAcceptance(streamIDs: streamIDs)
        let staleDetachTasks = pendingTerminalDetaches.values.map(\.task)
        staleDetachTasks.forEach { $0.cancel() }
        pendingTerminalDetaches.removeAll(keepingCapacity: false)
        terminalOutput.finishAllStreams()
        activeTerminals.removeAll(keepingCapacity: false)
        terminalInputReadyStreams.removeAll(keepingCapacity: false)
        ambiguousInputStreams.removeAll(keepingCapacity: false)
        isAmbiguousInputAlertPresented = false
        sessionStartAttempts = SessionStartAttemptStore()
        filePagination = FilePaginationState()
        fileListRequestID = nil
        isLoadingFiles = false
        isLoadingMoreFiles = false
        hasMoreFiles = false
        sessions = []
        workspaces = []
        files = []
        previewCapability = nil
        pairingState = .idle
        presentedError = nil

        // Invalidate the actor's server namespace before any new pairing can
        // begin, then let already-started best-effort detaches finish against
        // the now-disconnected transport.
        await remote.forgetServer()
        for task in staleDetachTasks { await task.value }
        await staleSessionRefreshTask?.value

        // Delete the profile first. If that fails, retain the orphan-safe key
        // rather than leaving a persisted profile that points at no identity.
        do {
            try ServerProfileStore.remove()
        } catch {
            presentedError = "服务器已从当前会话移除，但无法删除已保存的配对资料；重新打开 App 后它可能再次出现：\(error.localizedDescription)"
            return
        }
        do {
            try await DeviceIdentity.shared.delete()
        } catch {
            presentedError = "服务器与配对资料已移除，但设备私钥清理失败：\(error.localizedDescription)"
        }
    }

    func discardAmbiguousInput() async {
        let lifecycle = serverLifecycleGeneration
        guard let serverScopeID = activeServerScopeID else { return }
        let discarded = await remote.discardAmbiguousInput(serverScopeID: serverScopeID)
        guard lifecycle == serverLifecycleGeneration else { return }
        terminalInputReadyStreams.subtract(discarded)
        ambiguousInputStreams.subtract(discarded)
        isAmbiguousInputAlertPresented = !ambiguousInputStreams.isEmpty
        await resumeActiveTerminals(streamIDs: discarded)
    }

    func handleSceneBecameActive() async {
        sceneTransitionGeneration = UUID()
        isSceneActive = true
        guard profile != nil else { return }
        if connectionStatus.isReady {
            // Terminal reattachment is the foreground critical path. RTT
            // measurement uses its own ping FIFO, so launch it independently
            // and refresh sessions immediately instead of paying an extra full
            // round trip before output can resume.
            if let activeConnectionID {
                startLatencyProbe(connectionID: activeConnectionID)
            }
            // Cached terminal identities are generation-checked by the server,
            // so resume them first and put the first terminal byte on a one-RTT
            // path. The session list follows to reconcile any stale cache.
            await resumeActiveTerminals()
            await refreshSessions()
        } else if !connectionStatus.isConnecting {
            await connect()
        }
    }

    func handleSceneEnteredBackground() async {
        let transition = UUID()
        sceneTransitionGeneration = transition
        isSceneActive = false
        let activeSnapshot = activeTerminals
        let activeStreamIDs = Set(activeSnapshot.keys)
        // Pause synchronous delegate acceptance before the first await. Items
        // already accepted by a surface still drain; later keyboard callbacks
        // are explicitly rejected and can never race the detach boundary.
        terminalInputDrains.pauseAcceptance(streamIDs: activeStreamIDs)
        terminalInputReadyStreams.removeAll(keepingCapacity: true)
        latencyProbeTask?.cancel()
        latencyProbeTask = nil
        // A frame can already be in flight while the interactive detach waits
        // for the outbound FIFO. RemoteService may accept that frame and advance
        // its receive cursor after this model has stopped rendering. Force an
        // offset-zero replay on foreground so SwiftTerm can never resume beyond
        // bytes it did not consume.
        TerminalReplayPolicy.prepareForBackground(&activeTerminals)
        await terminalInputDrains.waitUntilDrained(streamIDs: activeStreamIDs)
        guard SceneLifecyclePolicy.shouldFinishBackgroundDrain(
            capturedGeneration: transition,
            currentGeneration: sceneTransitionGeneration,
            isSceneActive: isSceneActive
        ) else { return }
        let detaches = activeSnapshot.compactMap { streamID, active -> (UInt32, PendingTerminalDetach)? in
            guard TerminalOperationOwnershipPolicy.accepts(
                active: activeTerminals[streamID],
                sessionID: active.sessionID,
                generation: active.generation,
                ownerID: active.ownerID
            ) else { return nil }
            return (
                streamID,
                startTerminalDetach(streamID: streamID, generation: active.generation)
            )
        }
        for (streamID, pending) in detaches {
            await finishTerminalDetach(streamID: streamID, pending: pending)
        }
    }

    private func handle(_ packet: RemoteEventPacket) async {
        guard RemoteEventAcceptancePolicy.shouldAccept(
            eventTransportID: packet.transportID,
            activeTransportID: activeTransportID
        ) else { return }
        switch packet.event {
        case let .terminal(frame, reset):
            guard isSceneActive,
                  activeTerminals[frame.streamID] != nil,
                  frame.kind == .terminalOutput || frame.kind == .terminalSnapshot else { return }
            if !terminalOutput.deliver(frame.payload, for: frame.streamID, reset: reset) {
                TerminalReplayPolicy.recordUnrenderedOutput(
                    streamID: frame.streamID,
                    terminals: &activeTerminals
                )
            }
        case let .terminalEnded(streamID):
            activeTerminals.removeValue(forKey: streamID)
            terminalInputReadyStreams.remove(streamID)
            terminalInputDrains.pauseAcceptance(streamIDs: [streamID])
            // EOS closes output delivery; it does not prove whether previously
            // unacknowledged input executed. A quarantined stream remains in
            // the explicit-discard alert until the user resolves it.
            isAmbiguousInputAlertPresented = !ambiguousInputStreams.isEmpty
            terminalOutput.finishStream(streamID)
            Task { await refreshSessions() }
        case let .disconnected(message):
            latencyProbeTask?.cancel()
            latencyProbeTask = nil
            activeConnectionID = nil
            activeTransportID = nil
            TerminalReplayPolicy.prepareForTransportReplacement(&activeTerminals)
            terminalInputDrains.pauseAcceptance(streamIDs: Set(activeTerminals.keys))
            terminalInputReadyStreams.removeAll(keepingCapacity: true)
            connectionStatus = .disconnected
            startReconnectLoop(message: message)
        case let .inputAmbiguous(streamIDs):
            ambiguousInputStreams.formUnion(streamIDs)
            terminalInputReadyStreams.subtract(streamIDs)
            terminalInputDrains.pauseAcceptance(streamIDs: streamIDs)
            isAmbiguousInputAlertPresented = true
        case let .outputGap(streamID, expected, received):
            presentedError = "终端流 \(streamID) 检测到缺口（\(expected) → \(received)），正在请求重放。"
        case let .mutationOutcomeAmbiguous(method):
            presentedError = "已取消 \(method.rawValue)，但服务器执行结果仍可能已生效；Linco 会通过状态列表安全核对。"
        case let .interactiveInputFault(message):
            presentedError = "终端输入状态异常：\(message)"
        case let .terminalInputRejected(streamID, code):
            terminalInputReadyStreams.remove(streamID)
            terminalInputDrains.pauseAcceptance(streamIDs: [streamID])
            ambiguousInputStreams.remove(streamID)
            isAmbiguousInputAlertPresented = !ambiguousInputStreams.isEmpty
            if activeTerminals[streamID] != nil {
                activeTerminals[streamID]?.requiresFullReplay = true
            }
            presentedError = "终端输入已停止（\(code)），正在刷新会话状态。"
            Task { await refreshSessions() }
        case let .control(message):
            if message.type == "resume_reset" {
                Task { await refreshSessions() }
            }
        }
    }

    private func startReconnectLoop(message: String?) {
        guard reconnectTask == nil, profile != nil else { return }
        if let message { presentedError = "连接中断，正在恢复：\(message)" }
        let generation = UUID()
        reconnectGeneration = generation
        reconnectTask = Task { [weak self] in
            var backoff = ReconnectBackoff()
            while !Task.isCancelled {
                let schedule = backoff.next(jitterSample: Double.random(in: 0...1))
                self?.connectionStatus = .reconnecting(attempt: schedule.attempt)
                do {
                    try await Task.sleep(for: .milliseconds(schedule.delayMilliseconds))
                } catch {
                    break
                }
                guard !Task.isCancelled, let self, let profile = self.profile else { break }
                if let connectionID = await self.connectOnce(
                    profile: profile,
                    retryAttempt: schedule.attempt
                ), ConnectionLivenessPolicy.isLive(
                    committedID: connectionID,
                    activeID: self.activeConnectionID,
                    statusIsReady: self.connectionStatus.isReady
                ) {
                    backoff.registerSuccess()
                    break
                }
            }
            self?.finishReconnectLoop(generation: generation)
        }
    }

    private func cancelReconnectLoop() {
        reconnectGeneration = nil
        reconnectTask?.cancel()
        reconnectTask = nil
    }

    private func finishReconnectLoop(generation: UUID) {
        guard reconnectGeneration == generation else { return }
        reconnectGeneration = nil
        reconnectTask = nil
    }

    private func decodeSessionList(_ value: JSONValue) throws -> [RemoteSession] {
        guard let array = value.objectValue?["sessions"], array.arrayValue != nil else {
            throw AppModelError.invalidSessionList
        }
        let data = try JSONEncoder().encode(array)
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .millisecondsSince1970
        return try decoder.decode([RemoteSession].self, from: data)
    }

    private func runSessionRefreshLoop(lifecycle: UUID, workerID: UUID) async {
        while !Task.isCancelled,
              lifecycle == serverLifecycleGeneration,
              connectionStatus.isReady {
            let requestedVersion = sessionRefreshRequestVersion
            do {
                let value = try await callRemote(.sessionList)
                guard !Task.isCancelled,
                      lifecycle == serverLifecycleGeneration else { break }
                // A trigger that arrived while this RPC was in flight requires
                // a new, strictly later server snapshot. Never reconcile active
                // terminal ownership from the superseded response.
                guard SessionRefreshPolicy.shouldApply(
                    responseVersion: requestedVersion,
                    latestRequestedVersion: sessionRefreshRequestVersion
                ) else { continue }
                sessions = try decodeSessionList(value)
                await resumeActiveTerminals()
                guard SessionRefreshPolicy.shouldApply(
                    responseVersion: requestedVersion,
                    latestRequestedVersion: sessionRefreshRequestVersion
                ) else { continue }
                break
            } catch is CancellationError {
                break
            } catch {
                guard lifecycle == serverLifecycleGeneration else { break }
                if connectionStatus.isReady,
                   !SessionRefreshPolicy.shouldApply(
                    responseVersion: requestedVersion,
                    latestRequestedVersion: sessionRefreshRequestVersion
                   ) {
                    continue
                }
                presentedError = "无法刷新会话：\(error.localizedDescription)"
                break
            }
        }
        if sessionRefreshWorkerID == workerID {
            sessionRefreshWorkerID = nil
            sessionRefreshTask = nil
        }
    }

    private func callRemote(
        _ method: RPCMethod,
        params: JSONValue = .object([:]),
        idempotencyKey: UUID? = nil,
        deadlineMilliseconds: UInt64 = 5_000
    ) async throws -> JSONValue {
        guard let serverScopeID = activeServerScopeID else {
            throw RemoteServiceError.disconnected
        }
        return try await remote.call(
            method,
            serverScopeID: serverScopeID,
            params: params,
            idempotencyKey: idempotencyKey,
            deadlineMilliseconds: deadlineMilliseconds
        )
    }

    private func reconcileSessionStart(_ request: SessionStartWireRequest) async -> Bool {
        let lifecycle = serverLifecycleGeneration
        await refreshSessions()
        guard lifecycle == serverLifecycleGeneration else { return false }
        return request.reconciles(sessionIDs: sessions.map(\.id))
    }

    private func resumeActiveTerminals(streamIDs requestedStreams: Set<UInt32>? = nil) async {
        guard isSceneActive else { return }
        let lifecycle = serverLifecycleGeneration
        guard let serverScopeID = activeServerScopeID else { return }
        var resumable: [UInt32: RemoteSession] = [:]
        for session in sessions where session.state.keepsTerminalStreamOpen {
            resumable[session.streamID] = session
        }
        let activeSnapshot = activeTerminals
        for (streamID, active) in activeSnapshot {
            if let requestedStreams, !requestedStreams.contains(streamID) { continue }
            guard let session = resumable[streamID], session.id == active.sessionID else {
                activeTerminals.removeValue(forKey: streamID)
                terminalInputReadyStreams.remove(streamID)
                await detachTerminal(streamID: streamID, generation: active.generation)
                guard lifecycle == serverLifecycleGeneration else { return }
                if !ambiguousInputStreams.contains(streamID) {
                    await remote.discardTerminalState(
                        streamID: streamID,
                        serverScopeID: serverScopeID
                    )
                }
                guard lifecycle == serverLifecycleGeneration else { return }
                terminalOutput.finishStream(streamID)
                continue
            }
            let needsFullReplay = session.generation != active.generation || active.requiresFullReplay
            if needsFullReplay { terminalOutput.reset(streamID) }
            activeTerminals[streamID] = ActiveTerminal(
                sessionID: session.id,
                generation: session.generation,
                ownerID: active.ownerID,
                requiresFullReplay: needsFullReplay
            )
            if !needsFullReplay,
               terminalInputReadyStreams.contains(streamID),
               active.generation == session.generation {
                continue
            }
            do {
                terminalInputReadyStreams.remove(streamID)
                await waitForPendingTerminalDetach(streamID: streamID)
                guard lifecycle == serverLifecycleGeneration,
                      isSceneActive,
                      activeTerminals[streamID]?.ownerID == active.ownerID,
                      activeTerminals[streamID]?.generation == session.generation else { continue }
                try await remote.resumeTerminal(
                    streamID: streamID,
                    generation: session.generation,
                    offset: TerminalReplayPolicy.resumeOffset(requiresFullReplay: needsFullReplay),
                    serverScopeID: serverScopeID
                )
                if connectionStatus.isReady,
                   lifecycle == serverLifecycleGeneration,
                   isSceneActive,
                   activeTerminals[streamID]?.ownerID == active.ownerID,
                   activeTerminals[streamID]?.generation == session.generation {
                    activeTerminals[streamID]?.requiresFullReplay = false
                    terminalInputReadyStreams.insert(streamID)
                    terminalInputDrains.resumeAcceptance(streamIDs: [streamID])
                }
            } catch {
                guard lifecycle == serverLifecycleGeneration else { return }
                presentedError = "无法恢复终端：\(error.localizedDescription)"
            }
        }
    }

    private func detachTerminal(streamID: UInt32, generation: UInt64) async {
        let pending = startTerminalDetach(streamID: streamID, generation: generation)
        await finishTerminalDetach(streamID: streamID, pending: pending)
    }

    private func startTerminalDetach(streamID: UInt32, generation: UInt64) -> PendingTerminalDetach {
        if let pending = pendingTerminalDetaches[streamID] { return pending }
        let token = UUID()
        let serverScopeID = activeServerScopeID
        let task = Task { [remote] in
            guard let serverScopeID else { return }
            await remote.deactivateTerminal(
                streamID: streamID,
                generation: generation,
                serverScopeID: serverScopeID
            )
        }
        let pending = PendingTerminalDetach(token: token, task: task)
        pendingTerminalDetaches[streamID] = pending
        return pending
    }

    private func finishTerminalDetach(streamID: UInt32, pending: PendingTerminalDetach) async {
        await pending.task.value
        if pendingTerminalDetaches[streamID]?.token == pending.token {
            pendingTerminalDetaches.removeValue(forKey: streamID)
        }
    }

    private func waitForPendingTerminalDetach(streamID: UInt32) async {
        guard let pending = pendingTerminalDetaches[streamID] else { return }
        await finishTerminalDetach(streamID: streamID, pending: pending)
    }

    private func updateReadyLatency(_ latency: Int) {
        guard case let .ready(path, _) = connectionStatus else { return }
        connectionStatus = .ready(path: path, latencyMilliseconds: latency)
    }

    private func startLatencyProbe(connectionID: UUID) {
        latencyProbeTask?.cancel()
        guard let serverScopeID = activeServerScopeID else { return }
        latencyProbeTask = Task { [weak self, remote] in
            do {
                let latency = try await remote.probe(serverScopeID: serverScopeID)
                guard !Task.isCancelled,
                      self?.activeConnectionID == connectionID else { return }
                self?.updateReadyLatency(latency)
            } catch is CancellationError {
            } catch {
                // RemoteService publishes the transport failure and reconnects
                // through the normal event path.
            }
        }
    }

}

struct ActiveTerminal: Sendable, Equatable {
    let sessionID: UUID
    let generation: UInt64
    let ownerID: UUID
    var requiresFullReplay: Bool
}

enum TerminalReplayPolicy {
    static func prepareForBackground(_ terminals: inout [UInt32: ActiveTerminal]) {
        for streamID in Array(terminals.keys) {
            terminals[streamID]?.requiresFullReplay = true
        }
    }

    static func prepareForTransportReplacement(_ terminals: inout [UInt32: ActiveTerminal]) {
        prepareForBackground(&terminals)
    }

    static func resumeOffset(requiresFullReplay: Bool) -> UInt64? {
        requiresFullReplay ? 0 : nil
    }

    /// A surface can unsubscribe before its accepted input finishes draining.
    /// Missing that surface therefore requires replay, not an eager detach; the
    /// surface's drain completion remains the sole lifecycle owner.
    static func recordUnrenderedOutput(
        streamID: UInt32,
        terminals: inout [UInt32: ActiveTerminal]
    ) {
        terminals[streamID]?.requiresFullReplay = true
    }
}

enum SceneLifecyclePolicy {
    static func shouldFinishBackgroundDrain(
        capturedGeneration: UUID,
        currentGeneration: UUID,
        isSceneActive: Bool
    ) -> Bool {
        !isSceneActive && capturedGeneration == currentGeneration
    }
}

enum PairingLifecyclePolicy {
    static func canBeginPair(
        isForgettingServer: Bool,
        isPairingInProgress: Bool
    ) -> Bool {
        !isForgettingServer && !isPairingInProgress
    }

    static func canBeginForget(isForgettingServer: Bool) -> Bool {
        !isForgettingServer
    }
}

enum SessionRefreshPolicy {
    static func shouldApply(
        responseVersion: UInt64,
        latestRequestedVersion: UInt64
    ) -> Bool {
        responseVersion == latestRequestedVersion
    }
}

enum TerminalOperationOwnershipPolicy {
    static func accepts(
        active: ActiveTerminal?,
        sessionID: UUID,
        generation: UInt64,
        ownerID: UUID
    ) -> Bool {
        active?.sessionID == sessionID
            && active?.generation == generation
            && active?.ownerID == ownerID
    }
}

enum ConnectionLivenessPolicy {
    static func isLive(committedID: UUID, activeID: UUID?, statusIsReady: Bool) -> Bool {
        statusIsReady && activeID == committedID
    }
}

enum RemoteEventAcceptancePolicy {
    static func shouldAccept(eventTransportID: UUID, activeTransportID: UUID?) -> Bool {
        eventTransportID == activeTransportID
    }
}

private struct PendingTerminalDetach {
    let token: UUID
    let task: Task<Void, Never>
}

enum AppModelError: LocalizedError {
    case fileIsNotUTF8
    case missingFileRevision
    case invalidWorkspaceList
    case invalidSessionList

    var errorDescription: String? {
        switch self {
        case .fileIsNotUTF8: "该文件不是 UTF-8 文本，无法在代码编辑器中打开。"
        case .missingFileRevision: "服务器没有返回文件版本标识；为避免覆盖远端修改，Linco 已取消保存。"
        case .invalidWorkspaceList: "服务器返回了无效的工作区列表。"
        case .invalidSessionList: "服务器返回了无效的会话列表。"
        }
    }
}

private extension ConnectionPath {
    var displayName: String {
        switch self {
        case .direct: "直连"
        }
    }
}

private extension Error {
    var isDefinitiveRPCFailure: Bool {
        (self as? RemoteServiceError)?.isDefinitiveRPCFailure == true
    }
}
