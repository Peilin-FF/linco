use std::collections::BTreeMap;

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use thiserror::Error;
use uuid::Uuid;

use crate::LogicalChannel;

pub const PROTOCOL_VERSION: u8 = 1;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum ConnectionPath {
    Direct,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum KeyAlgorithm {
    /// ANSI X9.63 uncompressed P-256 public key and ASN.1 DER ECDSA signatures.
    P256,
}

#[derive(
    Debug, Clone, Copy, PartialEq, Eq, Hash, Ord, PartialOrd, Serialize, Deserialize, JsonSchema,
)]
#[serde(rename_all = "snake_case")]
pub enum Permission {
    Read,
    Terminal,
    Write,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum SessionKind {
    Shell,
    Claude,
    Codex,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum SessionState {
    Ready,
    Exited,
    Failed,
}

#[derive(
    Debug, Clone, Copy, PartialEq, Eq, Hash, Ord, PartialOrd, Serialize, Deserialize, JsonSchema,
)]
#[serde(rename_all = "snake_case")]
pub enum RpcMethod {
    SystemInfo,
    WorkspaceList,
    SessionList,
    SessionStart,
    SessionStop,
    SessionResume,
    TerminalDetach,
    TerminalResize,
    FileList,
    FileRead,
    FileWrite,
    PreviewResolve,
}

/// Security and replay behavior is defined centrally so every server adapter makes the same
/// authorization and retry decision.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct MethodPolicy {
    pub permission: Permission,
    pub mutating: bool,
    pub requires_idempotency_key: bool,
}

