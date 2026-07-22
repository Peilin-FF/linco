use std::{
    collections::{BTreeMap, HashMap, HashSet},
    path::{Path, PathBuf},
    sync::{Arc, RwLock},
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use anyhow::{anyhow, bail, Context};
use axum::{
    extract::{
        ws::{Message, WebSocket},
        State, WebSocketUpgrade,
    },
    response::Response,
};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use futures_util::{stream::SplitSink, SinkExt, StreamExt};
use linco_core::{
    CoreError, TerminalEvent, TerminalSessionInfo, TerminalSessionState, TerminalSize,
    TerminalStart, WorkspaceRoot,
};
use linco_protocol::{
    decode_client_message, encode_server_message, BinaryFrame, BinaryFrameHeader, BinaryKind,
    ClientMessage, ConnectionPath, EmptyParams, ErrorCode, FileEntry, FileKind, FileListRequest,
    FileListResponse, FileReadResponse, FileWriteRequest, FileWriteResponse,
    HttpAuthorizationScheme, HttpUploadMethod, KeyAlgorithm, LogicalChannel, Permission,
    PreviewResolveResponse, RpcMethod, ServerMessage, SessionGenerationRequest, SessionKind,
    SessionListResponse, SessionResumeResponse, SessionStartRequest, SessionState,
    SessionStopResponse, SessionSummary, SystemInfoResponse, TerminalCursorRequest,
    TerminalDetachRequest, TerminalDetachResponse, TerminalInputFaultCode, TerminalResizeRequest,
    TerminalResizeResponse, WorkspaceListResponse, WorkspacePathRequest, FILE_LIST_MAX_LIMIT,
    PROTOCOL_VERSION,
};
use rand::{rngs::OsRng, RngCore};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use tokio::sync::{mpsc, OwnedSemaphorePermit, Semaphore};
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

use crate::{
    auth::{decode_b64, decode_b64_vec, AuthenticatedDevice, IdempotencyBegin, PairingCandidate},
    state::AppState,
    terminal_backend::{BackendSubscription, InputApply},
    tickets::{HttpCapabilityKind, HttpGrant, LaneGrant},
};

const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(15);
const ATTACH_TICKET_TTL: Duration = Duration::from_secs(30);
const AUTHORIZATION_RECHECK_INTERVAL: Duration = Duration::from_secs(2);
// Terminal events are recoverable from the core ring/snapshot. Keeping this queue shallow avoids
// seconds of stale output sitting ahead of the terminal the user just selected.
const INTERACTIVE_DATA_QUEUE: usize = 32;
const INTERACTIVE_OVERLOAD_CLOSE_GRACE: Duration = Duration::from_millis(250);
const WS_WRITE_BUFFER_TARGET: usize = 0;
const CONTROL_MAX_WRITE_BUFFER: usize = 1024 * 1024;
const INTERACTIVE_MAX_WRITE_BUFFER: usize = 4 * 1024 * 1024;
const FILE_LIST_VALUE_BUDGET: usize = 48 * 1024;
const FILE_LIST_MAX_SCANNED: usize = 100_000;

enum Outbound {
    Control(ServerMessage),
    Binary {
        stream_id: u32,
        subscription_epoch: u64,
        bytes: Vec<u8>,
    },
    Pong(Vec<u8>),
}

#[derive(Debug, Clone, Copy)]
struct InteractiveSubscription {
    cursor: u64,
    session_id: Uuid,
    generation: u64,
    epoch: u64,
}

type DeliveryEpochs = Arc<RwLock<HashMap<u32, u64>>>;

struct InteractiveInputState<'a> {
    expected: &'a mut BTreeMap<u32, InteractiveSubscription>,
    dirty: &'a mut HashMap<u32, u64>,
    pending_end: &'a mut HashSet<u32>,
    delivery_epochs: &'a DeliveryEpochs,
    next_subscription_epoch: &'a mut u64,
    event_subscription: &'a BackendSubscription,
}

struct ControlSession {
    connection_id: Uuid,
    device: AuthenticatedDevice,
    resume_streams: BTreeMap<u32, u64>,
}

struct RpcCall {
    id: Uuid,
    method: RpcMethod,
    params: Value,
    idempotency_key: Option<Uuid>,
    deadline_ms: u64,
}

struct ActiveCallGuard {
    state: Arc<AppState>,
    device_id: Uuid,
    call_id: Uuid,
    registration_id: Uuid,
    cancellation: CancellationToken,
}

impl ActiveCallGuard {
    fn register(state: Arc<AppState>, device_id: Uuid, call_id: Uuid) -> Self {
        let registration = state.register_call(device_id, call_id);
        Self {
            state,
            device_id,
            call_id,
            registration_id: registration.registration_id,
            cancellation: registration.cancellation,
        }
    }
}

impl Drop for ActiveCallGuard {
    fn drop(&mut self) {
        self.state
            .finish_call(self.device_id, self.call_id, self.registration_id);
    }
}

fn try_call_permit(slots: &Arc<Semaphore>) -> Option<OwnedSemaphorePermit> {
    Arc::clone(slots).try_acquire_owned().ok()
}

#[derive(Debug)]
struct RpcFailure {
    code: ErrorCode,
    message: String,
    retry_after_ms: Option<u64>,
    definitive: bool,
}

impl RpcFailure {
    fn new(code: ErrorCode, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
            retry_after_ms: None,
            definitive: true,
        }
    }

    fn ambiguous(message: impl Into<String>) -> Self {
        Self {
            code: ErrorCode::Ambiguous,
            message: message.into(),
            retry_after_ms: None,
            definitive: false,
        }
    }
}

pub async fn control_upgrade(
    State(state): State<Arc<AppState>>,
    upgrade: WebSocketUpgrade,
) -> Response {
    upgrade
        .write_buffer_size(WS_WRITE_BUFFER_TARGET)
        .max_write_buffer_size(CONTROL_MAX_WRITE_BUFFER)
        .max_message_size(linco_protocol::MAX_CONTROL_MESSAGE_BYTES)
        .max_frame_size(linco_protocol::MAX_CONTROL_MESSAGE_BYTES)
        .on_upgrade(move |socket| control_socket(state, socket))
}

pub async fn interactive_upgrade(
    State(state): State<Arc<AppState>>,
    upgrade: WebSocketUpgrade,
) -> Response {
    let max = BinaryKind::TerminalSnapshot.max_payload_bytes() + linco_protocol::BINARY_HEADER_LEN;
    upgrade
        .write_buffer_size(WS_WRITE_BUFFER_TARGET)
        .max_write_buffer_size(INTERACTIVE_MAX_WRITE_BUFFER)
        .max_message_size(max)
        .max_frame_size(max)
        .on_upgrade(move |socket| interactive_socket(state, socket))
}

async fn control_socket(state: Arc<AppState>, mut socket: WebSocket) {
    let session =
        match tokio::time::timeout(HANDSHAKE_TIMEOUT, authenticate_control(&state, &mut socket))
            .await
        {
            Ok(Ok(session)) => session,
            Ok(Err(error)) => {
                let _ = send_direct(
                    &mut socket,
                    ServerMessage::Error {
                        id: None,
                        code: ErrorCode::Unauthorized,
                        message: error.to_string(),
                        retry_after_ms: None,
                    },
                )
                .await;
                return;
            }
            Err(_) => return,
        };

    let ticket = match state.tickets.issue_lane(
        LaneGrant {
            connection_id: session.connection_id,
            device_id: session.device.id,
            permissions: session.device.permissions.clone(),
            lane: LogicalChannel::Interactive,
            resume_streams: session.resume_streams,
        },
        ATTACH_TICKET_TTL,
    ) {
        Ok(ticket) => ticket,
        Err(error) => {
            tracing::warn!(error = %error, "failed to issue interactive ticket");
            return;
        }
    };
    if send_direct(
        &mut socket,
        ServerMessage::Ready {
            connection_id: session.connection_id,
            server_epoch: state.server_epoch,
            lane: LogicalChannel::Control,
            connection_path: ConnectionPath::Direct,
            attach_tickets: vec![ticket],
        },
    )
    .await
    .is_err()
    {
        return;
    }

    let (sink, mut reader) = socket.split();
    let (sender, receiver) = mpsc::channel(state.config.control_queue);
    let revoked = CancellationToken::new();
    let authorization_watcher = tokio::spawn(watch_device_authorization(
        Arc::clone(&state),
        session.device.id,
        revoked.clone(),
    ));
    let writer = tokio::spawn(single_writer(sink, receiver, revoked.clone()));

    loop {
        let message = tokio::select! {
            biased;
            _ = revoked.cancelled() => break,
            message = reader.next() => {
                let Some(message) = message else { break };
                message
            }
        };
        let message = match message {
            Ok(message) => message,
            Err(_) => break,
        };
        if let Message::Ping(payload) = &message {
            let _ = sender.send(Outbound::Pong(payload.to_vec())).await;
            continue;
        }
        let decoded = match decode_ws_control(message) {
            Ok(Some(message)) => message,
            Ok(None) => continue,
            Err(error) => {
                let _ = sender
                    .send(Outbound::Control(server_error(
                        None,
                        ErrorCode::BadRequest,
                        error.to_string(),
                    )))
                    .await;
                break;
            }
        };
        match decoded {
            ClientMessage::Call {
                id,
                method,
                params,
                idempotency_key,
                deadline_ms,
            } => {
                let policy = method.policy();
                if !session.device.permits(policy.permission) {
                    let _ = sender
                        .send(Outbound::Control(server_error(
                            Some(id),
                            ErrorCode::Forbidden,
                            "permission denied",
                        )))
                        .await;
                    continue;
                }
                let state = Arc::clone(&state);
                let sender = sender.clone();
                let device = session.device.clone();
                let permit = match try_call_permit(&state.call_slots) {
                    Some(permit) => permit,
                    None => {
                        let _ = sender
                            .send(Outbound::Control(server_error(
                                Some(id),
                                ErrorCode::Overloaded,
                                "too many in-flight calls",
                            )))
                            .await;
                        continue;
                    }
                };
                let call = RpcCall {
                    id,
                    method,
                    params,
                    idempotency_key,
                    deadline_ms,
                };
                let active_call = ActiveCallGuard::register(Arc::clone(&state), device.id, id);
                tokio::spawn(async move {
                    execute_call(state, sender, device, call, permit, active_call).await;
                });
            }
            ClientMessage::Cancel { id } => {
                state.cancel_call(session.device.id, id);
            }
            ClientMessage::Ping { nonce, sent_at_ms } => {
                let _ = sender
                    .send(Outbound::Control(ServerMessage::Pong {
                        nonce,
                        client_sent_at_ms: sent_at_ms,
                        server_at_ms: now_ms(),
                    }))
                    .await;
            }
            _ => {
                let _ = sender
                    .send(Outbound::Control(server_error(
                        None,
                        ErrorCode::BadRequest,
                        "message is not valid after control authentication",
                    )))
                    .await;
            }
        }
    }

    authorization_watcher.abort();
    drop(sender);
    let _ = writer.await;
}

