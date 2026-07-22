pub mod auth;
pub mod cli;
pub mod config;
pub mod http;
pub mod state;
pub mod terminal_backend;
pub mod tickets;
pub mod workspace;
pub mod ws;

use std::sync::Arc;

use anyhow::Context;
use axum::serve::ListenerExt;
use cli::{Cli, Command};
use config::ServerConfig;
use state::AppState;

pub async fn run(cli: Cli) -> anyhow::Result<()> {
    let config = ServerConfig::from_cli(&cli)?;
    let auth = auth::AuthStore::open(config.state_dir.join("auth.db")).await?;

    match cli.command.unwrap_or(Command::Serve) {
        Command::Pair { ttl_seconds } => {
            let bundle = auth.create_pairing(&config.public_url, ttl_seconds).await?;
            println!("{}", serde_json::to_string_pretty(&bundle)?);
            println!();
            println!("{}", auth::render_pairing_qr(&bundle)?);
            return Ok(());
        }
        Command::Devices => {
            for device in auth.list_devices().await? {
                println!(
                    "{}\t{}\t{}\t{}",
                    device.id,
                    if device.revoked { "revoked" } else { "active" },
                    device.name,
                    device.permissions.join(",")
                );
            }
            return Ok(());
        }
        Command::Revoke { device_id } => {
            auth.revoke_device(device_id).await?;
            println!("revoked {device_id}");
            return Ok(());
        }
        Command::Serve => {}
    }

    let workspaces = workspace::WorkspaceRegistry::new(&config.workspaces)?;
    let terminal = terminal_backend::CoreTerminalBackend::new(config.terminal.clone())
        .context("initialize terminal backend")?;
    let state = Arc::new(AppState::new(config.clone(), auth, workspaces, terminal));
    let app = http::router(Arc::clone(&state));

    let listener = tokio::net::TcpListener::bind(config.listen)
        .await
        .with_context(|| format!("bind {}", config.listen))?;
    let listener = listener.tap_io(|stream| {
        if let Err(error) = stream.set_nodelay(true) {
            tracing::debug!(error = %error, "could not enable TCP_NODELAY");
        }
    });
    tracing::info!(listen = %config.listen, "linco-server ready");

    axum::serve(listener, app)
        .with_graceful_shutdown(shutdown_signal())
        .await
        .context("HTTP server")?;
    state.shutdown().await;
    Ok(())
}

async fn shutdown_signal() {
    let ctrl_c = async {
        tokio::signal::ctrl_c()
            .await
            .expect("install Ctrl-C handler");
    };

    #[cfg(unix)]
    let terminate = async {
        tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
            .expect("install SIGTERM handler")
            .recv()
            .await;
    };
    #[cfg(not(unix))]
    let terminate = std::future::pending::<()>();

    tokio::select! {
        () = ctrl_c => {},
        () = terminate => {},
    }
    tracing::info!("shutdown requested");
}
