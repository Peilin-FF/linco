// 文件监听:启动/停止对当前工作目录的监听,变更经 "remote-fs-change" 事件推前端。
// - 远程:走 agent 的 watch op(远端 inotify/poll,最灵敏)。
// - 本地:本进程起一个 mtime 扫描线程(无 agent,直接读盘)。
// 前端在连接/工作目录就绪时调 watch_start;切换时自动换监听目标。

use std::collections::HashMap;
use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

use serde::Serialize;
use tauri::{AppHandle, Emitter};

#[derive(Clone, Serialize)]
struct FsChangeEvent {
    host: String,
    paths: Vec<String>,
}

// 本地监听:用 generation 计数让旧线程自然退出(切目录时 +1)。
static LOCAL_GEN: AtomicU64 = AtomicU64::new(0);
// 当前远程监听的 host(切换时先给旧 host unwatch)。
static REMOTE_HOST: OnceLock<Mutex<Option<String>>> = OnceLock::new();
fn remote_host() -> &'static Mutex<Option<String>> {
    REMOTE_HOST.get_or_init(|| Mutex::new(None))
}

const SKIP: &[&str] = &[".git", "node_modules", "target", "__pycache__", ".venv", "dist"];

/// 启动监听某工作目录。host 空=本地。重复调用会切换监听目标。
#[tauri::command]
pub fn watch_start(app: AppHandle, host: Option<String>, root: String) -> Result<(), String> {
    let host = host.filter(|s| !s.is_empty());
    // 先停掉之前的远程监听(若 host 变了)
    {
        let mut cur = remote_host().lock().map_err(|e| e.to_string())?;
        if let Some(old) = cur.clone() {
            if Some(&old) != host.as_ref() {
                let _ = crate::agent_rpc::unwatch(&old);
            }
        }
        *cur = host.clone();
    }
    // 本地监听换代(让旧线程退出)
    LOCAL_GEN.fetch_add(1, Ordering::Relaxed);

    if let Some(h) = host {
        // 远程:agent 监听。首次连远程要 spawn agent(ssh 部署+起 python+握手),
        // 耗时数秒——**放到后台线程**,绝不阻塞这个 Tauri 命令线程(否则启动时
        // 它和 prewarm 的数据调用一起把命令线程池占满,窗口画面卡住不刷新)。
        std::thread::spawn(move || {
            let _ = crate::agent_rpc::watch(&h, &root);
        });
        Ok(())
    } else {
        // 本地:起 mtime 扫描线程
        let gen = LOCAL_GEN.load(Ordering::Relaxed);
        std::thread::spawn(move || local_poll(app, root, gen));
        Ok(())
    }
}

/// 停止监听(切到无工作目录 / 断开)。
#[tauri::command]
pub fn watch_stop() -> Result<(), String> {
    LOCAL_GEN.fetch_add(1, Ordering::Relaxed);
    if let Ok(mut cur) = remote_host().lock() {
        if let Some(old) = cur.take() {
            let _ = crate::agent_rpc::unwatch(&old);
        }
    }
    Ok(())
}

fn scan_mtimes(root: &str) -> HashMap<String, i64> {
    let mut out = HashMap::new();
    let mut stack = vec![Path::new(root).to_path_buf()];
    while let Some(dir) = stack.pop() {
        let Ok(rd) = std::fs::read_dir(&dir) else { continue };
        for e in rd.flatten() {
            let p = e.path();
            let ft = match e.file_type() {
                Ok(t) => t,
                Err(_) => continue,
            };
            if ft.is_dir() {
                let n = e.file_name().to_string_lossy().to_string();
                if !SKIP.contains(&n.as_str()) {
                    stack.push(p);
                }
            } else if let Ok(m) = e.metadata().and_then(|md| md.modified()) {
                if let Ok(d) = m.duration_since(std::time::UNIX_EPOCH) {
                    out.insert(p.to_string_lossy().to_string(), d.as_secs() as i64);
                }
            }
        }
        if out.len() > 20000 {
            break;
        }
    }
    out
}

fn local_poll(app: AppHandle, root: String, gen: u64) {
    let mut prev = scan_mtimes(&root);
    loop {
        std::thread::sleep(Duration::from_millis(500));
        if LOCAL_GEN.load(Ordering::Relaxed) != gen {
            return; // 已换代,退出
        }
        let cur = scan_mtimes(&root);
        let mut changed: Vec<String> = Vec::new();
        for (p, m) in &cur {
            if prev.get(p) != Some(m) {
                changed.push(p.clone());
            }
        }
        for p in prev.keys() {
            if !cur.contains_key(p) {
                changed.push(p.clone());
            }
        }
        if !changed.is_empty() {
            changed.sort();
            changed.dedup();
            let _ = app.emit(
                "remote-fs-change",
                FsChangeEvent {
                    host: String::new(),
                    paths: changed,
                },
            );
        }
        prev = cur;
    }
}
