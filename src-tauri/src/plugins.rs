// 按语言安装 Linco 插件到 ~/.claude/plugins/。
//
// 背景:Linco 自带 6 个 Claude Code 插件(中文版 linco-html/linco-task-monitor/linco-shadow-diff
// 和各自的英文 -en 版),打包在 .app 资源里(tauri.conf 的 bundle.resources)。用户首启时选
// 「中文/英文开发」,据此把对应语言的三件套复制到 ~/.claude/plugins/,并清掉另一语言的同类,
// 避免两套 HTML 设计规范混淆。连远程集群时,把同语言三件套 rsync 到远端 ~/.claude/plugins/。

use std::path::{Path, PathBuf};
use std::process::Command;

use base64::engine::general_purpose::STANDARD as B64;
use base64::Engine;
use tauri::{AppHandle, Manager};

/// 某语言对应的三个插件目录名。
fn plugin_names(lang: &str) -> [&'static str; 3] {
    if lang == "en" {
        ["linco-html-en", "linco-task-monitor-en", "linco-shadow-diff-en"]
    } else {
        ["linco-html", "linco-task-monitor", "linco-shadow-diff"]
    }
}

/// 另一语言的三个插件名(用于安装时清除,避免中英并存)。
fn other_names(lang: &str) -> [&'static str; 3] {
    if lang == "en" {
        ["linco-html", "linco-task-monitor", "linco-shadow-diff"]
    } else {
        ["linco-html-en", "linco-task-monitor-en", "linco-shadow-diff-en"]
    }
}

/// 插件源目录(含 6 个插件):release 用 .app 资源里的 plugins/;dev 回退 vendor。
fn plugins_source(app: &AppHandle) -> Result<PathBuf, String> {
    // release:resource_dir/plugins(对应 tauri.conf bundle.resources 的 "plugins")
    if let Ok(res) = app.path().resource_dir() {
        let p = res.join("plugins");
        if p.join("linco-html").join(".claude-plugin").join("plugin.json").exists() {
            return Ok(p);
        }
    }
    // dev 回退:源码树 vendor
    let dev = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../vendor/HTML-VibeCoding/plugins");
    if dev.join("linco-html").join(".claude-plugin").join("plugin.json").exists() {
        return Ok(dev);
    }
    Err("找不到插件源目录(resource_dir/plugins 与 vendor 均不存在)".into())
}

