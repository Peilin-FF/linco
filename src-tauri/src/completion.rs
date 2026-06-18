// 补全数据源:为聊天输入框的 / $ @ 补全提供命令/技能列表。
//
// 按 agent 分发(用户诉求:启动 claude 跟 claude、启动 codex 跟 codex):
// - claude:跑 `claude -p '' --output-format stream-json --verbose`,解析首行
//   system/init 事件里的 slash_commands / skills(最准、自动跟版本)。
//   兜底:读 ~/.claude/skills/ 目录。
// - codex / 其他:暂无可读命令源,返回空(诚实);留 match 分支待扩展。
// 文件补全 @ 不在这里——前端直接复用 fs.listDir。
//
// 带缓存(host + command_base，5 分钟),避免每次开补全都跑 claude。

use std::collections::HashMap;
use std::process::Command;
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
pub fn agent_completions(
    command_base: String,
    cwd: Option<String>,
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
        b if b.contains("claude") => claude_completions(base, &cwd, &host),
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

/// claude:跑 claude 拿首行 system/init 事件,内含 slash_commands/skills/agents。
///
/// 两个坑(实测):
/// 1. `-p ''`(空 prompt)不会输出 init 行;必须给个非空 prompt(`-p x`)。
/// 2. `| head -1` 会等到整个模型回合结束才因 SIGPIPE 退出(6~15s)。改为:
///    后台启动 claude → 轮询临时文件直到出现 init 行 → 立刻 kill,不等回合。
/// `--strict-mcp-config` 跳过加载项目 MCP(更快更轻;命令仍来自插件+内置=134 条)。
fn claude_completions(base: &str, cwd: &Option<String>, host: &Option<String>) -> CompletionData {
    // base 可能是 "claude" 或带路径/flag,作为启动前缀原样使用。
    // 轮询临时文件取首行 init,拿到即 kill,避免等模型回合。
    let snippet = format!(
        "t=$(mktemp); {base} -p x --output-format stream-json --verbose --strict-mcp-config >\"$t\" 2>/dev/null & p=$!; \
i=0; while [ $i -lt 100 ]; do head -n1 \"$t\" 2>/dev/null | grep -q '\"subtype\":\"init\"' && break; \
kill -0 \"$p\" 2>/dev/null || break; sleep 0.1; i=$((i+1)); done; \
kill \"$p\" 2>/dev/null; head -n1 \"$t\"; rm -f \"$t\""
    );

    let raw = if let Some(h) = host.as_deref().filter(|s| !s.is_empty()) {
        // 远程:cd 后执行,经持久 ssh 会话
        let full = match cwd.as_deref().filter(|d| !d.is_empty()) {
            Some(d) => format!("cd {} 2>/dev/null; {snippet}", crate::remote::shq(d)),
            None => snippet.clone(),
        };
        crate::remote::run_remote(h, &full)
            .map(|b| String::from_utf8_lossy(&b).to_string())
            .unwrap_or_default()
    } else {
        // 本地:登录 shell(确保 PATH 找到 claude)
        let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".to_string());
        let mut c = Command::new(&shell);
        c.arg("-lc").arg(&snippet);
        if let Some(d) = cwd.as_deref().filter(|d| !d.is_empty()) {
            c.current_dir(d);
        }
        c.output()
            .map(|o| String::from_utf8_lossy(&o.stdout).to_string())
            .unwrap_or_default()
    };

    if let Some(d) = parse_init(&raw) {
        return d;
    }
    // 兜底:读 ~/.claude/skills/(远程不便,仅本地)
    if host.as_deref().filter(|s| !s.is_empty()).is_none() {
        if let Some(skills) = read_local_skills() {
            return CompletionData {
                commands: vec![],
                skills,
                agents: vec![],
            };
        }
    }
    CompletionData {
        commands: vec![],
        skills: vec![],
        agents: vec![],
    }
}

/// 解析 system/init 行,取 slash_commands / skills / agents。
fn parse_init(raw: &str) -> Option<CompletionData> {
    for line in raw.lines() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let v: serde_json::Value = match serde_json::from_str(line) {
            Ok(v) => v,
            Err(_) => continue,
        };
        if v.get("type").and_then(|t| t.as_str()) != Some("system") {
            continue;
        }
        let arr = |k: &str| -> Vec<String> {
            v.get(k)
                .and_then(|a| a.as_array())
                .map(|a| {
                    a.iter()
                        .filter_map(|x| x.as_str().map(|s| s.to_string()))
                        .collect()
                })
                .unwrap_or_default()
        };
        // claude 的 slash_commands 里**包含全部技能名**(技能也能用 /name 调用)。
        // 补全要分清:`/` 只给真·命令(含内置),`$` 才给技能。剔除技能名,
        // 避免输入 / 时弹出 $ 的内容。
        let skills = arr("skills");
        let raw_cmds = arr("slash_commands");
        let skill_set: std::collections::HashSet<&str> =
            skills.iter().map(|s| s.as_str()).collect();
        // 先补内置,再整体剔除技能名(内置里也可能有恰好是技能的,如 run/loop/verify)
        let commands: Vec<String> = merge_builtin_commands(raw_cmds)
            .into_iter()
            .filter(|c| !skill_set.contains(c.as_str()))
            .collect();
        return Some(CompletionData {
            commands,
            skills,
            agents: arr("agents"),
        });
    }
    None
}

