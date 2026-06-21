// SSH 远程核心:让 agent 与各视图真正运行在远程服务器环境里。
//
// 设计(借鉴 VS Code Remote-SSH 的稳定性打磨,但远程零安装):
// - 连接复用 ControlMaster:一次认证,后续所有命令复用同一 socket,瞬时。
// - 保活 ServerAliveInterval/CountMax:防路由器/防火墙掐空闲连接。
// - fs/git/search 用 BatchMode 只读复用,socket 失效时快速失败而非弹认证。
// - 密码/2FA/首次 host key 在终端 PTY 里交互完成一次(本机无 sshpass,
//   密码本就只能走 PTY)。
//
// 路径选择:直接读 ~/.ssh/config 的 Host,复用用户既有配置。

use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::path::PathBuf;
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

use base64::engine::general_purpose::STANDARD as B64;
use base64::Engine;

/// ControlMaster socket 目录(<linco_home>/ssh)。随发布版/dev 版隔离。
fn control_dir() -> PathBuf {
    let base = crate::config::linco_home().unwrap_or_else(|_| PathBuf::from("/tmp").join(".linco"));
    let dir = base.join("ssh");
    let _ = std::fs::create_dir_all(&dir);
    dir
}

/// 所有远程命令共用的 ssh 选项:连接复用 + 保活 + 超时。
/// `%C` 是 ssh 内置短哈希(基于 host/port/user),规避 socket 路径过长。
pub fn ssh_opts() -> Vec<String> {
    let cp = control_dir().join("%C");
    vec![
        "-o".into(),
        "ControlMaster=auto".into(),
        "-o".into(),
        format!("ControlPath={}", cp.to_string_lossy()),
        "-o".into(),
        // master 空闲后多保留(从 10 分钟拉长到 1 小时),减少"放一会就要重连"
        "ControlPersist=3600".into(),
        "-o".into(),
        // 每 15s 发保活探测;连续 8 次(=2 分钟)无响应才判定断开。
        // 比原来(30s×3=90s)更能扛网络抖动/路由器空闲掐连接。
        "ServerAliveInterval=15".into(),
        "-o".into(),
        "ServerAliveCountMax=8".into(),
        "-o".into(),
        // 开 TCP keepalive:让 OS 也发保活包,帮助探测/维持死连接
        "TCPKeepAlive=yes".into(),
        "-o".into(),
        "ConnectTimeout=15".into(),
    ]
}

/// 仅用于 PTY 终端的 ssh 参数(强制分配远程 TTY)。
pub fn ssh_terminal_args(host: &str, identity: &Option<String>) -> Vec<String> {
    let mut args = vec!["-tt".to_string()];
    args.extend(ssh_opts());
    if let Some(id) = identity.as_ref().filter(|s| !s.is_empty()) {
        args.push("-i".into());
        args.push(id.clone());
    }
    args.push(host.to_string());
    args
}

// ============ 持久常驻 shell 会话(VS Code Remote 式提速)============
//
// 现状痛点:每个远程操作 `ssh host "cmd"` 即使复用 ControlMaster,仍要开一个
// 新 ssh 子进程 + 一次往返(实测 ~75ms)。这里在一条持久 ssh 连接里跑一个常驻
// `/bin/sh`,通过 stdin/stdout 复用执行每条命令,把每次开销降到接近网络往返。
//
// 协议(二进制安全):用户命令在 `{ ...; } </dev/null >out 2>err` 里执行,
// 输出落到远端临时文件,再以 base64 单行回传,夹在唯一 nonce 标记之间。
// 信道只承载 [A-Za-z0-9+/=] 与 ASCII 标记,绝不与文件内容冲突。
//
// 失败时回退到一次性 ssh(run_remote_oneshot),保证永不崩。

const SESSION_TIMEOUT: Duration = Duration::from_secs(45);
static SEQ: AtomicU64 = AtomicU64::new(0);

struct ShellSession {
    child: Child,
    stdin: ChildStdin,
    stdout: BufReader<ChildStdout>,
}

impl Drop for ShellSession {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

type HostHandle = Arc<Mutex<Option<ShellSession>>>;
static SESSIONS: OnceLock<Mutex<HashMap<String, HostHandle>>> = OnceLock::new();

fn sessions() -> &'static Mutex<HashMap<String, HostHandle>> {
    SESSIONS.get_or_init(|| Mutex::new(HashMap::new()))
}

/// 取某 host 的会话句柄(只短暂持有全局 map 锁)。
fn host_handle(host: &str) -> HostHandle {
    let mut map = sessions().lock().unwrap_or_else(|e| e.into_inner());
    map.entry(host.to_string())
        .or_insert_with(|| Arc::new(Mutex::new(None)))
        .clone()
}

/// 关闭某 host 的持久会话(ssh_disconnect 时调用)。
fn drop_session(host: &str) {
    if let Ok(mut map) = sessions().lock() {
        map.remove(host);
    }
}

#[derive(Debug)]
#[allow(dead_code)]
enum FrameErr {
    Eof,
    Io,
    Timeout,
    Decode,
}

