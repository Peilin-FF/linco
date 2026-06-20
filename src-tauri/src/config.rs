// 应用配置:持久化到 ~/.linco/config.json。
//
// 设计目标(对齐 codex app 体验):用户在“设置 → 模型设置”里配好
// 供应商 / API Key / 启动命令,之后打开 app 就用这套配置自动拉起 agent,
// 直接对话,无需每次手敲命令。

use std::fs;
use std::path::PathBuf;

use serde::{Deserialize, Serialize};

/// 单个 agent 配置(一个供应商 + 一套凭据 + 启动命令)。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentConfig {
    /// 唯一 id,如 "claude" / "codex" / 自定义
    pub id: String,
    /// 展示名,如 "Claude Code"
    pub name: String,
    /// 供应商标识,如 "anthropic" / "openai" / "openrouter" / "custom"
    #[serde(default)]
    pub provider: String,
    /// 在终端里启动该 agent 的命令,如 "claude" / "codex"
    pub command: String,
    /// API Key(注入为环境变量)
    #[serde(default)]
    pub api_key: String,
    /// 自定义 base url(可选,留空用默认)
    #[serde(default)]
    pub base_url: String,
    /// 模型名(可选)
    #[serde(default)]
    pub model: String,
    /// 可选模型列表(同一供应商多个模型,聊天框可切换;空则只用 model)
    #[serde(default)]
    pub models: Vec<String>,
    /// 权限模式(控制是否反复询问)。取值随 provider:
    /// claude: default/acceptEdits/plan/bypassPermissions;codex: ""/full-auto/bypass
    #[serde(default)]
    pub permission: String,
    /// 思考力/推理预算。claude: low/medium/high/xhigh/max;codex: low/medium/high
    #[serde(default)]
    pub effort: String,
    /// 登录方式:""/"api"=用 API Key 注入环境变量;"subscription"=用 CLI 自身订阅登录(不注入 key)
    #[serde(default)]
    pub auth_mode: String,
}

/// 一个远程连接定义(SSH)。host 为 user@ip 或 ~/.ssh/config 别名。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Connection {
    pub id: String,
    pub name: String,
    pub host: String,
    #[serde(default)]
    pub cwd: String,
    #[serde(default)]
    pub identity: String,
    /// 该远程连接最近用过的目录(与本地的 recent_dirs 分开)
    #[serde(default, rename = "recentDirs")]
    pub recent_dirs: Vec<String>,
    /// 该远程的 HTTP 代理(与本地的 http_proxy 分开;本地/远程代理常不同,不互相同步)
    #[serde(default, rename = "httpProxy")]
    pub http_proxy: String,
}

/// 全量应用配置。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AppConfig {
    /// 已配置的 agent 列表
    #[serde(default)]
    pub agents: Vec<AgentConfig>,
    /// 默认 agent id —— 打开 app 自动启动它
    #[serde(default)]
    pub default_agent: String,
    /// 打开 app 是否自动启动默认 agent
    #[serde(default = "default_true")]
    pub auto_start: bool,
    /// 当前工作目录(agent 在此运行)
    #[serde(default)]
    pub cwd: String,
    /// 最近用过的工作目录
    #[serde(default)]
    pub recent_dirs: Vec<String>,
    /// 已配置的远程连接
    #[serde(default)]
    pub connections: Vec<Connection>,
    /// 当前激活的连接 id(空 = 本地)
    #[serde(default)]
    pub active_connection: String,
    /// 开发语言偏好:""=未选(触发首启询问)/ "zh" 中文 / "en" 英文。
    /// 决定首启时给 ~/.claude/plugins 安装中文版还是英文版插件,避免 HTML 设计规范混淆。
    #[serde(default)]
    pub language: String,
    /// 首启选定的插件 agent:""=未选 / "claude" / "codex"。决定装哪套插件、远程也装哪套。
    #[serde(default)]
    pub plugin_agent: String,
    /// 界面主题 id(见前端 theme.ts);空=默认 github-light。
    #[serde(default)]
    pub theme: String,
    /// 界面字体(CSS font-family);空=系统默认。
    #[serde(default)]
    pub ui_font: String,
    /// 界面字号(px);0=默认 14。
    #[serde(default)]
    pub ui_font_size: u32,
    /// GitHub 用户名(用于 git 凭据 ~/.git-credentials)。
    #[serde(default)]
    pub github_user: String,
    /// GitHub token / 密码(写入 ~/.git-credentials,push/pull 鉴权用)。
    #[serde(default)]
    pub github_token: String,
    /// HTTP 代理(http://host:port);非空则注入 git 的 http_proxy/https_proxy 环境变量。
    #[serde(default)]
    pub http_proxy: String,
}

impl Default for AppConfig {
    fn default() -> Self {
        Self {
            agents: builtin_agents(),
            default_agent: "claude".into(),
            auto_start: true,
            cwd: String::new(),
            recent_dirs: vec![],
            connections: vec![],
            active_connection: String::new(),
            language: String::new(),
            plugin_agent: String::new(),
            theme: String::new(),
            ui_font: String::new(),
            ui_font_size: 0,
            github_user: String::new(),
            github_token: String::new(),
            http_proxy: String::new(),
        }
    }
}

fn default_true() -> bool {
    true
}

