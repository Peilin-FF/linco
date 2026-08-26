// Code agent 会话历史:按项目列出 / 删除 CLI 存的历史对话。
//
// 这些会话不是 Linco 存的,而是各家 CLI 自己写在磁盘上的转录文件:
//   - Claude Code: ~/.claude/projects/<编码后的项目路径>/<uuid>.jsonl
//     编码规则:把项目绝对路径里每个非字母数字字符替换成 '-'。
//     天然一项目一目录,所以按项目过滤 = 只读那个目录。
//   - Codex: ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl(按日期,不按项目),
//     每个文件首行 session_meta.payload.cwd 标明它属于哪个项目 → 据此过滤。
//
// 远程连接(host 非空)时,会话在远端机器上,经持久 SSH 通道用 shell 读取。

use std::fs;
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::mpsc;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::json;

#[derive(Deserialize, Serialize)]
pub struct SessionInfo {
    /// 文件名去掉 .jsonl —— 删除时回传这个做定位
    pub id: String,
    /// 首条用户消息(截断、单行)作为标题;取不到则用时间/ id 兜底
    pub title: String,
    /// 修改时间(Unix 秒),前端据此显示「多久以前」并排序
    pub mtime: u64,
    /// 文件字节数(粗略反映会话长度)
    pub size: u64,
}

fn home() -> Result<PathBuf, String> {
    crate::config::home_dir()
}

/// 把项目绝对路径编码成 Claude 的目录名:非字母数字 → '-'。
fn encode_project_path(cwd: &str) -> String {
    cwd.chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
        .collect()
}

/// 是否 codex(否则按 claude 处理)。
fn is_codex(provider: &str) -> bool {
    provider == "openai" || provider == "codex"
}

/// 把一行长文本压成单行短标题(去换行、压空白、截断)。
fn make_title(raw: &str) -> String {
    let one: String = raw.split_whitespace().collect::<Vec<_>>().join(" ");
    let trimmed = one.trim();
    let max = 48usize;
    if trimmed.chars().count() > max {
        let s: String = trimmed.chars().take(max).collect();
        format!("{s}…")
    } else {
        trimmed.to_string()
    }
}

/// 该文本是否是机器注入的上下文(非用户真实输入),用于跳过取标题。
fn is_injected_context(text: &str) -> bool {
    let t = text.trim_start();
    t.starts_with("<environment_context>")
        || t.starts_with("<user_instructions>")
        || t.starts_with("<codex_internal_context")
        || t.starts_with("<system-reminder>")
        || t.starts_with("# AGENTS.md instructions")
        || t.starts_with("Caveat:")
}

/// 从 Claude 的 jsonl 内容里取首条用户消息文本。
fn claude_title(content: &str) -> Option<String> {
    for line in content.lines() {
        let v: serde_json::Value = match serde_json::from_str(line) {
            Ok(v) => v,
            Err(_) => continue,
        };
        if v.get("type").and_then(|t| t.as_str()) != Some("user") {
            continue;
        }
        let msg = v.get("message")?;
        let c = msg.get("content")?;
        // content 可能是字符串或 [{type:text,text:..}]
        if let Some(s) = c.as_str() {
            if !is_injected_context(s) {
                return Some(make_title(s));
            }
            continue;
        }
        if let Some(arr) = c.as_array() {
            for block in arr {
                if block.get("type").and_then(|t| t.as_str()) == Some("text") {
                    if let Some(s) = block.get("text").and_then(|t| t.as_str()) {
                        if !is_injected_context(s) {
                            return Some(make_title(s));
                        }
                    }
                }
            }
        }
    }
    None
}

struct CodexMeta {
    cwd: Option<String>,
    session_id: Option<String>,
    title: Option<String>,
    is_subagent: bool,
    is_interactive: bool,
}

