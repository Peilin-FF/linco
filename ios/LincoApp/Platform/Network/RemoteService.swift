import Foundation
import LincoCore
import Network
import Security

struct NetworkPathSnapshot: Sendable, Equatable {
    enum Interface: String, Sendable, Equatable {
        case wifi
        case cellular
        case wiredEthernet
        case other
    }

    let isSatisfied: Bool
    let interface: Interface?
}

enum NetworkPathRecoveryDecision: Sendable, Equatable {
    case none
    case probe
    case disconnect
}

enum NetworkPathRecoveryPolicy {
    static func decision(
        previous: NetworkPathSnapshot?,
        current: NetworkPathSnapshot
    ) -> NetworkPathRecoveryDecision {
        guard current.isSatisfied else { return .disconnect }
        guard let previous else { return .none }
        if !previous.isSatisfied || previous.interface != current.interface { return .probe }
        return .none
    }
}

enum RemoteEvent: Sendable {
    case control(ServerEnvelope)
    case terminal(frame: BinaryFrame, reset: Bool)
    case terminalEnded(streamID: UInt32)
    case disconnected(String)
    case inputAmbiguous(Set<UInt32>)
    case outputGap(streamID: UInt32, expected: UInt64, received: UInt64)
    case mutationOutcomeAmbiguous(method: RPCMethod)
    case interactiveInputFault(String)
    case terminalInputRejected(streamID: UInt32, code: String)
}

struct RemoteEventPacket: Sendable {
    let transportID: UUID
    let event: RemoteEvent
}

private actor RemoteOperationSignal {
    private enum State {
        case pending
        case succeeded
        case failed(RemoteServiceError)
        case cancelled
    }

    private var state: State = .pending
    private var waiters: [CheckedContinuation<Void, any Error>] = []

    func wait() async throws {
        switch state {
        case .pending:
            try await withCheckedThrowingContinuation { waiters.append($0) }
        case .succeeded:
            return
        case let .failed(error):
            throw error
        case .cancelled:
            throw CancellationError()
        }
    }

    func succeed() {
        guard case .pending = state else { return }
        state = .succeeded
        let waiters = self.waiters
        self.waiters.removeAll()
        waiters.forEach { $0.resume() }
    }

    func fail(_ error: RemoteServiceError) {
        guard case .pending = state else { return }
        state = .failed(error)
        let waiters = self.waiters
        self.waiters.removeAll()
        waiters.forEach { $0.resume(throwing: error) }
    }

    func cancel() {
        guard case .pending = state else { return }
        state = .cancelled
        let waiters = self.waiters
        self.waiters.removeAll()
        waiters.forEach { $0.resume(throwing: CancellationError()) }
    }
}

struct TerminalResumeBaseline: Sendable, Equatable {
    let streamID: UInt32
    let generation: UInt64
    let startingOffset: UInt64
    let inputThrough: UInt64

    init(streamID: UInt32, generation: UInt64, startingOffset: UInt64, inputThrough: UInt64) {
        self.streamID = streamID
        self.generation = generation
        self.startingOffset = startingOffset
        self.inputThrough = inputThrough
    }

    init?(envelope: ServerEnvelope) {
        guard let streamID = envelope.uint64("stream_id").flatMap(UInt32.init(exactly:)),
              let generation = envelope.uint64("generation"),
              let startingOffset = envelope.uint64("starting_offset"),
              let inputThrough = envelope.uint64("input_through") else { return nil }
        self.init(
            streamID: streamID,
            generation: generation,
            startingOffset: startingOffset,
            inputThrough: inputThrough
        )
    }

    init?(value: JSONValue?) {
        guard let object = value?.objectValue,
              let streamID = object["stream_id"]?.uint64Value.flatMap(UInt32.init(exactly:)),
              let generation = object["generation"]?.uint64Value,
              let startingOffset = object["starting_offset"]?.uint64Value,
              let inputThrough = object["input_through"]?.uint64Value else { return nil }
        self.init(
            streamID: streamID,
            generation: generation,
            startingOffset: startingOffset,
            inputThrough: inputThrough
        )
    }
}

struct TerminalResumeHandshake: Sendable, Equatable {
    let streamID: UInt32
    let generation: UInt64
    private(set) var openedBaseline: TerminalResumeBaseline?

    init(streamID: UInt32, generation: UInt64, openedBaseline: TerminalResumeBaseline?) {
        self.streamID = streamID
        self.generation = generation
        self.openedBaseline = openedBaseline
    }

    mutating func registerOpened(_ baseline: TerminalResumeBaseline) -> Bool {
        guard baseline.streamID == streamID, baseline.generation == generation else { return false }
        openedBaseline = baseline
        return true
    }

    func acceptsResult(_ baseline: TerminalResumeBaseline) -> Bool {
        openedBaseline == baseline
            && baseline.streamID == streamID
            && baseline.generation == generation
    }
}

private struct PendingTerminalResume: Sendable {
    let callID: UUID
    let streamID: UInt32
    let generation: UInt64
    let serverScopeID: UUID
    let transportID: UUID
    let signal: RemoteOperationSignal
    var handshake: TerminalResumeHandshake
}

private struct TerminalInputFault: Sendable {
    let streamID: UInt32
    let generation: UInt64?
    let code: String
    let discardPending: Bool

    init?(envelope: ServerEnvelope) {
        guard envelope.type == "terminal_input_fault",
              let streamID = envelope.uint64("stream_id").flatMap(UInt32.init(exactly:)),
              let code = envelope.string("code"),
              case let .bool(discardPending)? = envelope.fields["discard_pending"] else { return nil }
        self.streamID = streamID
        self.generation = envelope.uint64("generation")
        self.code = code
        self.discardPending = discardPending
    }
}

enum TerminalInputFaultDisposition: Sendable, Equatable {
    case discardStream
    case quarantine
    case retryAfterReconnect
    case invalid
}

enum TerminalInputFaultPolicy {
    static func disposition(code: String, discardPending: Bool) -> TerminalInputFaultDisposition {
        if code == "overloaded", !discardPending { return .retryAfterReconnect }
        if ["not_found", "session_exited", "generation_changed"].contains(code), discardPending {
            return .discardStream
        }
        if ["conflict", "ambiguous"].contains(code), !discardPending { return .quarantine }
        return .invalid
    }
}

enum TerminalInputAdmission: Sendable, Equatable {
    case ready
    case notResumed
    case superseded
}

enum TerminalInputAdmissionPolicy {
    static func disposition(
        expectedGeneration: UInt64?,
        requestedGeneration: UInt64
    ) -> TerminalInputAdmission {
        guard let expectedGeneration else { return .notResumed }
        return expectedGeneration == requestedGeneration ? .ready : .superseded
    }
}

struct ConnectedServer: Sendable {
    let serverScopeID: UUID
    let transportID: UUID
    let connectionID: UUID
    let serverEpoch: UUID
    let connectionPath: ConnectionPath
    let ambiguousInputStreams: Set<UInt32>
}

actor RemoteEventRelay {
    typealias Handler = @Sendable (RemoteEventPacket) async -> Void

    private var handler: Handler?

    func install(_ handler: Handler?) {
        self.handler = handler
    }

    /// Delivery is rendezvous-style: the producer does not resume until the
    /// installed handler has consumed the event. No hidden AsyncStream queue can
    /// grow during sustained terminal output.
    func deliver(_ packet: RemoteEventPacket) async {
        guard let handler else { return }
        await handler(packet)
    }
}

