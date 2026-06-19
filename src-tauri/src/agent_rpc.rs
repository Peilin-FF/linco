// 远程助手进程的 RPC 客户端(借鉴 VS Code Remote 的"远端常驻 + RPC")。
//
// 思路:不再每个远程操作起一个 ssh 跑 shell,而是在远端常驻一个 Python 助手进程
// (linco_agent.py),通过一条持久 ssh 管道跑 JSON-RPC。每个操作 = 一条消息往返。
//
// 架构(支持 agent 主动推送,如文件变更事件):
// 每个 host 会话起一个**常驻 reader 线程**独占 stdout,按行读:
//   - 有 id 的 = RPC 响应 → 投递给等待该 id 的 call(pending 表 + channel)
//   - 有 event 的 = agent 主动推送(如 fileChange)→ app.emit 给前端
// call() 注册一个 id 的应答 channel、写请求、等该 channel(带超时)。
// 这样 agent 任何时刻推送都能被收到(不必有 RPC 在等)。
//
// 任何环节失败 → call 返回 Err,上层回退到 remote.rs 的 shell 实现,保证永不崩。

use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{sync_channel, SyncSender};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

use base64::engine::general_purpose::STANDARD as B64;
use base64::Engine;
use serde::Serialize;
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter};

use crate::remote::{shq, ssh_opts};

const AGENT_VERSION: &str = "3";
const AGENT_SRC: &str = include_str!("agent/linco_agent.py");
const RPC_TIMEOUT: Duration = Duration::from_secs(45);
static SEQ: AtomicU64 = AtomicU64::new(1);

// 全局 AppHandle(在 lib.rs setup 时存入),供 reader 线程 emit 推送事件。
static APP: OnceLock<AppHandle> = OnceLock::new();
pub fn set_app(app: AppHandle) {
    let _ = APP.set(app);
}

#[derive(Clone, Serialize)]
struct FsChangeEvent {
    host: String,
    paths: Vec<String>,
}

/// 是否禁用 agent(强制走 shell):调试/排障用。
pub fn agent_enabled() -> bool {
    std::env::var("LINCO_NO_AGENT").is_err()
}

type Pending = Arc<Mutex<HashMap<u64, SyncSender<Result<Value, String>>>>>;

struct AgentSession {
    child: Child,
    stdin: ChildStdin,
    pending: Pending,
    // reader 线程句柄(会话 Drop 时随 child 被杀而自然结束)
    _reader: std::thread::JoinHandle<()>,
}

impl Drop for AgentSession {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
        // 唤醒所有还在等的 call(管道已断)
        if let Ok(mut p) = self.pending.lock() {
            for (_, tx) in p.drain() {
                let _ = tx.send(Err("agent EOF".into()));
            }
        }
    }
}

type Handle = Arc<Mutex<Option<AgentSession>>>;
static SESSIONS: OnceLock<Mutex<HashMap<String, Handle>>> = OnceLock::new();

fn sessions() -> &'static Mutex<HashMap<String, Handle>> {
    SESSIONS.get_or_init(|| Mutex::new(HashMap::new()))
}

fn host_handle(host: &str) -> Handle {
    let mut map = sessions().lock().unwrap_or_else(|e| e.into_inner());
    map.entry(host.to_string())
        .or_insert_with(|| Arc::new(Mutex::new(None)))
        .clone()
}

/// 关闭某 host 的 agent 会话(ssh_disconnect 时调用)。
pub fn drop_session(host: &str) {
    if let Ok(mut map) = sessions().lock() {
        map.remove(host);
    }
}

/// 把 agent 脚本推到远端 ~/.linco/linco_agent.py(版本不符才重推),返回远端路径。
fn ensure_script(host: &str) -> Result<String, String> {
    let b64 = B64.encode(AGENT_SRC.as_bytes());
    let script = format!(
        "d=\"$HOME/.linco\"; mkdir -p \"$d\"; \
         if [ \"$(cat \"$d/agent.version\" 2>/dev/null)\" != {ver} ]; then \
           base64 -d > \"$d/linco_agent.py\" <<'__LINCO_AGENT_B64__'\n{b64}\n__LINCO_AGENT_B64__\n \
           printf %s {ver} > \"$d/agent.version\"; \
         fi; \
         printf '%s/linco_agent.py' \"$d\"",
        ver = shq(AGENT_VERSION),
        b64 = b64,
    );
    let out = crate::remote::run_remote_oneshot_pub(host, &script, None)?;
    let path = String::from_utf8_lossy(&out).trim().to_string();
    if path.is_empty() {
        return Err("无法部署 agent 脚本".into());
    }
    Ok(path)
}