/// Read the resumable UUID, project path, title, and source from a Codex rollout.
fn codex_meta(content: &str) -> CodexMeta {
    let mut cwd: Option<String> = None;
    let mut session_id: Option<String> = None;
    let mut title: Option<String> = None;
    let mut is_subagent = false;
    let mut is_interactive = false;
    for line in content.lines() {
        let v: serde_json::Value = match serde_json::from_str(line) {
            Ok(v) => v,
            Err(_) => continue,
        };
        let ty = v.get("type").and_then(|t| t.as_str()).unwrap_or("");
        if ty == "session_meta" {
            let payload = v.get("payload").unwrap_or(&v);
            if let Some(c) = payload.get("cwd").and_then(|c| c.as_str()) {
                cwd = Some(c.to_string());
            }
            if let Some(id) = payload.get("id").and_then(|id| id.as_str()) {
                session_id = Some(id.to_string());
            }
            if let Some(source) = payload.get("source") {
                is_subagent = source.get("subagent").is_some();
                is_interactive = source
                    .as_str()
                    .is_some_and(|kind| kind == "cli" || kind == "vscode");
            }
        } else if ty == "response_item" && title.is_none() {
            let p = v.get("payload").unwrap_or(&v);
            if p.get("role").and_then(|r| r.as_str()) == Some("user") {
                if let Some(arr) = p.get("content").and_then(|c| c.as_array()) {
                    for block in arr {
                        if let Some(s) = block.get("text").and_then(|t| t.as_str()) {
                            if !is_injected_context(s) {
                                title = Some(make_title(s));
                                break;
                            }
                        }
                    }
                }
            }
        }
        if cwd.is_some() && session_id.is_some() && title.is_some() {
            break;
        }
    }
    CodexMeta {
        cwd,
        session_id,
        title,
        is_subagent,
        is_interactive,
    }
}

fn normalize_project_path(raw: &str) -> String {
    let path = fs::canonicalize(raw).unwrap_or_else(|_| PathBuf::from(raw));
    let mut normalized = path.to_string_lossy().replace('\\', "/");
    if let Some(rest) = normalized.strip_prefix("//?/") {
        normalized = rest.to_string();
    }
    while normalized.len() > 1 && normalized.ends_with('/') {
        normalized.pop();
    }
    if cfg!(target_os = "windows") {
        normalized.make_ascii_lowercase();
    }
    normalized
}

fn same_project_path(left: &str, right: &str) -> bool {
    normalize_project_path(left) == normalize_project_path(right)
}

const CODEX_RESUME_PAGE_SIZE: usize = 25;