impl RpcMethod {
    pub const fn policy(self) -> MethodPolicy {
        use Permission::{Read, Terminal, Write};
        use RpcMethod::*;

        match self {
            SystemInfo | WorkspaceList | SessionList | FileList | FileRead | PreviewResolve => {
                MethodPolicy {
                    permission: Read,
                    mutating: false,
                    requires_idempotency_key: false,
                }
            }
            SessionStop | SessionResume | TerminalDetach | TerminalResize => MethodPolicy {
                permission: Terminal,
                mutating: false,
                requires_idempotency_key: false,
            },
            SessionStart => MethodPolicy {
                permission: Terminal,
                mutating: true,
                requires_idempotency_key: true,
            },
            FileWrite => MethodPolicy {
                permission: Write,
                mutating: false,
                requires_idempotency_key: false,
            },
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum ErrorCode {
    BadRequest,
    Unauthorized,
    Forbidden,
    NotFound,
    Conflict,
    PayloadTooLarge,
    RateLimited,
    Overloaded,
    UnsupportedVersion,
    SessionExited,
    Ambiguous,
    SnapshotRequired,
    Internal,
}

/// Machine-readable outcome for a rejected terminal-input frame.
///
/// Unlike a generic RPC error, this event always identifies the affected stream so a client can
/// quarantine or discard only that stream's pending input without destabilizing other terminals.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum TerminalInputFaultCode {
    NotFound,
    SessionExited,
    GenerationChanged,
    Conflict,
    /// The server could not start the write before its bounded admission deadline. No bytes were
    /// written, so the client may retain the pending frame and retry after resuming the stream.
    Overloaded,
    Ambiguous,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct ResumeCursor {
    #[serde(default)]
    pub streams: BTreeMap<u32, u64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct LaneTicket {
    pub lane: LogicalChannel,
    pub ticket_b64: String,
    pub expires_at_ms: u64,
}

/// Short-lived payload rendered as a QR code by the daemon's local pairing command.
///
/// The secret proves physical access only during pairing and must be destroyed after success or
/// expiry. `server_identity_b64` pins the daemon identity independently of the TLS certificate.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct PairingPayload {
    pub protocol_version: u8,
    pub endpoint: String,
    pub server_identity_b64: String,
    pub pairing_id: Uuid,
    pub pairing_secret_b64: String,
    pub expires_at_ms: u64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ClientMessage {
    Hello {
        protocol_version: u8,
        lane: LogicalChannel,
        connection_id: Option<Uuid>,
        device_id: Option<Uuid>,
        client_nonce_b64: String,
        resume: ResumeCursor,
    },
    Authenticate {
        connection_id: Uuid,
        device_id: Uuid,
        challenge_signature_b64: String,
    },
    AttachLane {
        connection_id: Uuid,
        lane: LogicalChannel,
        ticket_b64: String,
        client_nonce_b64: String,
    },
    PairStart {
        pairing_id: Uuid,
        device_name: String,
        device_key_algorithm: KeyAlgorithm,
        device_public_key_b64: String,
        client_nonce_b64: String,
    },
    PairFinish {
        pairing_id: Uuid,
        proof_b64: String,
        device_signature_b64: String,
    },
    Call {
        id: Uuid,
        method: RpcMethod,
        #[serde(default)]
        params: Value,
        idempotency_key: Option<Uuid>,
        deadline_ms: u64,
    },
    Cancel {
        id: Uuid,
    },
    Ping {
        nonce: u64,
        sent_at_ms: u64,
    },
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ServerMessage {
    Hello {
        protocol_version: u8,
        lane: LogicalChannel,
        connection_id: Uuid,
        server_epoch: Uuid,
        server_identity_b64: String,
        auth_challenge_b64: String,
        server_signature_b64: String,
        heartbeat_ms: u64,
    },
    PairChallenge {
        pairing_id: Uuid,
        challenge_b64: String,
        expires_at_ms: u64,
    },
    PairAccepted {
        device_id: Uuid,
        permissions: Vec<Permission>,
    },
    Ready {
        connection_id: Uuid,
        server_epoch: Uuid,
        lane: LogicalChannel,
        connection_path: ConnectionPath,
        #[serde(default)]
        attach_tickets: Vec<LaneTicket>,
    },
    Result {
        id: Uuid,
        value: Value,
    },
    Error {
        id: Option<Uuid>,
        code: ErrorCode,
        message: String,
        retry_after_ms: Option<u64>,
    },
    StreamOpened {
        stream_id: u32,
        generation: u64,
        starting_offset: u64,
        /// Server-authoritative next byte offset for terminal input on this generation.
        input_through: u64,
    },
    StreamAck {
        stream_id: u32,
        through_offset: u64,
    },
    TerminalInputFault {
        stream_id: u32,
        generation: Option<u64>,
        code: TerminalInputFaultCode,
        authoritative_through: Option<u64>,
        /// `true` means the stream can never accept these bytes and automatic replay must stop.
        /// `false` preserves the bytes for explicit conflict/ambiguity resolution.
        discard_pending: bool,
    },
    ResumeReset {
        stream_id: Option<u32>,
        reason: String,
        snapshot_revision: Option<String>,
    },
    Pong {
        nonce: u64,
        client_sent_at_ms: u64,
        server_at_ms: u64,
    },
}

impl ClientMessage {
    /// Rejects semantically dangerous messages before they reach application code.
    pub fn validate(&self) -> Result<(), ControlDecodeError> {
        match self {
            Self::Hello {
                protocol_version,
                lane,
                ..
            } => {
                if *protocol_version != PROTOCOL_VERSION {
                    return Err(ControlDecodeError::UnsupportedVersion(*protocol_version));
                }
                if *lane != LogicalChannel::Control {
                    return Err(ControlDecodeError::InvalidMessage(
                        "hello is only valid for the control lane",
                    ));
                }
            }
            Self::AttachLane { lane, .. } if *lane == LogicalChannel::Control => {
                return Err(ControlDecodeError::InvalidMessage(
                    "control connections authenticate with hello",
                ));
            }
            Self::PairStart { device_name, .. }
                if device_name.trim().is_empty() || device_name.chars().count() > 80 =>
            {
                return Err(ControlDecodeError::InvalidMessage(
                    "device_name must contain 1 to 80 characters",
                ));
            }
            Self::Call {
                method,
                idempotency_key,
                deadline_ms,
                ..
            } => {
                if *deadline_ms == 0 || *deadline_ms > crate::MAX_CALL_DEADLINE_MS {
                    return Err(ControlDecodeError::InvalidDeadline(*deadline_ms));
                }
                if method.policy().requires_idempotency_key && idempotency_key.is_none() {
                    return Err(ControlDecodeError::MissingIdempotencyKey(*method));
                }
            }
            _ => {}
        }
        Ok(())
    }
}

#[derive(Debug, Error)]
pub enum ControlDecodeError {
    #[error("control message is too large: {actual} bytes (max {max})")]
    TooLarge { actual: usize, max: usize },
    #[error("invalid control JSON: {0}")]
    Json(#[from] serde_json::Error),
    #[error("unsupported protocol version {0}")]
    UnsupportedVersion(u8),
    #[error("invalid call deadline {0} ms")]
    InvalidDeadline(u64),
    #[error("{0:?} requires an idempotency key")]
    MissingIdempotencyKey(RpcMethod),
    #[error("invalid control message: {0}")]
    InvalidMessage(&'static str),
}

pub fn decode_client_message(bytes: &[u8]) -> Result<ClientMessage, ControlDecodeError> {
    if bytes.len() > crate::MAX_CONTROL_MESSAGE_BYTES {
        return Err(ControlDecodeError::TooLarge {
            actual: bytes.len(),
            max: crate::MAX_CONTROL_MESSAGE_BYTES,
        });
    }
    let message = serde_json::from_slice::<ClientMessage>(bytes)?;
    message.validate()?;
    Ok(message)
}

pub fn encode_server_message(message: &ServerMessage) -> Result<Vec<u8>, ControlDecodeError> {
    let encoded = serde_json::to_vec(message)?;
    if encoded.len() > crate::MAX_CONTROL_MESSAGE_BYTES {
        return Err(ControlDecodeError::TooLarge {
            actual: encoded.len(),
            max: crate::MAX_CONTROL_MESSAGE_BYTES,
        });
    }
    Ok(encoded)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn control_messages_are_explicitly_tagged_and_round_trip() {
        let id = Uuid::new_v4();
        let message = ClientMessage::Call {
            id,
            method: RpcMethod::TerminalResize,
            params: serde_json::json!({"session_id": "s1", "columns": 80, "rows": 24}),
            idempotency_key: Some(Uuid::new_v4()),
            deadline_ms: 1_000,
        };
        let json = serde_json::to_string(&message).expect("serialize");
        assert!(json.contains("\"type\":\"call\""));
        assert!(json.contains("\"method\":\"terminal_resize\""));
        let decoded: ClientMessage = serde_json::from_str(&json).expect("deserialize");
        assert_eq!(decoded, message);
    }

    #[test]
    fn unknown_methods_are_rejected_instead_of_forwarded() {
        let json = format!(
            "{{\"type\":\"call\",\"id\":\"{}\",\"method\":\"run_arbitrary_tauri_command\",\"params\":null,\"idempotency_key\":null,\"deadline_ms\":1000}}",
            Uuid::new_v4()
        );
        assert!(serde_json::from_str::<ClientMessage>(&json).is_err());
    }

    #[test]
    fn removed_ack_and_event_cursor_fields_are_rejected() {
        let ack = r#"{"type":"ack","events_through":1,"streams_through":{}}"#;
        assert!(serde_json::from_str::<ClientMessage>(ack).is_err());

        let cursor = r#"{"events":1,"streams":{}}"#;
        assert!(serde_json::from_str::<ResumeCursor>(cursor).is_err());
    }

    #[test]
    fn ready_contains_only_live_v1_recovery_fields() {
        let message = ServerMessage::Ready {
            connection_id: Uuid::nil(),
            server_epoch: Uuid::nil(),
            lane: LogicalChannel::Control,
            connection_path: ConnectionPath::Direct,
            attach_tickets: Vec::new(),
        };
        let encoded = String::from_utf8(encode_server_message(&message).unwrap()).unwrap();
        assert!(!encoded.contains("replayed_through"));
        assert!(!encoded.contains("event"));
    }

    #[test]
    fn stream_opened_carries_the_authoritative_input_cursor() {
        let message = ServerMessage::StreamOpened {
            stream_id: 7,
            generation: 3,
            starting_offset: 4_096,
            input_through: 98_304,
        };
        let encoded = String::from_utf8(encode_server_message(&message).unwrap()).unwrap();
        assert!(encoded.contains("\"input_through\":98304"));
        assert_eq!(
            serde_json::from_str::<ServerMessage>(&encoded).unwrap(),
            message
        );
    }

    #[test]
    fn terminal_input_fault_is_stream_scoped_and_machine_readable() {
        let message = ServerMessage::TerminalInputFault {
            stream_id: 7,
            generation: Some(3),
            code: TerminalInputFaultCode::SessionExited,
            authoritative_through: Some(98_304),
            discard_pending: true,
        };
        let encoded = String::from_utf8(encode_server_message(&message).unwrap()).unwrap();
        assert!(encoded.contains("\"type\":\"terminal_input_fault\""));
        assert!(encoded.contains("\"stream_id\":7"));
        assert!(encoded.contains("\"code\":\"session_exited\""));
        assert!(encoded.contains("\"authoritative_through\":98304"));
        assert!(encoded.contains("\"discard_pending\":true"));
        assert_eq!(
            serde_json::from_str::<ServerMessage>(&encoded).unwrap(),
            message
        );
    }

    #[test]
    fn mutating_calls_without_idempotency_are_rejected() {
        let message = ClientMessage::Call {
            id: Uuid::new_v4(),
            method: RpcMethod::SessionStart,
            params: Value::Null,
            idempotency_key: None,
            deadline_ms: 5_000,
        };
        let encoded = serde_json::to_vec(&message).expect("encode");
        assert!(matches!(
            decode_client_message(&encoded),
            Err(ControlDecodeError::MissingIdempotencyKey(
                RpcMethod::SessionStart
            ))
        ));
    }

    #[test]
    fn oversized_control_messages_are_rejected_before_json_parsing() {
        let oversized = vec![b' '; crate::MAX_CONTROL_MESSAGE_BYTES + 1];
        assert!(matches!(
            decode_client_message(&oversized),
            Err(ControlDecodeError::TooLarge { .. })
        ));
    }

    #[test]
    fn protocol_schema_is_generatable_for_swift_contract_checks() {
        let schema = schemars::schema_for!(ClientMessage);
        let json = serde_json::to_string(&schema).expect("schema json");
        assert!(json.contains("pair_start"));
        assert!(json.contains("terminal_resize"));
        assert!(!json.contains("git_push"));
    }

    #[test]
    fn control_fixture_decodes_and_validates() {
        let fixture: Value = serde_json::from_str(include_str!("../fixtures/v1-conformance.json"))
            .expect("valid conformance fixture");
        let encoded = serde_json::to_vec(&fixture["control_cases"][0]["json"])
            .expect("encode fixture message");
        let message = decode_client_message(&encoded).expect("valid fixture call");
        assert!(matches!(
            message,
            ClientMessage::Call {
                method: RpcMethod::FileRead,
                ..
            }
        ));

        let event: ServerMessage =
            serde_json::from_value(fixture["server_event_cases"][0]["json"].clone())
                .expect("valid server event fixture");
        assert!(matches!(
            event,
            ServerMessage::TerminalInputFault {
                stream_id: 7,
                generation: Some(3),
                code: TerminalInputFaultCode::SessionExited,
                authoritative_through: Some(98_304),
                discard_pending: true,
            }
        ));
        let overloaded: ServerMessage =
            serde_json::from_value(fixture["server_event_cases"][1]["json"].clone())
                .expect("valid overloaded event fixture");
        assert!(matches!(
            overloaded,
            ServerMessage::TerminalInputFault {
                stream_id: 8,
                generation: Some(4),
                code: TerminalInputFaultCode::Overloaded,
                authoritative_through: Some(65_536),
                discard_pending: false,
            }
        ));
    }
}
