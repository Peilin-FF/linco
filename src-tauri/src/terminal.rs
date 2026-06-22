// PTY 终端会话管理。
//
// 为什么用 PTY:Claude Code / Codex 等是全屏交互式 TUI(用 ANSI 转义、
// 光标控制、重绘),普通管道(pipe)无法正确驱动。必须给它们一个真正的
// 伪终端(pseudo-terminal),就像 VS Code 终端、Warp 那样。
//
// 数据通道:PTY 输出是带控制序列的原始字节,可能在任意位置截断(包括 UTF-8
// 多字节中间),所以跨 IPC 边界统一用 base64 传输,前端解码成 Uint8Array
// 喂给 xterm.js —— 避免字符串编码破坏控制序列。

use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use base64::engine::general_purpose::STANDARD as B64;
use base64::Engine;
use portable_pty::{CommandBuilder, MasterPty, PtySize};
use serde::Serialize;
use tauri::{AppHandle, Emitter, State};

type SharedWriter = Arc<Mutex<Box<dyn Write + Send>>>;

/// 单个终端会话持有的句柄。
pub(crate) struct Session {
    master: Box<dyn MasterPty + Send>,
    writer: SharedWriter,
    child: Box<dyn portable_pty::Child + Send + Sync>,
}

/// 全局会话表,按 id 索引(支持多终端,例如每个项目一个)。
#[derive(Default)]
pub struct TerminalState(pub Mutex<HashMap<String, Session>>);

#[derive(Clone, Serialize)]
struct TermOutput {
    id: String,
    /// base64 编码的原始 PTY 字节
    data: String,
}

#[derive(Clone, Serialize)]
struct TermExit {
    id: String,
}

