use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::{Mutex, OnceLock};

use serde::Serialize;
use tauri::{AppHandle, Manager};

struct ProxyState {
    child: Option<Child>,
    port: u16,
    upstream: String,
}

impl Default for ProxyState {
    fn default() -> Self {
        ProxyState {
            child: None,
            port: 0,
            upstream: String::new(),
        }
    }
}

fn state() -> &'static Mutex<ProxyState> {
    static S: OnceLock<Mutex<ProxyState>> = OnceLock::new();
    S.get_or_init(|| Mutex::new(ProxyState::default()))
}

#[derive(Serialize, Clone)]
pub struct ProxyStatus {
    pub running: bool,
    pub port: u16,
    pub available: bool,
}

fn resolve_proxy_bin(app: &AppHandle) -> Option<PathBuf> {
    let exe = bin_name();

    if let Ok(res) = app.path().resource_dir() {
        for cand in [
            res.join("pv").join(&exe),
            res.join("pv").join("agent-proxy").join(&exe),
        ] {
            if cand.is_file() {
                return Some(cand);
            }
        }
    }

    let crate_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("pv")
        .join("agent-proxy");
    if !crate_dir.join("Cargo.toml").is_file() {
        return None;
    }
    let built = crate_dir.join("target").join("release").join(&exe);
    if built.is_file() {
        return Some(built);
    }
    let ok = Command::new("cargo")
        .args(["build", "--release"])
        .current_dir(&crate_dir)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map(|s| s.success())
        .unwrap_or(false);
    if ok && built.is_file() {
        Some(built)
    } else {
        None
    }
}

fn bin_name() -> String {
    if cfg!(windows) {
        "linco-agent-proxy.exe".into()
    } else {
        "linco-agent-proxy".into()
    }
}

#[tauri::command]
pub fn proxy_available(app: AppHandle) -> bool {
    resolve_proxy_bin(&app).is_some()
}

#[tauri::command]
pub fn proxy_start(app: AppHandle, upstream: String, session: String) -> Option<u16> {
    {
        let st = state().lock().ok()?;
        if st.port != 0 && st.upstream == upstream {
            return Some(st.port);
        }
    }
    proxy_stop_inner();
    // 兜底清理上一个 app 进程可能遗留的同名孤儿(dev 重启 / 上次崩溃未清),
    // 避免多个实例写同一 session 文件导致命令重复。
    kill_stray_proxies();

    let bin = resolve_proxy_bin(&app)?;
    let mut child = Command::new(&bin)
        .env("LINCO_UPSTREAM_BASE_URL", &upstream)
        .env("LINCO_PROXY_PORT", "0")
        .env(
            "LINCO_SESSION_ID",
            if session.is_empty() {
                "default"
            } else {
                &session
            },
        )
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .ok()?;

    let port = read_port_line(&mut child)?;
    {
        let mut st = state().lock().ok()?;
        st.child = Some(child);
        st.port = port;
        st.upstream = upstream;
    }
    Some(port)
}

fn read_port_line(child: &mut Child) -> Option<u16> {
    use std::io::{BufRead, BufReader};
    use std::sync::mpsc;
    use std::time::Duration;
    let stdout = child.stdout.take()?;
    // 在独立线程读首行,带超时:代理正常会立刻打印端口;万一二进制卡住,不能让
    // 启动调用(进而 agent 启动)无限期挂起 —— 超时即放弃(上层据此降级直连)。
    let (tx, rx) = mpsc::channel::<Option<u16>>();
    std::thread::spawn(move || {
        let mut reader = BufReader::new(stdout);
        let mut line = String::new();
        let parsed = if reader.read_line(&mut line).unwrap_or(0) == 0 {
            None
        } else {
            serde_json::from_str::<serde_json::Value>(line.trim())
                .ok()
                .and_then(|v| v.get("port").and_then(|p| p.as_u64()))
                .map(|p| p as u16)
                .filter(|p| *p != 0)
        };
        let _ = tx.send(parsed);
    });
    match rx.recv_timeout(Duration::from_secs(5)) {
        Ok(Some(port)) => Some(port),
        _ => {
            let _ = child.kill();
            None
        }
    }
}

#[tauri::command]
pub fn proxy_stop() {
    proxy_stop_inner();
}

fn proxy_stop_inner() {
    if let Ok(mut st) = state().lock() {
        if let Some(mut c) = st.child.take() {
            let _ = c.kill();
            let _ = c.wait();
        }
        st.port = 0;
        st.upstream = String::new();
    }
}

/// 清理同名孤儿子进程(上次 app 退出/崩溃没清干净的)。仅 Unix;按二进制名匹配。
/// 不影响本进程刚要启动的新实例(此函数在 spawn 之前调用)。
fn kill_stray_proxies() {
    #[cfg(not(windows))]
    {
        let _ = Command::new("pkill")
            .args(["-f", "linco-agent-proxy"])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
    }
}

#[tauri::command]
pub fn proxy_status(app: AppHandle) -> ProxyStatus {
    let (running, port) = state()
        .lock()
        .map(|s| (s.port != 0, s.port))
        .unwrap_or((false, 0));
    ProxyStatus {
        running,
        port,
        available: resolve_proxy_bin(&app).is_some(),
    }
}

#[tauri::command]
pub fn proxy_cmdlog_file(session: String) -> String {
    let dir = std::env::var("LINCO_CMDLOG_DIR")
        .ok()
        .filter(|s| !s.trim().is_empty())
        .map(expand_tilde)
        .unwrap_or_else(|| {
            let home = std::env::var("HOME").unwrap_or_else(|_| ".".into());
            PathBuf::from(home).join(".linco").join("agent-cmdlog")
        });
    let session = if session.is_empty() {
        "default"
    } else {
        &session
    };
    dir.join(session)
        .join("current.jsonl")
        .to_string_lossy()
        .to_string()
}

fn expand_tilde(p: String) -> PathBuf {
    if let Some(rest) = p.strip_prefix("~/") {
        if let Ok(home) = std::env::var("HOME") {
            return PathBuf::from(home).join(rest);
        }
    }
    PathBuf::from(p)
}

/// 新回合:清空本会话命令日志文件(纯回合制,不累积,防存储膨胀)。用户发消息时调。
/// 直接截断文件即可——代理进程的去重表在其内存里不动,下一回合 agent 重发完整历史时,
/// 旧命令因去重表仍记着而不会被重复写入,新文件只装这一回合真正新产生的命令。
#[tauri::command]
pub fn proxy_begin_turn(session: String) {
    let path = proxy_cmdlog_file(session);
    let _ = std::fs::OpenOptions::new()
        .write(true)
        .truncate(true)
        .open(&path);
}