/// 跨平台用户主目录。Unix/macOS 读 `HOME`;Windows 上 `HOME` 通常不存在,
/// 回退 `USERPROFILE`(标准),再退 `HOMEDRIVE`+`HOMEPATH`。供所有本地路径复用。
pub fn home_dir() -> Result<PathBuf, String> {
    if let Ok(h) = std::env::var("HOME") {
        if !h.is_empty() {
            return Ok(PathBuf::from(h));
        }
    }
    if let Ok(up) = std::env::var("USERPROFILE") {
        if !up.is_empty() {
            return Ok(PathBuf::from(up));
        }
    }
    if let (Ok(d), Ok(p)) = (std::env::var("HOMEDRIVE"), std::env::var("HOMEPATH")) {
        if !d.is_empty() && !p.is_empty() {
            return Ok(PathBuf::from(format!("{d}{p}")));
        }
    }
    Err("无法定位用户主目录(HOME / USERPROFILE 均未设置)".to_string())
}

/// Linco 本地数据根目录。**发布版与 dev 版隔离**:
/// - debug build(`tauri dev`)→ `~/.linco`(开发者日常用,保留)
/// - release build(`tauri build` 出来的发布版)→ `~/.linco-app`(独立、默认空,
///   装上即从零开始,绝不导入开发者已有的 SSH 连接/模型/密钥)。
/// config / shadows / ssh socket / usage 全部挂在这个根下,一并隔离。
/// 注意:SSH **主机别名**读的是系统 `~/.ssh/config`(ssh 命令标准位置),不受此影响。
pub fn linco_home() -> Result<PathBuf, String> {
    let home = home_dir()?;
    let dir = if cfg!(debug_assertions) {
        ".linco"
    } else {
        ".linco-app"
    };
    Ok(home.join(dir))
}

fn config_dir() -> Result<PathBuf, String> {
    linco_home()
}

fn config_path() -> Result<PathBuf, String> {
    Ok(config_dir()?.join("config.json"))
}

fn builtin_agents() -> Vec<AgentConfig> {
    vec![
        AgentConfig {
            id: "claude".into(),
            name: "Claude Code".into(),
            provider: "anthropic".into(),
            command: "claude".into(),
            api_key: String::new(),
            base_url: String::new(),
            model: String::new(),
            models: Vec::new(),
            permission: String::new(),
            effort: String::new(),
            auth_mode: String::new(),
        },
        AgentConfig {
            id: "codex".into(),
            name: "Codex".into(),
            provider: "openai".into(),
            command: "codex".into(),
            api_key: String::new(),
            base_url: String::new(),
            model: String::new(),
            models: Vec::new(),
            permission: String::new(),
            effort: String::new(),
            auth_mode: String::new(),
        },
    ]
}

fn ensure_builtin_agents(config: &mut AppConfig) {
    for agent in builtin_agents() {
        if !config.agents.iter().any(|a| a.id == agent.id) {
            config.agents.push(agent);
        }
    }
    if config.default_agent.is_empty() {
        config.default_agent = config
            .agents
            .first()
            .map(|a| a.id.clone())
            .unwrap_or_default();
    }
}

/// 读取配置;文件不存在时返回默认配置。
#[tauri::command]
pub fn load_config() -> Result<AppConfig, String> {
    let path = config_path()?;
    if !path.exists() {
        return Ok(AppConfig::default());
    }
    let text = fs::read_to_string(&path).map_err(|e| e.to_string())?;
    let mut config: AppConfig =
        serde_json::from_str(&text).map_err(|e| format!("配置解析失败: {e}"))?;
    ensure_builtin_agents(&mut config);
    Ok(config)
}

/// 保存配置到 ~/.linco/config.json。
#[tauri::command]
pub fn save_config(config: AppConfig) -> Result<(), String> {
    let dir = config_dir()?;
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let path = config_path()?;
    let text = serde_json::to_string_pretty(&config).map_err(|e| e.to_string())?;
    fs::write(&path, text).map_err(|e| e.to_string())?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_config_includes_codex_tui_agent() {
        let cfg = AppConfig::default();
        let codex = cfg
            .agents
            .iter()
            .find(|a| a.id == "codex")
            .expect("codex preset should exist");

        assert_eq!(codex.provider, "openai");
        assert_eq!(codex.command, "codex");
        assert!(cfg.agents.iter().any(|a| a.id == "claude"));
    }

    #[test]
    fn config_migration_adds_codex_without_overwriting_existing_agents() {
        let mut cfg = AppConfig {
            agents: vec![AgentConfig {
                id: "claude".into(),
                name: "My Claude".into(),
                provider: "anthropic".into(),
                command: "claude --dangerously-skip-permissions".into(),
                api_key: String::new(),
                base_url: String::new(),
                model: String::new(),
                models: Vec::new(),
                permission: String::new(),
                effort: String::new(),
                auth_mode: String::new(),
            }],
            default_agent: "claude".into(),
            ..AppConfig::default()
        };

        ensure_builtin_agents(&mut cfg);

        assert!(cfg.agents.iter().any(|a| a.id == "codex"));
        assert_eq!(cfg.agents.iter().filter(|a| a.id == "claude").count(), 1);
        assert_eq!(
            cfg.agents
                .iter()
                .find(|a| a.id == "claude")
                .map(|a| a.command.as_str()),
            Some("claude --dangerously-skip-permissions")
        );
    }
}
