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
        [
            "linco-html-en",
            "linco-task-monitor-en",
            "linco-shadow-diff-en",
        ]
    } else {
        ["linco-html", "linco-task-monitor", "linco-shadow-diff"]
    }
}

/// 另一语言的三个插件名(用于安装时清除,避免中英并存)。
fn other_names(lang: &str) -> [&'static str; 3] {
    if lang == "en" {
        ["linco-html", "linco-task-monitor", "linco-shadow-diff"]
    } else {
        [
            "linco-html-en",
            "linco-task-monitor-en",
            "linco-shadow-diff-en",
        ]
    }
}

/// 插件源目录(含 6 个插件):release 用 .app 资源里的 plugins/;dev 回退 vendor。
fn plugins_source(app: &AppHandle) -> Result<PathBuf, String> {
    // release:resource_dir/plugins(对应 tauri.conf bundle.resources 的 "plugins")
    if let Ok(res) = app.path().resource_dir() {
        let p = res.join("plugins");
        if p.join("linco-html")
            .join(".claude-plugin")
            .join("plugin.json")
            .exists()
        {
            return Ok(p);
        }
    }
    // dev 回退:源码树 vendor
    let dev = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../vendor/HTML-VibeCoding/plugins");
    if dev
        .join("linco-html")
        .join(".claude-plugin")
        .join("plugin.json")
        .exists()
    {
        return Ok(dev);
    }
    Err("找不到插件源目录(resource_dir/plugins 与 vendor 均不存在)".into())
}

/// marketplace 根目录(含 .claude-plugin/marketplace.json 与 .agents/plugins/marketplace.json)。
/// 这是 claude/codex `plugin marketplace add` 的目标。release 用 resource_dir/vendor,
/// dev 回退源码树 vendor/HTML-VibeCoding。
fn marketplace_root(app: &AppHandle) -> Result<PathBuf, String> {
    if let Ok(res) = app.path().resource_dir() {
        // Part 4 打包后:resource_dir/vendor = 整个 HTML-VibeCoding
        let p = res.join("vendor");
        if p.join(".claude-plugin").join("marketplace.json").exists() {
            return Ok(p);
        }
        // 兼容:也可能直接打在 resource_dir 根
        if res.join(".claude-plugin").join("marketplace.json").exists() {
            return Ok(res);
        }
    }
    let dev = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../vendor/HTML-VibeCoding");
    if dev.join(".claude-plugin").join("marketplace.json").exists() {
        return Ok(dev);
    }
    Err("找不到 marketplace 根目录".into())
}

/// claude marketplace 名(与 vendor/.claude-plugin/marketplace.json 的 name 一致)。
const CLAUDE_MARKETPLACE: &str = "linco-plugins-marketplace";
/// codex marketplace 名(与 vendor/.agents/plugins/marketplace.json 的 name 一致)。
const CODEX_MARKETPLACE: &str = "linco-codex-marketplace";

/// 探测某 CLI 是否有 `plugin` 子命令(老版本没有 → 回退拷文件)。
fn cli_has_plugin(exe: &str) -> bool {
    let mut c = Command::new(exe);
    c.arg("plugin").arg("--help");
    crate::proc_ext::no_window(&mut c);
    c.output().map(|o| o.status.success()).unwrap_or(false)
}

/// 跑一条本地 CLI 命令(no_window 包裹),返回 (成功, stderr)。
fn run_cli(exe: &str, args: &[&str]) -> (bool, String) {
    let mut c = Command::new(exe);
    c.args(args);
    crate::proc_ext::no_window(&mut c);
    match c.output() {
        Ok(o) => (
            o.status.success(),
            String::from_utf8_lossy(&o.stderr).to_string(),
        ),
        Err(e) => (false, e.to_string()),
    }
}

