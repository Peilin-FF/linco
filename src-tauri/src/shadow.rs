// 影子快照:Cursor 式"本轮 agent 改动"diff。
//
// 语义:用户每次发消息给 agent = 一轮。发消息那一刻用 `git stash create` 拿一个
// 只读基线 commit(不入栈、不动工作区/暂存区),代表"这一轮开始前"的状态。
// 之后 agent 改文件,diff = 工作区 vs 该基线;文件树高亮 = `git diff --name-status 基线`。
// 基线持续到下次发消息(新一轮)才覆盖。仅 git 仓库;非 git 返回空。
//
// 为什么不用 HEAD:HEAD 是上次提交,会把"多轮未提交改动"混在一起,分不清"这一轮"。
// git stash create 精确锚定"发消息那一刻"且不污染 git。

use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};

use crate::git::git_raw;

// 每个 (host, repo) 的当前轮基线 commit 哈希。host 空串=本地。
static BASELINE: OnceLock<Mutex<HashMap<String, String>>> = OnceLock::new();
fn baselines() -> &'static Mutex<HashMap<String, String>> {
    BASELINE.get_or_init(|| Mutex::new(HashMap::new()))
}

fn key(host: &Option<String>, repo: &str) -> String {
    format!("{}|{}", host.as_deref().unwrap_or(""), repo)
}

fn is_repo(host: &Option<String>, repo: &str) -> bool {
    git_raw(host, repo, &["rev-parse", "--is-inside-work-tree"])
        .map(|o| o.trim() == "true")
        .unwrap_or(false)
}

/// 取"发消息那一刻"的基线 commit:
/// - `git stash create` 把当前工作区(含已跟踪改动)封成一个 commit 对象返回其哈希,
///   **不入 stash 栈、不动工作区**。工作区干净时返回空 → 退回用 HEAD。
fn make_baseline(host: &Option<String>, repo: &str) -> Option<String> {
    let created = git_raw(host, repo, &["stash", "create"]).ok()?;
    let created = created.trim();
    if !created.is_empty() {
        return Some(created.to_string());
    }
    // 工作区干净 → 用 HEAD 作基线
    let head = git_raw(host, repo, &["rev-parse", "HEAD"]).ok()?;
    let head = head.trim();
    if head.is_empty() {
        None
    } else {
        Some(head.to_string())
    }
}

/// 开始新一轮(用户发消息时调):记基线,覆盖上一轮。非 git 仓库则清掉基线(关闭功能)。
#[tauri::command]
pub fn shadow_begin_turn(host: Option<String>, repo: String) -> Result<(), String> {
    let host = host.filter(|s| !s.is_empty());
    let k = key(&host, &repo);
    if !is_repo(&host, &repo) {
        if let Ok(mut m) = baselines().lock() {
            m.remove(&k);
        }
        return Ok(());
    }
    let base = make_baseline(&host, &repo);
    if let Ok(mut m) = baselines().lock() {
        match base {
            Some(b) => {
                m.insert(k, b);
            }
            None => {
                m.remove(&k);
            }
        }
    }
    Ok(())
}

/// 某文件本轮的 diff(unified)。无基线/无改动 → 返回空串(前端则显完整文件)。
#[tauri::command]
pub fn shadow_diff(host: Option<String>, repo: String, path: String) -> Result<String, String> {
    let host = host.filter(|s| !s.is_empty());
    let base = {
        let m = baselines().lock().map_err(|e| e.to_string())?;
        match m.get(&key(&host, &repo)) {
            Some(b) => b.clone(),
            None => return Ok(String::new()),
        }
    };
    // path 可能是绝对路径;git 需要相对 repo 的路径
    let rel = path
        .strip_prefix(&format!("{}/", repo.trim_end_matches('/')))
        .unwrap_or(&path)
        .to_string();
    git_raw(
        &host,
        &repo,
        &["diff", "--no-color", &base, "--", &rel],
    )
}

/// 本轮改过哪些文件:相对 repo 的路径 → 状态字符(M/A/D)。供文件树"本轮高亮"。
#[tauri::command]
pub fn shadow_changed(
    host: Option<String>,
    repo: String,
) -> Result<HashMap<String, String>, String> {
    let host = host.filter(|s| !s.is_empty());
    let base = {
        let m = baselines().lock().map_err(|e| e.to_string())?;
        match m.get(&key(&host, &repo)) {
            Some(b) => b.clone(),
            None => return Ok(HashMap::new()),
        }
    };
    let out = git_raw(&host, &repo, &["diff", "--name-status", &base])?;
    let base_dir = repo.trim_end_matches('/');
    let mut map = HashMap::new();
    for line in out.lines() {
        let mut it = line.split('\t');
        let st = it.next().unwrap_or("").trim();
        let p = it.next().unwrap_or("").trim();
        if st.is_empty() || p.is_empty() {
            continue;
        }
        // 状态首字母:A/M/D(R 改名等取首字母)
        let ch = st.chars().next().unwrap_or('M').to_string();
        map.insert(format!("{base_dir}/{p}"), ch);
    }
    Ok(map)
}
