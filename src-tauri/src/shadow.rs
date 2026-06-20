// 影子快照(Cursor 式「本轮 agent 改动」)—— 用独立 shadow git 仓库,与项目 git 完全无关。
//
// 设计(对齐 Cursor 的 checkpoint 机制):
// - 在 ~/.linco/shadows/<工作目录哈希>/ 建一个**独立的 git 仓库**,它的 work-tree 指向
//   用户的工作目录。所有操作都用 `git --git-dir=<影子> --work-tree=<工作目录>`,
//   **绝不碰用户项目自己的 .git**。
// - 「本轮基线」= 发消息那一刻,在影子仓库里 `add -A && commit` 出来的一个 commit。
//   因为影子仓库是全新的、没有用户的 .gitignore 约束,`add -A` 会纳入**一切文件**——
//   包括 untracked 产物、artifacts、被项目 .gitignore 忽略的临时文件。这正是
//   「本轮 agent 改了什么」该有的范围:跟文件有没有被项目 git 跟踪毫无关系。
// - changed = `git diff --name-status 基线`(对比影子基线 vs 当前工作目录)。
// - diff    = `git diff 基线 -- 文件`(红绿增删,git 原生,大文件/二进制 git 自动处理)。
//
// 为什么用影子 git 而非内存存文件内容:git 自动压缩去重、按内容寻址,内存/磁盘开销远低于
// 裸存;大文件、二进制、改名都由 git 妥善处理;diff 是 git 原生输出,前端 DiffView 直接渲染。
//
// 噪声目录(.git/node_modules/...)通过影子仓库自带的 .git/info/exclude 排除,既省扫描、
// 又避免把 node_modules 这种几万文件纳入快照。
//
// 本文件目前实现**本地**(host 为空)。远程(SSH)走 agent 端同构实现,见 linco_agent.py。

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, OnceLock};

// 临时文件唯一序号:tauri 命令在多线程池上跑,std::process::id() 在并发调用间相同,
// 会导致临时 index / 列表文件名冲突 → 并发 changed/diff 互相踩 index(全删/空 index bug)。
static SHADOW_SEQ: AtomicU64 = AtomicU64::new(0);
fn shadow_uniq() -> u64 {
    SHADOW_SEQ.fetch_add(1, Ordering::Relaxed)
}

// 每个 (host, repo) 是否已初始化过影子仓库(进程内缓存,避免每轮重复 init)。
static INITED: OnceLock<Mutex<HashMap<String, bool>>> = OnceLock::new();
fn inited() -> &'static Mutex<HashMap<String, bool>> {
    INITED.get_or_init(|| Mutex::new(HashMap::new()))
}

// 每仓库一把锁:begin/changed/diff 共享同一个常驻「热」index(保留 stat 缓存以增量哈希),
// 必须串行,避免并发同时改 index 互相踩(空 index → 全 D/全红 bug)。各操作已是秒级,串行无损。
static REPO_LOCKS: OnceLock<Mutex<HashMap<String, std::sync::Arc<Mutex<()>>>>> = OnceLock::new();
fn repo_lock(host: &Option<String>, repo: &str) -> std::sync::Arc<Mutex<()>> {
    let m = REPO_LOCKS.get_or_init(|| Mutex::new(HashMap::new()));
    let mut map = m.lock().unwrap_or_else(|e| e.into_inner());
    map.entry(key(host, repo))
        .or_insert_with(|| std::sync::Arc::new(Mutex::new(())))
        .clone()
}

fn key(host: &Option<String>, repo: &str) -> String {
    format!("{}|{}", host.as_deref().unwrap_or(""), repo)
}

/// 影子仓库目录:<linco_home>/shadows/<工作目录路径哈希>。随发布版/dev 版隔离。
/// 哈希用一个稳定的字符串散列(不引第三方 crate),足够避免不同工作目录冲突。
fn shadow_dir(repo: &str) -> PathBuf {
    let base = crate::config::linco_home()
        .unwrap_or_else(|_| PathBuf::from("/tmp").join(".linco"));
    let h = stable_hash(repo);
    base.join("shadows").join(format!("{h:016x}"))
}