/// Ask Codex's own app-server for the same first page shown by `/resume`.
fn list_codex_via_app_server(cwd: &str) -> Result<Vec<SessionInfo>, String> {
    let executable = if cfg!(windows) { "codex.cmd" } else { "codex" };
    let mut child = Command::new(executable)
        .args(["app-server", "--stdio"])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|error| format!("failed to start Codex app-server: {error}"))?;

    let mut stdin = child
        .stdin
        .take()
        .ok_or_else(|| "Codex app-server stdin unavailable".to_string())?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "Codex app-server stdout unavailable".to_string())?;
    let requests = [
        json!({
            "method": "initialize",
            "id": 1,
            "params": {
                "clientInfo": { "name": "linco", "title": "Linco", "version": env!("CARGO_PKG_VERSION") }
            }
        }),
        json!({ "method": "initialized", "params": {} }),
        json!({
            "method": "thread/list",
            "id": 2,
            "params": {
                "limit": CODEX_RESUME_PAGE_SIZE,
                "sortKey": "updated_at",
                "modelProviders": ["openai"],
                "sourceKinds": ["cli", "vscode"],
                "archived": false,
                "cwd": cwd,
                "useStateDbOnly": true
            }
        }),
    ];
    for request in requests {
        serde_json::to_writer(&mut stdin, &request).map_err(|error| error.to_string())?;
        stdin.write_all(b"\n").map_err(|error| error.to_string())?;
    }
    stdin.flush().map_err(|error| error.to_string())?;

    let (sender, receiver) = mpsc::channel();
    std::thread::spawn(move || {
        for line in BufReader::new(stdout).lines().map_while(Result::ok) {
            let Ok(value) = serde_json::from_str::<serde_json::Value>(&line) else {
                continue;
            };
            if value.get("id").and_then(|id| id.as_i64()) == Some(2) {
                let _ = sender.send(value);
                break;
            }
        }
    });

    let response = receiver
        .recv_timeout(Duration::from_secs(15))
        .map_err(|_| "Codex app-server thread/list timed out".to_string());
    drop(stdin);
    let _ = child.kill();
    let _ = child.wait();
    let response = response?;
    if let Some(error) = response.get("error") {
        return Err(format!("Codex app-server thread/list failed: {error}"));
    }

    let rows = response
        .pointer("/result/data")
        .and_then(|value| value.as_array())
        .ok_or_else(|| "Codex app-server returned an invalid thread list".to_string())?;
    Ok(rows
        .iter()
        .filter_map(|thread| {
            let id = thread.get("id")?.as_str()?.to_string();
            let title = thread
                .get("preview")
                .and_then(|value| value.as_str())
                .filter(|value| !value.trim().is_empty())
                .map(make_title)
                .unwrap_or_else(|| short_id(&id));
            let mtime = thread
                .get("updatedAt")
                .and_then(|value| value.as_u64())
                .unwrap_or(0);
            let size = thread
                .get("path")
                .and_then(|value| value.as_str())
                .and_then(|path| fs::metadata(path).ok())
                .map(|metadata| metadata.len())
                .unwrap_or(0);
            Some(SessionInfo {
                id,
                title,
                mtime,
                size,
            })
        })
        .collect())
}

/// 本地:列 Claude 项目目录下的会话。
fn list_claude_local(cwd: &str) -> Result<Vec<SessionInfo>, String> {
    let dir = home()?
        .join(".claude")
        .join("projects")
        .join(encode_project_path(cwd));
    if !dir.is_dir() {
        return Ok(vec![]);
    }
    let mut out = Vec::new();
    for entry in fs::read_dir(&dir).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("jsonl") {
            continue;
        }
        let meta = entry.metadata().map_err(|e| e.to_string())?;
        let mtime = mtime_secs(&meta);
        let id = path
            .file_stem()
            .map(|s| s.to_string_lossy().to_string())
            .unwrap_or_default();
        // 只读前面若干字节足够拿到首条用户消息,避免整文件载入
        let title = read_head(&path, 64 * 1024)
            .ok()
            .and_then(|c| claude_title(&c))
            .unwrap_or_else(|| short_id(&id));
        out.push(SessionInfo {
            id,
            title,
            mtime,
            size: meta.len(),
        });
    }
    out.sort_by(|a, b| b.mtime.cmp(&a.mtime));
    Ok(out)
}

/// 本地:扫 Codex 全量会话,按 cwd 过滤出本项目的。
fn list_codex_local(cwd: &str) -> Result<Vec<SessionInfo>, String> {
    if let Ok(sessions) = list_codex_via_app_server(cwd) {
        return Ok(sessions);
    }
    let root = home()?.join(".codex").join("sessions");
    if !root.is_dir() {
        return Ok(vec![]);
    }
    let mut out = Vec::new();
    collect_codex(&root, cwd, &mut out)?;
    out.sort_by(|a, b| b.mtime.cmp(&a.mtime));
    out.truncate(CODEX_RESUME_PAGE_SIZE);
    Ok(out)
}

