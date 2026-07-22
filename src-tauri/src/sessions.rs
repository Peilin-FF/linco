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
use std::path::{Path, PathBuf};

use serde::Serialize;

#[derive(Serialize)]
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
        || t.starts_with("<system-reminder>")
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

/// 从 Codex 的 jsonl 内容里取 cwd 与首条真实用户消息。
/// 返回 (cwd, title)。
fn codex_meta(content: &str) -> (Option<String>, Option<String>) {
    let mut cwd: Option<String> = None;
    let mut title: Option<String> = None;
    for line in content.lines() {
        let v: serde_json::Value = match serde_json::from_str(line) {
            Ok(v) => v,
            Err(_) => continue,
        };
        let ty = v.get("type").and_then(|t| t.as_str()).unwrap_or("");
        if ty == "session_meta" {
            if let Some(c) = v
                .get("payload")
                .and_then(|p| p.get("cwd"))
                .and_then(|c| c.as_str())
            {
                cwd = Some(c.to_string());
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
        if cwd.is_some() && title.is_some() {
            break;
        }
    }
    (cwd, title)
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
    let root = home()?.join(".codex").join("sessions");
    if !root.is_dir() {
        return Ok(vec![]);
    }
    let mut out = Vec::new();
    collect_codex(&root, cwd, &mut out)?;
    out.sort_by(|a, b| b.mtime.cmp(&a.mtime));
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
        let (file_cwd, title) = codex_meta(&content);
        if file_cwd.as_deref() != Some(cwd) {
            continue; // 不是本项目的会话
        }
        let meta = entry.metadata().map_err(|e| e.to_string())?;
        let id = path
            .file_stem()
            .map(|s| s.to_string_lossy().to_string())
            .unwrap_or_default();
        out.push(SessionInfo {
            id: id.clone(),
            title: title.unwrap_or_else(|| short_id(&id)),
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
    // 远端 HOME
    let home = crate::remote::run_remote(host, "printf %s \"$HOME\"")
        .map(|b| String::from_utf8_lossy(&b).trim().to_string())?;
    if home.is_empty() {
        return Ok(vec![]);
    }
    let dir = if is_codex(provider) {
        // codex 远端按日期存,过滤成本高;暂只支持 claude 远端,codex 返回空
        return Ok(vec![]);
    } else {
        format!(
            "{}/.claude/projects/{}",
            home.trim_end_matches('/'),
            encode_project_path(cwd)
        )
    };
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
            let home = crate::remote::run_remote(&h, "printf %s \"$HOME\"")
                .map(|b| String::from_utf8_lossy(&b).trim().to_string())?;
            if home.is_empty() {
                return Err("无法解析远端 HOME".into());
            }
            if is_codex(&provider) {
                return Err("远程暂不支持删除 Codex 会话".into());
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
            } else if path.extension().and_then(|e| e.to_str()) == Some("jsonl")
                && path
                    .file_stem()
                    .map(|s| s.to_string_lossy() == id)
                    .unwrap_or(false)
            {
                return Some(path);
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
    fn title_truncates_long_text() {
        let long = "a".repeat(100);
        let t = make_title(&long);
        assert!(t.ends_with('…'));
        assert!(t.chars().count() <= 49);
    }
}