/// 稳定的 FNV-1a 64 位哈希(进程间一致,不依赖 RandomState)。
fn stable_hash(s: &str) -> u64 {
    let mut hash: u64 = 0xcbf29ce484222325;
    for b in s.as_bytes() {
        hash ^= *b as u64;
        hash = hash.wrapping_mul(0x100000001b3);
    }
    hash
}

/// 单文件纳入快照的大小上限:超过则不纳入(不标记、不 diff)。
/// 训练产物里动辄上 GB 的模型权重必须挡在外面,否则影子 git 会被撑爆/卡死。
const MAX_SNAPSHOT_FILE: u64 = 1024 * 1024; // 1MB

/// 噪声目录:整目录跳过,不递归。
const SKIP_DIRS: &[&str] = &[
    ".git", "node_modules", "target", "__pycache__", ".venv", "venv", "env", "dist", "build",
    ".tox", ".mypy_cache", ".pytest_cache", ".ruff_cache", ".idea", ".vscode", ".cache",
    "site-packages", "swanlog", "wandb", "outputs", "checkpoints", "logs",
    ".ipynb_checkpoints", ".conda", ".eggs", "__MACOSX",
];

/// 只收人类会手改的源码/文本/配置扩展名;venv 库、模型权重、数据产物等一律不进影子。
const SNAPSHOT_EXTS: &[&str] = &[
    "py", "pyi", "pyx", "ipynb", "json", "jsonl", "md", "markdown", "rst", "txt",
    "yaml", "yml", "toml", "cfg", "ini", "conf", "env", "properties",
    "sh", "bash", "zsh", "fish", "ps1", "bat",
    "ts", "tsx", "js", "jsx", "mjs", "cjs", "vue", "svelte",
    "css", "scss", "less", "html", "htm", "xml", "svg",
    "c", "h", "cpp", "cc", "hpp", "rs", "go", "java", "kt", "rb", "php", "lua",
    "sql", "graphql", "proto", "tex", "csv", "tsv", "gradle", "cmake", "mk",
    "r", "jl", "scala", "swift", "m", "mm",
];

/// 无扩展名但人类常改的文件名。
const SNAPSHOT_NAMES: &[&str] = &[
    "Dockerfile", "Makefile", "makefile", "CMakeLists.txt", "Justfile", "justfile",
    "README", "LICENSE", "Procfile", ".gitignore", ".dockerignore", ".env",
    "requirements.txt",
];

/// 在影子仓库上跑一条 git 命令(本地)。`--git-dir`/`--work-tree` 把它和项目 git 隔离。
fn shadow_git(repo: &str, gitdir: &Path, args: &[&str]) -> Result<String, String> {
    let mut full: Vec<String> = vec![
        format!("--git-dir={}", gitdir.to_string_lossy()),
        format!("--work-tree={}", repo),
        // 关掉用户全局/系统 git 配置干扰(hooks、gpgsign 等),保证影子提交干净快速。
        "-c".into(),
        "core.hooksPath=/dev/null".into(),
        "-c".into(),
        "commit.gpgsign=false".into(),
    ];
    full.extend(args.iter().map(|a| a.to_string()));
    let out = Command::new("git")
        .args(&full)
        .output()
        .map_err(|e| format!("无法执行 git: {e}"))?;
    if out.status.success() {
        Ok(String::from_utf8_lossy(&out.stdout).to_string())
    } else {
        Err(String::from_utf8_lossy(&out.stderr).to_string())
    }
}