/// 递归走 ~/.codex/sessions/YYYY/MM/DD/*.jsonl。
fn collect_codex(dir: &Path, cwd: &str, out: &mut Vec<SessionInfo>) -> Result<(), String> {
    for entry in fs::read_dir(dir).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let path = entry.path();
        if path.is_dir() {
            collect_codex(&path, cwd, out)?;
            continue;
        }
        if path.extension().and_then(|e| e.to_str()) != Some("jsonl") {
            continue;
        }
        let content = match read_head(&path, 64 * 1024) {
            Ok(c) => c,
            Err(_) => continue,
        };
        let session = codex_meta(&content);
        if session.is_subagent
            || !session.is_interactive
            || !session
                .cwd
                .as_deref()
                .is_some_and(|file_cwd| same_project_path(file_cwd, cwd))
        {
            continue; // 不是本项目的会话
        }
        let meta = entry.metadata().map_err(|e| e.to_string())?;
        let file_id = path
            .file_stem()
            .map(|s| s.to_string_lossy().to_string())
            .unwrap_or_default();
        let id = session.session_id.unwrap_or(file_id);
        out.push(SessionInfo {
            id: id.clone(),
            title: session.title.unwrap_or_else(|| short_id(&id)),
            mtime: mtime_secs(&meta),
            size: meta.len(),
        });
    }
    Ok(())
}