/// 启动一个终端会话:开 PTY、跑登录 shell、起读取线程把输出流式 emit 回前端。
/// 登录 shell 确保 ~/.cargo/bin、homebrew、npm 全局等路径在 PATH 中,
/// 这样用户安装的 `claude` / `codex` 等 CLI 能被找到。
///
/// - `env`:注入的环境变量(如 API Key、base url),让 agent 用配置的凭据启动。
/// - `initial_command`:PTY 起来后自动执行的命令(如 `claude`),实现“开箱即对话”。
/// - `host`:非空时通过 ssh 在远程服务器开 PTY(agent 真正运行在远程环境)。
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub fn term_start(
    app: AppHandle,
    state: State<'_, TerminalState>,
    id: String,
    cwd: Option<String>,
    cols: u16,
    rows: u16,
    env: Option<std::collections::HashMap<String, String>>,
    initial_command: Option<String>,
    host: Option<String>,
    identity: Option<String>,
) -> Result<(), String> {
    // 若同 id 已存在,先清掉旧会话
    {
        let mut map = state.0.lock().map_err(|e| e.to_string())?;
        if let Some(mut old) = map.remove(&id) {
            let _ = old.child.kill();
        }
    }

    let pty_system = portable_pty::native_pty_system();
    let pair = pty_system
        .openpty(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| format!("openpty 失败: {e}"))?;

    let remote = host.as_ref().filter(|h| !h.is_empty()).cloned();

    // 计算实际写入 PTY 的自动启动命令。
    // 远程:把 env 导出 + cd 工作目录折进命令(本地 cmd.cwd/cmd.env 对远程 shell 无效)。
    let effective_initial: Option<String> = {
        let base = initial_command
            .as_ref()
            .map(|s| s.trim())
            .filter(|s| !s.is_empty())
            .map(|s| s.to_string());
        if remote.is_some() {
            // 远程:无论是否有 base,都先 cd(+导出 env),再跑 base
            let mut prefix = String::new();
            // 中文乱码修复:远端 locale 不是 UTF-8 时,中文路径/输出会乱码。仅在远端未设时兜底
            // 一个 UTF-8 locale(${VAR:-default} 不覆盖远端已有的正确值),让会话按 UTF-8 输出。
            prefix.push_str(
                "export LANG=${LANG:-en_US.UTF-8} LC_ALL=${LC_ALL:-en_US.UTF-8}; ",
            );
            // IS_SANDBOX=1 仅在要启动 agent(base 非空,如 claude)时注入:
            // Claude Code 在 root 容器里用 --dangerously-skip-permissions 会被拦,
            // 除非环境里有 IS_SANDBOX=1。普通终端(无 base)不需要,保持干净。
            if base.is_some() {
                prefix.push_str("export IS_SANDBOX=1; ");
            }
            if let Some(vars) = &env {
                for (k, v) in vars {
                    if !k.is_empty() {
                        prefix.push_str(&format!("export {}={}; ", k, crate::remote::shq(v)));
                    }
                }
            }
            if let Some(dir) = cwd.as_ref().filter(|d| !d.is_empty()) {
                prefix.push_str(&format!("cd {} 2>/dev/null; ", crate::remote::shq(dir)));
            }
            match base {
                Some(b) => Some(format!("{prefix}{b}")),
                None if !prefix.is_empty() => Some(prefix.trim_end().to_string()),
                None => None,
            }
        } else {
            base
        }
    };

    let mut cmd;
    if let Some(h) = &remote {
        // 远程:ssh -tt <复用opts> host(env/cwd 已折进 effective_initial)
        cmd = CommandBuilder::new("ssh");
        for a in crate::remote::ssh_terminal_args(h, &identity) {
            cmd.arg(a);
        }
        cmd.env("TERM", "xterm-256color");
    } else {
        // 本地:登录 shell,加载完整 PATH。Windows 没有 SHELL/zsh,用 PowerShell。
        #[cfg(windows)]
        {
            // Windows:用 cmd.exe(ComSpec)。订阅登录、跑 claude/codex 都在 cmd 里进行。
            // 中文乱码修复:cmd 默认用系统 OEM 代码页(简体中文 Windows 是 GBK/936),输出的中文
            // 是 GBK 字节,而前端 xterm.js 固定按 UTF-8 解码 → 乱码。用 `/K "chcp 65001>nul"`
            // 在进入交互前把控制台代码页切到 UTF-8(65001),`>nul` 静默不污染首屏。
            // 另注入 PYTHONUTF8/PYTHONIOENCODING:chcp 管 cmd 自身与原生程序,但 Python 这类
            // 按 locale 决定输出编码的运行时还需要这两个 env 才稳定吐 UTF-8。
            let shell = std::env::var("ComSpec").unwrap_or_else(|_| "cmd.exe".to_string());
            cmd = CommandBuilder::new(&shell);
            cmd.arg("/K");
            cmd.arg("chcp 65001>nul");
            cmd.env("TERM", "xterm-256color");
            cmd.env("PYTHONUTF8", "1");
            cmd.env("PYTHONIOENCODING", "utf-8");
            if let Some(vars) = &env {
                for (k, v) in vars {
                    if !k.is_empty() {
                        cmd.env(k, v);
                    }
                }
            }
            if let Some(dir) = cwd.clone().filter(|d| !d.is_empty()) {
                cmd.cwd(dir);
            } else if let Some(home) = dirs_home() {
                cmd.cwd(home);
            }
        }
        #[cfg(not(windows))]
        {
            // macOS/Linux:登录 shell(-l)确保 ~/.cargo/bin、homebrew、npm 全局在 PATH。
            let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".to_string());
            cmd = CommandBuilder::new(&shell);
            cmd.arg("-l");
            cmd.env("TERM", "xterm-256color");
            // 中文乱码兜底:若用户 LANG 缺失或不是 UTF-8(精简环境/容器常见),程序可能按非 UTF-8
            // 输出 → xterm 当 UTF-8 解 → 乱码。仅在缺失/非 UTF-8 时补一个 UTF-8 locale,
            // 不覆盖用户已正确设置的值(只动 LANG 这个回退键,不碰 LC_ALL 以免盖掉用户精细配置)。
            let lang_ok = std::env::var("LANG")
                .map(|l| {
                    let l = l.to_ascii_lowercase();
                    l.contains("utf-8") || l.contains("utf8")
                })
                .unwrap_or(false);
            if !lang_ok {
                cmd.env("LANG", "en_US.UTF-8");
            }
            // 注入配置的环境变量(API Key / base url 等)
            if let Some(vars) = &env {
                for (k, v) in vars {
                    if !k.is_empty() {
                        cmd.env(k, v);
                    }
                }
            }
            if let Some(dir) = cwd.filter(|d| !d.is_empty()) {
                cmd.cwd(dir);
            } else if let Some(home) = dirs_home() {
                cmd.cwd(home);
            }
        }
    }

    let child = pair
        .slave
        .spawn_command(cmd)
        .map_err(|e| format!("spawn shell 失败: {e}"))?;
    // slave 在 spawn 后即可释放(子进程已持有);保留 master 用于读写和 resize
    drop(pair.slave);

    let mut reader = pair
        .master
        .try_clone_reader()
        .map_err(|e| format!("clone reader 失败: {e}"))?;
    let writer: SharedWriter = Arc::new(Mutex::new(
        pair.master
            .take_writer()
            .map_err(|e| format!("take writer 失败: {e}"))?,
    ));

    // 当收到 shell 的首个输出(说明提示符已就绪)时通过该通道通知,
    // 用于在“正确时机”注入自动启动命令,避免被 zsh 行编辑器初始化吞掉。
    let (ready_tx, ready_rx) = std::sync::mpsc::channel::<()>();
    let mut ready_signaled = false;

    // 读取线程:阻塞读 PTY 输出,base64 后 emit
    let app_for_thread = app.clone();
    let id_for_thread = id.clone();
    std::thread::spawn(move || {
        let mut buf = [0u8; 8192];
        loop {
            match reader.read(&mut buf) {
                Ok(0) => break, // EOF:shell 退出
                Ok(n) => {
                    if !ready_signaled {
                        ready_signaled = true;
                        let _ = ready_tx.send(());
                    }
                    let payload = TermOutput {
                        id: id_for_thread.clone(),
                        data: B64.encode(&buf[..n]),
                    };
                    if app_for_thread.emit("term-output", payload).is_err() {
                        break;
                    }
                }
                Err(_) => break,
            }
        }
        let _ = app_for_thread.emit("term-exit", TermExit { id: id_for_thread });
    });

    // 自动启动 agent:在 shell 提示符就绪后再写入启动命令(等价于在终端键入并回车)。
    // 用独立线程等待“就绪信号”+ 一点缓冲,确保命令不会在 shell 初始化期间被丢弃。
    if let Some(cmd_str) = effective_initial {
        let writer_for_cmd = Arc::clone(&writer);
        // 远程 ssh 登录较慢,给更长的就绪等待与缓冲
        let is_remote = remote.is_some();
        std::thread::spawn(move || {
            let wait = if is_remote { 20 } else { 5 };
            let buffer = if is_remote { 700 } else { 350 };
            let _ = ready_rx.recv_timeout(Duration::from_secs(wait));
            std::thread::sleep(Duration::from_millis(buffer));
            if let Ok(mut w) = writer_for_cmd.lock() {
                let line = format!("{}\r", cmd_str.trim());
                let _ = w.write_all(line.as_bytes());
                let _ = w.flush();
            }
        });
    }

    let mut map = state.0.lock().map_err(|e| e.to_string())?;
    map.insert(
        id,
        Session {
            master: pair.master,
            writer,
            child,
        },
    );
    Ok(())
}

