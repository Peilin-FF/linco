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

const AGENT_VERSION: &str = "19";
const AGENT_SRC: &str = include_str!("agent/linco_agent.py");
const RPC_TIMEOUT: Duration = Duration::from_secs(45);
static SEQ: AtomicU64 = AtomicU64::new(1);
// 会话代号:每次 spawn 自增,用于「失败丢弃」时判断当前会话是否仍是发起调用的那个,
// 避免误杀已被另一线程重建的新会话。
static SESSION_SEQ: AtomicU64 = AtomicU64::new(1);

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

#[derive(Clone, Copy, Debug, Eq, PartialEq, Hash)]
enum RpcLane {
    Interactive,
    Background,
    Preview,
}

impl RpcLane {
    fn as_str(self) -> &'static str {
        match self {
            RpcLane::Interactive => "interactive",
            RpcLane::Background => "background",
            RpcLane::Preview => "preview",
        }
    }
}

struct AgentSession {
    child: Child,
    // stdin 单独加锁:多个并发 call 只在「写一行请求」时短暂互斥,写完即释放;
    // 等待响应不持有任何会话锁 → 同一 host 的多个 RPC 可真正并发在飞。
    stdin: Arc<Mutex<ChildStdin>>,
    pending: Pending,
    // 会话代号:用于并发下「失败丢弃」时判断当前 host 槽里是否仍是本次调用用的会话,
    // 避免误杀已被其它线程重建的新会话。
    gen: u64,
    // reader 线程句柄(会话 Drop 时随 child 被杀而自然结束)
    _reader: std::thread::JoinHandle<()>,
}

#[derive(Clone)]
struct AgentEndpoint {
    stdin: Arc<Mutex<ChildStdin>>,
    pending: Pending,
    gen: u64,
}

impl AgentSession {
    fn endpoint(&self) -> AgentEndpoint {
        AgentEndpoint {
            stdin: Arc::clone(&self.stdin),
            pending: Arc::clone(&self.pending),
            gen: self.gen,
        }
    }
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

fn session_key(host: &str, lane: RpcLane) -> String {
    format!("{host}\0{}", lane.as_str())
}

fn host_handle_for(host: &str, lane: RpcLane) -> Handle {
    let mut map = sessions().lock().unwrap_or_else(|e| e.into_inner());
    map.entry(session_key(host, lane))
        .or_insert_with(|| Arc::new(Mutex::new(None)))
        .clone()
}

#[cfg(test)]
fn host_handle(host: &str) -> Handle {
    host_handle_for(host, RpcLane::Interactive)
}

/// 关闭某 host 的 agent 会话(ssh_disconnect 时调用)。
pub fn drop_session(host: &str) {
    if let Ok(mut map) = sessions().lock() {
        let prefix = format!("{host}\0");
        map.retain(|k, _| !k.starts_with(&prefix));
    }
}

// 本进程已确认「脚本已按当前版本部署」的 host → 远端脚本路径。
// 部署是一次性的:首次连某 host 时跑一次 SSH 把脚本落到 ~/.linco/,之后
// 同一进程内每次 spawn_session 都复用这个路径,**省掉每次 600~1000ms 的版本
// 校验 SSH 往返**(实测这是 spawn 耗时的一半)。版本变了 = 重新编译 = 新进程
// = 缓存自动清空,会重新部署一次。远端脚本文件跨 SSH 断连仍在,故断连不清缓存。
static SCRIPT_DEPLOYED: OnceLock<Mutex<HashMap<String, String>>> = OnceLock::new();
fn script_deployed() -> &'static Mutex<HashMap<String, String>> {
    SCRIPT_DEPLOYED.get_or_init(|| Mutex::new(HashMap::new()))
}

/// 把 agent 脚本推到远端 ~/.linco/linco_agent.py(版本不符才重推),返回远端路径。
/// 本进程内对同一 host 只做一次真正的部署 SSH,之后返回缓存路径(零往返)。
fn ensure_script(host: &str) -> Result<String, String> {
    // 命中进程内缓存:脚本本轮已部署,直接用路径,不再走 SSH。
    if let Ok(m) = script_deployed().lock() {
        if let Some(p) = m.get(host) {
            return Ok(p.clone());
        }
    }
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
    // 记入进程缓存:同一 host 下次 spawn 直接复用,省掉版本校验 SSH。
    if let Ok(mut m) = script_deployed().lock() {
        m.insert(host.to_string(), path.clone());
    }
    Ok(path)
}