/// 遍历工作目录,收集应纳入快照的文件(相对路径)。不读项目 .gitignore。
/// 三重筛选,把噪声挡在外面(否则 venv/日志/产物动辄几万文件,首次哈希撞超时):
///   1) 跳 venv:目录含 pyvenv.cfg → 整个不进(抓住 .venv/.venv312/env 等所有命名变体)
///   2) 跳噪声目录 SKIP_DIRS + *.egg-info
///   3) 只收白名单类型(人类会改的源码/文本/配置)+ 少数无扩展名常见文件,且 <1MB
fn collect_files(repo: &str) -> Vec<String> {
    let root = Path::new(repo);
    let mut out = Vec::new();
    let mut stack = vec![root.to_path_buf()];
    while let Some(dir) = stack.pop() {
        // venv 探测:该目录含 pyvenv.cfg 则整个跳过(不递归、不收文件)。
        if dir.join("pyvenv.cfg").exists() {
            continue;
        }
        let Ok(rd) = std::fs::read_dir(&dir) else {
            continue;
        };
        for e in rd.flatten() {
            let p = e.path();
            let Ok(ft) = e.file_type() else { continue };
            if ft.is_symlink() {
                continue; // 不跟随符号链接,避免环/越界
            }
            if ft.is_dir() {
                let name = e.file_name().to_string_lossy().to_string();
                if !SKIP_DIRS.contains(&name.as_str()) && !name.ends_with(".egg-info") {
                    stack.push(p);
                }
            } else if ft.is_file() {
                let name = e.file_name().to_string_lossy().to_string();
                let ext = name
                    .rsplit_once('.')
                    .map(|(_, e)| e.to_ascii_lowercase())
                    .unwrap_or_default();
                let wanted =
                    SNAPSHOT_EXTS.contains(&ext.as_str()) || SNAPSHOT_NAMES.contains(&name.as_str());
                if !wanted {
                    continue;
                }
                let too_big = e
                    .metadata()
                    .map(|m| m.len() > MAX_SNAPSHOT_FILE)
                    .unwrap_or(true);
                if too_big {
                    continue;
                }
                if let Ok(rel) = p.strip_prefix(root) {
                    out.push(rel.to_string_lossy().to_string());
                }
            }
        }
        if out.len() > 100_000 {
            break; // 文件数硬上限,防失控
        }
    }
    out
}

/// 增量刷新持久 index 到当前工作区状态(**绝不清空** → 保留 git 的 stat 缓存,
/// `add` 只重哈希真正变动的文件,大目录从几十秒降到秒级 = 增量重置,不会爆机器):
///   1) git add -f <当前文件列表>:纳入新增/修改(强制,绕过 .gitignore)
///   2) git add -u:只更新已跟踪文件,识别「消失的文件」→ 记录为删除(D)
/// -u 只动已在 index 的文件,不会把 .gitignore 忽略的新目录拉进来,故 .gitignore 安全。
fn stage_snapshot(repo: &str, gitdir: &Path) -> Result<(), String> {
    let files = collect_files(repo);
    if !files.is_empty() {
        // 用 NUL 分隔的 pathspec 文件喂给 git add -f(避免文件名含空格/特殊字符出错;
        // 也避免命令行参数过长)。文件名唯一,避免并发互相覆盖。
        let mut buf = String::with_capacity(files.len() * 24);
        for f in &files {
            buf.push_str(f);
            buf.push('\0');
        }
        let tmp = gitdir.join(format!("linco-stage-{}", shadow_uniq()));
        std::fs::write(&tmp, buf.as_bytes()).map_err(|e| e.to_string())?;
        let res = shadow_git(
            repo,
            gitdir,
            &[
                "add",
                "-f",
                "--pathspec-from-file",
                &tmp.to_string_lossy(),
                "--pathspec-file-nul",
            ],
        );
        let _ = std::fs::remove_file(&tmp);
        res?;
    }
    // 补删除:更新已跟踪文件,把磁盘上已消失的记为删除。
    shadow_git(repo, gitdir, &["add", "-u"]).map(|_| ())
}


