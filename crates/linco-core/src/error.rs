use std::io;
use std::path::PathBuf;

use thiserror::Error;
use uuid::Uuid;

#[derive(Debug, Error)]
pub enum CoreError {
    #[error("workspace root does not exist or cannot be resolved: {path}")]
    WorkspaceRootUnavailable {
        path: PathBuf,
        #[source]
        source: io::Error,
    },

    #[error("workspace root is not a directory: {0}")]
    WorkspaceRootNotDirectory(PathBuf),

    #[error("workspace path must be relative and may not contain parent traversal: {0}")]
    InvalidWorkspacePath(PathBuf),

    #[error("workspace path escapes the configured root: {0}")]
    WorkspaceEscape(PathBuf),

    #[error("workspace path does not exist or cannot be resolved: {path}")]
    WorkspacePathUnavailable {
        path: PathBuf,
        #[source]
        source: io::Error,
    },

    #[error("workspace path is not a directory: {0}")]
    WorkspacePathNotDirectory(PathBuf),

    #[error("invalid terminal configuration: {0}")]
    InvalidTerminalConfig(&'static str),

    #[error("terminal manager has been shut down")]
    ShuttingDown,

    #[error("terminal generation counter is exhausted")]
    GenerationExhausted,

    #[error("terminal session was not found: {0}")]
    SessionNotFound(Uuid),

    #[error("terminal session identity is already bound to different start parameters: {0}")]
    SessionIdentityConflict(Uuid),

    #[error(
        "terminal generation mismatch for {session_id}: expected {expected}, current {current}"
    )]
    GenerationMismatch {
        session_id: Uuid,
        expected: u64,
        current: u64,
    },

    #[error("terminal session limit reached ({0})")]
    SessionLimit(usize),

    #[error("live terminal process limit reached ({0})")]
    ProcessLimit(usize),

    #[error("terminal subscriber limit reached ({0})")]
    SubscriberLimit(usize),

    #[error("terminal size must have non-zero rows and columns")]
    InvalidTerminalSize,

    #[error("terminal input is {actual} bytes; maximum is {maximum} bytes")]
    TerminalInputTooLarge { actual: usize, maximum: usize },

    #[error("terminal session has exited: {0}")]
    SessionExited(Uuid),

    #[error("shell sessions do not accept agent arguments")]
    ShellArgumentsNotAllowed,

    #[error("invalid environment variable name or value")]
    InvalidEnvironment,

    #[error("PTY operation {operation} failed: {message}")]
    Pty {
        operation: &'static str,
        message: String,
    },

    #[error("I/O operation {operation} failed")]
    Io {
        operation: &'static str,
        #[source]
        source: io::Error,
    },

    #[error(transparent)]
    Replay(#[from] RingReplayError),
}

#[derive(Debug, Clone, PartialEq, Eq, Error)]
pub enum RingReplayError {
    #[error(
        "requested offset {requested} has expired; available range is {available_from}..{available_to}"
    )]
    Gap {
        requested: u64,
        available_from: u64,
        available_to: u64,
    },

    #[error("requested offset {requested} is beyond stream end {end}")]
    FutureOffset { requested: u64, end: u64 },

    #[error("terminal stream offset overflow")]
    OffsetOverflow,
}
