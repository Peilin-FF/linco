// Agent 进程管理:用 `claude -p --output-format stream-json` 驱动对话。
//
// 与 terminal.rs(PTY/TUI)不同,这里用普通管道跑非交互模式:
// claude 仍是完整的 Claude Code(读写文件、跑命令、用工具、读 CLAUDE.md/MCP),
// 但不渲染 TUI,而是按行吐结构化 JSON。我们按行读 stdout,逐行 emit 给前端,
// 由前端解析成气泡 UI,实现丝滑流式渲染。

use std::collections::HashMap;
use std::io::{BufRead, BufReader};
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};

/// 运行中的 agent 进程表,按对话 id 索引,支持取消。
#[derive(Default)]
pub struct AgentState(pub Mutex<HashMap<String, Child>>);

#[derive(Clone, Serialize)]
struct AgentEvent {
    id: String,
    /// 一行原始 JSON(由前端解析)
    line: String,
}

#[derive(Clone, Serialize)]
struct AgentDone {
    id: String,
    /// 进程退出码(None 表示被 kill)
    code: Option<i32>,
}

/// 发送一次提问,启动 claude 进程并流式回传输出。
///
/// - `command_base`:启动命令(默认 "claude",可换 codex 等兼容 CLI)
/// - `session_id`:非空则 `--resume <id>` 续接多轮上下文
/// - `permission_mode`:default / acceptEdits / bypassPermissions 等
/// - `env`:注入的环境变量(API Key / base url)
#[tauri::command]
pub fn agent_send(
    app: AppHandle,
    state: State<'_, AgentState>,
    id: String,
    prompt: String,
    command_base: Option<String>,
    cwd: Option<String>,
    env: Option<HashMap<String, String>>,
    session_id: Option<String>,
    permission_mode: Option<String>,
) -> Result<(), String> {
    // 若同 id 仍有进程在跑,先杀掉
    {
        let mut map = state.0.lock().map_err(|e| e.to_string())?;
        if let Some(mut old) = map.remove(&id) {
            let _ = old.kill();
        }
    }

    let base = command_base
        .filter(|c| !c.trim().is_empty())
        .unwrap_or_else(|| "claude".to_string());

    // 通过登录 shell 启动,确保 PATH 能找到用户安装的 CLI(homebrew/npm 等)。
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".to_string());

    let mut args = vec![
        base.clone(),
        "-p".into(),
        shell_quote(&prompt),
        "--output-format".into(),
        "stream-json".into(),
        "--verbose".into(),
        "--include-partial-messages".into(),
    ];
    if let Some(sid) = session_id.filter(|s| !s.trim().is_empty()) {
        args.push("--resume".into());
        args.push(shell_quote(&sid));
    }
    if let Some(mode) = permission_mode.filter(|m| !m.trim().is_empty()) {
        args.push("--permission-mode".into());
        args.push(mode);
    }
    let command_line = args.join(" ");

    let mut cmd = Command::new(&shell);
    cmd.arg("-lc").arg(&command_line);
    cmd.env("TERM", "xterm-256color");
    if let Some(vars) = &env {
        for (k, v) in vars {
            if !k.is_empty() {
                cmd.env(k, v);
            }
        }
    }
    if let Some(dir) = cwd.filter(|d| !d.is_empty()) {
        cmd.current_dir(dir);
    }
    cmd.stdin(Stdio::null());
    cmd.stdout(Stdio::piped());
    cmd.stderr(Stdio::piped());

    let mut child = cmd.spawn().map_err(|e| format!("启动 agent 失败: {e}"))?;

    let stdout = child
        .stdout
        .take()
        .ok_or("无法获取 stdout".to_string())?;
    let stderr = child.stderr.take();

    // stdout 读取线程:按行 emit
    let app_out = app.clone();
    let id_out = id.clone();
    std::thread::spawn(move || {
        let reader = BufReader::new(stdout);
        for line in reader.lines() {
            match line {
                Ok(l) if !l.is_empty() => {
                    let _ = app_out.emit(
                        "agent-event",
                        AgentEvent {
                            id: id_out.clone(),
                            line: l,
                        },
                    );
                }
                Ok(_) => {}
                Err(_) => break,
            }
        }
    });

    // stderr 读取线程:把错误也作为事件发出(前端可显示)
    if let Some(stderr) = stderr {
        let app_err = app.clone();
        let id_err = id.clone();
        std::thread::spawn(move || {
            let reader = BufReader::new(stderr);
            for line in reader.lines().map_while(Result::ok) {
                if line.is_empty() {
                    continue;
                }
                // 包装成一个 stderr 类型事件(前端按 type 区分)
                let payload = format!(
                    "{{\"type\":\"linco_stderr\",\"text\":{}}}",
                    json_string(&line)
                );
                let _ = app_err.emit(
                    "agent-event",
                    AgentEvent {
                        id: id_err.clone(),
                        line: payload,
                    },
                );
            }
        });
    }

    // 等待线程:进程结束后清理并通知前端
    let app_done = app.clone();
    let id_done = id.clone();
    // 把 child 存入 state(供取消使用);等待线程通过 app.state() 取回轮询
    {
        let mut map = state.0.lock().map_err(|e| e.to_string())?;
        map.insert(id.clone(), child);
    }
    std::thread::spawn(move || {
        // 轮询等待进程结束(简单可靠;子进程不多)
        loop {
            std::thread::sleep(std::time::Duration::from_millis(120));
            let state = app_done.state::<AgentState>();
            let mut map = match state.0.lock() {
                Ok(m) => m,
                Err(_) => break,
            };
            let finished = match map.get_mut(&id_done) {
                Some(c) => match c.try_wait() {
                    Ok(Some(status)) => Some(status.code()),
                    Ok(None) => None,
                    Err(_) => Some(None),
                },
                None => Some(None), // 已被取消/移除
            };
            if let Some(code) = finished {
                map.remove(&id_done);
                drop(map);
                let _ = app_done.emit(
                    "agent-done",
                    AgentDone {
                        id: id_done.clone(),
                        code,
                    },
                );
                break;
            }
        }
    });

    Ok(())
}

/// 取消正在运行的 agent。
#[tauri::command]
pub fn agent_cancel(state: State<'_, AgentState>, id: String) -> Result<(), String> {
    let mut map = state.0.lock().map_err(|e| e.to_string())?;
    if let Some(mut child) = map.remove(&id) {
        let _ = child.kill();
    }
    Ok(())
}

/// 简单 shell 单引号转义,安全地把任意文本作为一个参数传给登录 shell。
fn shell_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', "'\\''"))
}

/// 把字符串转成合法 JSON 字符串字面量(含引号)。
fn json_string(s: &str) -> String {
    serde_json::to_string(s).unwrap_or_else(|_| "\"\"".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn shell_quote_escapes_single_quotes() {
        assert_eq!(shell_quote("hello"), "'hello'");
        assert_eq!(shell_quote("it's"), "'it'\\''s'");
    }

    #[test]
    fn json_string_is_valid() {
        assert_eq!(json_string("a\"b"), "\"a\\\"b\"");
    }
}