actor RemoteService {
    private let eventRelay = RemoteEventRelay()
    private let identity: DeviceIdentity
    private var controlSocket: LincoWebSocket?
    private var interactiveSocket: LincoWebSocket?
    private var controlReader: Task<Void, Never>?
    private var interactiveReader: Task<Void, Never>?
    private var heartbeatTask: Task<Void, Never>?
    private var networkPathMonitor: NWPathMonitor?
    private var networkPathSnapshot: NetworkPathSnapshot?
    private var networkPathProbeTask: Task<Void, Never>?
    private var networkPathProbeID: UUID?
    private var hasPublishedTransportFailure = true
    private var transportGeneration: UUID?
    private var failureNotificationGeneration: UUID?
    private var pendingCalls: [UUID: CheckedContinuation<JSONValue, any Error>] = [:]
    private var reliabilityScope = UUID()
    private var inputLedger = TerminalInputLedger()
    private var outputLedger = TerminalOutputLedger()
    private var streamGenerations: [UInt32: UInt64] = [:]
    private var expectedStreamGenerations: [UInt32: UInt64] = [:]
    private var inputReadyGenerations: [UInt32: UInt64] = [:]
    private var terminalResumeCalls: [UUID: PendingTerminalResume] = [:]
    private var terminalResumeCallByStream: [UInt32: UUID] = [:]
    private var inputReadinessWaiters: [UInt32: [UUID: RemoteOperationSignal]] = [:]
    private var inputCapacityWaiters: [UInt32: [UUID: RemoteOperationSignal]] = [:]
    private var terminalInputGates: [UInt32: AsyncSerialGate] = [:]
    private var bestEffortCallIDs: Set<UUID> = []

    init(identity: DeviceIdentity = .shared) {
        self.identity = identity
    }

    func setEventHandler(_ handler: RemoteEventRelay.Handler?) async {
        await eventRelay.install(handler)
    }

    func isTransportActive(_ id: UUID) -> Bool {
        transportGeneration == id
            && !hasPublishedTransportFailure
            && controlSocket != nil
            && interactiveSocket != nil
    }

    func connect(profile: ServerProfile) async throws -> ConnectedServer {
        let generation = UUID()
        let previousControl = controlSocket
        let previousInteractive = interactiveSocket
        heartbeatTask?.cancel()
        controlReader?.cancel()
        interactiveReader?.cancel()
        stopNetworkPathMonitoring()
        heartbeatTask = nil
        controlReader = nil
        interactiveReader = nil
        controlSocket = nil
        interactiveSocket = nil
        streamGenerations.removeAll(keepingCapacity: true)
        inputReadyGenerations.removeAll(keepingCapacity: true)
        bestEffortCallIDs.removeAll(keepingCapacity: true)
        failAllPending(with: RemoteServiceError.disconnected)
        let staleSignals = drainTerminalResumeSignals()
        transportGeneration = generation
        failureNotificationGeneration = nil
        hasPublishedTransportFailure = false
        for signal in staleSignals { await signal.fail(.disconnected) }
        await previousControl?.close()
        await previousInteractive?.close()
        try validateConnectionTransaction(generation)

        var localControl: LincoWebSocket?
        var localInteractive: LincoWebSocket?

        do {
            let clientNonce = try SecureRandomSource.bytes(count: 32)
            let control = try LincoWebSocket(baseURL: profile.endpoint, lane: .control)
            localControl = control
            try await control.open()
            try validateConnectionTransaction(generation)
            try await control.sendControl(HelloMessage(
                lane: .control,
                deviceID: profile.deviceID,
                clientNonce: clientNonce,
                // Terminal input can only be replayed after this connection has
                // received a fresh per-stream `input_through`. Active terminals
                // therefore resume explicitly after both lanes commit.
                resume: ResumeCursor()
            ))
            try validateConnectionTransaction(generation)
            let hello = try await expectControl(type: "hello", from: control)
            try validateConnectionTransaction(generation)
            guard hello.uint64("protocol_version") == UInt64(ControlProtocol.version),
                  hello.string("lane") == LogicalChannel.control.rawValue,
                  let connectionID = hello.uuid("connection_id"),
                  let serverEpoch = hello.uuid("server_epoch"),
                  let encodedIdentity = hello.string("server_identity_b64"),
                  Data(base64URL: encodedIdentity) == profile.serverIdentity,
                  let encodedChallenge = hello.string("auth_challenge_b64"),
                  let challenge = Data(base64URL: encodedChallenge),
                  let encodedServerSignature = hello.string("server_signature_b64"),
                  let serverSignature = Data(base64URL: encodedServerSignature),
                  try ServerHelloProof.verify(
                    signature: serverSignature,
                    protocolVersion: ControlProtocol.version,
                    lane: .control,
                    connectionID: connectionID,
                    serverEpoch: serverEpoch,
                    clientNonce: clientNonce,
                    challenge: challenge,
                    serverIdentity: profile.serverIdentity
                  ) else {
                throw RemoteServiceError.invalidServerHello
            }
            let pingInterval = HeartbeatCadence.pingIntervalMilliseconds(
                advertisedHeartbeatMilliseconds: hello.uint64("heartbeat_ms")
            )

            let transcript = try AuthenticationTranscript.encode(
                connectionID: connectionID,
                deviceID: profile.deviceID,
                serverEpoch: serverEpoch,
                clientNonce: clientNonce,
                challenge: challenge,
                serverIdentity: profile.serverIdentity
            )
            let signature = try await identity.signature(for: transcript)
            try validateConnectionTransaction(generation)
            try await control.sendControl(AuthenticateMessage(
                connectionID: connectionID,
                deviceID: profile.deviceID,
                challengeSignature: signature
            ))
            try validateConnectionTransaction(generation)
            let controlReady = try await expectControl(type: "ready", from: control)
            try validateConnectionTransaction(generation)
            let ticket = try interactiveTicket(from: controlReady)

            let interactive = try LincoWebSocket(baseURL: profile.endpoint, lane: .interactive)
            localInteractive = interactive
            try await interactive.open()
            try validateConnectionTransaction(generation)
            let laneNonce = try SecureRandomSource.bytes(count: 32)
            try await interactive.sendControl(AttachLaneMessage(
                connectionID: connectionID,
                lane: .interactive,
                ticket: ticket,
                clientNonce: laneNonce
            ))
            try validateConnectionTransaction(generation)
            let interactiveReady = try await expectControl(type: "ready", from: interactive)
            try validateConnectionTransaction(generation)
            guard interactiveReady.string("lane") == LogicalChannel.interactive.rawValue else {
                throw RemoteServiceError.invalidInteractiveReady
            }

            guard let path = ConnectionPath(rawValue: controlReady.string("connection_path") ?? "") else {
                throw RemoteServiceError.invalidConnectionPath
            }
            let epochTransition = inputLedger.beginServerEpoch(serverEpoch)
            try validateConnectionTransaction(generation)
            controlSocket = control
            interactiveSocket = interactive
            startNetworkPathMonitoring(generation: generation)
            controlReader = Task { await readControlLoop(control, generation: generation) }
            interactiveReader = Task { await readInteractiveLoop(interactive, generation: generation) }
            startHeartbeat(
                control: control,
                interactive: interactive,
                intervalMilliseconds: pingInterval,
                generation: generation
            )
            let ambiguousInputStreams: Set<UInt32>
            if case let .ambiguous(streamIDs) = epochTransition {
                ambiguousInputStreams = streamIDs
            } else {
                ambiguousInputStreams = []
            }
            return ConnectedServer(
                serverScopeID: reliabilityScope,
                transportID: generation,
                connectionID: connectionID,
                serverEpoch: serverEpoch,
                connectionPath: path,
                ambiguousInputStreams: ambiguousInputStreams
            )
        } catch {
            if transportGeneration == generation {
                await abortConnectionTransaction(generation: generation)
            }
            await localControl?.close()
            await localInteractive?.close()
            throw error
        }
    }

    func disconnect() async {
        let cleanup = prepareDisconnect()
        await finishDisconnect(cleanup)
    }

    /// Removes the complete reliability namespace for the paired server before
    /// yielding. Pending cursors and queued gate operations must not survive
    /// into a later pairing whose stream IDs or epochs may coincidentally match.
    func forgetServer() async {
        reliabilityScope = UUID()
        inputLedger.resetForServerIdentityChange()
        outputLedger.resetForServerIdentityChange()
        terminalInputGates.removeAll(keepingCapacity: false)
        let cleanup = prepareDisconnect()
        await finishDisconnect(cleanup)
    }

    private func prepareDisconnect() -> (
        control: LincoWebSocket?,
        interactive: LincoWebSocket?,
        signals: [RemoteOperationSignal]
    ) {
        hasPublishedTransportFailure = true
        transportGeneration = nil
        failureNotificationGeneration = nil
        heartbeatTask?.cancel()
        stopNetworkPathMonitoring()
        heartbeatTask = nil
        controlReader?.cancel()
        interactiveReader?.cancel()
        bestEffortCallIDs.removeAll(keepingCapacity: true)
        controlReader = nil
        interactiveReader = nil
        let control = controlSocket
        let interactive = interactiveSocket
        controlSocket = nil
        interactiveSocket = nil
        streamGenerations.removeAll(keepingCapacity: true)
        expectedStreamGenerations.removeAll(keepingCapacity: true)
        inputReadyGenerations.removeAll(keepingCapacity: true)
        failAllPending(with: RemoteServiceError.disconnected)
        let signals = drainAllTerminalOperationSignals()
        return (control, interactive, signals)
    }

    private func finishDisconnect(_ cleanup: (
        control: LincoWebSocket?,
        interactive: LincoWebSocket?,
        signals: [RemoteOperationSignal]
    )) async {
        for signal in cleanup.signals { await signal.fail(.disconnected) }
        await cleanup.control?.close()
        await cleanup.interactive?.close()
    }

    func cancelConnectionAttempt() async {
        guard let generation = transportGeneration else { return }
        await abortConnectionTransaction(generation: generation)
    }

    private func abortConnectionTransaction(generation: UUID) async {
        guard transportGeneration == generation else { return }
        hasPublishedTransportFailure = true
        transportGeneration = nil
        failureNotificationGeneration = nil
        heartbeatTask?.cancel()
        controlReader?.cancel()
        interactiveReader?.cancel()
        stopNetworkPathMonitoring()
        heartbeatTask = nil
        controlReader = nil
        interactiveReader = nil
        bestEffortCallIDs.removeAll(keepingCapacity: true)
        let control = controlSocket
        let interactive = interactiveSocket
        controlSocket = nil
        interactiveSocket = nil
        streamGenerations.removeAll(keepingCapacity: true)
        inputReadyGenerations.removeAll(keepingCapacity: true)
        failAllPending(with: RemoteServiceError.disconnected)
        let signals = drainTerminalResumeSignals()
        for signal in signals { await signal.fail(.disconnected) }
        await control?.close()
        await interactive?.close()
    }

    func call(
        _ method: RPCMethod,
        serverScopeID: UUID,
        params: JSONValue = .object([:]),
        idempotencyKey: UUID? = nil,
        deadlineMilliseconds: UInt64 = 5_000
    ) async throws -> JSONValue {
        guard serverScopeID == reliabilityScope else {
            throw RemoteServiceError.serverIdentityChanged
        }
        guard let controlSocket else { throw RemoteServiceError.disconnected }
        let id = UUID()
        let message = try CallMessage(
            id: id,
            method: method,
            params: params,
            idempotencyKey: method.isMutating ? (idempotencyKey ?? UUID()) : nil,
            deadlineMilliseconds: deadlineMilliseconds
        )

        return try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { continuation in
                pendingCalls[id] = continuation
                Task {
                    do {
                        try await controlSocket.sendControl(message)
                    } catch {
                        await self.failPending(id: id, error: error)
                    }
                }
            }
        } onCancel: {
            Task {
                await self.cancelPendingCall(id: id, method: method, socket: controlSocket)
            }
        }
    }

    func sendTerminalInput(
        streamID: UInt32,
        generation: UInt64,
        bytes: Data,
        serverScopeID: UUID
    ) async throws {
        guard serverScopeID == reliabilityScope else {
            throw RemoteServiceError.serverIdentityChanged
        }
        let scope = serverScopeID
        switch TerminalInputAdmissionPolicy.disposition(
            expectedGeneration: expectedStreamGenerations[streamID],
            requestedGeneration: generation
        ) {
        case .ready:
            break
        case .notResumed:
            throw RemoteServiceError.terminalInputNotReady(streamID: streamID)
        case .superseded:
            throw RemoteServiceError.terminalResumeSuperseded(streamID: streamID)
        }
        let gate: AsyncSerialGate
        if let existing = terminalInputGates[streamID] {
            gate = existing
        } else {
            let created = AsyncSerialGate()
            terminalInputGates[streamID] = created
            gate = created
        }
        try await gate.perform { [self] in
            try await performTerminalInput(
                streamID: streamID,
                generation: generation,
                bytes: bytes,
                scope: scope
            )
        }
    }

    private func performTerminalInput(
        streamID: UInt32,
        generation: UInt64,
        bytes: Data,
        scope: UUID
    ) async throws {
        guard reliabilityScope == scope else { throw RemoteServiceError.serverIdentityChanged }
        guard !bytes.isEmpty else { return }
        guard bytes.count <= inputLedger.maximumPendingBytesPerStream else {
            throw RemoteServiceError.terminalInputTooLarge(
                maximumBytes: inputLedger.maximumPendingBytesPerStream
            )
        }

        while true {
            guard reliabilityScope == scope else { throw RemoteServiceError.serverIdentityChanged }
            guard let expectedGeneration = expectedStreamGenerations[streamID],
                  expectedGeneration == generation else {
                throw RemoteServiceError.terminalStreamEnded(streamID: streamID)
            }
            guard let interactiveSocket,
                  let transport = transportGeneration,
                  streamGenerations[streamID] == expectedGeneration,
                  inputReadyGenerations[streamID] == expectedGeneration else {
                let waiterID = UUID()
                let signal = RemoteOperationSignal()
                inputReadinessWaiters[streamID, default: [:]][waiterID] = signal
                do {
                    try await withTaskCancellationHandler {
                        try await signal.wait()
                    } onCancel: {
                        Task { await self.cancelInputReadinessWaiter(streamID: streamID, id: waiterID) }
                    }
                } catch {
                    inputReadinessWaiters[streamID]?.removeValue(forKey: waiterID)
                    if inputReadinessWaiters[streamID]?.isEmpty == true {
                        inputReadinessWaiters.removeValue(forKey: streamID)
                    }
                    throw error
                }
                continue
            }
            do {
                let reservedFrames = try inputLedger.enqueueBatch(streamID: streamID, payload: bytes)
                for frame in reservedFrames {
                    guard reliabilityScope == scope else {
                        throw RemoteServiceError.serverIdentityChanged
                    }
                    do {
                        try await interactiveSocket.sendBinary(frame)
                    } catch {
                        // Every byte in this delegate item was reserved before
                        // the first send. The ledger owns same-epoch replay, so
                        // a mid-batch transport failure must not make the pump
                        // retry and duplicate the already accepted prefix.
                        await transportDidFail(error, generation: transport)
                        return
                    }
                    guard reliabilityScope == scope else {
                        throw RemoteServiceError.serverIdentityChanged
                    }
                    guard transportGeneration == transport else { return }
                }
                return
            } catch TerminalReliabilityError.inputBackpressure(streamID: _) {
                let waiterID = UUID()
                let signal = RemoteOperationSignal()
                inputCapacityWaiters[streamID, default: [:]][waiterID] = signal
                do {
                    try await withTaskCancellationHandler {
                        try await signal.wait()
                    } onCancel: {
                        Task { await self.cancelInputCapacityWaiter(streamID: streamID, id: waiterID) }
                    }
                } catch {
                    inputCapacityWaiters[streamID]?.removeValue(forKey: waiterID)
                    if inputCapacityWaiters[streamID]?.isEmpty == true {
                        inputCapacityWaiters.removeValue(forKey: streamID)
                    }
                    throw error
                }
            }
        }
    }

    func resumeTerminal(
        streamID: UInt32,
        generation: UInt64,
        offset: UInt64? = nil,
        serverScopeID: UUID
    ) async throws {
        guard serverScopeID == reliabilityScope else {
            throw RemoteServiceError.serverIdentityChanged
        }
        expectedStreamGenerations[streamID] = generation
        guard let interactiveSocket,
              let transport = transportGeneration else { throw RemoteServiceError.disconnected }
        if let previousID = terminalResumeCallByStream.removeValue(forKey: streamID),
           let previous = terminalResumeCalls.removeValue(forKey: previousID) {
            await previous.signal.fail(.terminalResumeSuperseded(streamID: streamID))
            guard serverScopeID == reliabilityScope,
                  transportGeneration == transport else {
                throw RemoteServiceError.serverIdentityChanged
            }
        }
        streamGenerations[streamID] = generation
        inputReadyGenerations.removeValue(forKey: streamID)
        let cursor = offset ?? outputLedger.cursor(for: streamID)
        outputLedger.setCursor(cursor, for: streamID)
        let call = try CallMessage(
            method: .sessionResume,
            params: .object([
                "stream_id": .unsignedInteger(UInt64(streamID)),
                "generation": .unsignedInteger(generation),
                "offset": .unsignedInteger(cursor)
            ]),
            idempotencyKey: nil,
            deadlineMilliseconds: 5_000
        )
        let signal = RemoteOperationSignal()
        terminalResumeCalls[call.id] = PendingTerminalResume(
            callID: call.id,
            streamID: streamID,
            generation: generation,
            serverScopeID: serverScopeID,
            transportID: transport,
            signal: signal,
            handshake: TerminalResumeHandshake(
                streamID: streamID,
                generation: generation,
                openedBaseline: nil
            )
        )
        terminalResumeCallByStream[streamID] = call.id
        do {
            try await interactiveSocket.sendControl(call)
        } catch {
            await failTerminalResume(id: call.id, error: .disconnected)
            throw error
        }
        guard serverScopeID == reliabilityScope,
              transportGeneration == transport,
              terminalResumeCalls[call.id]?.serverScopeID == serverScopeID else {
            throw RemoteServiceError.serverIdentityChanged
        }
        try await withTaskCancellationHandler {
            try await signal.wait()
        } onCancel: {
            Task { await self.cancelTerminalResume(id: call.id, socket: interactiveSocket) }
        }
        guard serverScopeID == reliabilityScope,
              transportGeneration == transport,
              streamGenerations[streamID] == generation,
              inputReadyGenerations[streamID] == generation else {
            throw RemoteServiceError.disconnected
        }
    }

    func deactivateTerminal(
        streamID: UInt32,
        generation: UInt64,
        serverScopeID: UUID
    ) async {
        guard serverScopeID == reliabilityScope else { return }
        guard expectedStreamGenerations[streamID] == generation
                || streamGenerations[streamID] == generation else { return }
        // Stop local delivery before the first suspension. The detach RPC is
        // deliberately best effort and cannot delay leaving the terminal view.
        streamGenerations.removeValue(forKey: streamID)
        expectedStreamGenerations.removeValue(forKey: streamID)
        inputReadyGenerations.removeValue(forKey: streamID)
        if let resumeID = terminalResumeCallByStream.removeValue(forKey: streamID),
           let pending = terminalResumeCalls.removeValue(forKey: resumeID) {
            await pending.signal.cancel()
            guard serverScopeID == reliabilityScope else { return }
        }
        await failInputReadinessWaiters(
            streamID: streamID,
            error: .terminalStreamEnded(streamID: streamID)
        )
        guard serverScopeID == reliabilityScope else { return }
        await failInputCapacityWaiters(
            streamID: streamID,
            error: .terminalStreamEnded(streamID: streamID)
        )
        guard serverScopeID == reliabilityScope else { return }
        guard let interactiveSocket else { return }
        let request = TerminalDetachWireRequest(streamID: streamID, generation: generation)
        guard let call = try? CallMessage(
            method: .terminalDetach,
            params: request.params,
            idempotencyKey: nil,
            deadlineMilliseconds: 2_000
        ) else { return }

        bestEffortCallIDs.insert(call.id)
        do {
            try await interactiveSocket.sendControl(call)
        } catch {
            bestEffortCallIDs.remove(call.id)
        }
    }

    func discardAmbiguousInput(serverScopeID: UUID) async -> Set<UInt32> {
        guard serverScopeID == reliabilityScope else { return [] }
        let discarded = inputLedger.discardAmbiguousInput()
        for streamID in discarded {
            guard serverScopeID == reliabilityScope else { return [] }
            inputReadyGenerations.removeValue(forKey: streamID)
            await failInputReadinessWaiters(
                streamID: streamID,
                error: .terminalInputNotReady(streamID: streamID)
            )
            guard serverScopeID == reliabilityScope else { return [] }
            await failInputCapacityWaiters(
                streamID: streamID,
                error: .terminalInputNotReady(streamID: streamID)
            )
        }
        return discarded
    }

    @discardableResult
    func discardTerminalState(streamID: UInt32, serverScopeID: UUID) async -> Bool {
        guard serverScopeID == reliabilityScope else { return false }
        let discarded = inputLedger.discardStreamIfUnambiguous(streamID: streamID)
        inputReadyGenerations.removeValue(forKey: streamID)
        streamGenerations.removeValue(forKey: streamID)
        expectedStreamGenerations.removeValue(forKey: streamID)
        if let resumeID = terminalResumeCallByStream[streamID] {
            await failTerminalResume(
                id: resumeID,
                error: .terminalStreamEnded(streamID: streamID)
            )
            guard serverScopeID == reliabilityScope else { return false }
        }
        await failInputReadinessWaiters(
            streamID: streamID,
            error: .terminalStreamEnded(streamID: streamID)
        )
        guard serverScopeID == reliabilityScope else { return false }
        await failInputCapacityWaiters(
            streamID: streamID,
            error: .terminalStreamEnded(streamID: streamID)
        )
        return discarded
    }

    func probe(serverScopeID: UUID) async throws -> Int {
        guard serverScopeID == reliabilityScope else {
            throw RemoteServiceError.serverIdentityChanged
        }
        guard let controlSocket, let interactiveSocket, let generation = transportGeneration else {
            throw RemoteServiceError.disconnected
        }
        let clock = ContinuousClock()
        let startedAt = clock.now
        do {
            try await withLincoTimeout(.seconds(3), onTimeout: {
                await controlSocket.close()
                await interactiveSocket.close()
            }) {
                async let controlPing: Void = controlSocket.sendPing()
                async let interactivePing: Void = interactiveSocket.sendPing()
            _ = try await (controlPing, interactivePing)
        }
            guard serverScopeID == reliabilityScope else {
                throw RemoteServiceError.serverIdentityChanged
            }
            guard transportGeneration == generation else { throw RemoteServiceError.disconnected }
            let components = startedAt.duration(to: clock.now).components
            let milliseconds = components.seconds * 1_000
                + components.attoseconds / 1_000_000_000_000_000
            return Int(clamping: max(0, milliseconds))
        } catch is CancellationError {
            throw CancellationError()
        } catch {
            await transportDidFail(error, generation: generation)
            throw error
        }
    }

    private func readControlLoop(_ socket: LincoWebSocket, generation: UUID) async {
        do {
            while !Task.isCancelled {
                let incoming = try await socket.receive()
                guard transportGeneration == generation, !Task.isCancelled else { return }
                guard case let .control(message) = incoming else {
                    throw RemoteServiceError.binaryOnControlLane
                }
                switch message.type {
                case "result":
                    guard let id = message.uuid("id"), let continuation = pendingCalls.removeValue(forKey: id) else { continue }
                    continuation.resume(returning: message.fields["value"] ?? .null)
                case "error":
                    let error = RemoteServiceError.server(
                        code: message.string("code") ?? "internal",
                        message: message.string("message") ?? "服务器返回了未知错误。"
                    )
                    if let id = message.uuid("id"), let continuation = pendingCalls.removeValue(forKey: id) {
                        continuation.resume(throwing: error)
                    } else {
                        await publish(.control(message), generation: generation)
                    }
                default:
                    await publish(.control(message), generation: generation)
                }
            }
        } catch is CancellationError {
        } catch {
            await transportDidFail(error, generation: generation)
        }
    }

    private func readInteractiveLoop(_ socket: LincoWebSocket, generation: UUID) async {
        do {
            while !Task.isCancelled {
                let incoming = try await socket.receive()
                guard transportGeneration == generation, !Task.isCancelled else { return }
                switch incoming {
                case let .binary(data):
                    let frame = try BinaryFrame.decode(data, on: .interactive)
                    guard streamGenerations[frame.streamID] != nil else { continue }
                    switch try outputLedger.accept(frame) {
                    case let .deliver(delivery, reset, endOfStream):
                        if endOfStream {
                            streamGenerations.removeValue(forKey: delivery.streamID)
                            expectedStreamGenerations.removeValue(forKey: delivery.streamID)
                            inputReadyGenerations.removeValue(forKey: delivery.streamID)
                            let preservedAmbiguity = !inputLedger.discardStreamIfUnambiguous(
                                streamID: delivery.streamID
                            )
                            await failInputReadinessWaiters(
                                streamID: delivery.streamID,
                                error: .terminalStreamEnded(streamID: delivery.streamID)
                            )
                            guard transportGeneration == generation else { return }
                            await failInputCapacityWaiters(
                                streamID: delivery.streamID,
                                error: .terminalStreamEnded(streamID: delivery.streamID)
                            )
                            guard transportGeneration == generation else { return }
                            await publish(.terminal(frame: delivery, reset: reset), generation: generation)
                            guard transportGeneration == generation else { return }
                            if preservedAmbiguity {
                                await publish(
                                    .inputAmbiguous([delivery.streamID]),
                                    generation: generation
                                )
                                guard transportGeneration == generation else { return }
                            }
                            await publish(.terminalEnded(streamID: delivery.streamID), generation: generation)
                        } else {
                            await publish(.terminal(frame: delivery, reset: reset), generation: generation)
                        }
                    case let .endOfStream(streamID, _):
                        streamGenerations.removeValue(forKey: streamID)
                        expectedStreamGenerations.removeValue(forKey: streamID)
                        inputReadyGenerations.removeValue(forKey: streamID)
                        let preservedAmbiguity = !inputLedger.discardStreamIfUnambiguous(
                            streamID: streamID
                        )
                        await failInputReadinessWaiters(
                            streamID: streamID,
                            error: .terminalStreamEnded(streamID: streamID)
                        )
                        guard transportGeneration == generation else { return }
                        await failInputCapacityWaiters(
                            streamID: streamID,
                            error: .terminalStreamEnded(streamID: streamID)
                        )
                        guard transportGeneration == generation else { return }
                        if preservedAmbiguity {
                            await publish(.inputAmbiguous([streamID]), generation: generation)
                            guard transportGeneration == generation else { return }
                        }
                        await publish(.terminalEnded(streamID: streamID), generation: generation)
                    case .duplicate:
                        continue
                    case let .gap(expected, received):
                        await publish(
                            .outputGap(streamID: frame.streamID, expected: expected, received: received),
                            generation: generation
                        )
                        guard transportGeneration == generation else { return }
                        if let streamGeneration = streamGenerations[frame.streamID] {
                            let serverScopeID = reliabilityScope
                            Task {
                                await self.recoverOutputGap(
                                    streamID: frame.streamID,
                                    generation: streamGeneration,
                                    offset: expected,
                                    serverScopeID: serverScopeID,
                                    transportID: generation
                                )
                            }
                        }
                    }
                case let .control(message):
                    if message.type == "stream_opened" {
                        try await registerTerminalStreamOpened(message, transport: generation)
                    } else if message.type == "result",
                              let id = message.uuid("id"),
                              terminalResumeCalls[id] != nil {
                        try await completeTerminalResume(
                            id: id,
                            result: message,
                            socket: socket,
                            transport: generation
                        )
                    } else if message.type == "error",
                              let id = message.uuid("id"),
                              let pending = terminalResumeCalls[id] {
                        let code = message.string("code") ?? "internal"
                        let error = RemoteServiceError.server(
                            code: code,
                            message: message.string("message") ?? "The server rejected terminal resume."
                        )
                        if code == "not_found" || code == "snapshot_required" {
                            let preservesAmbiguousInput = !inputLedger.discardStreamIfUnambiguous(
                                streamID: pending.streamID
                            )
                            inputReadyGenerations.removeValue(forKey: pending.streamID)
                            streamGenerations.removeValue(forKey: pending.streamID)
                            expectedStreamGenerations.removeValue(forKey: pending.streamID)
                            await failInputReadinessWaiters(
                                streamID: pending.streamID,
                                error: .terminalStreamEnded(streamID: pending.streamID)
                            )
                            guard transportGeneration == generation else { return }
                            await failInputCapacityWaiters(
                                streamID: pending.streamID,
                                error: .terminalStreamEnded(streamID: pending.streamID)
                            )
                            guard transportGeneration == generation else { return }
                            await failTerminalResume(id: id, error: error)
                            guard transportGeneration == generation else { return }
                            if preservesAmbiguousInput {
                                await publish(.inputAmbiguous([pending.streamID]), generation: generation)
                            } else {
                                await publish(
                                    .terminalInputRejected(streamID: pending.streamID, code: code),
                                    generation: generation
                                )
                            }
                        } else if code == "ambiguous" {
                            inputReadyGenerations.removeValue(forKey: pending.streamID)
                            let affected = inputLedger.markInputAmbiguous(streamID: pending.streamID)
                            await failTerminalResume(id: id, error: error)
                            guard transportGeneration == generation else { return }
                            await failInputReadinessWaiters(
                                streamID: pending.streamID,
                                error: .terminalInputAmbiguous(streamID: pending.streamID)
                            )
                            guard transportGeneration == generation else { return }
                            await failInputCapacityWaiters(
                                streamID: pending.streamID,
                                error: .terminalInputAmbiguous(streamID: pending.streamID)
                            )
                            guard transportGeneration == generation else { return }
                            await publish(.inputAmbiguous(affected), generation: generation)
                        } else {
                            await failTerminalResume(id: id, error: error)
                        }
                    } else if (message.type == "result" || message.type == "error"),
                       let id = message.uuid("id"),
                       bestEffortCallIDs.remove(id) != nil {
                        continue
                    } else if message.type == "stream_ack",
                       let stream = message.uint64("stream_id").flatMap(UInt32.init(exactly:)),
                       let through = message.uint64("through_offset") {
                        try inputLedger.acknowledge(streamID: stream, through: through)
                        await wakeInputCapacityWaiters(streamID: stream)
                    } else if message.type == "terminal_input_fault" {
                        try await handleTerminalInputFault(message, transport: generation)
                    } else if message.type == "error" {
                        throw RemoteServiceError.server(
                            code: message.string("code") ?? "internal",
                            message: message.string("message") ?? "The server rejected an interactive operation."
                        )
                    } else {
                        await publish(.control(message), generation: generation)
                    }
                }
            }
        } catch is CancellationError {
        } catch {
            await transportDidFail(error, generation: generation)
        }
    }

    private func recoverOutputGap(
        streamID: UInt32,
        generation: UInt64,
        offset: UInt64,
        serverScopeID: UUID,
        transportID: UUID
    ) async {
        guard reliabilityScope == serverScopeID,
              transportGeneration == transportID else { return }
        try? await resumeTerminal(
            streamID: streamID,
            generation: generation,
            offset: offset,
            serverScopeID: serverScopeID
        )
    }

    private func registerTerminalStreamOpened(
        _ message: ServerEnvelope,
        transport: UUID
    ) async throws {
        guard let baseline = TerminalResumeBaseline(envelope: message),
              let callID = terminalResumeCallByStream[baseline.streamID],
              var pending = terminalResumeCalls[callID],
              pending.streamID == baseline.streamID,
              pending.generation == baseline.generation,
              pending.serverScopeID == reliabilityScope,
              pending.transportID == transport,
              streamGenerations[baseline.streamID] == baseline.generation else {
            throw RemoteServiceError.invalidTerminalResume
        }

        switch try inputLedger.synchronizeServerInputThrough(
            streamID: baseline.streamID,
            through: baseline.inputThrough
        ) {
        case .ready:
            guard pending.handshake.registerOpened(baseline) else {
                throw RemoteServiceError.invalidTerminalResume
            }
            terminalResumeCalls[callID] = pending
            await wakeInputCapacityWaiters(streamID: baseline.streamID)
            guard reliabilityScope == pending.serverScopeID,
                  transportGeneration == transport else { return }
        case .ambiguous:
            inputReadyGenerations.removeValue(forKey: baseline.streamID)
            await failTerminalResume(
                id: callID,
                error: .terminalInputAmbiguous(streamID: baseline.streamID)
            )
            guard reliabilityScope == pending.serverScopeID,
                  transportGeneration == transport else { return }
            await failInputReadinessWaiters(
                streamID: baseline.streamID,
                error: .terminalInputAmbiguous(streamID: baseline.streamID)
            )
            guard transportGeneration == transport else { return }
            await failInputCapacityWaiters(
                streamID: baseline.streamID,
                error: .terminalInputAmbiguous(streamID: baseline.streamID)
            )
            guard transportGeneration == transport else { return }
            await publish(.inputAmbiguous([baseline.streamID]), generation: transport)
        }
    }

    private func completeTerminalResume(
        id: UUID,
        result: ServerEnvelope,
        socket: LincoWebSocket,
        transport: UUID
    ) async throws {
        guard let pending = terminalResumeCalls[id],
              let returned = TerminalResumeBaseline(value: result.fields["value"]),
              pending.handshake.acceptsResult(returned),
              terminalResumeCallByStream[pending.streamID] == id,
              pending.serverScopeID == reliabilityScope,
              pending.transportID == transport,
              streamGenerations[pending.streamID] == pending.generation else {
            await failTerminalResume(id: id, error: .invalidTerminalResume)
            throw RemoteServiceError.invalidTerminalResume
        }

        for frame in inputLedger.pendingFrames(streamID: pending.streamID) {
            do {
                try await socket.sendBinary(frame)
            } catch {
                await failTerminalResume(id: id, error: .disconnected)
                throw error
            }
            guard pending.serverScopeID == reliabilityScope,
                  transportGeneration == transport,
                  terminalResumeCalls[id] != nil,
                  terminalResumeCallByStream[pending.streamID] == id else { return }
        }

        guard let completed = terminalResumeCalls.removeValue(forKey: id) else { return }
        if terminalResumeCallByStream[completed.streamID] == id {
            terminalResumeCallByStream.removeValue(forKey: completed.streamID)
        }
        inputReadyGenerations[completed.streamID] = completed.generation
        await wakeInputReadinessWaiters(streamID: completed.streamID)
        guard completed.serverScopeID == reliabilityScope,
              transportGeneration == transport else {
            await completed.signal.fail(.disconnected)
            return
        }
        await completed.signal.succeed()
    }

    private func handleTerminalInputFault(
        _ message: ServerEnvelope,
        transport: UUID
    ) async throws {
        guard let fault = TerminalInputFault(envelope: message) else {
            throw RemoteServiceError.invalidTerminalInputFault
        }
        if let generation = fault.generation,
           streamGenerations[fault.streamID] != generation {
            return
        }

        let disposition = TerminalInputFaultPolicy.disposition(
            code: fault.code,
            discardPending: fault.discardPending
        )
        if disposition == .retryAfterReconnect {
            inputReadyGenerations.removeValue(forKey: fault.streamID)
            let error = RemoteServiceError.server(
                code: fault.code,
                message: "The terminal input queue is busy; pending bytes will retry after resume."
            )
            if let resumeID = terminalResumeCallByStream[fault.streamID] {
                await failTerminalResume(id: resumeID, error: error)
                guard transportGeneration == transport else { return }
            }
            await publish(.interactiveInputFault(fault.code), generation: transport)
            guard transportGeneration == transport else { return }
            // The server closes this lane after a queued zero-write timeout so
            // already-enqueued suffix frames cannot race a same-lane replay.
            // Enter the normal single-flight reconnect path immediately.
            throw error
        }
        if disposition == .discardStream {
            let preservesAmbiguousInput = !inputLedger.discardStreamIfUnambiguous(
                streamID: fault.streamID
            )
            inputReadyGenerations.removeValue(forKey: fault.streamID)
            streamGenerations.removeValue(forKey: fault.streamID)
            expectedStreamGenerations.removeValue(forKey: fault.streamID)
            if let resumeID = terminalResumeCallByStream[fault.streamID] {
                await failTerminalResume(
                    id: resumeID,
                    error: .terminalStreamEnded(streamID: fault.streamID)
                )
                guard transportGeneration == transport else { return }
            }
            await failInputReadinessWaiters(
                streamID: fault.streamID,
                error: .terminalStreamEnded(streamID: fault.streamID)
            )
            guard transportGeneration == transport else { return }
            await failInputCapacityWaiters(
                streamID: fault.streamID,
                error: .terminalStreamEnded(streamID: fault.streamID)
            )
            guard transportGeneration == transport else { return }
            if preservesAmbiguousInput {
                await publish(.inputAmbiguous([fault.streamID]), generation: transport)
            } else {
                await publish(
                    .terminalInputRejected(streamID: fault.streamID, code: fault.code),
                    generation: transport
                )
            }
            return
        }
        if disposition == .quarantine {
            inputReadyGenerations.removeValue(forKey: fault.streamID)
            let affected = inputLedger.markInputAmbiguous(streamID: fault.streamID)
            if let resumeID = terminalResumeCallByStream[fault.streamID] {
                await failTerminalResume(
                    id: resumeID,
                    error: .terminalInputAmbiguous(streamID: fault.streamID)
                )
                guard transportGeneration == transport else { return }
            }
            await failInputReadinessWaiters(
                streamID: fault.streamID,
                error: .terminalInputAmbiguous(streamID: fault.streamID)
            )
            guard transportGeneration == transport else { return }
            await failInputCapacityWaiters(
                streamID: fault.streamID,
                error: .terminalInputAmbiguous(streamID: fault.streamID)
            )
            guard transportGeneration == transport else { return }
            await publish(.inputAmbiguous(affected), generation: transport)
            guard transportGeneration == transport else { return }
            await publish(.interactiveInputFault(fault.code), generation: transport)
            return
        }
        throw RemoteServiceError.invalidTerminalInputFault
    }

    private func expectControl(type: String, from socket: LincoWebSocket) async throws -> ServerEnvelope {
        guard case let .control(message) = try await socket.receive() else {
            throw RemoteServiceError.unexpectedMessage
        }
        if message.type == "error" {
            throw RemoteServiceError.server(
                code: message.string("code") ?? "internal",
                message: message.string("message") ?? "服务器拒绝了连接。"
            )
        }
        guard message.type == type else { throw RemoteServiceError.unexpectedMessage }
        return message
    }

    private func interactiveTicket(from ready: ServerEnvelope) throws -> Data {
        for value in ready.fields["attach_tickets"]?.arrayValue ?? [] {
            guard let object = value.objectValue,
                  object["lane"]?.stringValue == LogicalChannel.interactive.rawValue,
                  let encoded = object["ticket_b64"]?.stringValue,
                  let ticket = Data(base64URL: encoded) else { continue }
            return ticket
        }
        throw RemoteServiceError.missingInteractiveTicket
    }

    private func startHeartbeat(
        control: LincoWebSocket,
        interactive: LincoWebSocket,
        intervalMilliseconds: UInt64,
        generation: UUID
    ) {
        heartbeatTask?.cancel()
        heartbeatTask = Task { [weak self] in
            do {
                while !Task.isCancelled {
                    try await Task.sleep(for: .milliseconds(intervalMilliseconds))
                    try await withLincoTimeout(.seconds(5), onTimeout: {
                        await control.close()
                        await interactive.close()
                    }) {
                        async let controlPing: Void = control.sendPing()
                        async let interactivePing: Void = interactive.sendPing()
                        _ = try await (controlPing, interactivePing)
                    }
                }
            } catch is CancellationError {
            } catch {
                await self?.transportDidFail(error, generation: generation)
            }
        }
    }

    private func startNetworkPathMonitoring(generation: UUID) {
        stopNetworkPathMonitoring()
        let monitor = NWPathMonitor()
        monitor.pathUpdateHandler = { [weak self] path in
            let interface: NetworkPathSnapshot.Interface?
            if path.usesInterfaceType(.wifi) {
                interface = .wifi
            } else if path.usesInterfaceType(.cellular) {
                interface = .cellular
            } else if path.usesInterfaceType(.wiredEthernet) {
                interface = .wiredEthernet
            } else if path.availableInterfaces.isEmpty {
                interface = nil
            } else {
                interface = .other
            }
            let snapshot = NetworkPathSnapshot(
                isSatisfied: path.status == .satisfied,
                interface: interface
            )
            Task { await self?.networkPathDidChange(snapshot, generation: generation) }
        }
        networkPathMonitor = monitor
        networkPathSnapshot = nil
        monitor.start(queue: DispatchQueue(label: "app.linco.network-path", qos: .userInitiated))
    }

    private func stopNetworkPathMonitoring() {
        networkPathMonitor?.cancel()
        networkPathMonitor = nil
        networkPathSnapshot = nil
        networkPathProbeTask?.cancel()
        networkPathProbeTask = nil
        networkPathProbeID = nil
    }

    private func networkPathDidChange(
        _ snapshot: NetworkPathSnapshot,
        generation: UUID
    ) async {
        guard transportGeneration == generation, !hasPublishedTransportFailure else { return }
        let decision = NetworkPathRecoveryPolicy.decision(
            previous: networkPathSnapshot,
            current: snapshot
        )
        networkPathSnapshot = snapshot
        switch decision {
        case .none:
            return
        case .disconnect:
            await transportDidFail(RemoteServiceError.networkUnavailable, generation: generation)
        case .probe:
            networkPathProbeTask?.cancel()
            let probeID = UUID()
            let serverScopeID = reliabilityScope
            networkPathProbeID = probeID
            networkPathProbeTask = Task { [weak self] in
                do {
                    try await Task.sleep(for: .milliseconds(120))
                    guard !Task.isCancelled else { return }
                    try await self?.runNetworkPathProbe(
                        id: probeID,
                        generation: generation,
                        serverScopeID: serverScopeID
                    )
                } catch is CancellationError {
                } catch {
                    // `probe()` publishes the transport failure itself.
                }
            }
        }
    }

    private func runNetworkPathProbe(
        id: UUID,
        generation: UUID,
        serverScopeID: UUID
    ) async throws {
        guard networkPathProbeID == id,
              transportGeneration == generation,
              reliabilityScope == serverScopeID else { return }
        _ = try await probe(serverScopeID: serverScopeID)
        guard networkPathProbeID == id,
              transportGeneration == generation,
              reliabilityScope == serverScopeID else { return }
        networkPathProbeID = nil
        networkPathProbeTask = nil
    }

    private func validateConnectionTransaction(_ generation: UUID) throws {
        try Task.checkCancellation()
        guard transportGeneration == generation, !hasPublishedTransportFailure else {
            throw RemoteServiceError.disconnected
        }
    }

    private func publish(_ event: RemoteEvent, generation: UUID) async {
        await eventRelay.deliver(.init(transportID: generation, event: event))
    }

    private func drainTerminalResumeSignals() -> [RemoteOperationSignal] {
        let signals = terminalResumeCalls.values.map(\.signal)
        terminalResumeCalls.removeAll(keepingCapacity: true)
        terminalResumeCallByStream.removeAll(keepingCapacity: true)
        return signals
    }

    private func drainAllTerminalOperationSignals() -> [RemoteOperationSignal] {
        var signals = drainTerminalResumeSignals()
        signals.append(contentsOf: inputReadinessWaiters.values.flatMap(\.values))
        signals.append(contentsOf: inputCapacityWaiters.values.flatMap(\.values))
        inputReadinessWaiters.removeAll(keepingCapacity: true)
        inputCapacityWaiters.removeAll(keepingCapacity: true)
        return signals
    }

    private func failTerminalResume(id: UUID, error: RemoteServiceError) async {
        guard let pending = terminalResumeCalls.removeValue(forKey: id) else { return }
        if terminalResumeCallByStream[pending.streamID] == id {
            terminalResumeCallByStream.removeValue(forKey: pending.streamID)
        }
        if inputReadyGenerations[pending.streamID] == pending.generation {
            inputReadyGenerations.removeValue(forKey: pending.streamID)
        }
        await pending.signal.fail(error)
    }

    private func cancelTerminalResume(id: UUID, socket: LincoWebSocket) async {
        guard let pending = terminalResumeCalls.removeValue(forKey: id) else { return }
        if terminalResumeCallByStream[pending.streamID] == id {
            terminalResumeCallByStream.removeValue(forKey: pending.streamID)
        }
        inputReadyGenerations.removeValue(forKey: pending.streamID)
        await pending.signal.cancel()
        try? await socket.sendControl(CancelMessage(id: id))
    }

    private func cancelInputCapacityWaiter(streamID: UInt32, id: UUID) async {
        guard let signal = inputCapacityWaiters[streamID]?.removeValue(forKey: id) else { return }
        if inputCapacityWaiters[streamID]?.isEmpty == true {
            inputCapacityWaiters.removeValue(forKey: streamID)
        }
        await signal.cancel()
    }

    private func cancelInputReadinessWaiter(streamID: UInt32, id: UUID) async {
        guard let signal = inputReadinessWaiters[streamID]?.removeValue(forKey: id) else { return }
        if inputReadinessWaiters[streamID]?.isEmpty == true {
            inputReadinessWaiters.removeValue(forKey: streamID)
        }
        await signal.cancel()
    }

    private func wakeInputReadinessWaiters(streamID: UInt32) async {
        guard let waiters = inputReadinessWaiters.removeValue(forKey: streamID) else { return }
        for signal in waiters.values { await signal.succeed() }
    }

    private func failInputReadinessWaiters(
        streamID: UInt32,
        error: RemoteServiceError
    ) async {
        guard let waiters = inputReadinessWaiters.removeValue(forKey: streamID) else { return }
        for signal in waiters.values { await signal.fail(error) }
    }

    private func wakeInputCapacityWaiters(streamID: UInt32) async {
        guard let waiters = inputCapacityWaiters.removeValue(forKey: streamID) else { return }
        for signal in waiters.values { await signal.succeed() }
    }

    private func failInputCapacityWaiters(
        streamID: UInt32,
        error: RemoteServiceError
    ) async {
        guard let waiters = inputCapacityWaiters.removeValue(forKey: streamID) else { return }
        for signal in waiters.values { await signal.fail(error) }
    }

    private func transportDidFail(_ error: any Error, generation: UUID) async {
        guard transportGeneration == generation, !hasPublishedTransportFailure else { return }
        hasPublishedTransportFailure = true
        transportGeneration = nil
        failureNotificationGeneration = generation
        heartbeatTask?.cancel()
        stopNetworkPathMonitoring()
        heartbeatTask = nil
        controlReader?.cancel()
        interactiveReader?.cancel()
        bestEffortCallIDs.removeAll(keepingCapacity: true)
        controlReader = nil
        interactiveReader = nil
        let control = controlSocket
        let interactive = interactiveSocket
        controlSocket = nil
        interactiveSocket = nil
        failAllPending(with: error)
        streamGenerations.removeAll(keepingCapacity: true)
        inputReadyGenerations.removeAll(keepingCapacity: true)
        let signals = drainTerminalResumeSignals()
        for signal in signals { await signal.fail(.disconnected) }
        await control?.close()
        await interactive?.close()
        guard failureNotificationGeneration == generation else { return }
        failureNotificationGeneration = nil
        await publish(.disconnected(error.localizedDescription), generation: generation)
    }

    private func cancelPendingCall(id: UUID, method: RPCMethod, socket: LincoWebSocket) async {
        guard failPending(id: id, error: CancellationError()) else { return }
        if method.isMutating, let generation = transportGeneration {
            await publish(.mutationOutcomeAmbiguous(method: method), generation: generation)
        }
        try? await socket.sendControl(CancelMessage(id: id))
    }

    @discardableResult
    private func failPending(id: UUID, error: any Error) -> Bool {
        guard let continuation = pendingCalls.removeValue(forKey: id) else { return false }
        continuation.resume(throwing: error)
        return true
    }

    private func failAllPending(with error: any Error) {
        let pending = pendingCalls.values
        pendingCalls.removeAll()
        pending.forEach { $0.resume(throwing: error) }
    }
}