async fn authenticate_control(
    state: &Arc<AppState>,
    socket: &mut WebSocket,
) -> anyhow::Result<ControlSession> {
    let hello = recv_control(socket).await?;
    let (hello_device, client_nonce_b64, resume_streams) = match hello {
        ClientMessage::Hello {
            protocol_version,
            lane: LogicalChannel::Control,
            device_id,
            client_nonce_b64,
            resume,
            ..
        } if protocol_version == PROTOCOL_VERSION => (device_id, client_nonce_b64, resume.streams),
        _ => bail!("the first control message must be hello"),
    };
    let client_nonce = decode_b64::<32>(&client_nonce_b64, "client nonce")?;
    let connection_id = Uuid::new_v4();
    let mut challenge = [0_u8; 32];
    OsRng.fill_bytes(&mut challenge);
    let proof = state
        .auth
        .server_hello_proof(
            PROTOCOL_VERSION,
            LogicalChannel::Control,
            connection_id,
            state.server_epoch,
            client_nonce.to_vec(),
            challenge.to_vec(),
        )
        .await?;
    send_direct(
        socket,
        ServerMessage::Hello {
            protocol_version: PROTOCOL_VERSION,
            lane: LogicalChannel::Control,
            connection_id,
            server_epoch: state.server_epoch,
            server_identity_b64: proof.identity_b64,
            server_signature_b64: proof.signature_b64,
            auth_challenge_b64: URL_SAFE_NO_PAD.encode(challenge),
            heartbeat_ms: 15_000,
        },
    )
    .await?;

    let device = match recv_control(socket).await? {
        ClientMessage::Authenticate {
            connection_id: signed_connection,
            device_id,
            challenge_signature_b64,
        } => {
            if signed_connection != connection_id || hello_device.is_some_and(|id| id != device_id)
            {
                bail!("authentication is bound to a different connection or device");
            }
            let signature = decode_b64_vec(&challenge_signature_b64, "signature", 80)?;
            state
                .auth
                .authenticate_device(
                    device_id,
                    connection_id,
                    state.server_epoch,
                    challenge.to_vec(),
                    client_nonce.to_vec(),
                    signature,
                )
                .await?
        }
        ClientMessage::PairStart {
            pairing_id,
            device_name,
            device_key_algorithm,
            device_public_key_b64,
            client_nonce_b64,
        } => {
            if device_key_algorithm != KeyAlgorithm::P256 {
                bail!("unsupported device key algorithm");
            }
            state.auth.check_pairing(pairing_id).await?;
            let candidate = PairingCandidate {
                pairing_id,
                device_name,
                device_key_algorithm,
                device_public_key: decode_b64_vec(&device_public_key_b64, "device public key", 65)?,
                client_nonce: decode_b64::<32>(&client_nonce_b64, "pairing client nonce")?.to_vec(),
            };
            if candidate.device_public_key.len() != 65 {
                bail!("device public key must contain 65 bytes");
            }
            send_direct(
                socket,
                ServerMessage::PairChallenge {
                    pairing_id,
                    challenge_b64: URL_SAFE_NO_PAD.encode(challenge),
                    expires_at_ms: now_ms().saturating_add(15_000),
                },
            )
            .await?;
            let (proof, signature) = match recv_control(socket).await? {
                ClientMessage::PairFinish {
                    pairing_id: finished_id,
                    proof_b64,
                    device_signature_b64,
                } if finished_id == pairing_id => (
                    decode_b64::<32>(&proof_b64, "pairing proof")?.to_vec(),
                    decode_b64_vec(&device_signature_b64, "device signature", 80)?,
                ),
                _ => bail!("expected pair_finish for the active pairing"),
            };
            let device = state
                .auth
                .finish_pairing(
                    candidate,
                    connection_id,
                    challenge.to_vec(),
                    proof,
                    signature,
                )
                .await?;
            send_direct(
                socket,
                ServerMessage::PairAccepted {
                    device_id: device.id,
                    permissions: device.permissions.clone(),
                },
            )
            .await?;
            device
        }
        _ => bail!("expected authenticate or pair_start"),
    };

    Ok(ControlSession {
        connection_id,
        device,
        resume_streams,
    })
}

async fn execute_call(
    state: Arc<AppState>,
    sender: mpsc::Sender<Outbound>,
    device: AuthenticatedDevice,
    call: RpcCall,
    permit: OwnedSemaphorePermit,
    active_call: ActiveCallGuard,
) {
    let RpcCall {
        id,
        method,
        params,
        idempotency_key,
        deadline_ms,
    } = call;
    let fingerprint = request_fingerprint(method, &params);
    let policy = method.policy();
    if policy.mutating {
        let Some(key) = idempotency_key else {
            drop(active_call);
            drop(permit);
            let _ = sender
                .send(Outbound::Control(server_error(
                    Some(id),
                    ErrorCode::BadRequest,
                    "mutating call requires an idempotency key",
                )))
                .await;
            return;
        };
        match state
            .auth
            .begin_idempotent(device.id, key, method, fingerprint)
            .await
        {
            Ok(IdempotencyBegin::Completed(message)) => {
                drop(active_call);
                drop(permit);
                let _ = sender.send(Outbound::Control(retarget(message, id))).await;
                return;
            }
            Ok(IdempotencyBegin::Conflict) => {
                drop(active_call);
                drop(permit);
                let _ = sender
                    .send(Outbound::Control(server_error(
                        Some(id),
                        ErrorCode::Conflict,
                        "idempotency key was already used for another request",
                    )))
                    .await;
                return;
            }
            Ok(IdempotencyBegin::Ambiguous) => {
                drop(active_call);
                drop(permit);
                let _ = sender
                    .send(Outbound::Control(server_error(
                        Some(id),
                        ErrorCode::Ambiguous,
                        "a previous attempt may have completed; refusing to repeat it",
                    )))
                    .await;
                return;
            }
            Ok(IdempotencyBegin::Execute) => {}
            Err(error) => {
                tracing::warn!(error = %error, "idempotency reservation failed");
                drop(active_call);
                drop(permit);
                let _ = sender
                    .send(Outbound::Control(server_error(
                        Some(id),
                        ErrorCode::Internal,
                        "could not reserve idempotency key",
                    )))
                    .await;
                return;
            }
        }
    }

    let deadline = Duration::from_millis(deadline_ms);
    let operation = async {
        tokio::select! {
            _ = active_call.cancellation.cancelled() => Err(RpcFailure::ambiguous("call cancelled; outcome may be ambiguous")),
            result = handle_rpc(&state, &device, method, params) => result,
        }
    };
    let (response, definitive) = match tokio::time::timeout(deadline, operation).await {
        Ok(Ok(value)) => (ServerMessage::Result { id, value }, true),
        Ok(Err(error)) => (
            ServerMessage::Error {
                id: Some(id),
                code: error.code,
                message: error.message,
                retry_after_ms: error.retry_after_ms,
            },
            error.definitive,
        ),
        Err(_) => (
            server_error(
                Some(id),
                ErrorCode::Ambiguous,
                "call deadline exceeded; outcome may be ambiguous",
            ),
            false,
        ),
    };
    if policy.mutating && definitive {
        if let Some(key) = idempotency_key {
            if let Err(error) = state
                .auth
                .complete_idempotent(device.id, key, method, fingerprint, response.clone())
                .await
            {
                tracing::warn!(error = %error, "idempotency completion failed");
                drop(active_call);
                drop(permit);
                let _ = sender
                    .send(Outbound::Control(server_error(
                        Some(id),
                        ErrorCode::Ambiguous,
                        "operation finished but its durable result could not be recorded",
                    )))
                    .await;
                return;
            }
        }
    }
    drop(active_call);
    drop(permit);
    let _ = sender.send(Outbound::Control(response)).await;
}