/// claude 的内置斜杠命令(编译在二进制里,session/init 事件**不返回**它们,
/// 只在 TUI 菜单里出现)。实测(逐字母枚举真实 `/` 菜单)得到这批名字,
/// 与 init 的 slash_commands 合并去重,补齐 /resume /rewind /config 等。
/// 内置命令跨版本稳定;插件/技能仍由 init 实时提供(自动跟版本)。
const BUILTIN_COMMANDS: &[&str] = &[
    "add-dir", "agents", "background", "branch", "btw", "clear", "color", "compact", "config",
    "context", "copy", "diff", "doctor", "effort", "exit", "export", "fast", "feedback", "focus",
    "help", "hooks", "ide", "init", "keybindings", "login", "logout", "loop", "mcp", "memory",
    "model", "permissions", "plan", "plugin", "powerup", "recap", "release-notes", "reload-plugins",
    "reload-skills", "rename", "resume", "review", "rewind", "run", "sandbox", "security-review",
    "skills", "status", "statusline", "stickers", "tasks", "terminal-setup", "theme", "tui",
    "usage", "verify", "workflows",
];

/// 把内置命令合并进 init 返回的命令列表(去重,init 优先保留其顺序,内置追加缺失的)。
fn merge_builtin_commands(mut cmds: Vec<String>) -> Vec<String> {
    use std::collections::HashSet;
    let have: HashSet<String> = cmds.iter().cloned().collect();
    for &b in BUILTIN_COMMANDS {
        if !have.contains(b) {
            cmds.push(b.to_string());
        }
    }
    cmds
}

fn read_local_skills() -> Option<Vec<String>> {
    let home = std::env::var("HOME").ok()?;
    let dir = std::path::PathBuf::from(home).join(".claude").join("skills");
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
    fn parse_init_extracts_lists() {
        let line = r#"{"type":"system","subtype":"init","slash_commands":["a","b","c"],"skills":["s1","s2"],"agents":["g1"]}"#;
        let d = parse_init(line).expect("parsed");
        // init 的命令保留在前
        assert_eq!(&d.commands[..3], &["a", "b", "c"]);
        // 内置命令被合并追加(init 里没有 /resume,应补上)
        assert!(d.commands.iter().any(|c| c == "resume"));
        assert!(d.commands.iter().any(|c| c == "rewind"));
        assert_eq!(d.skills, vec!["s1", "s2"]);
        assert_eq!(d.agents, vec!["g1"]);
    }

    #[test]
    fn parse_init_ignores_non_init() {
        let raw = "{\"type\":\"stream_event\"}\n{\"type\":\"system\",\"slash_commands\":[\"x\"]}";
        let d = parse_init(raw).expect("parsed");
        assert_eq!(d.commands[0], "x");
    }

    #[test]
    fn merge_dedups_and_appends() {
        // init 已含 "resume" 时不应重复;缺失的内置应补上
        let merged = merge_builtin_commands(vec!["resume".into(), "myplugin".into()]);
        assert_eq!(merged.iter().filter(|c| *c == "resume").count(), 1);
        assert_eq!(merged[0], "resume"); // init 顺序保留在前
        assert_eq!(merged[1], "myplugin");
        assert!(merged.iter().any(|c| c == "config")); // 内置补上
    }

    #[test]
    fn slash_commands_exclude_skills() {
        // 实测:claude 的 slash_commands 含全部技能名。补全里 / 不应混入 $ 的技能。
        let line = r#"{"type":"system","subtype":"init","slash_commands":["review","apple-notes","arxiv"],"skills":["apple-notes","arxiv"],"agents":[]}"#;
        let d = parse_init(line).expect("parsed");
        // 技能名(apple-notes/arxiv)从命令里被剔除
        assert!(!d.commands.contains(&"apple-notes".to_string()));
        assert!(!d.commands.contains(&"arxiv".to_string()));
        // 真·命令保留
        assert!(d.commands.contains(&"review".to_string()));
        // 技能仍在 skills 里
        assert!(d.skills.contains(&"apple-notes".to_string()));
    }
}
