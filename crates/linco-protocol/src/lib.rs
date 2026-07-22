//! Stable protocol contract between `linco-server` and native Linco clients.
//!
//! The protocol uses one control WebSocket for small JSON messages and one isolated interactive
//! WebSocket for raw terminal bytes. Files and preview assets use authenticated HTTP Range/ETag,
//! keeping bulk traffic out of the latency-sensitive sockets. No base64 is used on the hot path.

mod binary;
mod control;
mod dto;
mod transcript;

pub use binary::{
    BinaryDecodeError, BinaryFrame, BinaryFrameHeader, BinaryKind, LogicalChannel,
    BINARY_HEADER_LEN,
};
pub use control::{
    decode_client_message, encode_server_message, ClientMessage, ConnectionPath,
    ControlDecodeError, ErrorCode, KeyAlgorithm, LaneTicket, MethodPolicy, PairingPayload,
    Permission, ResumeCursor, RpcMethod, ServerMessage, SessionKind, SessionState,
    TerminalInputFaultCode, PROTOCOL_VERSION,
};
pub use dto::{
    DtoValidationError, EmptyParams, FileEntry, FileKind, FileListRequest, FileListResponse,
    FileReadResponse, FileWriteRequest, FileWriteResponse, HttpAuthorizationScheme,
    HttpUploadMethod, PreviewResolveResponse, SessionGenerationRequest, SessionListResponse,
    SessionResumeResponse, SessionStartRequest, SessionStopResponse, SessionSummary,
    SystemInfoResponse, TerminalCursorRequest, TerminalDetachRequest, TerminalDetachResponse,
    TerminalResizeRequest, TerminalResizeResponse, WorkspaceListResponse, WorkspacePathRequest,
    WorkspaceSummary, FILE_LIST_DEFAULT_LIMIT, FILE_LIST_MAX_LIMIT,
};
pub use transcript::{
    authentication_transcript, pairing_transcript, server_hello_transcript, TranscriptError,
    AUTH_CHALLENGE_BYTES, AUTH_CLIENT_NONCE_BYTES, PAIRING_CHALLENGE_BYTES,
    PAIRING_CLIENT_NONCE_BYTES, PAIRING_DEVICE_PUBLIC_KEY_BYTES, PAIRING_SECRET_BYTES,
    SERVER_HELLO_SIGNATURE_BYTES, SERVER_IDENTITY_PUBLIC_KEY_BYTES,
};

/// Control traffic must remain small so a malformed client cannot use JSON as a bulk channel.
pub const MAX_CONTROL_MESSAGE_BYTES: usize = 64 * 1024;

/// Prevent stale calls from living forever in a reconnecting client queue.
pub const MAX_CALL_DEADLINE_MS: u64 = 60_000;