async fn handle_rpc(
    state: &Arc<AppState>,
    device: &AuthenticatedDevice,
    method: RpcMethod,
    params: Value,
) -> Result<Value, RpcFailure> {
    match method {
        RpcMethod::SystemInfo => {
            let _: EmptyParams = parse_params(params)?;
            response_value(SystemInfoResponse {
                name: "linco-server".into(),
                version: env!("CARGO_PKG_VERSION").into(),
                protocol_version: PROTOCOL_VERSION,
                server_epoch: state.server_epoch,
                platform: std::env::consts::OS.into(),
                architecture: std::env::consts::ARCH.into(),
            })
        }
        RpcMethod::WorkspaceList => {
            let _: EmptyParams = parse_params(params)?;
            response_value(WorkspaceListResponse {
                workspaces: state.workspaces.list(),
            })
        }
        RpcMethod::SessionList => {
            let _: EmptyParams = parse_params(params)?;
            let sessions = state.terminal.list().await.map_err(|error| {
                tracing::warn!(error = %error, "session list failed");
                RpcFailure::new(ErrorCode::Internal, "session list failed")
            })?;
            response_value(SessionListResponse {
                sessions: sessions
                    .iter()
                    .map(|(info, stream)| {
                        let workspace_name = state
                            .workspaces
                            .name_for_path(&info.cwd)
                            .unwrap_or("Workspace");
                        session_summary(info, *stream, workspace_name)
                    })
                    .collect(),
            })
        }
        RpcMethod::SessionStart => {
            let request: SessionStartRequest = parse_params(params)?;
            let workspace = state
                .workspaces
                .get(request.workspace_id)
                .map_err(|_| RpcFailure::new(ErrorCode::NotFound, "workspace not found"))?;
            let workspace_name = workspace.name.clone();
            let size = terminal_size(
                request.rows,
                request.columns,
                request.pixel_width,
                request.pixel_height,
            );
            let start = TerminalStart {
                session_id: request.session_id,
                kind: request.kind,
                workspace: workspace.root.clone(),
                relative_cwd: PathBuf::from(request.cwd),
                size,
                environment: request.environment,
                agent_arguments: request.agent_arguments,
            };
            let (info, stream) = state.terminal.start(start).await.map_err(|error| {
                tracing::warn!(error = %error, "terminal start failed");
                terminal_start_failure(&error)
            })?;
            response_value(session_summary(&info, stream, &workspace_name))
        }
        RpcMethod::SessionStop => {
            let request: SessionGenerationRequest = parse_params(params)?;
            state
                .terminal
                .stop(request.session_id, request.generation)
                .await
                .map_err(|error| {
                    tracing::warn!(error = %error, "terminal stop failed");
                    RpcFailure::new(ErrorCode::NotFound, "terminal session not found")
                })?;
            response_value(SessionStopResponse { stopped: true })
        }
        RpcMethod::TerminalResize => {
            let request: TerminalResizeRequest = parse_params(params)?;
            state
                .terminal
                .resize(
                    request.session_id,
                    request.generation,
                    terminal_size(
                        request.rows,
                        request.columns,
                        request.pixel_width,
                        request.pixel_height,
                    ),
                )
                .await
                .map_err(|error| {
                    tracing::warn!(error = %error, "terminal resize failed");
                    RpcFailure::new(ErrorCode::BadRequest, "terminal resize failed")
                })?;
            response_value(TerminalResizeResponse { resized: true })
        }
        RpcMethod::SessionResume => {
            let _: TerminalCursorRequest = parse_params(params)?;
            Err(RpcFailure::new(
                ErrorCode::BadRequest,
                "session_resume is only valid on the interactive lane",
            ))
        }
        RpcMethod::TerminalDetach => {
            let _: TerminalDetachRequest = parse_params(params)?;
            Err(RpcFailure::new(
                ErrorCode::BadRequest,
                "terminal_detach is only valid on the interactive lane",
            ))
        }
        RpcMethod::FileList => {
            let request: FileListRequest = parse_params(params)?;
            request
                .validate()
                .map_err(|error| RpcFailure::new(ErrorCode::BadRequest, error.to_string()))?;
            let workspace = state
                .workspaces
                .get(request.workspace_id)
                .map_err(|_| RpcFailure::new(ErrorCode::NotFound, "workspace not found"))?;
            let response = list_directory(
                workspace.root.clone(),
                request.path,
                request.limit,
                request.cursor,
            )
            .await?;
            response_value(response)
        }
        RpcMethod::FileRead => {
            let request: WorkspacePathRequest = parse_params(params)?;
            let workspace = state
                .workspaces
                .get(request.workspace_id)
                .map_err(|_| RpcFailure::new(ErrorCode::NotFound, "workspace not found"))?;
            workspace
                .root
                .resolve_existing(&request.path)
                .map_err(|_| RpcFailure::new(ErrorCode::NotFound, "file not found"))?;
            let capability = state
                .tickets
                .issue_http(
                    HttpGrant {
                        device_id: device.id,
                        workspace_id: request.workspace_id,
                        relative_path: request.path,
                        kind: HttpCapabilityKind::BulkRead,
                        expected_etag: None,
                        max_bytes: 0,
                        content_length: None,
                    },
                    state.config.http_ticket_ttl,
                )
                .map_err(|_| RpcFailure::new(ErrorCode::Internal, "capability issue failed"))?;
            response_value(FileReadResponse {
                url: format!("{}/v1/bulk", state.config.public_url),
                authorization_scheme: HttpAuthorizationScheme::LincoCapability,
                capability,
                expires_in_ms: state.config.http_ticket_ttl.as_millis() as u64,
            })
        }
        RpcMethod::FileWrite => {
            let request: FileWriteRequest = parse_params(params)?;
            if request.expected_revision.len() > 128 || request.expected_revision == "*" {
                return Err(RpcFailure::new(
                    ErrorCode::BadRequest,
                    "expected_revision must be an existing strong file revision",
                ));
            }
            if request.content_length > state.config.max_upload_bytes {
                return Err(RpcFailure::new(
                    ErrorCode::PayloadTooLarge,
                    "file exceeds the upload limit",
                ));
            }
            let workspace = state
                .workspaces
                .get(request.workspace_id)
                .map_err(|_| RpcFailure::new(ErrorCode::NotFound, "workspace not found"))?;
            let target = workspace
                .root
                .resolve_existing(&request.path)
                .map_err(|_| RpcFailure::new(ErrorCode::NotFound, "file not found"))?;
            let revision_matches = match tokio::fs::metadata(&target).await {
                Ok(metadata) if metadata.is_file() => crate::http::strong_etag(&target)
                    .await
                    .is_ok_and(|revision| revision == request.expected_revision),
                _ => false,
            };
            if !revision_matches {
                return Err(RpcFailure::new(
                    ErrorCode::Conflict,
                    "file revision does not match",
                ));
            }
            let capability = state
                .tickets
                .issue_http(
                    HttpGrant {
                        device_id: device.id,
                        workspace_id: request.workspace_id,
                        relative_path: request.path,
                        kind: HttpCapabilityKind::BulkWrite,
                        expected_etag: Some(request.expected_revision.clone()),
                        max_bytes: state.config.max_upload_bytes,
                        content_length: Some(request.content_length),
                    },
                    Duration::from_secs(60),
                )
                .map_err(|_| RpcFailure::new(ErrorCode::Internal, "capability issue failed"))?;
            response_value(FileWriteResponse {
                url: format!("{}/v1/upload", state.config.public_url),
                method: HttpUploadMethod::Put,
                authorization_scheme: HttpAuthorizationScheme::LincoCapability,
                capability,
                if_match: request.expected_revision,
                content_length: request.content_length,
                max_bytes: state.config.max_upload_bytes,
                expires_in_ms: 60_000,
            })
        }
        RpcMethod::PreviewResolve => {
            let request: WorkspacePathRequest = parse_params(params)?;
            let workspace = state
                .workspaces
                .get(request.workspace_id)
                .map_err(|_| RpcFailure::new(ErrorCode::NotFound, "workspace not found"))?;
            workspace
                .root
                .resolve_existing(&request.path)
                .map_err(|_| RpcFailure::new(ErrorCode::NotFound, "preview target not found"))?;
            let capability = state
                .tickets
                .issue_http(
                    HttpGrant {
                        device_id: device.id,
                        workspace_id: request.workspace_id,
                        relative_path: request.path,
                        kind: HttpCapabilityKind::PreviewBootstrap,
                        expected_etag: None,
                        max_bytes: 0,
                        content_length: None,
                    },
                    Duration::from_secs(60),
                )
                .map_err(|_| RpcFailure::new(ErrorCode::Internal, "capability issue failed"))?;
            response_value(PreviewResolveResponse {
                bootstrap_url: format!("{}/v1/preview/bootstrap", state.config.public_url),
                authorization_scheme: HttpAuthorizationScheme::LincoCapability,
                capability,
                expires_in_ms: 60_000,
            })
        }
    }
}

