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
}

/// 全量应用配置。
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
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
    /// 当前工作目录(claude 在此运行)
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
}

fn default_true() -> bool {
    true
}

fn config_dir() -> Result<PathBuf, String> {
    let home = std::env::var("HOME").map_err(|_| "无法定位 HOME 目录".to_string())?;
    Ok(PathBuf::from(home).join(".linco"))
}

fn config_path() -> Result<PathBuf, String> {
    Ok(config_dir()?.join("config.json"))
}

/// 读取配置;文件不存在时返回默认配置。
#[tauri::command]
pub fn load_config() -> Result<AppConfig, String> {
    let path = config_path()?;
    if !path.exists() {
        return Ok(AppConfig::default());
    }
    let text = fs::read_to_string(&path).map_err(|e| e.to_string())?;
    serde_json::from_str(&text).map_err(|e| format!("配置解析失败: {e}"))
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