/// 启动一个持久会话:`ssh <复用opts> host /bin/sh`,并做握手(PATH 预置 + base64 探测)。
fn spawn_session(host: &str) -> Result<ShellSession, String> {
    let mut cmd = Command::new("ssh");
    cmd.args(ssh_opts());
    cmd.arg("-o").arg("BatchMode=yes");
    cmd.arg(host);
    cmd.arg("/bin/sh");
    cmd.stdin(Stdio::piped());
    cmd.stdout(Stdio::piped());
    cmd.stderr(Stdio::null()); // stderr 由协议在远端重定向到文件,这里丢弃噪声
    crate::proc_ext::no_window(&mut cmd);
    let mut child = cmd.spawn().map_err(|e| format!("ssh 启动失败: {e}"))?;
    let stdin = child.stdin.take().ok_or("无 stdin")?;
    let stdout = BufReader::new(child.stdout.take().ok_or("无 stdout")?);
    let mut sess = ShellSession {
        child,
        stdin,
        stdout,
    };
    // 握手前置:非交互 /bin/sh 不加载登录 PATH,这里补上常见工具路径,
    // 否则 git/base64/grep/find 可能找不到(persistent 与 oneshot 的主要差异点)。
    // 顺便清理可能残留的临时文件。
    let prelude = "[ -f /etc/profile ] && . /etc/profile 2>/dev/null; \
         export PATH=\"$HOME/bin:$HOME/.local/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:$PATH\"; \
         rm -f \"${TMPDIR:-/tmp}\"/.linco.*.out \"${TMPDIR:-/tmp}\"/.linco.*.err 2>/dev/null; \
         command -v base64 >/dev/null && echo __LINCO_HS_OK__";
    let (out, _err, _rc) = exec_on(&mut sess, prelude, None, Duration::from_secs(15))
        .map_err(|e| format!("会话握手失败: {e:?}"))?;
    if !String::from_utf8_lossy(&out).contains("__LINCO_HS_OK__") {
        return Err("远端缺少 base64,无法启用持久会话".into());
    }
    Ok(sess)
}

/// 在给定会话上执行一条命令,返回 (stdout, stderr, exit_code)。
/// 用看门狗线程在超时时杀掉 ssh 进程,打断阻塞读。
fn exec_on(
    sess: &mut ShellSession,
    sh_cmd: &str,
    stdin_data: Option<&[u8]>,
    timeout: Duration,
) -> Result<(Vec<u8>, Vec<u8>, i32), FrameErr> {
    let seq = SEQ.fetch_add(1, Ordering::Relaxed);
    let nonce = {
        let t = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        format!("{t:x}{seq:x}")
    };
    let tmp = "${TMPDIR:-/tmp}";
    let outf = format!("{tmp}/.linco.{nonce}.out");
    let errf = format!("{tmp}/.linco.{nonce}.err");

    // 构造脚本:用户命令在 subshell 里执行(保留 cd && / 管道 / 重定向,
    // 且 exit/cd 不会泄漏或杀掉常驻会话);</dev/null 防止它吞掉脚本;
    // stdin_data 经 base64 heredoc 解码喂入。
    let mut script = String::new();
    match stdin_data {
        None => {
            script.push_str(&format!("( {sh_cmd} ) </dev/null >{outf} 2>{errf}\n"));
        }
        Some(data) => {
            let b64 = B64.encode(data);
            // 引号 heredoc:不展开;base64 字母表不含分隔行,二进制安全。
            script.push_str(&format!(
                "( base64 -d <<'__LINCO_IN_{nonce}__' | ( {sh_cmd} ) ) >{outf} 2>{errf}\n{b64}\n__LINCO_IN_{nonce}__\n"
            ));
        }
    }
    script.push_str("__rc=$?\n");
    script.push_str(&format!("printf '__LINCO_{nonce}__OUT '\n"));
    script.push_str(&format!("base64 <{outf} | tr -d '\\n'\n"));
    script.push_str(&format!("printf '\\n__LINCO_{nonce}__ERR '\n"));
    script.push_str(&format!("base64 <{errf} | tr -d '\\n'\n"));
    script.push_str(&format!(
        "printf '\\n__LINCO_{nonce}__END %s\\n' \"$__rc\"\n"
    ));
    script.push_str(&format!("rm -f {outf} {errf}\n"));

    // 看门狗:超时杀子进程以打断阻塞 read_line
    let deadline = Instant::now() + timeout;
    let pid = sess.child.id();
    let done = Arc::new(std::sync::atomic::AtomicBool::new(false));
    let done_wd = Arc::clone(&done);
    let watchdog = std::thread::spawn(move || {
        while Instant::now() < deadline {
            if done_wd.load(Ordering::Relaxed) {
                return;
            }
            std::thread::sleep(Duration::from_millis(50));
        }
        if !done_wd.load(Ordering::Relaxed) {
            // 超时:杀掉 ssh 进程(用 pid)
            kill_pid(pid);
        }
    });

    let res = (|| {
        sess.stdin
            .write_all(script.as_bytes())
            .map_err(|_| FrameErr::Io)?;
        sess.stdin.flush().map_err(|_| FrameErr::Io)?;
        read_framed(&mut sess.stdout, &nonce)
    })();

    done.store(true, Ordering::Relaxed);
    let _ = watchdog.join();
    res
}

/// 读取一条命令的分帧输出。
fn read_framed(
    stdout: &mut BufReader<ChildStdout>,
    nonce: &str,
) -> Result<(Vec<u8>, Vec<u8>, i32), FrameErr> {
    let out_m = format!("__LINCO_{nonce}__OUT ");
    let err_m = format!("__LINCO_{nonce}__ERR ");
    let end_m = format!("__LINCO_{nonce}__END ");
    let mut out_b64 = String::new();
    let mut err_b64 = String::new();
    enum Phase {
        SeekOut,
        SeekErr,
        SeekEnd,
    }
    let mut phase = Phase::SeekOut;
    let mut line = String::new();
    loop {
        line.clear();
        let n = stdout.read_line(&mut line).map_err(|_| FrameErr::Io)?;
        if n == 0 {
            return Err(FrameErr::Eof);
        }
        match phase {
            // 容忍标记前的噪声(首条命令可能有 MOTD 等)
            Phase::SeekOut => {
                if let Some(rest) = line.strip_prefix(&out_m) {
                    out_b64.push_str(rest.trim_end());
                    phase = Phase::SeekErr;
                }
            }
            Phase::SeekErr => {
                if let Some(rest) = line.strip_prefix(&err_m) {
                    err_b64.push_str(rest.trim_end());
                    phase = Phase::SeekEnd;
                } else {
                    out_b64.push_str(line.trim_end());
                }
            }
            Phase::SeekEnd => {
                if let Some(rest) = line.strip_prefix(&end_m) {
                    let rc: i32 = rest.trim().parse().unwrap_or(-1);
                    let out = B64.decode(out_b64.trim()).map_err(|_| FrameErr::Decode)?;
                    let err = B64.decode(err_b64.trim()).map_err(|_| FrameErr::Decode)?;
                    return Ok((out, err, rc));
                } else {
                    err_b64.push_str(line.trim_end());
                }
            }
        }
    }
}