async fn interactive_socket(state: Arc<AppState>, mut socket: WebSocket) {
    let attach = match tokio::time::timeout(HANDSHAKE_TIMEOUT, recv_control(&mut socket)).await {
        Ok(Ok(ClientMessage::AttachLane {
            connection_id,
            lane: LogicalChannel::Interactive,
            ticket_b64,
            client_nonce_b64,
        })) => {
            if decode_b64::<32>(&client_nonce_b64, "interactive nonce").is_err() {
                return;
            }
            match state.tickets.consume_lane(
                &ticket_b64,
                connection_id,
                LogicalChannel::Interactive,
            ) {
                Ok(grant) => grant,
                Err(_) => return,
            }
        }
        _ => return,
    };
    if !device_authorization_is_live(&state, attach.device_id).await {
        return;
    }
    if !attach.permissions.contains(&Permission::Terminal) {
        return;
    }
    if send_direct(
        &mut socket,
        ServerMessage::Ready {
            connection_id: attach.connection_id,
            server_epoch: state.server_epoch,
            lane: LogicalChannel::Interactive,
            connection_path: ConnectionPath::Direct,
            attach_tickets: Vec::new(),
        },
    )
    .await
    .is_err()
    {
        return;
    }

    let mut subscription = match state.terminal.subscribe() {
        Ok(subscription) => subscription,
        Err(error) => {
            tracing::warn!(error = %error, "terminal subscription rejected");
            return;
        }
    };
    let (sink, mut reader) = socket.split();
    let (priority_tx, priority_rx) = mpsc::channel(32);
    let (data_tx, data_rx) = mpsc::channel(INTERACTIVE_DATA_QUEUE);
    let delivery_epochs = DeliveryEpochs::default();
    let revoked = CancellationToken::new();
    let authorization_watcher = tokio::spawn(watch_device_authorization(
        Arc::clone(&state),
        attach.device_id,
        revoked.clone(),
    ));
    let mut writer = tokio::spawn(priority_writer(
        sink,
        priority_rx,
        data_rx,
        Arc::clone(&delivery_epochs),
        revoked.clone(),
    ));
    let mut next_subscription_epoch = 1_u64;
    let mut expected = BTreeMap::new();
    let mut dirty: HashMap<u32, u64> = HashMap::new();
    let mut pending_end: HashSet<u32> = HashSet::new();
    let mut close_after_overload = false;

    for (stream_id, offset) in attach.resume_streams {
        if let Ok(binding) = state.terminal.binding(stream_id) {
            let input_through = match state
                .terminal
                .input_through(stream_id, binding.generation)
                .await
            {
                Ok(through) => through,
                Err(error) => {
                    tracing::warn!(
                        error = %error,
                        stream_id,
                        generation = binding.generation,
                        "terminal attach rejected because input state is not resumable"
                    );
                    let _ = priority_tx
                        .send(Outbound::Control(ServerMessage::ResumeReset {
                            stream_id: Some(stream_id),
                            reason: "terminal input outcome is ambiguous; start a new generation"
                                .into(),
                            snapshot_revision: None,
                        }))
                        .await;
                    continue;
                }
            };
            let epoch = allocate_subscription_epoch(&mut next_subscription_epoch);
            expected.insert(
                stream_id,
                InteractiveSubscription {
                    cursor: offset,
                    session_id: binding.session_id,
                    generation: binding.generation,
                    epoch,
                },
            );
            subscription.select(binding.session_id, binding.generation);
            set_delivery_epoch(&delivery_epochs, stream_id, epoch);
            let _ = priority_tx
                .send(Outbound::Control(ServerMessage::StreamOpened {
                    stream_id,
                    generation: binding.generation,
                    starting_offset: offset,
                    input_through,
                }))
                .await;
            dirty.insert(stream_id, binding.generation);
        }
    }

    let mut recovery = tokio::time::interval(Duration::from_millis(20));
    recovery.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    let mut reconciliation = tokio::time::interval(Duration::from_millis(250));
    reconciliation.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    loop {
        tokio::select! {
            biased;
            _ = revoked.cancelled() => break,
            incoming = reader.next() => {
                let Some(Ok(message)) = incoming else { break };
                let handled = tokio::select! {
                    biased;
                    _ = revoked.cancelled() => break,
                    handled = handle_interactive_input(
                        &state,
                        &priority_tx,
                        InteractiveInputState {
                            expected: &mut expected,
                            dirty: &mut dirty,
                            pending_end: &mut pending_end,
                            delivery_epochs: &delivery_epochs,
                            next_subscription_epoch: &mut next_subscription_epoch,
                            event_subscription: &subscription,
                        },
                        message,
                    ) => handled,
                };
                match handled {
                    Ok(InteractiveInputAction::Continue) => {}
                    Ok(InteractiveInputAction::CloseAfterOverload) => {
                        close_after_overload = true;
                        break;
                    }
                    Err(_) => break,
                }
            }
            _ = recovery.tick(), if !dirty.is_empty() => {
                let candidates = dirty.iter().map(|(stream, generation)| (*stream, *generation)).collect::<Vec<_>>();
                for (stream_id, generation) in candidates {
                    let Some(active) = expected.get_mut(&stream_id) else {
                        dirty.remove(&stream_id);
                        pending_end.remove(&stream_id);
                        continue;
                    };
                    if active.generation != generation {
                        dirty.remove(&stream_id);
                        pending_end.remove(&stream_id);
                        continue;
                    }
                    match pump_replay(
                        &state,
                        &priority_tx,
                        &data_tx,
                        stream_id,
                        generation,
                        active.epoch,
                        &mut active.cursor,
                    ).await {
                        ReplayProgress::CaughtUp => {
                            dirty.remove(&stream_id);
                            if pending_end.remove(&stream_id) {
                                if let Ok(frame) = BinaryFrame::new(
                                    BinaryKind::TerminalOutput,
                                    stream_id,
                                    active.cursor,
                                    BinaryFrameHeader::FLAG_END_OF_STREAM,
                                    Vec::new(),
                                ) {
                                    if data_tx.try_send(Outbound::Binary {
                                        stream_id,
                                        subscription_epoch: active.epoch,
                                        bytes: frame.encode(),
                                    }).is_err() {
                                        pending_end.insert(stream_id);
                                        dirty.insert(stream_id, generation);
                                    }
                                }
                            }
                        }
                        ReplayProgress::Progress | ReplayProgress::Backpressured => {}
                        ReplayProgress::Gone => { dirty.remove(&stream_id); pending_end.remove(&stream_id); }
                    }
                }
            }
            _ = reconciliation.tick(), if !expected.is_empty() => {
                if let Ok(sessions) = state.terminal.list().await {
                    reconcile_terminal_state(
                        &sessions,
                        &expected,
                        &mut dirty,
                        &mut pending_end,
                    );
                }
            }
            event = subscription.recv() => {
                let Some(event) = event else { break };
                forward_live_terminal_event(
                    &state,
                    &data_tx,
                    &mut expected,
                    &mut dirty,
                    &mut pending_end,
                    event,
                );
            }
        }
    }
    authorization_watcher.abort();
    if close_after_overload {
        // Stop any queued output from sitting ahead of the overload fault. The writer gets a short
        // best-effort flush window, then is aborted so a non-reading peer cannot delay reconnect.
        if let Ok(mut epochs) = delivery_epochs.write() {
            epochs.clear();
        }
    }
    drop(priority_tx);
    drop(data_tx);
    if close_after_overload {
        if tokio::time::timeout(INTERACTIVE_OVERLOAD_CLOSE_GRACE, &mut writer)
            .await
            .is_err()
        {
            writer.abort();
            let _ = writer.await;
        }
    } else {
        let _ = writer.await;
    }
}

fn forward_live_terminal_event(
    state: &Arc<AppState>,
    data_tx: &mpsc::Sender<Outbound>,
    expected: &mut BTreeMap<u32, InteractiveSubscription>,
    dirty: &mut HashMap<u32, u64>,
    pending_end: &mut HashSet<u32>,
    event: TerminalEvent,
) {
    match event {
        TerminalEvent::Output {
            session_id,
            generation,
            offset,
            data,
        } => {
            let Some(stream_id) = state.terminal.stream_for_session(session_id, generation) else {
                return;
            };
            let Some(active) = expected.get_mut(&stream_id) else {
                return;
            };
            if active.generation != generation {
                return;
            }
            if active.cursor < offset {
                dirty.insert(stream_id, generation);
                return;
            }
            let end = offset.saturating_add(data.len() as u64);
            if active.cursor >= end {
                return;
            }
            let skip = (active.cursor - offset) as usize;
            let payload = data.slice(skip..).to_vec();
            let Ok(frame) = BinaryFrame::new(
                BinaryKind::TerminalOutput,
                stream_id,
                active.cursor,
                0,
                payload,
            ) else {
                return;
            };
            match data_tx.try_send(Outbound::Binary {
                stream_id,
                subscription_epoch: active.epoch,
                bytes: frame.encode(),
            }) {
                Ok(()) => active.cursor = end,
                Err(_) => {
                    dirty.insert(stream_id, generation);
                }
            }
        }
        TerminalEvent::Exited {
            session_id,
            generation,
            ..
        } => {
            let Some(stream_id) = state.terminal.stream_for_session(session_id, generation) else {
                return;
            };
            if expected
                .get(&stream_id)
                .is_some_and(|active| active.generation == generation)
            {
                dirty.insert(stream_id, generation);
                pending_end.insert(stream_id);
            }
        }
    }
}