/// reader 线程:独占 stdout,分流响应与推送。
fn reader_loop(
    host: String,
    mut stdout: BufReader<ChildStdout>,
    pending: Pending,
) {
    let mut line = String::new();
    loop {
        line.clear();
        match stdout.read_line(&mut line) {
            Ok(0) | Err(_) => break, // EOF / IO 错 → 会话结束
            Ok(_) => {}
        }
        let v: Value = match serde_json::from_str(line.trim()) {
            Ok(v) => v,
            Err(_) => continue, // 噪声行(MOTD 等)
        };
        // 主动推送(无 id,带 event)
        if let Some(ev) = v.get("event").and_then(|e| e.as_str()) {
            if ev == "fileChange" {
                let paths: Vec<String> = v
                    .get("paths")
                    .and_then(|p| p.as_array())
                    .map(|a| a.iter().filter_map(|x| x.as_str().map(String::from)).collect())
                    .unwrap_or_default();
                if let Some(app) = APP.get() {
                    let _ = app.emit(
                        "remote-fs-change",
                        FsChangeEvent { host: host.clone(), paths },
                    );
                }
            }
            continue;
        }
        // RPC 响应:按 id 投递
        if let Some(id) = v.get("id").and_then(|x| x.as_u64()) {
            let tx = pending.lock().ok().and_then(|mut p| p.remove(&id));
            if let Some(tx) = tx {
                let payload = if v.get("ok").and_then(|x| x.as_bool()).unwrap_or(false) {
                    Ok(v.get("result").cloned().unwrap_or(Value::Null))
                } else {
                    Err(v
                        .get("error")
                        .and_then(|x| x.as_str())
                        .unwrap_or("agent 错误")
                        .to_string())
                };
                let _ = tx.send(payload);
            }
        }
    }
    // 线程退出:唤醒所有等待者
    if let Ok(mut p) = pending.lock() {
        for (_, tx) in p.drain() {
            let _ = tx.send(Err("agent EOF".into()));
        }
    }
}

/// 启动 agent 会话:ssh host "python3 <脚本>",起 reader 线程,握手 ping。
fn spawn_session(host: &str) -> Result<AgentSession, String> {
    let script_path = ensure_script(host)?;
    let mut cmd = Command::new("ssh");
    cmd.args(ssh_opts());
    cmd.arg("-o").arg("BatchMode=yes");
    cmd.arg(host);
    cmd.arg(format!(
        "exec python3 {p} 2>/dev/null || exec python {p}",
        p = shq(&script_path)
    ));
    cmd.stdin(Stdio::piped());
    cmd.stdout(Stdio::piped());
    cmd.stderr(Stdio::null());
    let mut child = cmd.spawn().map_err(|e| format!("agent 启动失败: {e}"))?;
    let stdin = child.stdin.take().ok_or("无 stdin")?;
    let stdout = BufReader::new(child.stdout.take().ok_or("无 stdout")?);

    let pending: Pending = Arc::new(Mutex::new(HashMap::new()));
    let host_owned = host.to_string();
    let pending_r = Arc::clone(&pending);
    let reader = std::thread::spawn(move || reader_loop(host_owned, stdout, pending_r));

    let mut sess = AgentSession {
        child,
        stdin,
        pending,
        _reader: reader,
    };
    // 握手:ping → pong
    let resp = rpc_on(&mut sess, "ping", json!({}), Duration::from_secs(15))
        .map_err(|e| format!("agent 握手失败: {e}"))?;
    if !resp.get("pong").and_then(|v| v.as_bool()).unwrap_or(false) {
        return Err("agent 握手响应异常".into());
    }
    Ok(sess)
}

/// 在给定会话上发一次 RPC:注册 id 的应答 channel,写请求,等 channel(超时)。
fn rpc_on(
    sess: &mut AgentSession,
    op: &str,
    args: Value,
    timeout: Duration,
) -> Result<Value, String> {
    let id = SEQ.fetch_add(1, Ordering::Relaxed);
    let req = json!({"id": id, "op": op, "args": args});
    let line = serde_json::to_string(&req).map_err(|e| e.to_string())? + "\n";

    let (tx, rx) = sync_channel::<Result<Value, String>>(1);
    {
        let mut p = sess.pending.lock().map_err(|e| e.to_string())?;
        p.insert(id, tx);
    }
    // 写请求
    if let Err(e) = sess
        .stdin
        .write_all(line.as_bytes())
        .and_then(|_| sess.stdin.flush())
    {
        sess.pending.lock().ok().map(|mut p| p.remove(&id));
        return Err(e.to_string());
    }
    // 等应答
    match rx.recv_timeout(timeout) {
        Ok(res) => res,
        Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {
            sess.pending.lock().ok().map(|mut p| p.remove(&id));
            Err("agent 超时".into())
        }
        Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => Err("agent EOF".into()),
    }
}