/// reader 线程:独占 stdout,分流响应与推送。
fn reader_loop(host: String, mut stdout: BufReader<ChildStdout>, pending: Pending) {
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
                    .map(|a| {
                        a.iter()
                            .filter_map(|x| x.as_str().map(String::from))
                            .collect()
                    })
                    .unwrap_or_default();
                if let Some(app) = APP.get() {
                    let _ = app.emit(
                        "remote-fs-change",
                        FsChangeEvent {
                            host: host.clone(),
                            paths,
                        },
                    );
                }
            } else if ev == "searchMatch" || ev == "searchDone" {
                // 流式搜索:把整条 payload(含 sid/rows/count/hitLimit)转发给前端,附上 host。
                if let Some(app) = APP.get() {
                    let mut payload = v.clone();
                    if let Some(obj) = payload.as_object_mut() {
                        obj.insert("host".into(), Value::String(host.clone()));
                    }
                    let topic = if ev == "searchMatch" {
                        "remote-search-match"
                    } else {
                        "remote-search-done"
                    };
                    let _ = app.emit(topic, payload);
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
    crate::proc_ext::no_window(&mut cmd);
    let mut child = cmd.spawn().map_err(|e| format!("agent 启动失败: {e}"))?;
    let stdin = Arc::new(Mutex::new(child.stdin.take().ok_or("无 stdin")?));
    let stdout = BufReader::new(child.stdout.take().ok_or("无 stdout")?);

    let pending: Pending = Arc::new(Mutex::new(HashMap::new()));
    let host_owned = host.to_string();
    let pending_r = Arc::clone(&pending);
    let reader = std::thread::spawn(move || reader_loop(host_owned, stdout, pending_r));

    let sess = AgentSession {
        child,
        stdin,
        pending,
        gen: SESSION_SEQ.fetch_add(1, Ordering::Relaxed),
        _reader: reader,
    };
    // 握手:ping → pong
    let resp = rpc_on(&sess, "ping", json!({}), Duration::from_secs(15))
        .map_err(|e| format!("agent 握手失败: {e}"))?;
    if !resp.get("pong").and_then(|v| v.as_bool()).unwrap_or(false) {
        return Err("agent 握手响应异常".into());
    }
    Ok(sess)
}

/// 在给定会话上发一次 RPC:注册 id 的应答 channel,写请求,等 channel(超时)。
fn rpc_on(sess: &AgentSession, op: &str, args: Value, timeout: Duration) -> Result<Value, String> {
    rpc_on_endpoint(&sess.endpoint(), op, args, timeout)
}

fn rpc_on_endpoint(
    endpoint: &AgentEndpoint,
    op: &str,
    args: Value,
    timeout: Duration,
) -> Result<Value, String> {
    let id = SEQ.fetch_add(1, Ordering::Relaxed);
    let req = json!({"id": id, "op": op, "args": args});
    let line = serde_json::to_string(&req).map_err(|e| e.to_string())? + "\n";

    let (tx, rx) = sync_channel::<Result<Value, String>>(1);
    {
        let mut p = endpoint.pending.lock().map_err(|e| e.to_string())?;
        p.insert(id, tx);
    }
    // 写请求
    let write_result = {
        let mut stdin = endpoint.stdin.lock().map_err(|e| e.to_string())?;
        stdin.write_all(line.as_bytes()).and_then(|_| stdin.flush())
    };
    if let Err(e) = write_result {
        endpoint.pending.lock().ok().map(|mut p| p.remove(&id));
        return Err(e.to_string());
    }
    // 等应答
    match rx.recv_timeout(timeout) {
        Ok(res) => res,
        Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {
            endpoint.pending.lock().ok().map(|mut p| p.remove(&id));
            Err("agent 超时".into())
        }
        Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => Err("agent EOF".into()),
    }
}

fn is_session_error(e: &str) -> bool {
    e == "agent EOF" || e == "agent 超时" || e.contains("Broken pipe") || e.contains("os error")
}

fn clear_session_if_current(handle: &Handle, gen: u64) {
    let Ok(mut guard) = handle.lock() else {
        return;
    };
    if guard.as_ref().map(|sess| sess.gen) == Some(gen) {
        *guard = None;
    }
}

/// 对某 host 发一次 RPC。懒建会话,断线重连重试一次。
pub fn call(host: &str, op: &str, args: Value) -> Result<Value, String> {
    call_on_lane(host, RpcLane::Interactive, op, args)
}

/// 后台 RPC lane:给 watch/git/search/diff 等非交互任务使用,避免抢占文件树/打开文件。
pub fn call_background(host: &str, op: &str, args: Value) -> Result<Value, String> {
    call_on_lane_timeout(host, RpcLane::Background, op, args, RPC_TIMEOUT)
}

/// 后台 RPC,但用自定义超时。给「首次拍影子基线」这类一次性慢操作用:
/// 234GB 大目录首次哈希 3 万文件可能要 ~60s,远超默认 45s。
pub fn call_background_timeout(
    host: &str,
    op: &str,
    args: Value,
    timeout: Duration,
) -> Result<Value, String> {
    call_on_lane_timeout(host, RpcLane::Background, op, args, timeout)
}

/// HTML preview 专用 RPC lane:预览刷新是主路径,不与文件树/编辑器/后台任务排队。
pub fn call_preview(host: &str, op: &str, args: Value) -> Result<Value, String> {
    call_on_lane_timeout(host, RpcLane::Preview, op, args, RPC_TIMEOUT)
}

fn call_on_lane(host: &str, lane: RpcLane, op: &str, args: Value) -> Result<Value, String> {
    call_on_lane_timeout(host, lane, op, args, RPC_TIMEOUT)
}

fn call_on_lane_timeout(
    host: &str,
    lane: RpcLane,
    op: &str,
    args: Value,
    timeout: Duration,
) -> Result<Value, String> {
    call_on_lane_opts(host, lane, op, args, timeout, true)
}

/// 同上,但可关闭"会话错误后重连重试"。搜索这类**只读且可能很慢**的查询应关掉重试:
/// 超时重跑同一个慢 grep 只会雪上加霜(~2 倍耗时 + 远端孤儿进程),应直接返回让前端结束 loading。
fn call_on_lane_opts(
    host: &str,
    lane: RpcLane,
    op: &str,
    args: Value,
    timeout: Duration,
    retry: bool,
) -> Result<Value, String> {
    if !agent_enabled() {
        return Err("agent disabled".into());
    }
    let handle = host_handle_for(host, lane);
    let max_attempts = if retry { 2 } else { 1 };
    for attempt in 0..max_attempts {
        let endpoint = {
            let mut guard = handle.lock().unwrap_or_else(|e| e.into_inner());
            if guard.is_none() {
                match spawn_session(host) {
                    Ok(s) => *guard = Some(s),
                    Err(e) => return Err(e),
                }
            }
            guard.as_ref().unwrap().endpoint()
        };

        match rpc_on_endpoint(&endpoint, op, args.clone(), timeout) {
            Ok(v) => return Ok(v),
            Err(e) => {
                // 会话级失败(EOF/超时/IO)→ 丢弃重连;业务错(ok:false)→ 直接返回
                if is_session_error(&e) {
                    eprintln!("[agent] session dropped on '{op}' ({host}): {e}");
                    clear_session_if_current(&handle, endpoint.gen);
                    if attempt + 1 >= max_attempts {
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

/// 后台 RPC,超时后**不重连重试**。给搜索等只读慢查询用。
pub fn call_background_no_retry(
    host: &str,
    op: &str,
    args: Value,
    timeout: Duration,
) -> Result<Value, String> {
    call_on_lane_opts(host, RpcLane::Background, op, args, timeout, false)
}

/// 发起一次**流式搜索**(grep_stream):立即返回,结果经 remote-search-match/done 事件流式回前端。
/// 在后台线程跑那条会阻塞到 searchDone(~≤20s)的 RPC,所以这里 fire-and-forget。
pub fn grep_stream_start(host: &str, args: Value) {
    let host = host.to_string();
    std::thread::spawn(move || {
        // 用不重试 + 略大于 helper 内部 20s 的超时;结果已通过事件推送,这里只为驱动/收尾。
        let _ = call_background_no_retry(&host, "grep_stream", args, Duration::from_secs(25));
    });
}

/// 取消进行中的流式搜索(kill 远端子进程)。短超时,失败忽略。
pub fn search_cancel(host: &str, sid: &str) {
    let _ = call_background_no_retry(
        host,
        "search_cancel",
        json!({ "sid": sid }),
        Duration::from_secs(5),
    );
}

/// 预热某 host 的 RPC agent。成功返回时,远端 Python agent 已部署、启动并握手完成。
/// 这对应 VS Code remote authority resolved 后再开放文件系统通道的边界:
/// 用户交互请求不应该承担部署/建连/握手的冷启动成本。
pub fn warmup(host: &str) -> Result<(), String> {
    let v = call(host, "ping", json!({}))?;
    if v.get("pong").and_then(|x| x.as_bool()).unwrap_or(false) {
        Ok(())
    } else {
        Err("agent warmup 响应异常".into())
    }
}

/// 预热 HTML preview 专用 lane,让首次 iframe 读取不承担建连/握手成本。
pub fn warmup_preview(host: &str) -> Result<(), String> {
    let v = call_preview(host, "ping", json!({}))?;
    if v.get("pong").and_then(|x| x.as_bool()).unwrap_or(false) {
        Ok(())
    } else {
        Err("preview agent warmup 响应异常".into())
    }
}

/// 开始监听某 host 工作目录(agent watch op)。事件经 reader 线程 emit remote-fs-change。
pub fn watch(host: &str, root: &str) -> Result<(), String> {
    call_background(host, "watch", json!({ "root": root })).map(|_| ())
}

/// 停止监听。
pub fn unwatch(host: &str) -> Result<(), String> {
    call_background(host, "unwatch", json!({})).map(|_| ())
}

// ---- 影子快照(本轮 agent 改动)远程转发:逻辑在 linco_agent.py 的 op_shadow_* ----

// 影子操作专用超时:首次拍基线在大目录(实测 234GB / 3 万小文件)要哈希所有 blob,
// 可达 ~60s,远超默认 45s。给足 4 分钟余量,避免「超时返回 Err 但 commit 没跑完 →
// HEAD 不存在 → 后续 diff 全报错」这个把远端功能整个废掉的链式失败。
const SHADOW_TIMEOUT: Duration = Duration::from_secs(240);

/// 远端拍本轮基线(独立影子仓库:自筛文件 + add -f + commit)。
pub fn shadow_begin(host: &str, repo: &str) -> Result<(), String> {
    call_background_timeout(
        host,
        "shadow_begin",
        json!({ "repo": repo }),
        SHADOW_TIMEOUT,
    )
    .map(|_| ())
}

/// 远端本轮改过哪些文件:绝对路径 → 状态字符(M/A/D)。
pub fn shadow_changed_remote(
    host: &str,
    repo: &str,
) -> Result<std::collections::HashMap<String, String>, String> {
    let v = call_background_timeout(
        host,
        "shadow_changed",
        json!({ "repo": repo }),
        SHADOW_TIMEOUT,
    )?;
    let mut map = std::collections::HashMap::new();
    if let Some(obj) = v.get("changed").and_then(|x| x.as_object()) {
        for (k, val) in obj {
            if let Some(s) = val.as_str() {
                map.insert(k.clone(), s.to_string());
            }
        }
    }
    Ok(map)
}

/// 远端某文件本轮 diff(unified)。
pub fn shadow_diff_remote(host: &str, repo: &str, path: &str) -> Result<String, String> {
    let v = call_background_timeout(
        host,
        "shadow_diff",
        json!({ "repo": repo, "path": path }),
        SHADOW_TIMEOUT,
    )?;
    Ok(v.get("diff")
        .and_then(|x| x.as_str())
        .unwrap_or("")
        .to_string())
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
        let stdin = Arc::new(Mutex::new(child.stdin.take().unwrap()));
        let stdout = BufReader::new(child.stdout.take().unwrap());
        let pending: Pending = Arc::new(Mutex::new(HashMap::new()));
        let pending_r = Arc::clone(&pending);
        let reader = std::thread::spawn(move || reader_loop("test".to_string(), stdout, pending_r));
        AgentSession {
            child,
            stdin,
            pending,
            gen: SESSION_SEQ.fetch_add(1, Ordering::Relaxed),
            _reader: reader,
        }
    }

    #[test]
    fn rpc_ping_and_readdir() {
        let s = local_agent();
        let pong = rpc_on(&s, "ping", json!({}), Duration::from_secs(5)).unwrap();
        assert_eq!(pong.get("pong").and_then(|v| v.as_bool()), Some(true));

        let dir = std::env::temp_dir().join("linco_rpc_test");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("x.txt"), "hi").unwrap();
        let r = rpc_on(
            &s,
            "readdir",
            json!({ "path": dir.to_string_lossy() }),
            Duration::from_secs(5),
        )
        .unwrap();
        let entries = r.get("entries").and_then(|v| v.as_array()).unwrap();
        assert!(entries
            .iter()
            .any(|e| e.get("name").and_then(|n| n.as_str()) == Some("x.txt")));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn rpc_business_error_not_session_error() {
        let s = local_agent();
        // 读不存在的文件 → agent 返回 ok:false,rpc_on 返回 Err(业务错)
        let r = rpc_on(
            &s,
            "read_file",
            json!({ "path": "/nonexistent/zzz.txt" }),
            Duration::from_secs(5),
        );
        assert!(r.is_err());
        // 会话仍可用:再发一次 ping 成功
        let pong = rpc_on(&s, "ping", json!({}), Duration::from_secs(5)).unwrap();
        assert_eq!(pong.get("pong").and_then(|v| v.as_bool()), Some(true));
    }

    #[test]
    fn rpc_bytes_roundtrip() {
        let s = local_agent();
        let dir = std::env::temp_dir().join("linco_rpc_bytes");
        std::fs::create_dir_all(&dir).unwrap();
        let p = dir.join("b.bin");
        let raw = [0u8, 1, 255, 65, 66, 67];
        rpc_on(
            &s,
            "write_bytes",
            json!({ "path": p.to_string_lossy(), "b64": B64.encode(raw) }),
            Duration::from_secs(5),
        )
        .unwrap();
        let r = rpc_on(
            &s,
            "read_bytes",
            json!({ "path": p.to_string_lossy() }),
            Duration::from_secs(5),
        )
        .unwrap();
        let b64 = r.get("b64").and_then(|v| v.as_str()).unwrap();
        assert_eq!(B64.decode(b64).unwrap(), raw);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn call_allows_fast_rpc_while_another_rpc_is_blocked() {
        let host = format!("local-mux-test-{}", SEQ.fetch_add(1, Ordering::Relaxed));
        let dir = std::env::temp_dir().join(format!("linco_rpc_mux_{}", host));
        std::fs::create_dir_all(&dir).unwrap();
        let fifo = dir.join("blocked-read");
        let status = Command::new("mkfifo").arg(&fifo).status().unwrap();
        assert!(status.success());

        {
            let handle = host_handle(&host);
            let mut guard = handle.lock().unwrap();
            *guard = Some(local_agent());
        }

        let slow_host = host.clone();
        let fifo_path = fifo.to_string_lossy().to_string();
        let slow = std::thread::spawn(move || {
            call(
                &slow_host,
                "read_file",
                json!({ "path": fifo_path, "max": 5 * 1024 * 1024 }),
            )
        });

        std::thread::sleep(Duration::from_millis(150));

        let (tx, rx) = std::sync::mpsc::sync_channel(1);
        let ping_host = host.clone();
        let ping = std::thread::spawn(move || {
            let result = call(&ping_host, "ping", json!({}));
            let _ = tx.send(result);
        });

        let ping_result = rx.recv_timeout(Duration::from_secs(1));

        {
            let mut writer = std::fs::OpenOptions::new().write(true).open(&fifo).unwrap();
            writer.write_all(b"done").unwrap();
        }

        let _ = slow.join().unwrap();
        let _ = ping.join();
        drop_session(&host);
        let _ = std::fs::remove_dir_all(&dir);

        let pong = ping_result
            .expect("ping should not wait behind the blocked read")
            .expect("ping RPC should succeed");
        assert_eq!(pong.get("pong").and_then(|v| v.as_bool()), Some(true));
    }

    #[test]
    fn warmup_marks_existing_agent_ready_with_ping() {
        let host = format!("local-warmup-test-{}", SEQ.fetch_add(1, Ordering::Relaxed));
        {
            let handle = host_handle(&host);
            let mut guard = handle.lock().unwrap();
            *guard = Some(local_agent());
        }

        warmup(&host).expect("warmup should ping the existing local agent");
        drop_session(&host);
    }

    #[test]
    fn watch_without_inotify_falls_back_to_poll() {
        let has_inotify = Command::new("sh")
            .arg("-c")
            .arg("command -v inotifywait >/dev/null 2>&1")
            .status()
            .map(|s| s.success())
            .unwrap_or(false);
        if has_inotify {
            return; // 装了 inotify 的机器走 inotify 路径,本测试只验证回退分支
        }

        let s = local_agent();
        let dir = std::env::temp_dir().join(format!(
            "linco_watch_poll_{}",
            SEQ.fetch_add(1, Ordering::Relaxed)
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let result = rpc_on(
            &s,
            "watch",
            json!({ "root": dir.to_string_lossy() }),
            Duration::from_secs(5),
        )
        .unwrap();
        // 无 inotifywait → 回退纯 Python mtime 轮询(mode=poll),而非放弃监听(none)。
        // 这保证 agent 写出的产物(含 untracked / artifacts)也能被监控到。
        assert_eq!(result.get("mode").and_then(|v| v.as_str()), Some("poll"));
        let _ = rpc_on(&s, "unwatch", json!({}), Duration::from_secs(5));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn interactive_rpc_does_not_wait_for_background_lane_lock() {
        let host = format!("local-lane-test-{}", SEQ.fetch_add(1, Ordering::Relaxed));
        {
            let bg = host_handle_for(&host, RpcLane::Background);
            let mut guard = bg.lock().unwrap();
            *guard = Some(local_agent());
        }
        {
            let ui = host_handle_for(&host, RpcLane::Interactive);
            let mut guard = ui.lock().unwrap();
            *guard = Some(local_agent());
        }

        let bg = host_handle_for(&host, RpcLane::Background);
        let _bg_guard = bg.lock().unwrap();

        let (tx, rx) = std::sync::mpsc::sync_channel(1);
        let host_for_call = host.clone();
        let t = std::thread::spawn(move || {
            let _ = tx.send(call(&host_for_call, "ping", json!({})));
        });

        let pong = rx
            .recv_timeout(Duration::from_secs(1))
            .expect("interactive lane should not wait for background lane lock")
            .expect("interactive ping should succeed");
        let _ = t.join();
        drop_session(&host);

        assert_eq!(pong.get("pong").and_then(|v| v.as_bool()), Some(true));
    }

    #[test]
    fn preview_rpc_does_not_wait_for_interactive_or_background_lane_locks() {
        let host = format!(
            "local-preview-lane-test-{}",
            SEQ.fetch_add(1, Ordering::Relaxed)
        );
        {
            let bg = host_handle_for(&host, RpcLane::Background);
            let mut guard = bg.lock().unwrap();
            *guard = Some(local_agent());
        }
        {
            let ui = host_handle_for(&host, RpcLane::Interactive);
            let mut guard = ui.lock().unwrap();
            *guard = Some(local_agent());
        }
        {
            let pv = host_handle_for(&host, RpcLane::Preview);
            let mut guard = pv.lock().unwrap();
            *guard = Some(local_agent());
        }

        let bg = host_handle_for(&host, RpcLane::Background);
        let ui = host_handle_for(&host, RpcLane::Interactive);
        let _bg_guard = bg.lock().unwrap();
        let _ui_guard = ui.lock().unwrap();

        let (tx, rx) = std::sync::mpsc::sync_channel(1);
        let host_for_call = host.clone();
        let t = std::thread::spawn(move || {
            let _ = tx.send(call_preview(&host_for_call, "ping", json!({})));
        });

        let pong = rx
            .recv_timeout(Duration::from_secs(1))
            .expect("preview lane should not wait for interactive/background lane locks")
            .expect("preview ping should succeed");
        let _ = t.join();
        drop_session(&host);

        assert_eq!(pong.get("pong").and_then(|v| v.as_bool()), Some(true));
    }
}
