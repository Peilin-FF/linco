// 远程助手进程的 RPC 客户端(借鉴 VS Code Remote 的"远端常驻 + RPC")。
//
// 思路:不再每个远程操作起一个 ssh 跑 shell,而是在远端常驻一个 Python 助手进程
// (linco_agent.py),通过一条持久 ssh 管道跑 JSON-RPC。每个操作 = 一条消息往返,
// 省掉每次"起 shell + 临时文件 + base64"的开销。
//
// 会话生命周期沿用 remote.rs 的模式(按 host 的 Mutex<Option<Session>>、看门狗超时、
// 断线重连一次、Drop 杀进程)。任何环节失败 → 返回 Err,上层回退到 remote.rs 的
// shell 实现,保证永不崩。
//
// 协议:stdin 写一行请求 JSON,stdout 读一行响应 JSON(见 linco_agent.py)。

use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

use base64::engine::general_purpose::STANDARD as B64;
use base64::Engine;
use serde_json::{json, Value};

use crate::remote::{shq, ssh_opts};

const AGENT_VERSION: &str = "1";
const AGENT_SRC: &str = include_str!("agent/linco_agent.py");
const RPC_TIMEOUT: Duration = Duration::from_secs(45);
static SEQ: AtomicU64 = AtomicU64::new(1);

/// 是否禁用 agent(强制走 shell):调试/排障用。
pub fn agent_enabled() -> bool {
    std::env::var("LINCO_NO_AGENT").is_err()
}

struct AgentSession {
    child: Child,
    stdin: ChildStdin,
    stdout: BufReader<ChildStdout>,
}

impl Drop for AgentSession {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
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

// 用 libc kill 打断看门狗超时下的阻塞读(与 remote.rs 同法)。
unsafe fn libc_kill(pid: u32) {
    extern "C" {
        fn kill(pid: i32, sig: i32) -> i32;
    }
    kill(pid as i32, 9);
}

/// 把 agent 脚本推到远端 ~/.linco/linco_agent.py(版本不符才重推),返回远端路径。
/// 用一次性 ssh 完成(只在首次/升级时发生,不在热路径)。
fn ensure_script(host: &str) -> Result<String, String> {
    // 远端目标:$HOME/.linco/linco_agent.py;用版本标记文件判断是否需要重推。
    let b64 = B64.encode(AGENT_SRC.as_bytes());
    // 一条命令:确保目录;若版本文件不符则用 base64 写入脚本与版本。返回脚本绝对路径。
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

/// 启动 agent 会话:ssh host "python3 <脚本>",握手 ping。
fn spawn_session(host: &str) -> Result<AgentSession, String> {
    let script_path = ensure_script(host)?;
    let mut cmd = Command::new("ssh");
    cmd.args(ssh_opts());
    cmd.arg("-o").arg("BatchMode=yes");
    cmd.arg(host);
    // python3 优先,回退 python
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
    let mut sess = AgentSession { child, stdin, stdout };
    // 握手:ping → pong + 版本匹配
    let resp = rpc_on(&mut sess, "ping", json!({}), Duration::from_secs(15))
        .map_err(|e| format!("agent 握手失败: {e}"))?;
    let ok = resp.get("pong").and_then(|v| v.as_bool()).unwrap_or(false);
    if !ok {
        return Err("agent 握手响应异常".into());
    }
    Ok(sess)
}

/// 在给定会话上发一次 RPC:写一行请求,读一行响应。看门狗超时杀进程打断阻塞读。
/// 成功返回 result 对象;agent 报错返回 Err(error 文本)。
fn rpc_on(
    sess: &mut AgentSession,
    op: &str,
    args: Value,
    timeout: Duration,
) -> Result<Value, String> {
    let id = SEQ.fetch_add(1, Ordering::Relaxed);
    let req = json!({"id": id, "op": op, "args": args});
    let line = serde_json::to_string(&req).map_err(|e| e.to_string())? + "\n";

    let deadline = Instant::now() + timeout;
    let pid = sess.child.id();
    let done = Arc::new(AtomicBool::new(false));
    let done_wd = Arc::clone(&done);
    let watchdog = std::thread::spawn(move || {
        while Instant::now() < deadline {
            if done_wd.load(Ordering::Relaxed) {
                return;
            }
            std::thread::sleep(Duration::from_millis(50));
        }
        if !done_wd.load(Ordering::Relaxed) {
            unsafe { libc_kill(pid) }
        }
    });

    let res = (|| -> Result<Value, String> {
        sess.stdin
            .write_all(line.as_bytes())
            .map_err(|e| e.to_string())?;
        sess.stdin.flush().map_err(|e| e.to_string())?;
        // 读到匹配 id 的响应(跳过 event 推送行与不匹配的 id)
        let mut buf = String::new();
        loop {
            buf.clear();
            let n = sess.stdout.read_line(&mut buf).map_err(|e| e.to_string())?;
            if n == 0 {
                return Err("agent EOF".into());
            }
            let v: Value = match serde_json::from_str(buf.trim()) {
                Ok(v) => v,
                Err(_) => continue, // 噪声行,跳过
            };
            // 推送事件(无 id)交给事件分流,这里跳过(阶段1再接 emit)
            if v.get("event").is_some() {
                continue;
            }
            match v.get("id").and_then(|x| x.as_u64()) {
                Some(rid) if rid == id => {
                    if v.get("ok").and_then(|x| x.as_bool()).unwrap_or(false) {
                        return Ok(v.get("result").cloned().unwrap_or(Value::Null));
                    }
                    let err = v
                        .get("error")
                        .and_then(|x| x.as_str())
                        .unwrap_or("agent 错误")
                        .to_string();
                    return Err(err);
                }
                _ => continue, // 不匹配的 id,跳过
            }
        }
    })();

    done.store(true, Ordering::Relaxed);
    let _ = watchdog.join();
    res
}

/// 对某 host 发一次 RPC。懒建会话,断线重连重试一次。
/// 区分两类错误:
///  - 会话级失败(起不来/EOF/超时)→ Err,上层回退 shell。
///  - 业务级失败(agent 返回 ok:false,如"文件过大")→ 也 Err,但语义等同 shell 出错。
/// 上层用 `try_call(...).or_else(|_| shell实现())` 即可。
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
                // 区分:EOF/IO/超时 = 会话坏,丢弃重连;其它 = 业务错,直接返回
                if e == "agent EOF" || e.contains("Broken pipe") || e.contains("os error") {
                    *guard = None;
                    if attempt == 1 {
                        return Err("agent 会话不可用".into());
                    }
                    continue;
                }
                return Err(e); // 业务错(ok:false),不重试
            }
        }
    }
    unreachable!()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::{Command, Stdio};

    // 用本地 python3 跑 agent 脚本,验证 RPC 往返(无需远程)。
    fn local_agent() -> AgentSession {
        // 把内嵌脚本写到临时文件再跑
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
        AgentSession { child, stdin, stdout }
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
