use anyhow::Context;
use clap::Parser;
use linco_server::{cli::Cli, run};

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let cli = Cli::parse();
    init_tracing(cli.log_format);
    run(cli).await.context("linco-server failed")
}

fn init_tracing(format: linco_server::cli::LogFormat) {
    let filter = tracing_subscriber::EnvFilter::try_from_default_env()
        .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("linco_server=info"));
    let builder = tracing_subscriber::fmt().with_env_filter(filter);
    match format {
        linco_server::cli::LogFormat::Pretty => builder.init(),
        linco_server::cli::LogFormat::Json => builder.json().init(),
    }
}