fn reconcile_terminal_state(
    sessions: &[(TerminalSessionInfo, u32)],
    expected: &BTreeMap<u32, InteractiveSubscription>,
    dirty: &mut HashMap<u32, u64>,
    pending_end: &mut HashSet<u32>,
) {
    for (info, stream_id) in sessions {
        let Some(active) = expected.get(stream_id) else {
            continue;
        };
        if active.generation != info.generation {
            continue;
        }
        if active.cursor < info.output.end {
            dirty.insert(*stream_id, info.generation);
        }
        if matches!(info.state, TerminalSessionState::Exited(_)) {
            pending_end.insert(*stream_id);
            dirty.insert(*stream_id, info.generation);
        }
    }
}

fn allocate_subscription_epoch(next: &mut u64) -> u64 {
    let epoch = (*next).max(1);
    *next = epoch.checked_add(1).unwrap_or(1);
    epoch
}

fn set_delivery_epoch(delivery_epochs: &DeliveryEpochs, stream_id: u32, epoch: u64) {
    if let Ok(mut active) = delivery_epochs.write() {
        active.insert(stream_id, epoch);
    }
}

fn delivery_is_current(
    delivery_epochs: &DeliveryEpochs,
    stream_id: u32,
    subscription_epoch: u64,
) -> bool {
    delivery_epochs
        .read()
        .is_ok_and(|active| active.get(&stream_id) == Some(&subscription_epoch))
}