fn claude_plugins_dir() -> Result<PathBuf, String> {
    let home = std::env::var("HOME").map_err(|_| "无法定位 HOME".to_string())?;
    let dir = PathBuf::from(home).join(".claude").join("plugins");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

/// 递归复制目录(覆盖式:先删目标再拷)。
fn copy_dir(src: &Path, dst: &Path) -> Result<(), String> {
    if dst.exists() {
        std::fs::remove_dir_all(dst).map_err(|e| e.to_string())?;
    }
    std::fs::create_dir_all(dst).map_err(|e| e.to_string())?;
    for entry in std::fs::read_dir(src).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let from = entry.path();
        let to = dst.join(entry.file_name());
        let ft = entry.file_type().map_err(|e| e.to_string())?;
        if ft.is_dir() {
            copy_dir(&from, &to)?;
        } else if ft.is_symlink() {
            // 跟随符号链接拷其内容(资源里一般无,稳妥处理)
            let real = std::fs::read_link(&from).map_err(|e| e.to_string())?;
            let base = if real.is_absolute() { real } else { from.parent().unwrap().join(real) };
            if base.is_dir() { copy_dir(&base, &to)?; }
            else { std::fs::copy(&base, &to).map_err(|e| e.to_string())?; }
        } else {
            std::fs::copy(&from, &to).map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

/// 本地安装:把 lang 对应三件套复制进 ~/.claude/plugins/,并删掉另一语言的同类。
fn install_local(app: &AppHandle, lang: &str) -> Result<(), String> {
    let src = plugins_source(app)?;
    let dst_root = claude_plugins_dir()?;
    // 先清另一语言
    for n in other_names(lang) {
        let p = dst_root.join(n);
        if p.exists() {
            let _ = std::fs::remove_dir_all(&p);
        }
    }
    // 复制本语言
    for n in plugin_names(lang) {
        let from = src.join(n);
        if !from.exists() {
            return Err(format!("插件源缺失: {}", from.to_string_lossy()));
        }
        copy_dir(&from, &dst_root.join(n))?;
    }
    Ok(())
}

/// 远程安装:rsync 同语言三件套到远端 ~/.claude/plugins/,并删另一语言。
/// 复用 ssh_opts() 的 ControlMaster,不额外认证。
fn install_remote(app: &AppHandle, host: &str, lang: &str) -> Result<(), String> {
    let src = plugins_source(app)?;
    // rsync 的 -e 参数:用与本项目一致的 ssh 选项(复用持久连接)
    let ssh_e = format!("ssh {}", crate::remote::ssh_opts().join(" "));
    // 先建远端目录 + 清另一语言
    let mut cleanup = String::from("mkdir -p ~/.claude/plugins");
    for n in other_names(lang) {
        cleanup.push_str(&format!(" && rm -rf ~/.claude/plugins/{n}"));
    }
    let _ = crate::remote::run_remote(host, &cleanup);
    // rsync 每个插件目录
    for n in plugin_names(lang) {
        let from = src.join(n);
        if !from.exists() {
            continue;
        }
        // 尾随 / 让 rsync 拷目录内容到目标目录
        let from_arg = format!("{}/", from.to_string_lossy());
        let dst_arg = format!("{host}:.claude/plugins/{n}/");
        let out = Command::new("rsync")
            .args(["-a", "--delete", "-e", &ssh_e, &from_arg, &dst_arg])
            .output()
            .map_err(|e| format!("rsync 失败: {e}"))?;
        if !out.status.success() {
            return Err(String::from_utf8_lossy(&out.stderr).to_string());
        }
    }
    Ok(())
}

// ============ Codex(~/.codex)============
// codex 没有 SessionStart hook,改用两层:① 全局 ~/.codex/AGENTS.md 每次会话稳定注入
// 常驻指令(我们用 marker 区块管理,不覆盖用户已有内容);② ~/.codex/skills/html-kit
// 放完整设计套件 skill,AGENTS.md 指引按需加载。

const CODEX_BEGIN: &str = "<!-- LINCO:BEGIN";
const CODEX_END: &str = "<!-- LINCO:END -->";

/// codex 资源根:release 用 resource_dir/codex;dev 回退 vendor/HTML-VibeCoding/codex。
fn codex_source(app: &AppHandle) -> Result<PathBuf, String> {
    if let Ok(res) = app.path().resource_dir() {
        let p = res.join("codex");
        if p.join("zh").join("AGENTS.md").exists() {
            return Ok(p);
        }
    }
    let dev = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../vendor/HTML-VibeCoding/codex");
    if dev.join("zh").join("AGENTS.md").exists() {
        return Ok(dev);
    }
    Err("找不到 codex 资源目录".into())
}

/// 把 LINCO marker 区块更新进 ~/.codex/AGENTS.md(保留用户的其余内容;替换旧区块或追加)。
fn upsert_agents_md(path: &Path, block: &str) -> Result<(), String> {
    let existing = std::fs::read_to_string(path).unwrap_or_default();
    let merged = if let (Some(b), Some(e)) = (existing.find(CODEX_BEGIN), existing.find(CODEX_END)) {
        // 替换旧 LINCO 区块
        let end = e + CODEX_END.len();
        format!("{}{}{}", &existing[..b], block.trim_end(), &existing[end..])
    } else if existing.trim().is_empty() {
        format!("{}\n", block.trim_end())
    } else {
        format!("{}\n\n{}\n", existing.trim_end(), block.trim_end())
    };
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    std::fs::write(path, merged).map_err(|e| e.to_string())
}

/// codex 本地安装:写 AGENTS.md 常驻区块 + 复制 html-kit skill 到 ~/.codex/skills/。
fn install_codex_local(app: &AppHandle, lang: &str) -> Result<(), String> {
    let home = std::env::var("HOME").map_err(|_| "无法定位 HOME".to_string())?;
    let codex_home = PathBuf::from(&home).join(".codex");
    let src = codex_source(app)?.join(lang);
    // AGENTS.md
    let block = std::fs::read_to_string(src.join("AGENTS.md")).map_err(|e| e.to_string())?;
    upsert_agents_md(&codex_home.join("AGENTS.md"), &block)?;
    // skill
    let skill_src = src.join("skills").join("html-kit");
    if skill_src.exists() {
        copy_dir(&skill_src, &codex_home.join("skills").join("html-kit"))?;
    }
    Ok(())
}

// ============ Tauri 命令 ============

/// 设置 agent + 开发语言:写回 config + 安装对应那套。首启弹窗选定后调用。
/// agent="codex" → 装 ~/.codex 的 AGENTS.md+skill;否则(claude)装 ~/.claude/plugins。
#[tauri::command]
pub async fn set_language(app: AppHandle, agent: String, lang: String) -> Result<(), String> {
    let lang = if lang == "en" { "en" } else { "zh" }.to_string();
    let is_codex = agent == "codex";
    crate::blocking::run({
        let app = app.clone();
        let lang = lang.clone();
        move || {
            if is_codex {
                install_codex_local(&app, &lang)
            } else {
                install_local(&app, &lang)
            }
        }
    })
    .await?;
    // 写回配置
    let mut cfg = crate::config::load_config()?;
    cfg.language = lang;
    cfg.plugin_agent = if is_codex { "codex" } else { "claude" }.to_string();
    crate::config::save_config(cfg)?;
    Ok(())
}

/// 给某远程主机安装当前 agent+语言 的那套(连接成功后调用;失败静默)。
/// 与本地一致:claude→远端 ~/.claude/plugins;codex→远端 ~/.codex(AGENTS.md 区块 + skill)。
#[tauri::command]
pub async fn install_remote_plugins(app: AppHandle, host: String) -> Result<(), String> {
    let cfg = crate::config::load_config()?;
    let lang = if cfg.language == "en" { "en" } else { "zh" }.to_string();
    let is_codex = cfg.plugin_agent == "codex";
    crate::blocking::run(move || {
        if is_codex {
            install_codex_remote(&app, &host, &lang)
        } else {
            install_remote(&app, &host, &lang)
        }
    })
    .await
}

/// 远程 codex 安装:rsync skill 到远端 ~/.codex/skills/html-kit/,并把 AGENTS.md 的
/// LINCO 区块 merge 进远端 ~/.codex/AGENTS.md(rsync 不能 merge,用 awk 在远端替换区块)。
fn install_codex_remote(app: &AppHandle, host: &str, lang: &str) -> Result<(), String> {
    let src = codex_source(app)?.join(lang);
    let ssh_e = format!("ssh {}", crate::remote::ssh_opts().join(" "));
    // 1) rsync skill 目录
    let skill_src = src.join("skills").join("html-kit");
    if skill_src.exists() {
        let _ = crate::remote::run_remote(host, "mkdir -p ~/.codex/skills/html-kit");
        let from_arg = format!("{}/", skill_src.to_string_lossy());
        let dst_arg = format!("{host}:.codex/skills/html-kit/");
        let out = Command::new("rsync")
            .args(["-a", "--delete", "-e", &ssh_e, &from_arg, &dst_arg])
            .output()
            .map_err(|e| format!("rsync 失败: {e}"))?;
        if !out.status.success() {
            return Err(String::from_utf8_lossy(&out.stderr).to_string());
        }
    }
    // 2) AGENTS.md:把本地 block 经 stdin 传到远端,用 awk 替换 LINCO 区块(保留用户其余内容)
    let block = std::fs::read_to_string(src.join("AGENTS.md")).map_err(|e| e.to_string())?;
    let block_b64 = B64.encode(block.as_bytes());
    // 远端脚本:解析旧文件,去掉 LINCO:BEGIN..LINCO:END 之间,再追加新 block。
    let remote_sh = format!(
        "mkdir -p ~/.codex; f=~/.codex/AGENTS.md; nb=$(mktemp); echo {b64} | base64 -d > \"$nb\"; \
         if [ -f \"$f\" ] && grep -q 'LINCO:BEGIN' \"$f\"; then \
           awk 'BEGIN{{s=0}} /LINCO:BEGIN/{{s=1}} /LINCO:END/{{s=2;next}} s==2||s==0{{print}}' \"$f\" > \"$f.keep\" 2>/dev/null || cp \"$f\" \"$f.keep\"; \
           {{ cat \"$f.keep\"; echo; cat \"$nb\"; }} > \"$f\"; rm -f \"$f.keep\"; \
         elif [ -s \"$f\" ]; then {{ cat \"$f\"; echo; cat \"$nb\"; }} > \"$f.new\" && mv \"$f.new\" \"$f\"; \
         else cp \"$nb\" \"$f\"; fi; rm -f \"$nb\"",
        b64 = block_b64
    );
    crate::remote::run_remote(host, &remote_sh).map(|_| ())
}