private enum SecureRandomSource {
    static func bytes(count: Int) throws -> Data {
        var bytes = Data(repeating: 0, count: count)
        let status = bytes.withUnsafeMutableBytes { buffer in
            SecRandomCopyBytes(kSecRandomDefault, count, buffer.baseAddress!)
        }
        guard status == errSecSuccess else { throw RemoteServiceError.randomGenerationFailed }
        return bytes
    }
}

enum RemoteServiceError: LocalizedError, Sendable {
    case disconnected
    case serverIdentityChanged
    case invalidServerHello
    case invalidInteractiveReady
    case invalidConnectionPath
    case missingInteractiveTicket
    case binaryOnControlLane
    case unexpectedMessage
    case randomGenerationFailed
    case invalidTerminalResume
    case invalidTerminalInputFault
    case terminalInputNotReady(streamID: UInt32)
    case terminalInputTooLarge(maximumBytes: Int)
    case terminalInputAmbiguous(streamID: UInt32)
    case terminalStreamEnded(streamID: UInt32)
    case terminalResumeSuperseded(streamID: UInt32)
    case networkUnavailable
    case server(code: String, message: String)

    var isDefinitiveRPCFailure: Bool {
        guard case let .server(code, _) = self else { return false }
        return code != "ambiguous"
    }