// 跨平台强杀进程(打断看门狗超时下的阻塞读)。
// Unix:POSIX kill(SIGKILL);Windows:taskkill /F。
#[cfg(unix)]
fn kill_pid(pid: u32) {
    unsafe {
        extern "C" {
            fn kill(pid: i32, sig: i32) -> i32;
        }
        kill(pid as i32, 9); // SIGKILL
    }
}

#[cfg(windows)]
fn kill_pid(pid: u32) {
    use std::process::Command;
    let mut c = Command::new("taskkill");
    c.args(["/PID", &pid.to_string(), "/T", "/F"]);
    crate::proc_ext::no_window(&mut c);
    let _ = c.output();
}

/// 持久会话执行:锁定 host 会话,懒建,断线重试一次。
fn exec_persistent(
    host: &str,
    sh_cmd: &str,
    stdin_data: Option<&[u8]>,
) -> Result<(Vec<u8>, Vec<u8>, i32), String> {
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
        match exec_on(sess, sh_cmd, stdin_data, SESSION_TIMEOUT) {
            Ok(triple) => return Ok(triple),
            Err(_) => {
                *guard = None; // 丢弃坏会话(Drop 杀进程),重试一次
                if attempt == 1 {
                    return Err("持久会话不可用".into());
                }
            }
        }
    }
    unreachable!()
}

fn persistent_enabled() -> bool {
    std::env::var("LINCO_NO_PERSISTENT_SSH").is_err()
}

/// 执行一条远程命令。优先持久会话;失败回退一次性 ssh。
/// 返回 stdout 原始字节;失败返回 stderr 文本。契约与旧版完全一致。
pub fn run_remote(host: &str, sh_cmd: &str) -> Result<Vec<u8>, String> {
    run_remote_stdin(host, sh_cmd, None)
}

/// 同 run_remote,可向远程命令的 stdin 喂数据(用于写文件)。
pub fn run_remote_stdin(
    host: &str,
    sh_cmd: &str,
    stdin_data: Option<&[u8]>,
) -> Result<Vec<u8>, String> {
    if persistent_enabled() {
        match exec_persistent(host, sh_cmd, stdin_data) {
            Ok((stdout, _stderr, 0)) => return Ok(stdout),
            Ok((_stdout, stderr, _rc)) => {
                return Err(String::from_utf8_lossy(&stderr).trim().to_string());
            }
            Err(_) => {} // 降级到一次性 ssh
        }
    }
    run_remote_oneshot(host, sh_cmd, stdin_data)
}

/// HTML preview 专用远程 shell。正常路径走 preview RPC lane,避免和文件树/编辑器抢 lane。
pub fn preview_run_remote(host: &str, sh_cmd: &str) -> Result<Vec<u8>, String> {
    preview_run_remote_stdin(host, sh_cmd, None)
}

/// 同 preview_run_remote,可向远程命令 stdin 喂数据。
pub fn preview_run_remote_stdin(
    host: &str,
    sh_cmd: &str,
    stdin_data: Option<&[u8]>,
) -> Result<Vec<u8>, String> {
    let mut args = serde_json::json!({ "cmd": sh_cmd, "timeout": SESSION_TIMEOUT.as_secs() });
    if let Some(data) = stdin_data {
        args["stdin_b64"] = serde_json::Value::String(B64.encode(data));
    }
    if let Ok(v) = crate::agent_rpc::call_preview(host, "shell", args) {
        let code = v.get("code").and_then(|x| x.as_i64()).unwrap_or(1);
        let stdout_b64 = v.get("stdout_b64").and_then(|x| x.as_str()).unwrap_or("");
        let stdout = B64
            .decode(stdout_b64.as_bytes())
            .map_err(|e| e.to_string())?;
        if code == 0 {
            return Ok(stdout);
        }
        let stderr = v
            .get("stderr")
            .and_then(|x| x.as_str())
            .unwrap_or("preview shell 失败")
            .trim()
            .to_string();
        return Err(stderr);
    }
    // 兜底只在 preview RPC 不可用时触发;正常预览不经过共享 shell 会话。
    run_remote_stdin(host, sh_cmd, stdin_data)
}

/// 一次性 ssh 的公开包装(供 agent_rpc 部署脚本用,不走持久会话)。
pub fn run_remote_oneshot_pub(
    host: &str,
    sh_cmd: &str,
    stdin_data: Option<&[u8]>,
) -> Result<Vec<u8>, String> {
    run_remote_oneshot(host, sh_cmd, stdin_data)
}

/// 一次性 ssh(降级路径 / 旧实现)。
fn run_remote_oneshot(
    host: &str,
    sh_cmd: &str,
    stdin_data: Option<&[u8]>,
) -> Result<Vec<u8>, String> {
    let mut cmd = Command::new("ssh");
    cmd.args(ssh_opts());
    cmd.arg("-o").arg("BatchMode=yes");
    cmd.arg(host);
    cmd.arg(sh_cmd);
    cmd.stdin(if stdin_data.is_some() {
        Stdio::piped()
    } else {
        Stdio::null()
    });
    cmd.stdout(Stdio::piped());
    cmd.stderr(Stdio::piped());
    crate::proc_ext::no_window(&mut cmd);

    let mut child = cmd.spawn().map_err(|e| format!("ssh 启动失败: {e}"))?;
    if let Some(data) = stdin_data {
        if let Some(mut si) = child.stdin.take() {
            si.write_all(data).map_err(|e| e.to_string())?;
        }
    }
    let out = child.wait_with_output().map_err(|e| e.to_string())?;
    if out.status.success() {
        Ok(out.stdout)
    } else {
        Err(String::from_utf8_lossy(&out.stderr).trim().to_string())
    }
}

fn run_remote_str(host: &str, sh_cmd: &str) -> Result<String, String> {
    run_remote(host, sh_cmd).map(|b| String::from_utf8_lossy(&b).to_string())
}

