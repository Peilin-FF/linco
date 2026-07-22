//! Transport- and UI-independent runtime primitives used by `linco-server`.
//!
//! This crate deliberately knows nothing about Tauri, SSH, HTTP or WebSockets. Terminal output is
//! drained from the PTY for the lifetime of the child process and retained in a bounded byte ring;
//! network adapters may subscribe to best-effort live events and recover gaps by absolute offset.

mod error;
mod ring;
mod terminal;
mod workspace;

pub use error::{CoreError, RingReplayError};
pub use linco_protocol::SessionKind;
pub use ring::{ByteRing, RingRange, RingReplay};
pub use terminal::{
    SessionExit, TerminalConfig, TerminalEvent, TerminalManager, TerminalReplay,
    TerminalSessionInfo, TerminalSessionState, TerminalSize, TerminalStart, TerminalSubscription,
    TerminalSubscriptionFilter,
};
pub use workspace::WorkspaceRoot;
