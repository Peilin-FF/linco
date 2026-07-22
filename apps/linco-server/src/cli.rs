use std::{net::SocketAddr, path::PathBuf};

use clap::{Parser, Subcommand, ValueEnum};
use uuid::Uuid;

#[derive(Debug, Clone, Copy, ValueEnum)]
pub enum LogFormat {
    Pretty,
    Json,
}

#[derive(Debug, Parser)]
#[command(name = "linco-server", version, about)]
pub struct Cli {
    /// Persistent state directory. The auth database and server identity live here.
    #[arg(long, env = "LINCO_STATE_DIR")]
    pub state_dir: Option<PathBuf>,

    /// Plain HTTP listen address. Keep loopback unless TLS is terminated by a trusted proxy.
    #[arg(long, env = "LINCO_LISTEN", default_value = "127.0.0.1:7337")]
    pub listen: SocketAddr,

    /// Externally reachable HTTPS base URL encoded into pairing payloads.
    #[arg(
        long,
        env = "LINCO_PUBLIC_URL",
        default_value = "http://127.0.0.1:7337"
    )]
    pub public_url: String,

    /// Permit a plaintext listener on a non-loopback address. Intended only for an encrypted
    /// private overlay; public deployments should terminate TLS in Caddy/Tailscale Serve.
    #[arg(long, env = "LINCO_ALLOW_INSECURE_LISTEN", default_value_t = false)]
    pub allow_insecure_listen: bool,

    /// Workspace mapping in NAME=/absolute/path form. Repeat for multiple workspaces.
    #[arg(long = "workspace", env = "LINCO_WORKSPACES", value_delimiter = ';')]
    pub workspaces: Vec<String>,

    #[arg(long, value_enum, env = "LINCO_LOG_FORMAT", default_value = "pretty")]
    pub log_format: LogFormat,

    #[command(subcommand)]
    pub command: Option<Command>,
}

#[derive(Debug, Clone, Subcommand)]
pub enum Command {
    /// Run the headless daemon (the default command).
    Serve,
    /// Create a single-use pairing QR payload.
    Pair {
        #[arg(long, default_value_t = 120, value_parser = clap::value_parser!(u64).range(30..=120))]
        ttl_seconds: u64,
    },
    /// List paired devices without exposing their public keys.
    Devices,
    /// Revoke a paired device; active lanes and capabilities are cut off within five seconds.
    Revoke { device_id: Uuid },
}