fn detach_subscription(
    expected: &mut BTreeMap<u32, InteractiveSubscription>,
    dirty: &mut HashMap<u32, u64>,
    pending_end: &mut HashSet<u32>,
    delivery_epochs: &DeliveryEpochs,
    stream_id: u32,
    generation: u64,
) -> Option<InteractiveSubscription> {
    let active = expected.get(&stream_id).copied()?;
    if active.generation != generation {
        return None;
    }
    expected.remove(&stream_id);
    dirty.remove(&stream_id);
    pending_end.remove(&stream_id);
    if let Ok(mut delivery) = delivery_epochs.write() {
        if delivery.get(&stream_id) == Some(&active.epoch) {
            delivery.remove(&stream_id);
        }
    }
    Some(active)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum InteractiveInputAction {
    Continue,
    CloseAfterOverload,
}

fn terminal_input_fault_action(code: TerminalInputFaultCode) -> InteractiveInputAction {
    if code == TerminalInputFaultCode::Overloaded {
        InteractiveInputAction::CloseAfterOverload
    } else {
        InteractiveInputAction::Continue
    }
}

async fn handle_interactive_input(
    state: &Arc<AppState>,
    priority: &mpsc::Sender<Outbound>,
    routing: InteractiveInputState<'_>,
    message: Message,
) -> anyhow::Result<InteractiveInputAction> {
    let InteractiveInputState {
        expected,
        dirty,
        pending_end,
        delivery_epochs,
        next_subscription_epoch,
        event_subscription,
    } = routing;
    match message {
        Message::Binary(bytes) => {
            let frame = BinaryFrame::decode(LogicalChannel::Interactive, &bytes)?;
            if frame.header.kind != BinaryKind::TerminalInput || frame.header.flags != 0 {
                bail!("interactive client binary frames must be unflagged terminal input");
            }
            let stream_id = frame.header.stream_id;
            let binding = match state.terminal.binding(stream_id) {
                Ok(binding) => binding,
                Err(error) => {
                    tracing::info!(
                        error = %error,
                        stream_id,
                        "terminal input rejected for an unknown or retired stream"
                    );
                    priority
                        .send(Outbound::Control(ServerMessage::TerminalInputFault {
                            stream_id,
                            generation: None,
                            code: TerminalInputFaultCode::NotFound,
                            authoritative_through: None,
                            discard_pending: true,
                        }))
                        .await?;
                    return Ok(InteractiveInputAction::Continue);
                }
            };
            let generation = binding.generation;
            let applied = match state
                .terminal
                .apply_input(stream_id, generation, frame.header.sequence, frame.payload)
                .await
            {
                Ok(applied) => applied,
                Err(error) => {
                    tracing::warn!(
                        error = %error,
                        stream_id,
                        generation,
                        "terminal input transaction failed without a definitive outcome"
                    );
                    let authoritative_through = state
                        .terminal
                        .input_through(stream_id, generation)
                        .await
                        .ok();
                    priority
                        .send(Outbound::Control(ServerMessage::TerminalInputFault {
                            stream_id,
                            generation: Some(generation),
                            code: TerminalInputFaultCode::Ambiguous,
                            authoritative_through,
                            discard_pending: false,
                        }))
                        .await?;
                    return Ok(InteractiveInputAction::Continue);
                }
            };
            match applied {
                InputApply::Applied { through } | InputApply::Duplicate { through } => {
                    priority
                        .send(Outbound::Control(ServerMessage::StreamAck {
                            stream_id,
                            through_offset: through,
                        }))
                        .await?;
                }
                InputApply::Gap {
                    expected,
                    received: _,
                } => {
                    priority
                        .send(Outbound::Control(ServerMessage::TerminalInputFault {
                            stream_id,
                            generation: Some(generation),
                            code: TerminalInputFaultCode::Conflict,
                            authoritative_through: Some(expected),
                            discard_pending: false,
                        }))
                        .await?;
                }
                InputApply::OverlapMismatch { through } => {
                    priority
                        .send(Outbound::Control(ServerMessage::TerminalInputFault {
                            stream_id,
                            generation: Some(generation),
                            code: TerminalInputFaultCode::Conflict,
                            authoritative_through: Some(through),
                            discard_pending: false,
                        }))
                        .await?;
                }
                InputApply::Rejected { through, code } => {
                    let action = terminal_input_fault_action(code);
                    let discard_pending = matches!(
                        code,
                        TerminalInputFaultCode::NotFound
                            | TerminalInputFaultCode::SessionExited
                            | TerminalInputFaultCode::GenerationChanged
                    );
                    priority
                        .send(Outbound::Control(ServerMessage::TerminalInputFault {
                            stream_id,
                            generation: Some(generation),
                            code,
                            authoritative_through: Some(through),
                            discard_pending,
                        }))
                        .await?;
                    if action == InteractiveInputAction::CloseAfterOverload {
                        return Ok(action);
                    }
                }
                InputApply::Cancelled { .. } => {}
                InputApply::Ambiguous { through } => {
                    priority
                        .send(Outbound::Control(ServerMessage::TerminalInputFault {
                            stream_id,
                            generation: Some(generation),
                            code: TerminalInputFaultCode::Ambiguous,
                            authoritative_through: Some(through),
                            discard_pending: false,
                        }))
                        .await?;
                }
            }
        }
        Message::Text(text) => match decode_client_message(text.as_bytes())? {
            ClientMessage::Ping { nonce, sent_at_ms } => {
                priority
                    .send(Outbound::Control(ServerMessage::Pong {
                        nonce,
                        client_sent_at_ms: sent_at_ms,
                        server_at_ms: now_ms(),
                    }))
                    .await?;
            }
            ClientMessage::Call {
                id,
                method: RpcMethod::SessionResume,
                params,
                ..
            } => {
                let request: TerminalCursorRequest = serde_json::from_value(params)?;
                let binding = match state.terminal.binding(request.stream_id) {
                    Ok(binding) => binding,
                    Err(error) => {
                        tracing::info!(
                            error = %error,
                            stream_id = request.stream_id,
                            generation = request.generation,
                            "terminal resume rejected for an unknown or retired stream"
                        );
                        priority
                            .send(Outbound::Control(ServerMessage::ResumeReset {
                                stream_id: Some(request.stream_id),
                                reason: "terminal stream was not found".into(),
                                snapshot_revision: None,
                            }))
                            .await?;
                        priority
                            .send(Outbound::Control(server_error(
                                Some(id),
                                ErrorCode::NotFound,
                                "terminal stream was not found",
                            )))
                            .await?;
                        return Ok(InteractiveInputAction::Continue);
                    }
                };
                if binding.generation != request.generation {
                    priority
                        .send(Outbound::Control(ServerMessage::ResumeReset {
                            stream_id: Some(request.stream_id),
                            reason: "terminal generation changed".into(),
                            snapshot_revision: None,
                        }))
                        .await?;
                    priority
                        .send(Outbound::Control(server_error(
                            Some(id),
                            ErrorCode::SnapshotRequired,
                            "terminal generation changed",
                        )))
                        .await?;
                } else {
                    let input_through = match state
                        .terminal
                        .input_through(request.stream_id, request.generation)
                        .await
                    {
                        Ok(through) => through,
                        Err(error) => {
                            tracing::warn!(
                                error = %error,
                                stream_id = request.stream_id,
                                generation = request.generation,
                                "terminal resume rejected because input state is not resumable"
                            );
                            priority
                                .send(Outbound::Control(ServerMessage::ResumeReset {
                                    stream_id: Some(request.stream_id),
                                    reason: "terminal input outcome is ambiguous; start a new generation"
                                        .into(),
                                    snapshot_revision: None,
                                }))
                                .await?;
                            priority
                                .send(Outbound::Control(server_error(
                                    Some(id),
                                    ErrorCode::Ambiguous,
                                    "terminal input outcome is ambiguous; start a new generation",
                                )))
                                .await?;
                            return Ok(InteractiveInputAction::Continue);
                        }
                    };
                    let epoch = allocate_subscription_epoch(next_subscription_epoch);
                    if let Some(previous) = expected.insert(
                        request.stream_id,
                        InteractiveSubscription {
                            cursor: request.offset,
                            session_id: binding.session_id,
                            generation: request.generation,
                            epoch,
                        },
                    ) {
                        event_subscription.deselect(previous.session_id, previous.generation);
                    }
                    event_subscription.select(binding.session_id, binding.generation);
                    set_delivery_epoch(delivery_epochs, request.stream_id, epoch);
                    dirty.insert(request.stream_id, request.generation);
                    pending_end.remove(&request.stream_id);
                    priority
                        .send(Outbound::Control(ServerMessage::StreamOpened {
                            stream_id: request.stream_id,
                            generation: request.generation,
                            starting_offset: request.offset,
                            input_through,
                        }))
                        .await?;
                    priority
                        .send(Outbound::Control(ServerMessage::Result {
                            id,
                            value: serde_json::to_value(SessionResumeResponse {
                                stream_id: request.stream_id,
                                generation: request.generation,
                                starting_offset: request.offset,
                                input_through,
                                lane: LogicalChannel::Interactive,
                            })?,
                        }))
                        .await?;
                }
            }
            ClientMessage::Call {
                id,
                method: RpcMethod::TerminalDetach,
                params,
                ..
            } => {
                let request: TerminalDetachRequest = serde_json::from_value(params)?;
                let detached = detach_subscription(
                    expected,
                    dirty,
                    pending_end,
                    delivery_epochs,
                    request.stream_id,
                    request.generation,
                );
                if let Some(active) = detached {
                    event_subscription.deselect(active.session_id, active.generation);
                }
                priority
                    .send(Outbound::Control(ServerMessage::Result {
                        id,
                        value: serde_json::to_value(TerminalDetachResponse {
                            detached: detached.is_some(),
                        })?,
                    }))
                    .await?;
            }
            ClientMessage::Call { id, method, .. } => {
                priority
                    .send(Outbound::Control(server_error(
                        Some(id),
                        ErrorCode::BadRequest,
                        format!("{method:?} is not supported on the interactive lane"),
                    )))
                    .await?;
            }
            _ => bail!("message is not supported on the interactive lane"),
        },
        Message::Ping(payload) => {
            priority.send(Outbound::Pong(payload.to_vec())).await?;
        }
        Message::Pong(_) => {}
        Message::Close(_) => bail!("client closed"),
    }
    Ok(InteractiveInputAction::Continue)
}

enum ReplayProgress {
    Progress,
    CaughtUp,
    Backpressured,
    Gone,
}

async fn pump_replay(
    state: &Arc<AppState>,
    priority: &mpsc::Sender<Outbound>,
    data: &mpsc::Sender<Outbound>,
    stream_id: u32,
    generation: u64,
    subscription_epoch: u64,
    cursor: &mut u64,
) -> ReplayProgress {
    match state
        .terminal
        .replay(
            stream_id,
            generation,
            *cursor,
            BinaryKind::TerminalOutput.max_payload_bytes(),
        )
        .await
    {
        Ok(replay) if replay.data.is_empty() => ReplayProgress::CaughtUp,
        Ok(replay) => {
            let frame = BinaryFrame::new(
                BinaryKind::TerminalOutput,
                stream_id,
                replay.requested_offset,
                BinaryFrameHeader::FLAG_REPLAY,
                replay.data.to_vec(),
            )
            .expect("core replay respects protocol chunk limit");
            match data.try_send(Outbound::Binary {
                stream_id,
                subscription_epoch,
                bytes: frame.encode(),
            }) {
                Ok(()) => {
                    *cursor = replay.next_offset;
                    ReplayProgress::Progress
                }
                Err(_) => ReplayProgress::Backpressured,
            }
        }
        Err(_) => {
            let snapshot = match state
                .terminal
                .snapshot(
                    stream_id,
                    generation,
                    BinaryKind::TerminalSnapshot.max_payload_bytes(),
                )
                .await
            {
                Ok(snapshot) => snapshot,
                Err(_) => return ReplayProgress::Gone,
            };
            if priority
                .try_send(Outbound::Control(ServerMessage::ResumeReset {
                    stream_id: Some(stream_id),
                    reason: "requested output expired; terminal snapshot follows".into(),
                    snapshot_revision: Some(format!(
                        "{generation}:{}:{}",
                        snapshot.range.available_from, snapshot.range.end
                    )),
                }))
                .is_err()
            {
                return ReplayProgress::Backpressured;
            }
            let frame = BinaryFrame::new(
                BinaryKind::TerminalSnapshot,
                stream_id,
                snapshot.requested_offset,
                BinaryFrameHeader::FLAG_REPLAY,
                snapshot.data.to_vec(),
            )
            .expect("core snapshot respects protocol chunk limit");
            match data.try_send(Outbound::Binary {
                stream_id,
                subscription_epoch,
                bytes: frame.encode(),
            }) {
                Ok(()) => {
                    *cursor = snapshot.next_offset;
                    if snapshot.data.is_empty() {
                        ReplayProgress::CaughtUp
                    } else {
                        ReplayProgress::Progress
                    }
                }
                Err(_) => ReplayProgress::Backpressured,
            }
        }
    }
}

async fn single_writer(
    mut sink: SplitSink<WebSocket, Message>,
    mut receiver: mpsc::Receiver<Outbound>,
    revoked: CancellationToken,
) {
    loop {
        let message = tokio::select! {
            biased;
            _ = revoked.cancelled() => break,
            message = receiver.recv() => match message {
                Some(message) => message,
                None => break,
            },
        };
        let written = tokio::select! {
            biased;
            _ = revoked.cancelled() => break,
            written = write_outbound(&mut sink, message) => written,
        };
        if written.is_err() {
            break;
        }
    }
}

async fn priority_writer(
    mut sink: SplitSink<WebSocket, Message>,
    mut priority: mpsc::Receiver<Outbound>,
    mut data: mpsc::Receiver<Outbound>,
    delivery_epochs: DeliveryEpochs,
    revoked: CancellationToken,
) {
    loop {
        let message = tokio::select! {
            biased;
            _ = revoked.cancelled() => break,
            message = priority.recv() => match message {
                Some(message) => message,
                None => tokio::select! {
                    biased;
                    _ = revoked.cancelled() => break,
                    message = data.recv() => match message { Some(message) => message, None => break },
                },
            },
            message = data.recv() => match message {
                Some(message) => message,
                None => tokio::select! {
                    biased;
                    _ = revoked.cancelled() => break,
                    message = priority.recv() => match message { Some(message) => message, None => break },
                },
            },
        };
        if matches!(
            &message,
            Outbound::Binary {
                stream_id,
                subscription_epoch,
                ..
            } if !delivery_is_current(&delivery_epochs, *stream_id, *subscription_epoch)
        ) {
            continue;
        }
        let written = tokio::select! {
            biased;
            _ = revoked.cancelled() => break,
            written = write_outbound(&mut sink, message) => written,
        };
        if written.is_err() {
            break;
        }
    }
}

async fn write_outbound(
    sink: &mut SplitSink<WebSocket, Message>,
    outbound: Outbound,
) -> anyhow::Result<()> {
    let message = match outbound {
        Outbound::Control(message) => {
            let encoded = encode_control_or_error(message)?;
            Message::Text(String::from_utf8(encoded)?.into())
        }
        Outbound::Binary { bytes, .. } => Message::Binary(bytes.into()),
        Outbound::Pong(bytes) => Message::Pong(bytes.into()),
    };
    sink.send(message).await?;
    Ok(())
}

async fn send_direct(socket: &mut WebSocket, message: ServerMessage) -> anyhow::Result<()> {
    let encoded = encode_control_or_error(message)?;
    socket
        .send(Message::Text(String::from_utf8(encoded)?.into()))
        .await?;
    Ok(())
}

fn encode_control_or_error(message: ServerMessage) -> anyhow::Result<Vec<u8>> {
    let id = match &message {
        ServerMessage::Result { id, .. } => Some(*id),
        ServerMessage::Error { id, .. } => *id,
        _ => None,
    };
    match encode_server_message(&message) {
        Ok(encoded) => Ok(encoded),
        Err(error) => {
            tracing::warn!(error = %error, "outbound control message exceeded protocol limits");
            encode_server_message(&server_error(
                id,
                ErrorCode::PayloadTooLarge,
                "response exceeded the control-channel byte limit",
            ))
            .map_err(Into::into)
        }
    }
}

async fn recv_control(socket: &mut WebSocket) -> anyhow::Result<ClientMessage> {
    loop {
        match socket.next().await.context("websocket closed")?? {
            Message::Text(text) => {
                return decode_client_message(text.as_bytes()).map_err(Into::into)
            }
            Message::Ping(payload) => socket.send(Message::Pong(payload)).await?,
            Message::Pong(_) => {}
            Message::Close(_) => bail!("websocket closed"),
            Message::Binary(_) => bail!("expected a JSON control message"),
        }
    }
}

fn decode_ws_control(message: Message) -> anyhow::Result<Option<ClientMessage>> {
    match message {
        Message::Text(text) => Ok(Some(decode_client_message(text.as_bytes())?)),
        Message::Pong(_) | Message::Ping(_) => Ok(None),
        Message::Close(_) => Err(anyhow!("websocket closed")),
        Message::Binary(_) => bail!("binary traffic is forbidden on the control lane"),
    }
}

fn request_fingerprint(method: RpcMethod, params: &Value) -> [u8; 32] {
    let encoded = serde_json::to_vec(&(method, params)).unwrap_or_default();
    Sha256::digest(encoded).into()
}

fn retarget(message: ServerMessage, id: Uuid) -> ServerMessage {
    match message {
        ServerMessage::Result { value, .. } => ServerMessage::Result { id, value },
        ServerMessage::Error {
            code,
            message,
            retry_after_ms,
            ..
        } => ServerMessage::Error {
            id: Some(id),
            code,
            message,
            retry_after_ms,
        },
        other => other,
    }
}

fn server_error(id: Option<Uuid>, code: ErrorCode, message: impl Into<String>) -> ServerMessage {
    ServerMessage::Error {
        id,
        code,
        message: message.into(),
        retry_after_ms: None,
    }
}

fn parse_params<T: for<'de> Deserialize<'de>>(value: Value) -> Result<T, RpcFailure> {
    serde_json::from_value(value)
        .map_err(|error| RpcFailure::new(ErrorCode::BadRequest, format!("invalid params: {error}")))
}

fn terminal_start_failure(error: &anyhow::Error) -> RpcFailure {
    if matches!(
        error.downcast_ref::<CoreError>(),
        Some(CoreError::SessionIdentityConflict(_))
    ) {
        RpcFailure::new(
            ErrorCode::Conflict,
            "session_id is already bound to different start parameters",
        )
    } else {
        RpcFailure::new(ErrorCode::BadRequest, "terminal could not be started")
    }
}

fn response_value<T: Serialize>(response: T) -> Result<Value, RpcFailure> {
    serde_json::to_value(response)
        .map_err(|_| RpcFailure::new(ErrorCode::Internal, "response serialization failed"))
}

fn session_summary(
    info: &TerminalSessionInfo,
    stream_id: u32,
    workspace_name: &str,
) -> SessionSummary {
    let state = match &info.state {
        TerminalSessionState::Running => SessionState::Ready,
        TerminalSessionState::Exited(exit) if exit.success => SessionState::Exited,
        TerminalSessionState::Exited(_) => SessionState::Failed,
    };
    let title = match info.kind {
        SessionKind::Shell => "Shell",
        SessionKind::Claude => "Claude",
        SessionKind::Codex => "Codex",
    };
    SessionSummary {
        id: info.session_id,
        stream_id,
        generation: info.generation,
        title: title.into(),
        workspace_name: workspace_name.into(),
        kind: info.kind,
        state,
        updated_at: now_ms(),
    }
}

fn terminal_size(rows: u16, columns: u16, pixel_width: u16, pixel_height: u16) -> TerminalSize {
    TerminalSize {
        rows,
        columns,
        pixel_width,
        pixel_height,
    }
}

fn authorization_recheck_timer() -> tokio::time::Interval {
    let mut timer = tokio::time::interval_at(
        tokio::time::Instant::now() + AUTHORIZATION_RECHECK_INTERVAL,
        AUTHORIZATION_RECHECK_INTERVAL,
    );
    timer.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    timer
}

async fn watch_device_authorization(
    state: Arc<AppState>,
    device_id: Uuid,
    revoked: CancellationToken,
) {
    let mut timer = authorization_recheck_timer();
    loop {
        tokio::select! {
            biased;
            _ = revoked.cancelled() => return,
            _ = timer.tick() => {
                if !state.device_authorization_is_active(device_id).await {
                    state.cancel_device_calls(device_id);
                    revoked.cancel();
                    return;
                }
            }
        }
    }
}

async fn device_authorization_is_live(state: &Arc<AppState>, device_id: Uuid) -> bool {
    state.device_authorization_is_active(device_id).await
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .min(u64::MAX as u128) as u64
}

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord)]
struct FileSortKey {
    group: u8,
    folded_name: String,
    name: String,
}