/// 单引号安全转义,把任意字符串作为一个 sh 参数。
pub fn shq(s: &str) -> String {
    format!("'{}'", s.replace('\'', "'\\''"))
}

// ============ 连接管理命令 ============

/// 读取 ~/.ssh/config 里的 Host 别名(过滤通配符项),供前端列出可选主机。
#[tauri::command]
pub fn ssh_config_hosts() -> Vec<String> {
    let home = match crate::config::home_dir() {
        Ok(h) => h,
        Err(_) => return vec![],
    };
    let path = home.join(".ssh").join("config");
    let text = match std::fs::read_to_string(&path) {
        Ok(t) => t,
        Err(_) => return vec![],
    };
    let mut hosts: Vec<String> = Vec::new();
    for line in text.lines() {
        let t = line.trim();
        if let Some(rest) = t.strip_prefix("Host ").or_else(|| t.strip_prefix("host ")) {
            for h in rest.split_whitespace() {
                // 过滤通配符与否定项
                if h.contains('*') || h.contains('?') || h.starts_with('!') {
                    continue;
                }
                if !hosts.iter().any(|x| x == h) {
                    hosts.push(h.to_string());
                }
            }
        }
    }
    hosts
}

/// 尝试用 key/已有 master 静默连接(BatchMode)。成功 = master 与 RPC agent 都可用。
/// 失败(需密码/2FA/首次 host key)返回 Err,前端据此引导去终端交互连接。
#[tauri::command]
pub async fn ssh_connect(host: String, identity: Option<String>) -> Result<(), String> {
    crate::blocking::run(move || {
        let mut cmd = Command::new("ssh");
        cmd.args(ssh_opts());
        cmd.arg("-o").arg("BatchMode=yes");
        if let Some(id) = identity.as_ref().filter(|s| !s.is_empty()) {
            cmd.arg("-i").arg(id);
        }
        cmd.arg(&host).arg("--").arg("echo").arg("__linco_ok__");
        cmd.stdin(Stdio::null());
        cmd.stdout(Stdio::piped());
        cmd.stderr(Stdio::piped());
        crate::proc_ext::no_window(&mut cmd);
        let out = cmd.output().map_err(|e| format!("ssh 启动失败: {e}"))?;
        if out.status.success() && String::from_utf8_lossy(&out.stdout).contains("__linco_ok__") {
            crate::agent_rpc::warmup(&host)
        } else {
            Err(String::from_utf8_lossy(&out.stderr).trim().to_string())
        }
    })
    .await
}

/// 探测 master 是否存活。
#[tauri::command]
pub async fn ssh_check(host: String) -> bool {
    crate::blocking::run(move || {
        let mut cmd = Command::new("ssh");
        cmd.args(ssh_opts());
        cmd.arg("-O").arg("check").arg(&host);
        cmd.stdin(Stdio::null());
        cmd.stdout(Stdio::null());
        cmd.stderr(Stdio::null());
        crate::proc_ext::no_window(&mut cmd);
        Ok(cmd.status().map(|s| s.success()).unwrap_or(false))
    })
    .await
    .unwrap_or(false)
}

/// 关闭 master 连接。
#[tauri::command]
pub async fn ssh_disconnect(host: String) -> Result<(), String> {
    crate::blocking::run(move || {
        drop_session(&host); // 先关持久 shell 会话(否则会持有死管道)
        crate::agent_rpc::drop_session(&host); // 关 agent 会话(杀远端常驻进程的本地管道)
        let mut cmd = Command::new("ssh");
        cmd.args(ssh_opts());
        cmd.arg("-O").arg("exit").arg(&host);
        crate::proc_ext::no_window(&mut cmd);
        let _ = cmd.output();
        Ok(())
    })
    .await
}

// ============ 远程文件操作(供 fs.rs 在 host 非空时调用)============

pub struct RemoteEntry {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
}

fn join_remote(dir: &str, name: &str) -> String {
    if dir.ends_with('/') {
        format!("{dir}{name}")
    } else {
        format!("{dir}/{name}")
    }
}

/// 列目录:优先走常驻 agent(RPC),失败回退 shell。
pub fn list_dir(host: &str, dir: &str) -> Result<Vec<RemoteEntry>, String> {
    if let Ok(v) = crate::agent_rpc::call(host, "readdir", serde_json::json!({ "path": dir })) {
        if let Some(arr) = v.get("entries").and_then(|x| x.as_array()) {
            return Ok(arr
                .iter()
                .filter_map(|e| {
                    Some(RemoteEntry {
                        name: e.get("name")?.as_str()?.to_string(),
                        path: e.get("path")?.as_str()?.to_string(),
                        is_dir: e.get("is_dir").and_then(|d| d.as_bool()).unwrap_or(false),
                    })
                })
                .collect());
        }
    }
    list_dir_shell(host, dir)
}