fn claude_plugins_dir() -> Result<PathBuf, String> {
    let home = crate::config::home_dir()?;
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
            let base = if real.is_absolute() {
                real
            } else {
                from.parent().unwrap().join(real)
            };
            if base.is_dir() {
                copy_dir(&base, &to)?;
            } else {
                std::fs::copy(&base, &to).map_err(|e| e.to_string())?;
            }
        } else {
            std::fs::copy(&from, &to).map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

/// 本地安装(claude):优先走官方 CLI 真注册启用;CLI 不可用则回退到拷文件。
/// CLI 路径:`claude plugin marketplace add <vendor>` + `claude plugin install <名>@mkt --scope user`,
/// 并卸载另一语言。`--scope user` → 任意项目目录全局生效(不再依赖项目级 .claude/settings.json)。
fn install_local(app: &AppHandle, lang: &str) -> Result<(), String> {
    let exe = "claude";
    if cli_has_plugin(exe) {
        let root = marketplace_root(app)?;
        let root_s = root.to_string_lossy().to_string();
        // 注册 marketplace(幂等,已存在会提示 already)
        run_cli(exe, &["plugin", "marketplace", "add", &root_s, "--scope", "user"]);
        // 卸另一语言
        for n in other_names(lang) {
            run_cli(
                exe,
                &[
                    "plugin",
                    "uninstall",
                    &format!("{n}@{CLAUDE_MARKETPLACE}"),
                    "--scope",
                    "user",
                ],
            );
        }
        // 装本语言
        let mut last_err = String::new();
        let mut ok_any = false;
        for n in plugin_names(lang) {
            let (ok, err) = run_cli(
                exe,
                &[
                    "plugin",
                    "install",
                    &format!("{n}@{CLAUDE_MARKETPLACE}"),
                    "--scope",
                    "user",
                ],
            );
            if ok {
                ok_any = true;
            } else {
                last_err = err;
            }
        }
        if ok_any {
            return Ok(());
        }
        // 全失败 → 落回拷文件兜底
        eprintln!("claude plugin install 全失败,回退拷文件: {last_err}");
    }
    install_local_copy(app, lang)
}

/// 回退:把 lang 对应三件套复制进 ~/.claude/plugins/,并删另一语言(老 claude 无 plugin CLI 时)。
fn install_local_copy(app: &AppHandle, lang: &str) -> Result<(), String> {
    let src = plugins_source(app)?;
    let dst_root = claude_plugins_dir()?;
    for n in other_names(lang) {
        let p = dst_root.join(n);
        if p.exists() {
            let _ = std::fs::remove_dir_all(&p);
        }
    }
    for n in plugin_names(lang) {
        let from = src.join(n);
        if !from.exists() {
            return Err(format!("插件源缺失: {}", from.to_string_lossy()));
        }
        copy_dir(&from, &dst_root.join(n))?;
    }
    Ok(())
}

/// 远程安装(claude):rsync 整个 marketplace 到远端 ~/.linco/marketplace/,
/// 再经 SSH 跑 `claude plugin marketplace add ~/.linco/marketplace` + `plugin install --scope user`。
/// CLI 不可用则回退:rsync 三件套到远端 ~/.claude/plugins/(老逻辑)。
fn install_remote(app: &AppHandle, host: &str, lang: &str) -> Result<(), String> {
    let ssh_e = format!("ssh {}", crate::remote::ssh_opts().join(" "));
    // 1) rsync 整个 marketplace 根到远端 ~/.linco/marketplace/
    let mkt = marketplace_root(app)?;
    let synced = rsync_dir_to_remote(&mkt, host, ".linco/marketplace", &ssh_e).is_ok();
    // 2) 远端有 claude plugin CLI 吗?
    let has_cli = crate::remote::run_remote(host, "claude plugin --help >/dev/null 2>&1 && echo Y")
        .map(|b| String::from_utf8_lossy(&b).contains('Y'))
        .unwrap_or(false);
    if synced && has_cli {
        // 注册 marketplace + 卸另一语言 + 装本语言(全局 user scope)
        let _ = crate::remote::run_remote(
            host,
            "claude plugin marketplace add ~/.linco/marketplace --scope user 2>/dev/null; true",
        );
        for n in other_names(lang) {
            let _ = crate::remote::run_remote(
                host,
                &format!("claude plugin uninstall {n}@{CLAUDE_MARKETPLACE} --scope user 2>/dev/null; true"),
            );
        }
        let mut ok_any = false;
        for n in plugin_names(lang) {
            if crate::remote::run_remote(
                host,
                &format!("claude plugin install {n}@{CLAUDE_MARKETPLACE} --scope user"),
            )
            .is_ok()
            {
                ok_any = true;
            }
        }
        if ok_any {
            return Ok(());
        }
    }
    // 回退:rsync 三件套到远端 ~/.claude/plugins/
    install_remote_copy(app, host, lang, &ssh_e)
}

/// 回退:rsync 同语言三件套到远端 ~/.claude/plugins/,并删另一语言(老 claude 无 plugin CLI)。
fn install_remote_copy(
    app: &AppHandle,
    host: &str,
    lang: &str,
    ssh_e: &str,
) -> Result<(), String> {
    let src = plugins_source(app)?;
    let mut cleanup = String::from("mkdir -p ~/.claude/plugins");
    for n in other_names(lang) {
        cleanup.push_str(&format!(" && rm -rf ~/.claude/plugins/{n}"));
    }
    let _ = crate::remote::run_remote(host, &cleanup);
    for n in plugin_names(lang) {
        let from = src.join(n);
        if !from.exists() {
            continue;
        }
        let from_arg = format!("{}/", from.to_string_lossy());
        let dst_arg = format!("{host}:.claude/plugins/{n}/");
        let mut c = Command::new("rsync");
        c.args(["-a", "--delete", "-e", ssh_e, &from_arg, &dst_arg]);
        crate::proc_ext::no_window(&mut c);
        let out = c.output().map_err(|e| format!("rsync 失败: {e}"))?;
        if !out.status.success() {
            return Err(String::from_utf8_lossy(&out.stderr).to_string());
        }
    }
    Ok(())
}

/// rsync 一个本地目录到远端相对 $HOME 的子路径(尾随 / 拷内容)。
fn rsync_dir_to_remote(
    local: &Path,
    host: &str,
    remote_rel: &str,
    ssh_e: &str,
) -> Result<(), String> {
    let _ = crate::remote::run_remote(host, &format!("mkdir -p ~/{remote_rel}"));
    let from_arg = format!("{}/", local.to_string_lossy());
    let dst_arg = format!("{host}:{remote_rel}/");
    let mut c = Command::new("rsync");
    c.args(["-a", "--delete", "-e", ssh_e, &from_arg, &dst_arg]);
    crate::proc_ext::no_window(&mut c);
    let out = c.output().map_err(|e| format!("rsync 失败: {e}"))?;
    if out.status.success() {
        Ok(())
    } else {
        Err(String::from_utf8_lossy(&out.stderr).to_string())
    }
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
    let merged = if let (Some(b), Some(e)) = (existing.find(CODEX_BEGIN), existing.find(CODEX_END))
    {
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

/// codex 本地安装:优先走 `codex plugin marketplace add` + `codex plugin add`(真注册启用);
/// 同时**始终**写 AGENTS.md 区块 + 拷 skill 作兜底(老 codex 无 plugin CLI 时仍生效)。
fn install_codex_local(app: &AppHandle, lang: &str) -> Result<(), String> {
    let home = crate::config::home_dir()?;
    let codex_home = PathBuf::from(&home).join(".codex");
    let src = codex_source(app)?.join(lang);
    // 兜底① AGENTS.md 区块
    let block = std::fs::read_to_string(src.join("AGENTS.md")).map_err(|e| e.to_string())?;
    upsert_agents_md(&codex_home.join("AGENTS.md"), &block)?;
    // 兜底② skill 拷贝
    let skill_src = src.join("skills").join("html-kit");
    if skill_src.exists() {
        copy_dir(&skill_src, &codex_home.join("skills").join("html-kit"))?;
    }
    // 正规注册:codex plugin marketplace add + add 三个插件(若 CLI 支持)
    if cli_has_plugin("codex") {
        if ensure_codex_marketplace(app).is_ok() {
            for (id, _, _) in CODEX_PLUGINS {
                // 卸另一语言变体(忽略失败)
                run_cli(
                    "codex",
                    &[
                        "plugin",
                        "remove",
                        &format!("{}@{CODEX_MARKETPLACE}", codex_variant(id, other_lang(lang))),
                    ],
                );
                // 装本语言变体
                run_cli(
                    "codex",
                    &[
                        "plugin",
                        "add",
                        &format!("{}@{CODEX_MARKETPLACE}", codex_variant(id, lang)),
                    ],
                );
            }
        }
    }
    Ok(())
}

/// codex 逻辑 id → 该语言下的插件名(与 .agents/plugins/marketplace.json 一致)。
/// html→html-kit;task-monitor→task-monitor;shadow-diff→shadow-diff;en 加 "-en"。
fn codex_variant(id: &str, lang: &str) -> String {
    let base = match id {
        "html" => "html-kit",
        other => other, // task-monitor / shadow-diff 同名
    };
    if lang == "en" {
        format!("{base}-en")
    } else {
        base.to_string()
    }
}

/// 确保 codex marketplace 指向当前 vendor 根。codex 会缓存 marketplace 源,
/// 若旧源(如 dev 旧 build 的 target/.../vendor)与现在不一致,`add` 会报
/// "already added from a different source" → 先 remove 再 add,保证指向最新插件集。
fn ensure_codex_marketplace(app: &AppHandle) -> Result<(), String> {
    let root = marketplace_root(app)?;
    let root_s = root.to_string_lossy().to_string();
    let (ok, err) = run_cli("codex", &["plugin", "marketplace", "add", &root_s]);
    if !ok && err.contains("already added from a different source") {
        run_cli("codex", &["plugin", "marketplace", "remove", CODEX_MARKETPLACE]);
        run_cli("codex", &["plugin", "marketplace", "add", &root_s]);
    }
    Ok(())
}

fn other_lang(lang: &str) -> &'static str {
    if lang == "en" {
        "zh"
    } else {
        "en"
    }
}

/// codex 三个逻辑插件 → (逻辑 id, 展示名, 描述)。
const CODEX_PLUGINS: [(&str, &str, &str); 3] = [
    ("html", "HTML 产物套件", "codex 版:自包含 HTML 产物 + 设计套件 skill + notebook 工作流"),
    ("task-monitor", "后台任务监控", "后台长任务用 -u + .log + & 启动,Linco 终端面板实时可见"),
    ("shadow-diff", "改动可视化", "影子 git 追踪每轮 agent 改动 + shadow.sh CLI"),
];

// ============ Tauri 命令 ============

/// 插件管理界面用:一个逻辑插件的状态。
#[derive(serde::Serialize)]
pub struct PluginStatus {
    /// agent:"claude" | "codex"
    pub agent: String,
    /// 逻辑 id(语言无关):html / task-monitor / shadow-diff(codex 只有 html)
    pub id: String,
    /// 展示名
    pub name: String,
    /// 一句话描述
    pub desc: String,
    /// 当前语言下对应的变体是否已安装启用
    pub installed: bool,
}

/// claude 逻辑插件 → (基名, 展示名, 描述)。变体名 = 基名 + (en 时 "-en")。
const CLAUDE_PLUGINS: [(&str, &str, &str); 3] = [
    ("linco-html", "HTML 产物套件", "自包含 HTML 产物/报告/notebook + 设计组件 + 就地答复工作流"),
    ("linco-task-monitor", "后台任务监控", "把后台长任务输出重定向到 .log,在终端面板实时查看"),
    ("linco-shadow-diff", "改动可视化", "影子 git 追踪每轮 agent 改了哪些文件(A/M/D + 红绿 diff)"),
];

/// 取当前 config 的语言(zh/en)。
fn current_lang() -> String {
    crate::config::load_config()
        .map(|c| if c.language == "en" { "en" } else { "zh" }.to_string())
        .unwrap_or_else(|_| "zh".to_string())
}

/// claude 某基名在当前语言下的变体名。
fn claude_variant(base: &str, lang: &str) -> String {
    if lang == "en" {
        format!("{base}-en")
    } else {
        base.to_string()
    }
}

/// 查 claude 已安装启用的插件 id 集合(形如 "linco-html@linco-plugins-marketplace")。
/// `claude plugin list --json` 顶层是数组(每项含 id/enabled);
/// `--available` 时则是 {installed:[...], available:[...]}。两种都兼容。
fn claude_installed_ids() -> std::collections::HashSet<String> {
    let mut set = std::collections::HashSet::new();
    let mut c = Command::new("claude");
    c.args(["plugin", "list", "--json"]);
    crate::proc_ext::no_window(&mut c);
    let Ok(o) = c.output() else { return set };
    if !o.status.success() {
        return set;
    }
    let Ok(v) = serde_json::from_slice::<serde_json::Value>(&o.stdout) else {
        return set;
    };
    // 顶层数组,或 {installed:[...]}
    let arr = if let Some(a) = v.as_array() {
        a.clone()
    } else if let Some(a) = v.get("installed").and_then(|x| x.as_array()) {
        a.clone()
    } else {
        return set;
    };
    for p in &arr {
        if let Some(id) = p.get("id").and_then(|x| x.as_str()) {
            if p.get("enabled").and_then(|e| e.as_bool()).unwrap_or(true) {
                set.insert(id.to_string());
            }
        }
    }
    set
}

/// 查 codex 已安装启用的插件名集合(name,如 "html-kit")。
fn codex_installed_names() -> std::collections::HashSet<String> {
    let mut set = std::collections::HashSet::new();
    let mut c = Command::new("codex");
    c.args(["plugin", "list", "--json"]);
    crate::proc_ext::no_window(&mut c);
    if let Ok(o) = c.output() {
        if o.status.success() {
            if let Ok(v) = serde_json::from_slice::<serde_json::Value>(&o.stdout) {
                if let Some(arr) = v.get("installed").and_then(|x| x.as_array()) {
                    for p in arr {
                        let installed = p.get("installed").and_then(|x| x.as_bool()).unwrap_or(false);
                        let enabled = p.get("enabled").and_then(|x| x.as_bool()).unwrap_or(false);
                        if installed && enabled {
                            if let Some(n) = p.get("name").and_then(|x| x.as_str()) {
                                set.insert(n.to_string());
                            }
                        }
                    }
                }
            }
        }
    }
    set
}

/// 列出三个 claude 插件 + 一个 codex 插件的安装状态(供设置页插件管理界面)。
#[tauri::command]
pub async fn plugin_status() -> Result<Vec<PluginStatus>, String> {
    crate::blocking::run(move || {
        let lang = current_lang();
        let mut out = Vec::new();
        // claude
        let claude_ids = claude_installed_ids();
        for (base, name, desc) in CLAUDE_PLUGINS {
            let variant = claude_variant(base, &lang);
            let full = format!("{variant}@{CLAUDE_MARKETPLACE}");
            out.push(PluginStatus {
                agent: "claude".into(),
                id: base.into(),
                name: name.into(),
                desc: desc.into(),
                installed: claude_ids.contains(&full),
            });
        }
        // codex:三个逻辑插件(html / task-monitor / shadow-diff)
        let codex_names = codex_installed_names();
        for (id, name, desc) in CODEX_PLUGINS {
            let variant = codex_variant(id, &lang);
            out.push(PluginStatus {
                agent: "codex".into(),
                id: id.into(),
                name: name.into(),
                desc: desc.into(),
                installed: codex_names.contains(&variant),
            });
        }
        Ok(out)
    })
    .await
}

/// 开关单个插件(本地):install/uninstall(claude)或 add/remove(codex)。
/// agent + 逻辑 id + enabled。语言变体按当前 config 决定。
#[tauri::command]
pub async fn plugin_set(
    app: AppHandle,
    agent: String,
    id: String,
    enabled: bool,
) -> Result<(), String> {
    crate::blocking::run(move || {
        let lang = current_lang();
        if agent == "codex" {
            // codex:始终先确保 marketplace 已注册
            if !cli_has_plugin("codex") {
                return Err("当前 codex 版本不支持插件管理(无 plugin 子命令)".into());
            }
            ensure_codex_marketplace(&app)?;
            let variant = codex_variant(&id, &lang);
            let full = format!("{variant}@{CODEX_MARKETPLACE}");
            let (ok, err) = if enabled {
                run_cli("codex", &["plugin", "add", &full])
            } else {
                run_cli("codex", &["plugin", "remove", &full])
            };
            if ok {
                Ok(())
            } else {
                Err(err)
            }
        } else {
            // claude
            if !cli_has_plugin("claude") {
                return Err("当前 claude 版本不支持插件管理(无 plugin 子命令)".into());
            }
            let root = marketplace_root(&app)?;
            run_cli(
                "claude",
                &["plugin", "marketplace", "add", &root.to_string_lossy(), "--scope", "user"],
            );
            let variant = claude_variant(&id, &lang);
            let full = format!("{variant}@{CLAUDE_MARKETPLACE}");
            let (ok, err) = if enabled {
                run_cli("claude", &["plugin", "install", &full, "--scope", "user"])
            } else {
                run_cli("claude", &["plugin", "uninstall", &full, "--scope", "user"])
            };
            if ok {
                Ok(())
            } else {
                Err(err)
            }
        }
    })
    .await
}


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
        let mut c = Command::new("rsync");
        c.args(["-a", "--delete", "-e", &ssh_e, &from_arg, &dst_arg]);
        crate::proc_ext::no_window(&mut c);
        let out = c.output().map_err(|e| format!("rsync 失败: {e}"))?;
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
    crate::remote::run_remote(host, &remote_sh).map(|_| ())?;
    // 正规注册:rsync 整个 marketplace 到远端 + codex plugin marketplace add + add(若远端支持)
    let has_cli = crate::remote::run_remote(host, "codex plugin --help >/dev/null 2>&1 && echo Y")
        .map(|b| String::from_utf8_lossy(&b).contains('Y'))
        .unwrap_or(false);
    if has_cli {
        if let Ok(mkt) = marketplace_root(app) {
            if rsync_dir_to_remote(&mkt, host, ".linco/marketplace", &ssh_e).is_ok() {
                // marketplace 注册(若旧源不一致则 remove 再 add)
                let _ = crate::remote::run_remote(
                    host,
                    &format!(
                        "codex plugin marketplace add ~/.linco/marketplace 2>/dev/null \
                         || {{ codex plugin marketplace remove {CODEX_MARKETPLACE} 2>/dev/null; \
                               codex plugin marketplace add ~/.linco/marketplace 2>/dev/null; }}; true"
                    ),
                );
                // 三个插件:卸另一语言、装本语言
                for (id, _, _) in CODEX_PLUGINS {
                    let _ = crate::remote::run_remote(
                        host,
                        &format!(
                            "codex plugin remove {}@{CODEX_MARKETPLACE} 2>/dev/null; true",
                            codex_variant(id, other_lang(lang))
                        ),
                    );
                    let _ = crate::remote::run_remote(
                        host,
                        &format!(
                            "codex plugin add {}@{CODEX_MARKETPLACE}",
                            codex_variant(id, lang)
                        ),
                    );
                }
            }
        }
    }
    Ok(())
}
