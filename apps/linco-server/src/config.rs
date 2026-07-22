use std::{
    net::{IpAddr, SocketAddr},
    path::{Path, PathBuf},
    time::Duration,
};

use anyhow::{bail, Context};
use http::Uri;

use crate::{cli::Cli, workspace::WorkspaceSpec};

#[derive(Debug, Clone)]
pub struct TerminalConfig {
    pub replay_bytes: usize,
    pub outbound_queue: usize,
}

#[derive(Debug, Clone)]
pub struct ServerConfig {
    pub listen: SocketAddr,
    pub public_url: String,
    pub state_dir: PathBuf,
    pub workspaces: Vec<WorkspaceSpec>,
    pub terminal: TerminalConfig,
    pub control_queue: usize,
    pub max_inflight_calls: usize,
    pub http_ticket_ttl: Duration,
    pub max_upload_bytes: u64,
}

impl ServerConfig {
    pub fn from_cli(cli: &Cli) -> anyhow::Result<Self> {
        if !cli.listen.ip().is_loopback() && !cli.allow_insecure_listen {
            bail!(
                "refusing plaintext non-loopback listener {}; bind loopback behind TLS or pass --allow-insecure-listen for an encrypted private overlay",
                cli.listen
            );
        }

        let public_url = parse_public_origin(&cli.public_url)?;

        let state_dir = match &cli.state_dir {
            Some(path) => path.clone(),
            None => default_state_dir()?,
        };
        std::fs::create_dir_all(&state_dir)
            .with_context(|| format!("create state directory {}", state_dir.display()))?;
        secure_dir(&state_dir)?;

        let workspaces = cli
            .workspaces
            .iter()
            .map(|raw| WorkspaceSpec::parse(raw))
            .collect::<anyhow::Result<Vec<_>>>()?;

        Ok(Self {
            listen: cli.listen,
            public_url,
            state_dir,
            workspaces,
            terminal: TerminalConfig {
                replay_bytes: 1024 * 1024,
                // Output gaps are replayed from the ring or replaced by a snapshot. A shallow
                // queue limits bufferbloat while preserving correctness under slow mobile links.
                outbound_queue: 32,
            },
            control_queue: 128,
            max_inflight_calls: 32,
            http_ticket_ttl: Duration::from_secs(5 * 60),
            max_upload_bytes: 8 * 1024 * 1024,
        })
    }
}

fn parse_public_origin(raw: &str) -> anyhow::Result<String> {
    // `http::Uri` intentionally models the HTTP request target and discards URI fragments, so
    // reject a fragment delimiter before structured parsing instead of silently normalizing it.
    if raw.contains('#') {
        bail!("--public-url must be an origin without a fragment");
    }
    let parsed = raw
        .parse::<Uri>()
        .context("--public-url is not a valid absolute URL")?;
    let scheme = parsed
        .scheme_str()
        .context("--public-url must contain a URL scheme")?;
    let authority = parsed
        .authority()
        .context("--public-url must contain a network authority")?;
    if authority.as_str().contains('@') {
        bail!("--public-url must not contain credentials");
    }
    if parsed.query().is_some() || !matches!(parsed.path(), "" | "/") {
        bail!("--public-url must be an origin without path, query, or fragment");
    }

    match scheme {
        "https" => {}
        "http" if host_is_ip_loopback(authority.host()) => {}
        "http" => bail!("plaintext --public-url is allowed only for an IP loopback origin"),
        _ => bail!("--public-url must use https:// (IP loopback http is allowed for development)"),
    }

    Ok(format!("{scheme}://{authority}"))
}

fn host_is_ip_loopback(host: &str) -> bool {
    host.trim_start_matches('[')
        .trim_end_matches(']')
        .parse::<IpAddr>()
        .is_ok_and(|address| address.is_loopback())
}

fn default_state_dir() -> anyhow::Result<PathBuf> {
    if let Some(path) = std::env::var_os("XDG_STATE_HOME") {
        return Ok(PathBuf::from(path).join("linco-server"));
    }
    let home = std::env::var_os("HOME").context("HOME is not set; pass --state-dir")?;
    Ok(PathBuf::from(home)
        .join(".local")
        .join("state")
        .join("linco-server"))
}

fn secure_dir(_path: &Path) -> anyhow::Result<()> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(_path, std::fs::Permissions::from_mode(0o700))
            .with_context(|| format!("chmod 0700 {}", _path.display()))?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::cli::LogFormat;

    fn cli(state_dir: PathBuf) -> Cli {
        Cli {
            state_dir: Some(state_dir),
            listen: "127.0.0.1:7337".parse().unwrap(),
            public_url: "http://127.0.0.1:7337".into(),
            allow_insecure_listen: false,
            workspaces: Vec::new(),
            log_format: LogFormat::Pretty,
            command: None,
        }
    }

    #[test]
    fn refuses_public_plaintext_listener() {
        let tmp = tempfile::tempdir().unwrap();
        let mut value = cli(tmp.path().to_owned());
        value.listen = "0.0.0.0:7337".parse().unwrap();
        assert!(ServerConfig::from_cli(&value).is_err());
    }

    #[test]
    fn accepts_loopback_development_url() {
        let tmp = tempfile::tempdir().unwrap();
        let config = ServerConfig::from_cli(&cli(tmp.path().to_owned())).unwrap();
        assert_eq!(config.max_upload_bytes, 8 * 1024 * 1024);
        assert_eq!(config.terminal.outbound_queue, 32);
    }

    #[test]
    fn accepts_https_origin_and_ipv6_loopback_development_origin() {
        assert_eq!(
            parse_public_origin("https://linco.example:8443/").unwrap(),
            "https://linco.example:8443"
        );
        assert_eq!(
            parse_public_origin("http://[::1]:7337").unwrap(),
            "http://[::1]:7337"
        );
    }

    #[test]
    fn rejects_lookalike_and_non_ip_plaintext_hosts() {
        for value in [
            "http://127.0.0.1.evil.com",
            "http://127.0.0.1.example",
            "http://localhost:7337",
            "http://0.0.0.0:7337",
            "http://192.168.1.2:7337",
        ] {
            assert!(parse_public_origin(value).is_err(), "accepted {value}");
        }
    }

    #[test]
    fn rejects_credentials_query_fragment_and_non_root_path() {
        for value in [
            "https://user@example.com",
            "https://@example.com",
            "https://:password@example.com",
            "https://example.com/path",
            "https://example.com/?query=1",
            "https://example.com/#fragment",
            "https://example.com//",
            "https://example.com/%2F",
        ] {
            assert!(parse_public_origin(value).is_err(), "accepted {value}");
        }
    }
}