fn mtime_secs(meta: &fs::Metadata) -> u64 {
    meta.modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// id 兜底短名(取前 8 位)。
fn short_id(id: &str) -> String {
    let s: String = id.chars().take(8).collect();
    s
}

/// 只读文件前 n 字节(会话转录可能很大,取标题无需整读)。
fn read_head(path: &Path, n: u64) -> Result<String, String> {
    use std::io::Read;
    let f = fs::File::open(path).map_err(|e| e.to_string())?;
    let mut buf = Vec::new();
    f.take(n).read_to_end(&mut buf).map_err(|e| e.to_string())?;
    Ok(String::from_utf8_lossy(&buf).to_string())
}

/// 远程:经 SSH 列会话目录(claude)。标题取不到,用 id + 时间。
fn list_remote(host: &str, provider: &str, cwd: &str) -> Result<Vec<SessionInfo>, String> {
    if is_codex(provider) {
        let value = crate::agent_rpc::call_background_timeout(
            host,
            "agent_sessions",
            json!({ "cwd": cwd }),
            Duration::from_secs(30),
        )?;
        let sessions = value
            .get("sessions")
            .cloned()
            .unwrap_or_else(|| serde_json::Value::Array(Vec::new()));
        return serde_json::from_value(sessions).map_err(|error| error.to_string());
    }

    // 远端 HOME
    let home = crate::remote::run_remote(host, "printf %s \"$HOME\"")
        .map(|b| String::from_utf8_lossy(&b).trim().to_string())?;
    if home.is_empty() {
        return Ok(vec![]);
    }
    let dir = format!(
        "{}/.claude/projects/{}",
        home.trim_end_matches('/'),
        encode_project_path(cwd)
    );
    // 每行: "<mtime秒> <字节> <文件名>"
    let script = format!(
        "d={}; [ -d \"$d\" ] || exit 0; for f in \"$d\"/*.jsonl; do [ -e \"$f\" ] || continue; \
         m=$(stat -c %Y \"$f\" 2>/dev/null || stat -f %m \"$f\"); \
         s=$(stat -c %s \"$f\" 2>/dev/null || stat -f %z \"$f\"); \
         printf '%s %s %s\\n' \"$m\" \"$s\" \"$(basename \"$f\" .jsonl)\"; done",
        crate::remote::shq(&dir)
    );
    let raw = crate::remote::run_remote(host, &script)?;
    let text = String::from_utf8_lossy(&raw);
    let mut out = Vec::new();
    for line in text.lines() {
        let mut it = line.splitn(3, ' ');
        let m = it.next().unwrap_or("0").parse::<u64>().unwrap_or(0);
        let s = it.next().unwrap_or("0").parse::<u64>().unwrap_or(0);
        let id = match it.next() {
            Some(id) if !id.is_empty() => id.to_string(),
            _ => continue,
        };
        out.push(SessionInfo {
            title: short_id(&id),
            id,
            mtime: m,
            size: s,
        });
    }
    out.sort_by(|a, b| b.mtime.cmp(&a.mtime));
    Ok(out)
}

/// 列出当前项目的 agent 历史会话(newest first)。
#[tauri::command]
pub async fn agent_sessions(
    cwd: String,
    provider: String,
    host: Option<String>,
) -> Result<Vec<SessionInfo>, String> {
    crate::blocking::run(move || {
        if cwd.trim().is_empty() {
            return Ok(vec![]);
        }
        if let Some(h) = host.filter(|s| !s.is_empty()) {
            return list_remote(&h, &provider, &cwd);
        }
        if is_codex(&provider) {
            list_codex_local(&cwd)
        } else {
            list_claude_local(&cwd)
        }
    })
    .await
}

/// 删除一个会话文件。id 必须是无路径分隔符的纯文件名干,防目录穿越。
#[tauri::command]
pub async fn agent_session_delete(
    cwd: String,
    provider: String,
    id: String,
    host: Option<String>,
) -> Result<(), String> {
    crate::blocking::run(move || {
        if id.contains('/') || id.contains('\\') || id.contains("..") || id.is_empty() {
            return Err("非法会话 id".into());
        }
        if let Some(h) = host.filter(|s| !s.is_empty()) {
            if is_codex(&provider) {
                crate::agent_rpc::call_background_timeout(
                    &h,
                    "agent_session_delete",
                    json!({ "cwd": cwd, "id": id }),
                    Duration::from_secs(30),
                )?;
                return Ok(());
            }
            let home = crate::remote::run_remote(&h, "printf %s \"$HOME\"")
                .map(|b| String::from_utf8_lossy(&b).trim().to_string())?;
            if home.is_empty() {
                return Err("无法解析远端 HOME".into());
            }
            let path = format!(
                "{}/.claude/projects/{}/{}.jsonl",
                home.trim_end_matches('/'),
                encode_project_path(&cwd),
                id
            );
            crate::remote::run_remote(&h, &format!("rm -f -- {}", crate::remote::shq(&path)))?;
            return Ok(());
        }
        // 本地
        let path = if is_codex(&provider) {
            // codex 文件名不含项目,需扫出匹配 id 的文件
            find_codex_file(&id)?
        } else {
            home()?
                .join(".claude")
                .join("projects")
                .join(encode_project_path(&cwd))
                .join(format!("{id}.jsonl"))
        };
        if path.exists() {
            fs::remove_file(&path).map_err(|e| e.to_string())?;
        }
        Ok(())
    })
    .await
}

/// codex:按 id(文件名干)在 sessions 树里找到对应文件。
fn find_codex_file(id: &str) -> Result<PathBuf, String> {
    let root = home()?.join(".codex").join("sessions");
    fn walk(dir: &Path, id: &str) -> Option<PathBuf> {
        let rd = fs::read_dir(dir).ok()?;
        for entry in rd.flatten() {
            let path = entry.path();
            if path.is_dir() {
                if let Some(p) = walk(&path, id) {
                    return Some(p);
                }
            } else if path.extension().and_then(|e| e.to_str()) == Some("jsonl") {
                let matches = path
                    .file_stem()
                    .map(|stem| {
                        let stem = stem.to_string_lossy();
                        stem == id || stem.ends_with(&format!("-{id}"))
                    })
                    .unwrap_or(false);
                if matches {
                    return Some(path);
                }
            }
        }
        None
    }
    walk(&root, id).ok_or_else(|| "未找到该会话文件".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn encodes_project_path_like_claude() {
        assert_eq!(
            encode_project_path("/Users/tester/project"),
            "-Users-tester-project"
        );
    }

    #[test]
    fn title_skips_injected_context() {
        let jsonl = r#"{"type":"user","message":{"content":"<environment_context>x</environment_context>"}}
{"type":"user","message":{"content":"帮我修一个 bug"}}"#;
        assert_eq!(claude_title(jsonl).as_deref(), Some("帮我修一个 bug"));
    }

    #[test]
    fn codex_meta_uses_uuid_and_skips_agent_instructions() {
        let jsonl = r##"{"type":"session_meta","payload":{"id":"019f-test","cwd":"C:\\work\\app","source":"cli"}}
{"type":"response_item","payload":{"role":"user","content":[{"type":"input_text","text":"# AGENTS.md instructions\n<INSTRUCTIONS>test</INSTRUCTIONS>"}]}}
{"type":"response_item","payload":{"role":"user","content":[{"type":"input_text","text":"Fix the history list"}]}}"##;
        let meta = codex_meta(jsonl);
        assert_eq!(meta.session_id.as_deref(), Some("019f-test"));
        assert_eq!(meta.cwd.as_deref(), Some(r"C:\work\app"));
        assert_eq!(meta.title.as_deref(), Some("Fix the history list"));
        assert!(!meta.is_subagent);
        assert!(meta.is_interactive);
    }

    #[test]
    fn codex_meta_marks_subagent_sessions() {
        let jsonl = r#"{"type":"session_meta","payload":{"id":"child","cwd":"/work/app","source":{"subagent":{"thread_spawn":{"parent_thread_id":"root"}}}}}"#;
        assert!(codex_meta(jsonl).is_subagent);
    }

    #[test]
    fn codex_meta_excludes_non_interactive_sessions() {
        let jsonl = r#"{"type":"session_meta","payload":{"id":"worker","cwd":"/work/app","source":"app_server"}}"#;
        assert!(!codex_meta(jsonl).is_interactive);
    }

    #[test]
    fn codex_collection_keeps_only_direct_sessions_for_project() {
        let root = std::env::temp_dir().join(format!(
            "linco-codex-sessions-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let day = root.join("2026").join("07").join("23");
        fs::create_dir_all(&day).unwrap();
        fs::write(
            day.join("rollout-direct-root-id.jsonl"),
            r#"{"type":"session_meta","payload":{"id":"root-id","cwd":"C:\\work\\app","source":"cli"}}
{"type":"response_item","payload":{"role":"user","content":[{"type":"input_text","text":"Direct conversation"}]}}"#,
        )
        .unwrap();
        fs::write(
            day.join("rollout-subagent-id.jsonl"),
            r#"{"type":"session_meta","payload":{"id":"subagent-id","cwd":"C:\\work\\app","source":{"subagent":{"thread_spawn":{"parent_thread_id":"root-id"}}}}}
{"type":"response_item","payload":{"role":"user","content":[{"type":"input_text","text":"Internal worker"}]}}"#,
        )
        .unwrap();
        fs::write(
            day.join("rollout-other-project.jsonl"),
            r#"{"type":"session_meta","payload":{"id":"other-id","cwd":"C:\\work\\other","source":"cli"}}
{"type":"response_item","payload":{"role":"user","content":[{"type":"input_text","text":"Other project"}]}}"#,
        )
        .unwrap();

        let mut sessions = Vec::new();
        let project = if cfg!(target_os = "windows") {
            r"c:\WORK\app"
        } else {
            r"C:\work\app"
        };
        collect_codex(&root, project, &mut sessions).unwrap();

        assert_eq!(sessions.len(), 1);
        assert_eq!(sessions[0].id, "root-id");
        assert_eq!(sessions[0].title, "Direct conversation");
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn project_paths_ignore_windows_case_and_verbatim_prefix() {
        if cfg!(target_os = "windows") {
            assert!(same_project_path(
                r"\\?\C:\Users\Tester\Project\\",
                r"c:\users\tester\project"
            ));
        }
    }

    #[test]
    fn title_truncates_long_text() {
        let long = "a".repeat(100);
        let t = make_title(&long);
        assert!(t.ends_with('…'));
        assert!(t.chars().count() <= 49);
    }
}
