// 补全数据源:为聊天输入框的 / $ @ 补全提供命令/技能列表。
//
// 对话本体只走 PTY/TUI。这里不启动任何非交互 agent 进程,避免补全路径
// 和真实对话路径分叉。Claude 只提供静态内置命令 + 本地 ~/.claude/skills/ 兜底;
// Codex / 其他 agent 暂无可读命令源,返回空。
// 文件补全 @ 不在这里——前端直接复用 fs.listDir。
//
// 带缓存(host + command_base，5 分钟),避免重复读目录。

use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use serde::Serialize;

#[derive(Serialize, Clone)]
pub struct CompletionData {
    pub commands: Vec<String>,
    pub skills: Vec<String>,
    pub agents: Vec<String>,
}

struct Cached {
    data: CompletionData,
    at: Instant,
}

static CACHE: OnceLock<Mutex<HashMap<String, Cached>>> = OnceLock::new();
const TTL: Duration = Duration::from_secs(300);

fn cache() -> &'static Mutex<HashMap<String, Cached>> {
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

/// 取某 agent 的补全数据(命令/技能/子 agent)。带缓存。
#[tauri::command]
pub async fn agent_completions(
    command_base: String,
    cwd: Option<String>,
    host: Option<String>,
) -> Result<CompletionData, String> {
    crate::blocking::run(move || agent_completions_blocking(command_base, cwd, host)).await
}

fn agent_completions_blocking(
    command_base: String,
    _cwd: Option<String>,
    host: Option<String>,
) -> Result<CompletionData, String> {
    let base = command_base.trim();
    let host_key = host.as_deref().unwrap_or("");
    let key = format!("{host_key}|{base}");

    // 命中缓存
    if let Ok(map) = cache().lock() {
        if let Some(c) = map.get(&key) {
            if c.at.elapsed() < TTL {
                return Ok(c.data.clone());
            }
        }
    }

    let data = match base {
        b if b.contains("claude") => claude_completions(&host),
        // codex / openclaw 等:暂无可读命令源,返回空(留扩展位)
        _ => CompletionData {
            commands: vec![],
            skills: vec![],
            agents: vec![],
        },
    };

    if let Ok(mut map) = cache().lock() {
        map.insert(
            key,
            Cached {
                data: data.clone(),
                at: Instant::now(),
            },
        );
    }
    Ok(data)
}

fn claude_completions(host: &Option<String>) -> CompletionData {
    let skills = if host.as_deref().filter(|s| !s.is_empty()).is_none() {
        read_local_skills().unwrap_or_default()
    } else {
        vec![]
    };
    CompletionData {
        commands: BUILTIN_COMMANDS.iter().map(|c| (*c).to_string()).collect(),
        skills,
        agents: vec![],
    }
}

/// Claude 的内置斜杠命令。实测逐字母枚举 TUI 菜单得到这批名字。
const BUILTIN_COMMANDS: &[&str] = &[
    "add-dir",
    "agents",
    "background",
    "branch",
    "btw",
    "clear",
    "color",
    "compact",
    "config",
    "context",
    "copy",
    "diff",
    "doctor",
    "effort",
    "exit",
    "export",
    "fast",
    "feedback",
    "focus",
    "help",
    "hooks",
    "ide",
    "init",
    "keybindings",
    "login",
    "logout",
    "loop",
    "mcp",
    "memory",
    "model",
    "permissions",
    "plan",
    "plugin",
    "powerup",
    "recap",
    "release-notes",
    "reload-plugins",
    "reload-skills",
    "rename",
    "resume",
    "review",
    "rewind",
    "run",
    "sandbox",
    "security-review",
    "skills",
    "status",
    "statusline",
    "stickers",
    "tasks",
    "terminal-setup",
    "theme",
    "tui",
    "usage",
    "verify",
    "workflows",
];

fn read_local_skills() -> Option<Vec<String>> {
    let home = std::env::var("HOME").ok()?;
    let dir = std::path::PathBuf::from(home)
        .join(".claude")
        .join("skills");
    let mut out: Vec<String> = std::fs::read_dir(dir)
        .ok()?
        .flatten()
        .filter(|e| e.file_type().map(|t| t.is_dir()).unwrap_or(false))
        .map(|e| e.file_name().to_string_lossy().to_string())
        .collect();
    out.sort();
    Some(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn claude_completion_uses_static_tui_commands() {
        let d = claude_completions(&None);
        assert!(d.commands.iter().any(|c| c == "resume"));
        assert!(d.commands.iter().any(|c| c == "rewind"));
        assert!(d.commands.iter().any(|c| c == "config"));
        assert!(d.agents.is_empty());
    }

    #[test]
    fn non_claude_completion_stays_empty_until_a_tui_source_exists() {
        let d = agent_completions_blocking("codex".into(), None, None).expect("completion");
        assert!(d.commands.is_empty());
        assert!(d.skills.is_empty());
        assert!(d.agents.is_empty());
    }
}