/// 确保影子仓库已初始化(init + 写 excludes)。幂等:进程内只做一次真正的 init。
fn ensure_init(host: &Option<String>, repo: &str) -> Result<PathBuf, String> {
    let gitdir = shadow_dir(repo);
    let k = key(host, repo);
    {
        let m = inited().lock().map_err(|e| e.to_string())?;
        if m.get(&k).copied().unwrap_or(false) && gitdir.join("HEAD").exists() {
            return Ok(gitdir);
        }
    }
    std::fs::create_dir_all(&gitdir).map_err(|e| e.to_string())?;
    // 已是 git 目录则跳过 init
    if !gitdir.join("HEAD").exists() {
        shadow_git(repo, &gitdir, &["init", "-q"])?;
        // 身份(避免 commit 因缺 user.* 失败);影子仓库本地私有,值无所谓。
        let _ = shadow_git(repo, &gitdir, &["config", "user.email", "linco@local"]);
        let _ = shadow_git(repo, &gitdir, &["config", "user.name", "Linco"]);
    }
    if let Ok(mut m) = inited().lock() {
        m.insert(k, true);
    }
    Ok(gitdir)
}

/// 把绝对路径转成相对 repo 的路径(git diff 路径参数用)。
fn rel_of(repo: &str, path: &str) -> String {
    path.strip_prefix(&format!("{}/", repo.trim_end_matches('/')))
        .unwrap_or(path)
        .to_string()
}

/// 开始新一轮(用户发消息时调):在影子仓库里 add -A + commit,作为本轮基线。
/// 覆盖上一轮基线。对一切文件生效(含 untracked / gitignored 产物),不依赖项目 git。
#[tauri::command]
pub async fn shadow_begin_turn(host: Option<String>, repo: String) -> Result<(), String> {
    crate::blocking::run(move || {
        let host = host.filter(|s| !s.is_empty());
        // 远程暂走 agent(见 linco_agent.py 的 snap_* op);此处先实现本地。
        if host.is_some() {
            return crate::agent_rpc::shadow_begin(host.as_deref().unwrap(), &repo);
        }
        let gitdir = ensure_init(&host, &repo)?;
        // 持仓库锁:与 changed/diff 串行共享同一个热 index。增量 stage(不清空 → 秒级)。
        let lk = repo_lock(&host, &repo);
        let _g = lk.lock().unwrap_or_else(|e| e.into_inner());
        stage_snapshot(&repo, &gitdir)?;
        // commit:--allow-empty 保证即便无改动也产出一个基线 commit(后续 diff 才有锚点)。
        shadow_git(
            &repo,
            &gitdir,
            &[
                "commit",
                "-q",
                "--allow-empty",
                "-m",
                "linco-turn-baseline",
            ],
        )?;
        Ok(())
    })
    .await
}

/// 某文件本轮的 diff(unified)。无基线/无改动 → 空串(前端显完整文件)。
#[tauri::command]
pub async fn shadow_diff(
    host: Option<String>,
    repo: String,
    path: String,
) -> Result<String, String> {
    crate::blocking::run(move || {
        let host = host.filter(|s| !s.is_empty());
        if host.is_some() {
            return crate::agent_rpc::shadow_diff_remote(host.as_deref().unwrap(), &repo, &path);
        }
        let gitdir = shadow_dir(&repo);
        if !gitdir.join("HEAD").exists() {
            return Ok(String::new()); // 还没拍过基线
        }
        let rel = rel_of(&repo, &path);
        // 持仓库锁:与 begin/changed 串行共享同一个热 index(增量哈希,秒级),不互相踩。
        let lk = repo_lock(&host, &repo);
        let _g = lk.lock().unwrap_or_else(|e| e.into_inner());
        stage_snapshot(&repo, &gitdir)?;
        shadow_git(
            &repo,
            &gitdir,
            &["diff", "--cached", "--no-color", "HEAD", "--", &rel],
        )
    })
    .await
}