/// 对某 host 发一次 RPC。懒建会话,断线重连重试一次。
pub fn call(host: &str, op: &str, args: Value) -> Result<Value, String> {
    if !agent_enabled() {
        return Err("agent disabled".into());
    }
    let handle = host_handle(host);
    let mut guard = handle.lock().unwrap_or_else(|e| e.into_inner());
    for attempt in 0..2 {
        if guard.is_none() {
            match spawn_session(host) {
                Ok(s) => *guard = Some(s),
                Err(e) => return Err(e),
            }
        }
        let sess = guard.as_mut().unwrap();
        match rpc_on(sess, op, args.clone(), RPC_TIMEOUT) {
            Ok(v) => return Ok(v),
            Err(e) => {
                // 会话级失败(EOF/超时/IO)→ 丢弃重连;业务错(ok:false)→ 直接返回
                if e == "agent EOF" || e == "agent 超时" || e.contains("Broken pipe") || e.contains("os error") {
                    *guard = None;
                    if attempt == 1 {
                        return Err("agent 会话不可用".into());
                    }
                    continue;
                }
                return Err(e);
            }
        }
    }
    unreachable!()
}

/// 开始监听某 host 工作目录(agent watch op)。事件经 reader 线程 emit remote-fs-change。
pub fn watch(host: &str, root: &str) -> Result<(), String> {
    call(host, "watch", json!({ "root": root })).map(|_| ())
}

/// 停止监听。
pub fn unwatch(host: &str) -> Result<(), String> {
    call(host, "unwatch", json!({})).map(|_| ())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::{Command, Stdio};

    // 用本地 python3 跑 agent 脚本,验证 RPC 往返(无需远程)。起 reader 线程。
    fn local_agent() -> AgentSession {
        let tmp = std::env::temp_dir().join("linco_agent_test.py");
        std::fs::write(&tmp, AGENT_SRC).unwrap();
        let mut child = Command::new("python3")
            .arg(&tmp)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .expect("spawn python3 agent");
        let stdin = child.stdin.take().unwrap();
        let stdout = BufReader::new(child.stdout.take().unwrap());
        let pending: Pending = Arc::new(Mutex::new(HashMap::new()));
        let pending_r = Arc::clone(&pending);
        let reader =
            std::thread::spawn(move || reader_loop("test".to_string(), stdout, pending_r));
        AgentSession {
            child,
            stdin,
            pending,
            _reader: reader,
        }
    }

    #[test]
    fn rpc_ping_and_readdir() {
        let mut s = local_agent();
        let pong = rpc_on(&mut s, "ping", json!({}), Duration::from_secs(5)).unwrap();
        assert_eq!(pong.get("pong").and_then(|v| v.as_bool()), Some(true));

        let dir = std::env::temp_dir().join("linco_rpc_test");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("x.txt"), "hi").unwrap();
        let r = rpc_on(
            &mut s,
            "readdir",
            json!({ "path": dir.to_string_lossy() }),
            Duration::from_secs(5),
        )
        .unwrap();
        let entries = r.get("entries").and_then(|v| v.as_array()).unwrap();
        assert!(entries.iter().any(|e| e.get("name").and_then(|n| n.as_str()) == Some("x.txt")));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn rpc_business_error_not_session_error() {
        let mut s = local_agent();
        // 读不存在的文件 → agent 返回 ok:false,rpc_on 返回 Err(业务错)
        let r = rpc_on(
            &mut s,
            "read_file",
            json!({ "path": "/nonexistent/zzz.txt" }),
            Duration::from_secs(5),
        );
        assert!(r.is_err());
        // 会话仍可用:再发一次 ping 成功
        let pong = rpc_on(&mut s, "ping", json!({}), Duration::from_secs(5)).unwrap();
        assert_eq!(pong.get("pong").and_then(|v| v.as_bool()), Some(true));
    }

    #[test]
    fn rpc_bytes_roundtrip() {
        let mut s = local_agent();
        let dir = std::env::temp_dir().join("linco_rpc_bytes");
        std::fs::create_dir_all(&dir).unwrap();
        let p = dir.join("b.bin");
        let raw = [0u8, 1, 255, 65, 66, 67];
        rpc_on(
            &mut s,
            "write_bytes",
            json!({ "path": p.to_string_lossy(), "b64": B64.encode(raw) }),
            Duration::from_secs(5),
        )
        .unwrap();
        let r = rpc_on(
            &mut s,
            "read_bytes",
            json!({ "path": p.to_string_lossy() }),
            Duration::from_secs(5),
        )
        .unwrap();
        let b64 = r.get("b64").and_then(|v| v.as_str()).unwrap();
        assert_eq!(B64.decode(b64).unwrap(), raw);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