/// 把数据写入终端 stdin(等价于在终端里键入)。
/// 这是“对话框 → 终端重定向”的核心:对话框发送的文本通过它进入 PTY。
#[tauri::command]
pub fn term_write(state: State<'_, TerminalState>, id: String, data: String) -> Result<(), String> {
    let map = state.0.lock().map_err(|e| e.to_string())?;
    let session = map.get(&id).ok_or("终端会话不存在")?;
    let mut w = session.writer.lock().map_err(|e| e.to_string())?;
    w.write_all(data.as_bytes()).map_err(|e| e.to_string())?;
    w.flush().map_err(|e| e.to_string())?;
    Ok(())
}

/// 终端尺寸变化时同步 PTY,保证 TUI 重绘正确。
#[tauri::command]
pub fn term_resize(
    state: State<'_, TerminalState>,
    id: String,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    let map = state.0.lock().map_err(|e| e.to_string())?;
    let session = map.get(&id).ok_or("终端会话不存在")?;
    session
        .master
        .resize(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// 结束终端会话。
#[tauri::command]
pub fn term_kill(state: State<'_, TerminalState>, id: String) -> Result<(), String> {
    let mut map = state.0.lock().map_err(|e| e.to_string())?;
    if let Some(mut session) = map.remove(&id) {
        let _ = session.child.kill();
    }
    Ok(())
}

fn dirs_home() -> Option<String> {
    crate::config::home_dir()
        .ok()
        .map(|p| p.to_string_lossy().to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use portable_pty::PtySize;
    use std::time::{Duration, Instant};

    /// 冒烟测试:验证 PTY 核心机制 —— 开 shell、写命令、读回输出。
    /// 这是“对话框 → 终端重定向”和“输出流式回传”的底层保证。
    #[test]
    fn pty_echo_roundtrip() {
        let pty_system = portable_pty::native_pty_system();
        let pair = pty_system
            .openpty(PtySize {
                rows: 24,
                cols: 80,
                pixel_width: 0,
                pixel_height: 0,
            })
            .expect("openpty");

        let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/sh".to_string());
        let mut cmd = CommandBuilder::new(&shell);
        cmd.arg("-l");
        cmd.env("TERM", "xterm-256color");

        let mut child = pair.slave.spawn_command(cmd).expect("spawn");
        drop(pair.slave);

        let mut reader = pair.master.try_clone_reader().expect("reader");
        let mut writer = pair.master.take_writer().expect("writer");

        // 写入一条会回显独特字符串的命令(模拟对话框发送)
        writer.write_all(b"echo LINCO_PTY_OK\r").expect("write");
        writer.flush().expect("flush");

        // 在限定时间内读取,直到看到回显
        let mut acc = String::new();
        let mut buf = [0u8; 4096];
        let deadline = Instant::now() + Duration::from_secs(5);
        let mut found = false;
        while Instant::now() < deadline {
            match reader.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => {
                    acc.push_str(&String::from_utf8_lossy(&buf[..n]));
                    if acc.contains("LINCO_PTY_OK") {
                        found = true;
                        break;
                    }
                }
                Err(_) => break,
            }
        }

        let _ = child.kill();
        assert!(found, "未在 PTY 输出中读到回显,实际输出:\n{acc}");
    }

    /// 验证“等就绪再注入”的自动启动时序:模拟交互式登录 shell,
    /// 先等到首个提示符输出 + 缓冲,再写入命令,确认命令被执行而非被吞掉。
    #[test]
    fn auto_start_waits_for_prompt() {
        use std::sync::mpsc;

        let pty_system = portable_pty::native_pty_system();
        let pair = pty_system
            .openpty(PtySize {
                rows: 24,
                cols: 80,
                pixel_width: 0,
                pixel_height: 0,
            })
            .expect("openpty");

        let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".to_string());
        let mut cmd = CommandBuilder::new(&shell);
        cmd.arg("-i"); // 交互式,触发行编辑器初始化(复现被吞场景)
        cmd.env("TERM", "xterm-256color");

        let mut child = pair.slave.spawn_command(cmd).expect("spawn");
        drop(pair.slave);

        let mut reader = pair.master.try_clone_reader().expect("reader");
        let writer = Arc::new(Mutex::new(pair.master.take_writer().expect("writer")));

        let (ready_tx, ready_rx) = mpsc::channel::<()>();
        let acc = Arc::new(Mutex::new(String::new()));
        let acc_reader = Arc::clone(&acc);

        std::thread::spawn(move || {
            let mut buf = [0u8; 4096];
            let mut signaled = false;
            loop {
                match reader.read(&mut buf) {
                    Ok(0) => break,
                    Ok(n) => {
                        if !signaled {
                            signaled = true;
                            let _ = ready_tx.send(());
                        }
                        acc_reader
                            .lock()
                            .unwrap()
                            .push_str(&String::from_utf8_lossy(&buf[..n]));
                    }
                    Err(_) => break,
                }
            }
        });

        // 与生产逻辑一致:等就绪信号 + 缓冲后再写命令
        let _ = ready_rx.recv_timeout(Duration::from_secs(5));
        std::thread::sleep(Duration::from_millis(350));
        {
            let mut w = writer.lock().unwrap();
            w.write_all(b"echo LINCO_AUTOSTART_OK\r").unwrap();
            w.flush().unwrap();
        }

        let deadline = Instant::now() + Duration::from_secs(5);
        let mut found = false;
        while Instant::now() < deadline {
            if acc.lock().unwrap().contains("LINCO_AUTOSTART_OK") {
                found = true;
                break;
            }
            std::thread::sleep(Duration::from_millis(50));
        }

        let _ = child.kill();
        assert!(
            found,
            "自动启动命令未被执行(被 shell 初始化吞掉),实际输出:\n{}",
            acc.lock().unwrap()
        );
    }
}