/// 列目录(shell 实现):`ls -1Ap`(尾随 / 标记目录,-A 含 dotfile 但不含 . ..)。
fn list_dir_shell(host: &str, dir: &str) -> Result<Vec<RemoteEntry>, String> {
    let out = run_remote_str(host, &format!("ls -1Ap -- {}", shq(dir)))?;
    let mut entries = Vec::new();
    for line in out.lines() {
        if line.is_empty() {
            continue;
        }
        let is_dir = line.ends_with('/');
        let name = line.trim_end_matches('/').to_string();
        if name.is_empty() {
            continue;
        }
        entries.push(RemoteEntry {
            path: join_remote(dir, &name),
            name,
            is_dir,
        });
    }
    entries.sort_by(|a, b| {
        b.is_dir
            .cmp(&a.is_dir)
            .then(a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });
    Ok(entries)
}

const MAX_READ: u64 = 5 * 1024 * 1024;

pub fn read_file(host: &str, path: &str) -> Result<String, String> {
    if let Ok(v) = crate::agent_rpc::call(
        host,
        "read_file",
        serde_json::json!({ "path": path, "max": MAX_READ }),
    ) {
        if let Some(t) = v.get("text").and_then(|x| x.as_str()) {
            return Ok(t.to_string());
        }
    }
    read_file_shell(host, path)
}

fn read_file_shell(host: &str, path: &str) -> Result<String, String> {
    // 先判大小
    let size_out = run_remote_str(host, &format!("wc -c < {}", shq(path)))?;
    if let Ok(n) = size_out.trim().parse::<u64>() {
        if n > MAX_READ {
            return Err("文件过大,无法预览(>5MB)".into());
        }
    }
    let bytes = run_remote(host, &format!("cat -- {}", shq(path)))?;
    if bytes.iter().take(8000).any(|&b| b == 0) {
        return Err("二进制文件,无法预览".into());
    }
    String::from_utf8(bytes).map_err(|_| "非 UTF-8 文本,无法预览".to_string())
}

/// HTML preview 专用读文本:走 preview RPC lane。
pub fn preview_read_file(host: &str, path: &str) -> Result<String, String> {
    if let Ok(v) = crate::agent_rpc::call_preview(
        host,
        "read_file",
        serde_json::json!({ "path": path, "max": MAX_READ }),
    ) {
        if let Some(t) = v.get("text").and_then(|x| x.as_str()) {
            return Ok(t.to_string());
        }
    }
    preview_read_file_shell(host, path)
}

fn preview_read_file_shell(host: &str, path: &str) -> Result<String, String> {
    let size_out = preview_run_remote(host, &format!("wc -c < {}", shq(path)))?;
    if let Ok(n) = String::from_utf8_lossy(&size_out).trim().parse::<u64>() {
        if n > MAX_READ {
            return Err("文件过大,无法预览(>5MB)".into());
        }
    }
    let bytes = preview_run_remote(host, &format!("cat -- {}", shq(path)))?;
    if bytes.iter().take(8000).any(|&b| b == 0) {
        return Err("二进制文件,无法预览".into());
    }
    String::from_utf8(bytes).map_err(|_| "非 UTF-8 文本,无法预览".to_string())
}

pub fn write_file(host: &str, path: &str, content: &str) -> Result<(), String> {
    if crate::agent_rpc::call(
        host,
        "write_file",
        serde_json::json!({ "path": path, "content": content }),
    )
    .is_ok()
    {
        return Ok(());
    }
    run_remote_stdin(
        host,
        &format!("cat > {}", shq(path)),
        Some(content.as_bytes()),
    )
    .map(|_| ())
}

/// HTML preview 专用写文本:走 preview RPC lane。
pub fn preview_write_file(host: &str, path: &str, content: &str) -> Result<(), String> {
    if crate::agent_rpc::call_preview(
        host,
        "write_file",
        serde_json::json!({ "path": path, "content": content }),
    )
    .is_ok()
    {
        return Ok(());
    }
    preview_run_remote_stdin(
        host,
        &format!("cat > {}", shq(path)),
        Some(content.as_bytes()),
    )
    .map(|_| ())
}

/// 写远端二进制文件:原始字节经 stdin(base64 heredoc,二进制安全)写入。
pub fn write_bytes(host: &str, path: &str, bytes: &[u8]) -> Result<(), String> {
    let b64 = B64.encode(bytes);
    if crate::agent_rpc::call(
        host,
        "write_bytes",
        serde_json::json!({ "path": path, "b64": b64 }),
    )
    .is_ok()
    {
        return Ok(());
    }
    run_remote_stdin(host, &format!("cat > {}", shq(path)), Some(bytes)).map(|_| ())
}

/// 读远端文件为 base64(供图片/视频/PDF 等二进制预览)。
/// 远端用 `base64`(GNU coreutils / busybox 通用),失败回退 openssl。
pub fn read_bytes_b64(host: &str, path: &str, max: u64) -> Result<String, String> {
    if let Ok(v) = crate::agent_rpc::call(
        host,
        "read_bytes",
        serde_json::json!({ "path": path, "max": max }),
    ) {
        if let Some(b) = v.get("b64").and_then(|x| x.as_str()) {
            return Ok(b.to_string());
        }
    }
    read_bytes_b64_shell(host, path, max)
}

/// HTML preview 专用读二进制:走 preview RPC lane。
pub fn preview_read_bytes_b64(host: &str, path: &str, max: u64) -> Result<String, String> {
    if let Ok(v) = crate::agent_rpc::call_preview(
        host,
        "read_bytes",
        serde_json::json!({ "path": path, "max": max }),
    ) {
        if let Some(b) = v.get("b64").and_then(|x| x.as_str()) {
            return Ok(b.to_string());
        }
    }
    preview_read_bytes_b64_shell(host, path, max)
}

fn read_bytes_b64_shell(host: &str, path: &str, max: u64) -> Result<String, String> {
    // 先判大小
    let size_out = run_remote_str(host, &format!("wc -c < {}", shq(path)))?;
    if let Ok(n) = size_out.trim().parse::<u64>() {
        if n > max {
            return Err(format!("文件过大,无法预览(>{}MB)", max / 1024 / 1024));
        }
    }
    // base64 -w0 取消换行(GNU);BSD/busybox 无 -w 选项,故用管道去掉换行兜底
    let cmd = format!(
        "base64 -w0 -- {p} 2>/dev/null || base64 -- {p} | tr -d '\\n'",
        p = shq(path)
    );
    let out = run_remote(host, &cmd)?;
    let s = String::from_utf8_lossy(&out).trim().to_string();
    if s.is_empty() {
        return Err("无法读取文件".into());
    }
    Ok(s)
}

fn preview_read_bytes_b64_shell(host: &str, path: &str, max: u64) -> Result<String, String> {
    let size_out = preview_run_remote(host, &format!("wc -c < {}", shq(path)))?;
    if let Ok(n) = String::from_utf8_lossy(&size_out).trim().parse::<u64>() {
        if n > max {
            return Err(format!("文件过大,无法预览(>{}MB)", max / 1024 / 1024));
        }
    }
    let cmd = format!(
        "base64 -w0 -- {p} 2>/dev/null || base64 -- {p} | tr -d '\\n'",
        p = shq(path)
    );
    let out = preview_run_remote(host, &cmd)?;
    let s = String::from_utf8_lossy(&out).trim().to_string();
    if s.is_empty() {
        return Err("无法读取文件".into());
    }
    Ok(s)
}

pub fn create_file(host: &str, parent: &str, name: &str) -> Result<String, String> {
    match crate::agent_rpc::call(
        host,
        "create_file",
        serde_json::json!({ "parent": parent, "name": name }),
    ) {
        Ok(v) => {
            if let Some(p) = v.get("path").and_then(|x| x.as_str()) {
                return Ok(p.to_string());
            }
        }
        // 业务错(同名已存在)直接上抛,不回退(避免 shell 再创一次产生歧义)
        Err(e) if e.contains("已存在") => return Err(e),
        Err(_) => {}
    }
    let target = join_remote(parent, name);
    run_remote(host, &format!("set -C; : > {}", shq(&target)))
        .map_err(|_| "同名文件已存在或创建失败".to_string())?;
    Ok(target)
}

pub fn create_dir(host: &str, parent: &str, name: &str) -> Result<String, String> {
    if let Ok(v) = crate::agent_rpc::call(
        host,
        "mkdir",
        serde_json::json!({ "parent": parent, "name": name }),
    ) {
        if let Some(p) = v.get("path").and_then(|x| x.as_str()) {
            return Ok(p.to_string());
        }
    }
    let target = join_remote(parent, name);
    run_remote(host, &format!("mkdir -- {}", shq(&target)))?;
    Ok(target)
}

pub fn rename(host: &str, path: &str, new_name: &str) -> Result<String, String> {
    match crate::agent_rpc::call(
        host,
        "rename",
        serde_json::json!({ "path": path, "new_name": new_name }),
    ) {
        Ok(v) => {
            if let Some(p) = v.get("path").and_then(|x| x.as_str()) {
                return Ok(p.to_string());
            }
        }
        Err(e) if e.contains("已存在") => return Err(e),
        Err(_) => {}
    }
    let parent = path.rsplit_once('/').map(|(p, _)| p).unwrap_or("");
    let target = join_remote(parent, new_name);
    run_remote(
        host,
        &format!(
            "test ! -e {t} && mv -- {s} {t}",
            t = shq(&target),
            s = shq(path)
        ),
    )
    .map_err(|_| "目标已存在或重命名失败".to_string())?;
    Ok(target)
}

pub fn delete(host: &str, path: &str) -> Result<(), String> {
    if crate::agent_rpc::call(host, "delete", serde_json::json!({ "path": path })).is_ok() {
        return Ok(());
    }
    run_remote(host, &format!("rm -rf -- {}", shq(path))).map(|_| ())
}

pub fn copy(host: &str, src: &str, dest_dir: &str) -> Result<String, String> {
    if let Ok(v) = crate::agent_rpc::call(
        host,
        "copy",
        serde_json::json!({ "src": src, "dest_dir": dest_dir }),
    ) {
        if let Some(p) = v.get("path").and_then(|x| x.as_str()) {
            return Ok(p.to_string());
        }
    }
    let name = src.rsplit('/').next().unwrap_or(src);
    let target = join_remote(dest_dir, name);
    run_remote(host, &format!("cp -r -- {} {}", shq(src), shq(&target)))?;
    Ok(target)
}

pub fn move_to(host: &str, src: &str, dest_dir: &str) -> Result<String, String> {
    if let Ok(v) = crate::agent_rpc::call(
        host,
        "move",
        serde_json::json!({ "src": src, "dest_dir": dest_dir }),
    ) {
        if let Some(p) = v.get("path").and_then(|x| x.as_str()) {
            return Ok(p.to_string());
        }
    }
    let name = src.rsplit('/').next().unwrap_or(src);
    let target = join_remote(dest_dir, name);
    run_remote(host, &format!("mv -- {} {}", shq(src), shq(&target)))?;
    Ok(target)
}

/// 文件名搜索(优先 agent,回退远程 find)。
pub fn search_files(host: &str, root: &str, query: &str) -> Result<Vec<RemoteEntry>, String> {
    if let Ok(v) = crate::agent_rpc::call_background(
        host,
        "search_files",
        serde_json::json!({ "root": root, "query": query }),
    ) {
        if let Some(arr) = v.get("entries").and_then(|x| x.as_array()) {
            return Ok(arr
                .iter()
                .filter_map(|e| {
                    Some(RemoteEntry {
                        name: e.get("name")?.as_str()?.to_string(),
                        path: e.get("path")?.as_str()?.to_string(),
                        is_dir: e.get("is_dir").and_then(|d| d.as_bool()).unwrap_or(false),
                    })
                })
                .collect());
        }
    }
    search_files_shell(host, root, query)
}

fn search_files_shell(host: &str, root: &str, query: &str) -> Result<Vec<RemoteEntry>, String> {
    // 跳过重目录;-iname 大小写不敏感;限制数量
    let cmd = format!(
        "find {root} \\( -name .git -o -name node_modules -o -name target -o -name __pycache__ \\) -prune -o -iname {pat} -print 2>/dev/null | head -300",
        root = shq(root),
        pat = shq(&format!("*{query}*"))
    );
    let out = run_remote_str(host, &cmd)?;
    let mut entries = Vec::new();
    for line in out.lines() {
        if line.is_empty() {
            continue;
        }
        let name = line.rsplit('/').next().unwrap_or(line).to_string();
        // is_dir 无从快速判断,统一当文件(搜索结果主要点文件)
        entries.push(RemoteEntry {
            path: line.to_string(),
            name,
            is_dir: false,
        });
    }
    Ok(entries)
}

/// 远程内容搜索(grep)。返回 (path, line_no, line_text) 三元组。
/// 大小写敏感/正则由调用方传入对应 grep 标志。
pub fn grep_content(
    host: &str,
    root: &str,
    pattern: &str,
    case_sensitive: bool,
    is_regex: bool,
) -> Result<Vec<(String, usize, String)>, String> {
    // 搜索是只读慢查询:用不重试的调用 + 略大于 helper 内部 20s 的超时(让 Python 先返回部分结果),
    // 超时也直接返回、不重连重跑(重跑只会更慢、更堆远端孤儿进程)。
    if let Ok(v) = crate::agent_rpc::call_background_no_retry(
        host,
        "grep",
        serde_json::json!({ "root": root, "pattern": pattern, "case_sensitive": case_sensitive, "is_regex": is_regex }),
        std::time::Duration::from_secs(25),
    ) {
        if let Some(arr) = v.get("matches").and_then(|x| x.as_array()) {
            return Ok(arr
                .iter()
                .filter_map(|m| {
                    let a = m.as_array()?;
                    Some((
                        a.first()?.as_str()?.to_string(),
                        a.get(1)?.as_u64()? as usize,
                        a.get(2)?.as_str()?.to_string(),
                    ))
                })
                .collect());
        }
    }
    grep_content_shell(host, root, pattern, case_sensitive, is_regex)
}

fn grep_content_shell(
    host: &str,
    root: &str,
    pattern: &str,
    case_sensitive: bool,
    is_regex: bool,
) -> Result<Vec<(String, usize, String)>, String> {
    // -r 递归 -n 行号 -I 跳过二进制 --exclude-dir 跳过重目录
    let mut flags = String::from("-rnI");
    if !case_sensitive {
        flags.push('i');
    }
    if is_regex {
        flags.push('E'); // 扩展正则
    } else {
        flags.push('F'); // 固定字符串
    }
    let cmd = format!(
        "grep {flags} --exclude-dir=.git --exclude-dir=node_modules --exclude-dir=target --exclude-dir=__pycache__ --exclude-dir=.venv -e {pat} {root} 2>/dev/null | head -3000",
        flags = flags,
        pat = shq(pattern),
        root = shq(root),
    );
    let out = run_remote_str(host, &cmd)?;
    let mut results = Vec::new();
    for line in out.lines() {
        // 格式 path:lineno:text
        let mut it = line.splitn(3, ':');
        let path = it.next().unwrap_or("");
        let no = it.next().and_then(|s| s.parse::<usize>().ok());
        let text = it.next().unwrap_or("");
        if let Some(n) = no {
            if !path.is_empty() {
                results.push((path.to_string(), n, text.to_string()));
            }
        }
    }
    Ok(results)
}

// ============ SSH 指令解析 + 写入 ~/.ssh/config ============

#[derive(serde::Serialize)]
pub struct SshTarget {
    pub alias: String, // 建议的 Host 别名
    pub hostname: String,
    pub user: String,
    pub port: String,
    pub identity: String,
}

/// 解析一条 `ssh` 指令:`ssh [user@]host [-p port] [-i identity] [-l user] [别名]`。
/// 容错:可省略开头的 `ssh`;缺省 port=22。
#[tauri::command]
pub fn parse_ssh_command(cmd: String) -> Result<SshTarget, String> {
    let toks: Vec<String> = cmd.split_whitespace().map(|s| s.to_string()).collect();
    let mut i = 0;
    if toks.first().map(|s| s.as_str()) == Some("ssh") {
        i = 1;
    }
    let mut user = String::new();
    let mut port = String::new();
    let mut identity = String::new();
    let mut extra: Vec<String> = Vec::new(); // 位置参数(host / 别名)

    while i < toks.len() {
        let t = &toks[i];
        match t.as_str() {
            "-p" | "-P" => {
                i += 1;
                if let Some(v) = toks.get(i) {
                    port = v.clone();
                }
            }
            "-i" => {
                i += 1;
                if let Some(v) = toks.get(i) {
                    identity = v.clone();
                }
            }
            "-l" => {
                i += 1;
                if let Some(v) = toks.get(i) {
                    user = v.clone();
                }
            }
            _ if t.starts_with('-') => {
                // 跳过未知选项;若是 -pXXXX / -iXXXX 这种连写
                if let Some(rest) = t.strip_prefix("-p") {
                    if !rest.is_empty() {
                        port = rest.to_string();
                    }
                } else if let Some(rest) = t.strip_prefix("-i") {
                    if !rest.is_empty() {
                        identity = rest.to_string();
                    }
                }
            }
            _ => extra.push(t.clone()),
        }
        i += 1;
    }

    // 第一个位置参数是 [user@]host
    let target = extra
        .first()
        .cloned()
        .ok_or("缺少主机,如 ssh root@1.2.3.4")?;
    let hostname = if let Some((u, h)) = target.split_once('@') {
        if user.is_empty() {
            user = u.to_string();
        }
        h.to_string()
    } else {
        target
    };
    if hostname.is_empty() {
        return Err("无法解析主机地址".into());
    }
    if port.is_empty() {
        port = "22".into();
    }
    // 别名:第二个位置参数,否则用 host
    let alias = extra.get(1).cloned().unwrap_or_else(|| hostname.clone());

    Ok(SshTarget {
        alias,
        hostname,
        user,
        port,
        identity,
    })
}

/// 向 ~/.ssh/config 追加一段 Host block。同名 Host 已存在则报错(不覆盖)。
#[tauri::command]
pub fn ssh_config_add(
    alias: String,
    hostname: String,
    user: String,
    port: String,
    identity: String,
) -> Result<(), String> {
    let home = crate::config::home_dir()?;
    let ssh_dir = PathBuf::from(&home).join(".ssh");
    std::fs::create_dir_all(&ssh_dir).map_err(|e| e.to_string())?;
    let path = ssh_dir.join("config");

    let existing = std::fs::read_to_string(&path).unwrap_or_default();
    // 检查同名 Host
    for line in existing.lines() {
        let t = line.trim();
        if let Some(rest) = t.strip_prefix("Host ").or_else(|| t.strip_prefix("host ")) {
            if rest.split_whitespace().any(|h| h == alias) {
                return Err(format!("~/.ssh/config 中已存在 Host {alias}"));
            }
        }
    }

    let mut block = String::new();
    if !existing.is_empty() && !existing.ends_with('\n') {
        block.push('\n');
    }
    block.push('\n');
    block.push_str(&format!("Host {alias}\n"));
    block.push_str(&format!("    HostName {hostname}\n"));
    if !user.is_empty() {
        block.push_str(&format!("    User {user}\n"));
    }
    if !port.is_empty() && port != "22" {
        block.push_str(&format!("    Port {port}\n"));
    }
    if !identity.is_empty() {
        block.push_str(&format!("    IdentityFile {identity}\n"));
    }

    use std::io::Write;
    let mut f = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
        .map_err(|e| e.to_string())?;
    f.write_all(block.as_bytes()).map_err(|e| e.to_string())?;
    Ok(())
}

/// 远端 HOME 目录(作为目录浏览器初始路径)。
#[tauri::command]
pub async fn remote_home(host: String) -> Result<String, String> {
    crate::blocking::run(move || {
        let out = run_remote_str(&host, "echo $HOME")?;
        let h = out.trim().to_string();
        Ok(if h.is_empty() { "/".into() } else { h })
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    // 用本地 /bin/sh 构造一个会话(与 `ssh host /bin/sh` 同样的管道语义),
    // 从而无需远程即可测试分帧协议。
    fn local_session() -> ShellSession {
        let mut child = Command::new("/bin/sh")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .expect("spawn sh");
        let stdin = child.stdin.take().unwrap();
        let stdout = BufReader::new(child.stdout.take().unwrap());
        ShellSession {
            child,
            stdin,
            stdout,
        }
    }

    #[test]
    fn frame_stdout_stderr_rc() {
        let mut s = local_session();
        let (out, err, rc) = exec_on(
            &mut s,
            "echo hello; echo oops 1>&2; exit 3",
            None,
            Duration::from_secs(5),
        )
        .expect("exec");
        assert_eq!(String::from_utf8_lossy(&out).trim(), "hello");
        assert_eq!(String::from_utf8_lossy(&err).trim(), "oops");
        assert_eq!(rc, 3);
    }

    #[test]
    fn frame_binary_roundtrip() {
        let mut s = local_session();
        // 输出含 NUL 与高位字节,验证 base64 分帧二进制安全
        let (out, _err, rc) = exec_on(
            &mut s,
            "printf '\\000\\377\\001ABC'",
            None,
            Duration::from_secs(5),
        )
        .expect("exec");
        assert_eq!(out, vec![0u8, 0xff, 0x01, b'A', b'B', b'C']);
        assert_eq!(rc, 0);
    }

    #[test]
    fn frame_stdin_data() {
        let mut s = local_session();
        // 把数据经 stdin 喂给 cat,验证 heredoc 解码路径
        let data = b"\x00line1\nline2\xfe";
        let (out, _err, rc) =
            exec_on(&mut s, "cat", Some(data), Duration::from_secs(5)).expect("exec");
        assert_eq!(out, data);
        assert_eq!(rc, 0);
    }

    #[test]
    fn frame_reuse_same_session() {
        // 同一会话连续多条命令(验证复用不串状态)
        let mut s = local_session();
        let (o1, _, _) = exec_on(&mut s, "echo a", None, Duration::from_secs(5)).unwrap();
        let (o2, _, _) = exec_on(&mut s, "echo b", None, Duration::from_secs(5)).unwrap();
        let (o3, _, _) = exec_on(
            &mut s,
            "pwd >/dev/null; echo c",
            None,
            Duration::from_secs(5),
        )
        .unwrap();
        assert_eq!(String::from_utf8_lossy(&o1).trim(), "a");
        assert_eq!(String::from_utf8_lossy(&o2).trim(), "b");
        assert_eq!(String::from_utf8_lossy(&o3).trim(), "c");
    }

    #[test]
    fn frame_timeout_kills() {
        let mut s = local_session();
        let r = exec_on(&mut s, "sleep 30", None, Duration::from_millis(800));
        assert!(r.is_err(), "超时应返回错误");
    }

    #[test]
    fn ssh_opts_has_control_and_keepalive() {
        let o = ssh_opts().join(" ");
        assert!(o.contains("ControlMaster=auto"));
        assert!(o.contains("ControlPersist=3600"));
        assert!(o.contains("ServerAliveInterval=15"));
        assert!(o.contains("ServerAliveCountMax=8"));
        assert!(o.contains("ConnectTimeout=15"));
    }

    #[test]
    fn terminal_args_force_tty_and_host() {
        let args = ssh_terminal_args("root@1.2.3.4", &None);
        assert_eq!(args[0], "-tt");
        assert!(args.contains(&"root@1.2.3.4".to_string()));
    }

    #[test]
    fn shq_escapes() {
        assert_eq!(shq("a b"), "'a b'");
        assert_eq!(shq("it's"), "'it'\\''s'");
    }

    #[test]
    fn join_remote_handles_trailing_slash() {
        assert_eq!(join_remote("/root", "a.txt"), "/root/a.txt");
        assert_eq!(join_remote("/root/", "a.txt"), "/root/a.txt");
    }

    #[test]
    fn parse_ssh_basic() {
        let t = parse_ssh_command("ssh root@1.2.3.4".into()).unwrap();
        assert_eq!(t.hostname, "1.2.3.4");
        assert_eq!(t.user, "root");
        assert_eq!(t.port, "22");
    }

    #[test]
    fn parse_ssh_with_port_and_identity() {
        let t = parse_ssh_command("ssh dev@host -p 2222 -i ~/.ssh/k".into()).unwrap();
        assert_eq!(t.user, "dev");
        assert_eq!(t.hostname, "host");
        assert_eq!(t.port, "2222");
        assert_eq!(t.identity, "~/.ssh/k");
    }

    #[test]
    fn parse_ssh_without_ssh_prefix_and_alias() {
        let t = parse_ssh_command("user@10.0.0.1 mybox".into()).unwrap();
        assert_eq!(t.hostname, "10.0.0.1");
        assert_eq!(t.alias, "mybox");
    }

    #[test]
    fn parse_ssh_missing_host_errors() {
        assert!(parse_ssh_command("ssh -p 22".into()).is_err());
    }
}