#[derive(Debug, Serialize, Deserialize)]
struct FileListCursor {
    directory: bool,
    name: String,
}

async fn list_directory(
    root: WorkspaceRoot,
    relative: String,
    requested_limit: u16,
    cursor: Option<String>,
) -> Result<FileListResponse, RpcFailure> {
    let limit = usize::from(requested_limit.min(FILE_LIST_MAX_LIMIT));
    let cursor = cursor
        .as_deref()
        .map(decode_file_cursor)
        .transpose()?
        .map(|cursor| file_sort_key(cursor.directory, &cursor.name));
    tokio::task::spawn_blocking(move || {
        let directory = root
            .resolve_existing_dir(&relative)
            .map_err(|_| RpcFailure::new(ErrorCode::NotFound, "directory not found"))?;
        let entries = std::fs::read_dir(directory)
            .map_err(|_| RpcFailure::new(ErrorCode::NotFound, "directory not found"))?;
        let mut selected = BTreeMap::<FileSortKey, FileEntry>::new();
        for (scanned, entry) in entries.enumerate() {
            if scanned >= FILE_LIST_MAX_SCANNED {
                return Err(RpcFailure::new(
                    ErrorCode::PayloadTooLarge,
                    "directory scan exceeds the 100000-entry safety limit",
                ));
            }
            let Ok(entry) = entry else { continue };
            let Some(name) = entry.file_name().to_str().map(str::to_owned) else {
                continue;
            };
            let child = PathBuf::from(&relative).join(&name);
            let Ok(resolved) = root.resolve_existing(&child) else {
                continue;
            };
            let Ok(metadata) = std::fs::metadata(resolved) else {
                continue;
            };
            let key = file_sort_key(metadata.is_dir(), &name);
            if cursor.as_ref().is_some_and(|cursor| &key <= cursor) {
                continue;
            }
            selected.insert(key, file_entry(&path_to_wire(&child), &metadata));
            if selected.len() > limit + 1 {
                selected.pop_last();
            }
        }
        let mut selected = selected.into_iter().collect::<Vec<_>>();
        let mut has_more = selected.len() > limit;
        if has_more {
            selected.pop();
        }
        let path = path_to_wire(Path::new(&relative));
        loop {
            let next_cursor = if has_more {
                selected
                    .last()
                    .map(|(key, _)| encode_file_cursor(key))
                    .transpose()?
            } else {
                None
            };
            let entries = selected.iter().map(|(_, value)| value.clone()).collect();
            let response = FileListResponse {
                path: path.clone(),
                entries,
                next_cursor,
            };
            if serde_json::to_vec(&response)
                .is_ok_and(|encoded| encoded.len() <= FILE_LIST_VALUE_BUDGET)
            {
                return Ok(response);
            }
            if selected.pop().is_none() {
                return Err(RpcFailure::new(
                    ErrorCode::PayloadTooLarge,
                    "one directory entry exceeds the control-channel byte budget",
                ));
            }
            has_more = true;
        }
    })
    .await
    .map_err(|_| RpcFailure::new(ErrorCode::Internal, "directory listing task failed"))?
}

fn file_sort_key(directory: bool, name: &str) -> FileSortKey {
    FileSortKey {
        group: u8::from(!directory),
        folded_name: name.to_lowercase(),
        name: name.to_owned(),
    }
}

fn encode_file_cursor(key: &FileSortKey) -> Result<String, RpcFailure> {
    let value = FileListCursor {
        directory: key.group == 0,
        name: key.name.clone(),
    };
    serde_json::to_vec(&value)
        .map(|encoded| URL_SAFE_NO_PAD.encode(encoded))
        .map_err(|_| RpcFailure::new(ErrorCode::Internal, "file cursor encoding failed"))
}

fn decode_file_cursor(value: &str) -> Result<FileListCursor, RpcFailure> {
    if value.len() > 1024 {
        return Err(RpcFailure::new(
            ErrorCode::BadRequest,
            "file cursor is too large",
        ));
    }
    let decoded = URL_SAFE_NO_PAD
        .decode(value)
        .map_err(|_| RpcFailure::new(ErrorCode::BadRequest, "file cursor is invalid"))?;
    let cursor: FileListCursor = serde_json::from_slice(&decoded)
        .map_err(|_| RpcFailure::new(ErrorCode::BadRequest, "file cursor is invalid"))?;
    if cursor.name.is_empty() || cursor.name.len() > 1024 || cursor.name.contains('\0') {
        return Err(RpcFailure::new(
            ErrorCode::BadRequest,
            "file cursor is invalid",
        ));
    }
    Ok(cursor)
}