    var errorDescription: String? {
        switch self {
        case .disconnected: "未连接到 Linco Server。"
        case .serverIdentityChanged: "已移除原服务器；其排队中的终端输入已放弃。"
        case .invalidServerHello: "服务器身份或握手信息无效，连接已中止。"
        case .invalidInteractiveReady: "交互通道未能通过服务器确认。"
        case .invalidConnectionPath: "服务器返回了不受支持的连接路径。"
        case .missingInteractiveTicket: "服务器没有提供交互通道凭证。"
        case .binaryOnControlLane: "服务器在控制通道发送了二进制数据。"
        case .unexpectedMessage: "服务器返回了意外消息。"
        case .randomGenerationFailed: "无法生成安全随机数。"
        case .invalidTerminalResume: "服务器返回了无效的终端恢复确认。"
        case .invalidTerminalInputFault: "服务器返回了无效的终端输入状态。"
        case let .terminalInputNotReady(streamID): "终端流 \(streamID) 正在同步输入位置，请稍候。"
        case let .terminalInputTooLarge(maximumBytes): "单次粘贴不能超过 \(maximumBytes) 字节；本次内容尚未发送。"
        case let .terminalInputAmbiguous(streamID): "终端流 \(streamID) 的输入结果无法确定，需要确认后再继续。"
        case let .terminalStreamEnded(streamID): "终端流 \(streamID) 已结束。"
        case let .terminalResumeSuperseded(streamID): "终端流 \(streamID) 已由更新的恢复请求接管。"
        case .networkUnavailable: "当前网络不可用，Linco 将在网络恢复后立即重连。"
        case let .server(_, message): message
        }
    }
}