/// 本轮改过哪些文件:绝对路径 → 状态字符(M/A/D)。供文件树「本轮高亮」。
#[tauri::command]
pub async fn shadow_changed(
    host: Option<String>,
    repo: String,
) -> Result<HashMap<String, String>, String> {
    crate::blocking::run(move || {
        let host = host.filter(|s| !s.is_empty());
        if host.is_some() {
            return crate::agent_rpc::shadow_changed_remote(host.as_deref().unwrap(), &repo);
        }
        let gitdir = shadow_dir(&repo);
        if !gitdir.join("HEAD").exists() {
            return Ok(HashMap::new());
        }
        // 持仓库锁:与 begin/diff 串行共享同一个热 index(增量哈希,秒级),不互相踩。
        let lk = repo_lock(&host, &repo);
        let _g = lk.lock().unwrap_or_else(|e| e.into_inner());
        stage_snapshot(&repo, &gitdir)?;
        let out = shadow_git(&repo, &gitdir, &["diff", "--cached", "--name-status", "HEAD"])?;
        Ok(parse_name_status(&repo, &out))
    })
    .await
}

/// 解析 `git diff --name-status` 输出为 绝对路径 → 状态字符(M/A/D)。
fn parse_name_status(repo: &str, out: &str) -> HashMap<String, String> {
    let base_dir = repo.trim_end_matches('/');
    let mut map = HashMap::new();
    for line in out.lines() {
        let mut it = line.split('\t');
        let st = it.next().unwrap_or("").trim();
        let p = it.next().unwrap_or("").trim();
        if st.is_empty() || p.is_empty() {
            continue;
        }
        let ch = st.chars().next().unwrap_or('M').to_string();
        map.insert(format!("{base_dir}/{p}"), ch);
    }
    map
}

#[cfg(test)]
mod tests {
    use super::*;

    fn run<F: std::future::Future>(f: F) -> F::Output {
        tauri::async_runtime::block_on(f)
    }

    // 端到端:本地建临时工作目录 → begin_turn → 改文件/新建未跟踪文件 → changed/diff。
    #[test]
    fn snapshot_tracks_untracked_and_modified() {
        let tmp = std::env::temp_dir().join(format!("linco_shadow_test_{}", stable_hash("t1")));
        let _ = std::fs::remove_dir_all(&tmp);
        std::fs::create_dir_all(&tmp).unwrap();
        let repo = tmp.to_string_lossy().to_string();
        // 初始已有一个文件
        std::fs::write(tmp.join("a.txt"), "line1\nline2\n").unwrap();

        // 发消息:拍基线
        run(shadow_begin_turn(None, repo.clone())).unwrap();

        // agent 改动:改 a.txt、新建未跟踪 b.txt
        std::fs::write(tmp.join("a.txt"), "line1\nCHANGED\n").unwrap();
        std::fs::write(tmp.join("b.txt"), "new file\n").unwrap();

        let changed = run(shadow_changed(None, repo.clone())).unwrap();
        let a = format!("{repo}/a.txt");
        let b = format!("{repo}/b.txt");
        assert_eq!(changed.get(&a).map(String::as_str), Some("M"));
        assert_eq!(changed.get(&b).map(String::as_str), Some("A"), "未跟踪新建文件应标 A");

        // a.txt 的 diff 应含红绿增删
        let d = run(shadow_diff(None, repo.clone(), a)).unwrap();
        assert!(d.contains("-line2"), "diff 应显示删除行");
        assert!(d.contains("+CHANGED"), "diff 应显示新增行");

        // b.txt(全新)diff 应是全绿新增
        let db = run(shadow_diff(None, repo.clone(), b)).unwrap();
        assert!(db.contains("+new file"), "新建文件 diff 应显示新增内容");

        let _ = std::fs::remove_dir_all(&tmp);
        let _ = std::fs::remove_dir_all(shadow_dir(&repo));
    }

    #[test]
    fn no_baseline_returns_empty() {
        let repo = "/nonexistent/linco_no_baseline".to_string();
        let changed = run(shadow_changed(None, repo.clone())).unwrap();
        assert!(changed.is_empty());
        let d = run(shadow_diff(None, repo, "x".into())).unwrap();
        assert!(d.is_empty());
    }
}