fn file_entry(relative: &str, metadata: &std::fs::Metadata) -> FileEntry {
    let path = Path::new(relative);
    let kind = if metadata.is_dir() {
        FileKind::Directory
    } else if metadata.is_file() {
        FileKind::File
    } else {
        FileKind::Other
    };
    let modified_at = metadata
        .modified()
        .ok()
        .and_then(|value| value.duration_since(UNIX_EPOCH).ok())
        .map(|value| value.as_millis().min(u64::MAX as u128) as u64);
    FileEntry {
        name: path
            .file_name()
            .and_then(|value| value.to_str())
            .unwrap_or("")
            .into(),
        path: path_to_wire(path),
        kind,
        size: metadata.is_file().then_some(metadata.len()),
        modified_at,
        etag: None,
    }
}

fn path_to_wire(path: &Path) -> String {
    path.components()
        .filter_map(|component| component.as_os_str().to_str())
        .filter(|component| *component != ".")
        .collect::<Vec<_>>()
        .join("/")
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn idempotency_fingerprint_binds_method_and_params() {
        assert_ne!(
            request_fingerprint(RpcMethod::SessionStop, &json!({"x": 1})),
            request_fingerprint(RpcMethod::SessionStop, &json!({"x": 2}))
        );
        assert_ne!(
            request_fingerprint(RpcMethod::SessionStop, &json!({"x": 1})),
            request_fingerprint(RpcMethod::TerminalResize, &json!({"x": 1}))
        );
    }

    #[test]
    fn session_identity_conflict_maps_to_rpc_conflict() {
        let error = anyhow::Error::new(CoreError::SessionIdentityConflict(Uuid::new_v4()));
        assert_eq!(terminal_start_failure(&error).code, ErrorCode::Conflict);
    }

    #[test]
    fn burst_admission_is_hard_bounded_without_waiting_tasks() {
        let slots = Arc::new(Semaphore::new(3));
        let mut admitted = (0..100)
            .filter_map(|_| try_call_permit(&slots))
            .collect::<Vec<_>>();
        assert_eq!(admitted.len(), 3);
        assert!(try_call_permit(&slots).is_none());

        admitted.pop();
        assert!(try_call_permit(&slots).is_some());
    }

    #[test]
    fn websocket_writes_flush_without_the_default_large_coalescing_target() {
        assert_eq!(WS_WRITE_BUFFER_TARGET, 0);
        assert_eq!(INTERACTIVE_DATA_QUEUE, 32);
        assert!(
            INTERACTIVE_MAX_WRITE_BUFFER
                >= BinaryKind::TerminalSnapshot.max_payload_bytes()
                    + linco_protocol::BINARY_HEADER_LEN
        );
    }

    #[test]
    fn queued_overload_closes_the_lane_before_buffered_suffixes_are_read() {
        assert_eq!(
            terminal_input_fault_action(TerminalInputFaultCode::Overloaded),
            InteractiveInputAction::CloseAfterOverload
        );
        assert_eq!(
            terminal_input_fault_action(TerminalInputFaultCode::Conflict),
            InteractiveInputAction::Continue
        );
        assert!(INTERACTIVE_OVERLOAD_CLOSE_GRACE <= Duration::from_millis(250));
    }

    #[test]
    fn file_write_contract_uses_length_and_revision() {
        let params: FileWriteRequest = serde_json::from_value(json!({
            "workspace_id": Uuid::new_v4(),
            "path": "notes.md",
            "content_length": 42,
            "expected_revision": "\"sha256-deadbeef\"",
        }))
        .unwrap();
        assert_eq!(params.content_length, 42);
        assert_eq!(params.expected_revision, "\"sha256-deadbeef\"");
        assert!(serde_json::from_value::<FileWriteRequest>(json!({
            "workspace_id": Uuid::new_v4(),
            "path": "notes.md",
            "expected_etag": "old-contract",
        }))
        .is_err());
    }

    #[tokio::test]
    async fn file_list_pages_large_long_name_directories_under_byte_budget() {
        let temp = tempfile::tempdir().unwrap();
        for index in 0..230 {
            let name = format!("{index:03}-{}.txt", "x".repeat(110));
            std::fs::write(temp.path().join(name), b"x").unwrap();
        }
        let root = WorkspaceRoot::open(temp.path()).unwrap();
        let first = list_directory(root.clone(), String::new(), FILE_LIST_MAX_LIMIT, None)
            .await
            .unwrap();
        assert!(!first.entries.is_empty());
        assert!(first.entries.len() <= usize::from(FILE_LIST_MAX_LIMIT));
        assert!(serde_json::to_vec(&first).unwrap().len() <= FILE_LIST_VALUE_BUDGET);
        let cursor = first.next_cursor.as_deref().unwrap().to_owned();
        let first_names = first
            .entries
            .iter()
            .map(|entry| entry.name.as_str())
            .collect::<HashSet<_>>();

        let second = list_directory(root, String::new(), FILE_LIST_MAX_LIMIT, Some(cursor))
            .await
            .unwrap();
        assert!(!second.entries.is_empty());
        assert!(second
            .entries
            .iter()
            .all(|entry| !first_names.contains(entry.name.as_str())));
    }

    #[test]
    fn oversized_result_becomes_protocol_error_without_closing_writer() {
        let id = Uuid::new_v4();
        let encoded = encode_control_or_error(ServerMessage::Result {
            id,
            value: Value::String("x".repeat(linco_protocol::MAX_CONTROL_MESSAGE_BYTES)),
        })
        .unwrap();
        assert!(encoded.len() <= linco_protocol::MAX_CONTROL_MESSAGE_BYTES);
        let value: Value = serde_json::from_slice(&encoded).unwrap();
        assert_eq!(value["type"], "error");
        assert_eq!(value["id"], id.to_string());
        assert_eq!(value["code"], "payload_too_large");
    }

    #[test]
    fn reconciliation_recovers_a_dropped_silent_tail_and_exit() {
        let stream_id = 7;
        let info = TerminalSessionInfo {
            session_id: Uuid::new_v4(),
            generation: 3,
            kind: SessionKind::Shell,
            cwd: PathBuf::from("."),
            process_id: None,
            created_at_ms: 1,
            output: linco_core::RingRange {
                available_from: 0,
                end: 25,
            },
            state: TerminalSessionState::Exited(linco_core::SessionExit {
                exit_code: Some(0),
                success: true,
                io_error: None,
            }),
        };
        let expected = BTreeMap::from([(
            stream_id,
            InteractiveSubscription {
                cursor: 10,
                session_id: info.session_id,
                generation: 3,
                epoch: 1,
            },
        )]);
        let mut dirty = HashMap::new();
        let mut pending_end = HashSet::new();

        reconcile_terminal_state(
            &[(info, stream_id)],
            &expected,
            &mut dirty,
            &mut pending_end,
        );

        assert_eq!(dirty.get(&stream_id), Some(&3));
        assert!(pending_end.contains(&stream_id));
    }

    #[test]
    fn exact_detach_stops_queued_frames_and_clears_recovery_state() {
        let stream_id = 7;
        let epoch = 19;
        let session_id = Uuid::new_v4();
        let mut expected = BTreeMap::from([(
            stream_id,
            InteractiveSubscription {
                cursor: 42,
                session_id,
                generation: 3,
                epoch,
            },
        )]);
        let mut dirty = HashMap::from([(stream_id, 3)]);
        let mut pending_end = HashSet::from([stream_id]);
        let delivery_epochs = DeliveryEpochs::default();
        set_delivery_epoch(&delivery_epochs, stream_id, epoch);

        assert!(delivery_is_current(&delivery_epochs, stream_id, epoch));
        assert!(detach_subscription(
            &mut expected,
            &mut dirty,
            &mut pending_end,
            &delivery_epochs,
            stream_id,
            3,
        )
        .is_some());

        assert!(!expected.contains_key(&stream_id));
        assert!(!dirty.contains_key(&stream_id));
        assert!(!pending_end.contains(&stream_id));
        assert!(!delivery_is_current(&delivery_epochs, stream_id, epoch));
        assert!(detach_subscription(
            &mut expected,
            &mut dirty,
            &mut pending_end,
            &delivery_epochs,
            stream_id,
            3,
        )
        .is_none());
    }

    #[test]
    fn generation_mismatch_detach_is_safe_and_keeps_exact_subscription() {
        let stream_id = 11;
        let epoch = 23;
        let subscription = InteractiveSubscription {
            cursor: 64,
            session_id: Uuid::new_v4(),
            generation: 9,
            epoch,
        };
        let mut expected = BTreeMap::from([(stream_id, subscription)]);
        let mut dirty = HashMap::from([(stream_id, 9)]);
        let mut pending_end = HashSet::from([stream_id]);
        let delivery_epochs = DeliveryEpochs::default();
        set_delivery_epoch(&delivery_epochs, stream_id, epoch);

        assert!(detach_subscription(
            &mut expected,
            &mut dirty,
            &mut pending_end,
            &delivery_epochs,
            stream_id,
            8,
        )
        .is_none());

        assert_eq!(
            expected.get(&stream_id).map(|active| active.cursor),
            Some(64)
        );
        assert_eq!(dirty.get(&stream_id), Some(&9));
        assert!(pending_end.contains(&stream_id));
        assert!(delivery_is_current(&delivery_epochs, stream_id, epoch));
    }
}
