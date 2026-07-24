// 文件传输引擎(FileZilla 式并行 SFTP/scp)。
//
// 目标:在「文件」视图与本机桌面之间拖拽互传,支持本地与远程目标。
// - 上传(本地 → 远程):scp 本地文件到 host:远程路径
// - 下载(远程 → 本地):scp host:远程路径 到本地
//
// 跨平台要点:
// - 只用 ssh/scp(Windows 10+ 自带 OpenSSH;macOS 自带),**绝不用 rsync**(Windows 无)。
// - 认证靠 ~/.ssh/config 的 Host 别名 + IdentityFile,全程 BatchMode=yes 非交互。
// - 类 Unix 上自动复用 ControlMaster socket(ssh_opts);Windows 上每个 worker 各自认证。
// - 每条命令过 proc_ext::no_window(Windows 不闪窗)+ resolve_exe 定位 scp。
//
// 并行模型:一次传输 = 一个 job(唯一 id)。先扫描展开成文件清单(本地 walk /
// 远程 find),得到总文件数与总字节;再用 N 个 worker 并发取文件传输,每完成一个
// 文件就累加计数/字节并 emit 进度。这就是 FileZilla 的多路并行体验。
//
// 进度协议(emit 到前端):
//   "transfer-progress" { jobId, phase, done, total, bytesDone, bytesTotal, current }
//       phase: "scanning" | "transferring"
//   "transfer-done"     { jobId, ok, error, total }
//
// 安全:只搬运用户拖拽指定的文件;不读取/记录/传输 SSH 私钥、模型配置或任何凭据。

use std::collections::{BTreeSet, HashMap, VecDeque};
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};

use serde_json::json;
use tauri::{AppHandle, Emitter};

/// 并发 worker 数(同时进行的 scp 路数)。FileZilla 风格的多路并行,默认 8。
const WORKERS: usize = 8;
/// 一次 mkdir -p 批量创建的远端目录上限(避免命令行过长)。
const MKDIR_CHUNK: usize = 80;

/// 传输方向。
#[derive(Clone, Copy, PartialEq)]
enum Direction {
    Upload,   // 本地 → 远程
    Download, // 远程 → 本地
}

/// 展开后的单个文件项。src/dst 为各自一侧的绝对路径(不含 host 前缀)。
/// - Upload:src=本地路径,dst=远程路径
/// - Download:src=远程路径,dst=本地路径
struct Item {
    src: String,
    dst: String,
    size: u64,
}

/// worker 共享的进度状态(锁保护)。
struct Shared {
    done: u64,
    bytes_done: u64,
    current: String,
    errors: Vec<String>,
}

/// job id 自增计数器。
static SEQ: AtomicU64 = AtomicU64::new(1);
/// job 取消标志注册表:jobId → 取消标志。
fn registry() -> &'static Mutex<HashMap<u64, Arc<AtomicBool>>> {
    static REG: OnceLock<Mutex<HashMap<u64, Arc<AtomicBool>>>> = OnceLock::new();
    REG.get_or_init(|| Mutex::new(HashMap::new()))
}

fn next_id() -> u64 {
    SEQ.fetch_add(1, Ordering::Relaxed)
}
fn register(id: u64) -> Arc<AtomicBool> {
    let flag = Arc::new(AtomicBool::new(false));
    if let Ok(mut g) = registry().lock() {
        g.insert(id, flag.clone());
    }
    flag
}
fn unregister(id: u64) {
    if let Ok(mut g) = registry().lock() {
        g.remove(&id);
    }
}

/// 单引号转义,供远端 shell(scp 远端路径会被远端 shell 解析)安全使用。
fn shq(s: &str) -> String {
    format!("'{}'", s.replace('\'', "'\\''"))
}

/// scp 可执行文件(mac:/usr/bin/scp;Windows:裸名走 PATH,同仓库其余 ssh 用法一致)。
fn scp_exe() -> String {
    crate::proc_ext::resolve_exe("scp")
}

// ============ 对外命令 ============

/// 上传:把本地若干路径(文件/文件夹)传到远端 host 的 dest_dir 下。立即返回 jobId,
/// 实际传输在后台线程进行,通过事件推进度。
#[tauri::command]
pub fn transfer_upload(
    app: AppHandle,
    host: String,
    srcs: Vec<String>,
    dest_dir: String,
) -> Result<u64, String> {
    if host.is_empty() {
        return Err("上传需要远程主机".into());
    }
    let id = next_id();
    let cancel = register(id);
    std::thread::spawn(move || {
        run_job(app, id, cancel, Direction::Upload, host, srcs, dest_dir);
    });
    Ok(id)
}

/// 下载:把远端 host 的若干路径(文件/文件夹)传到本地 dest_dir 下。立即返回 jobId。
#[tauri::command]
pub fn transfer_download(
    app: AppHandle,
    host: String,
    srcs: Vec<String>,
    dest_dir: String,
) -> Result<u64, String> {
    if host.is_empty() {
        return Err("下载需要远程主机".into());
    }
    let id = next_id();
    let cancel = register(id);
    std::thread::spawn(move || {
        run_job(app, id, cancel, Direction::Download, host, srcs, dest_dir);
    });
    Ok(id)
}

/// 取消一个进行中的 job(worker 在下一个文件前检查标志后停止)。
#[tauri::command]
pub fn transfer_cancel(job_id: u64) -> Result<(), String> {
    if let Ok(g) = registry().lock() {
        if let Some(flag) = g.get(&job_id) {
            flag.store(true, Ordering::Relaxed);
        }
    }
    Ok(())
}

// ============ job 主流程 ============

fn run_job(
    app: AppHandle,
    id: u64,
    cancel: Arc<AtomicBool>,
    dir: Direction,
    host: String,
    srcs: Vec<String>,
    dest_dir: String,
) {
    // 1) 扫描阶段:先让 UI 弹出进度窗
    emit_progress(&app, id, "scanning", 0, 0, 0, 0, "");

    let items = match dir {
        Direction::Upload => expand_local(&srcs, &dest_dir),
        Direction::Download => expand_remote(&host, &srcs, &dest_dir),
    };
    let items = match items {
        Ok(v) => v,
        Err(e) => {
            emit_done(&app, id, false, &e, 0);
            unregister(id);
            return;
        }
    };

    let total = items.len() as u64;
    let bytes_total: u64 = items.iter().map(|i| i.size).sum();
    if total == 0 {
        emit_done(&app, id, true, "", 0);
        unregister(id);
        return;
    }

    // 2) 预创建目标目录
    let prep = match dir {
        Direction::Upload => precreate_remote_dirs(&host, &items),
        Direction::Download => precreate_local_dirs(&items),
    };
    if let Err(e) = prep {
        emit_done(&app, id, false, &format!("准备目标目录失败: {e}"), total);
        unregister(id);
        return;
    }

    emit_progress(&app, id, "transferring", 0, total, 0, bytes_total, "");

    // 3) worker 池并发传输
    let queue: Arc<Mutex<VecDeque<Item>>> = Arc::new(Mutex::new(items.into_iter().collect()));
    let shared = Arc::new(Mutex::new(Shared {
        done: 0,
        bytes_done: 0,
        current: String::new(),
        errors: Vec::new(),
    }));

    let n = WORKERS.min(total as usize).max(1);
    let mut handles = Vec::with_capacity(n);
    for _ in 0..n {
        let queue = queue.clone();
        let shared = shared.clone();
        let cancel = cancel.clone();
        let app = app.clone();
        let host = host.clone();
        handles.push(std::thread::spawn(move || loop {
            if cancel.load(Ordering::Relaxed) {
                break;
            }
            let item = {
                let mut q = match queue.lock() {
                    Ok(q) => q,
                    Err(_) => break,
                };
                q.pop_front()
            };
            let item = match item {
                Some(it) => it,
                None => break,
            };

            // 标记当前文件名
            let name = item
                .src
                .trim_end_matches('/')
                .rsplit('/')
                .next()
                .unwrap_or(&item.src)
                .to_string();
            if let Ok(mut s) = shared.lock() {
                s.current = name.clone();
            }
            emit_from_shared(&app, id, "transferring", total, bytes_total, &shared);

            // 执行单文件 scp
            let res = scp_one(dir, &host, &item);

            if let Ok(mut s) = shared.lock() {
                s.done += 1;
                s.bytes_done += item.size;
                if let Err(e) = res {
                    s.errors.push(format!("{name}: {e}"));
                }
            }
            emit_from_shared(&app, id, "transferring", total, bytes_total, &shared);
        }));
    }
    for h in handles {
        let _ = h.join();
    }

    // 4) 汇总
    let (done, errors, canceled) = {
        let s = shared.lock().ok();
        let canceled = cancel.load(Ordering::Relaxed);
        match s {
            Some(s) => (s.done, s.errors.clone(), canceled),
            None => (0, vec!["内部状态丢失".into()], canceled),
        }
    };
    let ok = errors.is_empty() && !canceled;
    let err_msg = if canceled {
        "已取消".to_string()
    } else if !errors.is_empty() {
        let shown: Vec<_> = errors.iter().take(5).cloned().collect();
        let more = if errors.len() > 5 {
            format!(" 等 {} 个", errors.len())
        } else {
            String::new()
        };
        format!("{}{}", shown.join("; "), more)
    } else {
        String::new()
    };
    let _ = done;
    emit_done(&app, id, ok, &err_msg, total);
    unregister(id);
}

// ============ 展开:目录 → 文件清单 ============

/// 本地展开(上传用)。dst 为远端路径(用 '/' 分隔)。
fn expand_local(srcs: &[String], dest_dir: &str) -> Result<Vec<Item>, String> {
    let base_dest = dest_dir.trim_end_matches('/');
    let mut items = Vec::new();
    for s in srcs {
        let p = PathBuf::from(s);
        let base = p
            .file_name()
            .ok_or_else(|| format!("无法解析源名称: {s}"))?
            .to_string_lossy()
            .to_string();
        if p.is_dir() {
            walk_local(&p, &mut |f, size| {
                // 相对源目录的路径(转 '/' 供远端)
                let rel = f
                    .strip_prefix(&p)
                    .map(|r| r.to_string_lossy().replace('\\', "/"))
                    .unwrap_or_default();
                let dst = format!("{base_dest}/{base}/{rel}");
                items.push(Item {
                    src: f.to_string_lossy().to_string(),
                    dst,
                    size,
                });
            })?;
        } else if p.is_file() {
            let size = p.metadata().map(|m| m.len()).unwrap_or(0);
            items.push(Item {
                src: s.clone(),
                dst: format!("{base_dest}/{base}"),
                size,
            });
        } else {
            return Err(format!("源不存在: {s}"));
        }
    }
    Ok(items)
}

fn walk_local(dir: &Path, f: &mut dyn FnMut(&Path, u64)) -> Result<(), String> {
    let rd = fs::read_dir(dir).map_err(|e| format!("{}: {e}", dir.display()))?;
    for e in rd {
        let e = e.map_err(|e| e.to_string())?;
        let path = e.path();
        let ft = e.file_type().map_err(|e| e.to_string())?;
        if ft.is_dir() {
            walk_local(&path, f)?;
        } else if ft.is_file() {
            let sz = e.metadata().map(|m| m.len()).unwrap_or(0);
            f(&path, sz);
        }
        // 跳过符号链接等其它类型(v1)
    }
    Ok(())
}

/// 远程展开(下载用)。远端为 Linux,用 `find -printf '%s\t%p\n'` 一次列举文件 + 大小。
/// dst 为本地路径(用 PathBuf::join,Windows 上正确分隔)。
fn expand_remote(host: &str, srcs: &[String], dest_dir: &str) -> Result<Vec<Item>, String> {
    let mut items = Vec::new();
    for s in srcs {
        let src = s.trim_end_matches('/');
        let base = src.rsplit('/').next().unwrap_or(src).to_string();
        // 列举:对文件返回自身,对目录递归返回内部所有普通文件
        let cmd = format!("find {} -type f -printf '%s\\t%p\\n'", shq(src));
        let out = crate::remote::run_remote(host, &cmd)
            .map_err(|e| format!("列举远程目录失败 {src}: {e}"))?;
        let text = String::from_utf8_lossy(&out);
        for line in text.lines() {
            let line = line.trim_end_matches('\r');
            if line.is_empty() {
                continue;
            }
            let (size_str, p) = match line.split_once('\t') {
                Some(t) => t,
                None => continue,
            };
            let size: u64 = size_str.trim().parse().unwrap_or(0);
            // rel = base + (p 相对 src 的部分)
            let rel = if p == src {
                base.clone()
            } else if let Some(tail) = p.strip_prefix(src) {
                format!("{base}{tail}") // tail 形如 "/sub/f.txt"
            } else {
                // find 可能返回不以 src 开头的路径(理论上不会),兜底用 basename
                format!("{base}/{}", p.rsplit('/').next().unwrap_or(p))
            };
            // 本地目标:dest_dir + rel(rel 用 '/' 分隔,join 在 Windows 上也认)
            let dst = Path::new(dest_dir)
                .join(rel.trim_start_matches('/'))
                .to_string_lossy()
                .to_string();
            items.push(Item {
                src: p.to_string(),
                dst,
                size,
            });
        }
    }
    Ok(items)
}

// ============ 目标目录预创建 ============

/// 上传前:在远端批量 mkdir -p 所有目标文件的父目录。
fn precreate_remote_dirs(host: &str, items: &[Item]) -> Result<(), String> {
    let mut dirs: BTreeSet<String> = BTreeSet::new();
    for it in items {
        if let Some((parent, _)) = it.dst.rsplit_once('/') {
            if !parent.is_empty() {
                dirs.insert(parent.to_string());
            }
        }
    }
    if dirs.is_empty() {
        return Ok(());
    }
    let all: Vec<String> = dirs.into_iter().collect();
    for chunk in all.chunks(MKDIR_CHUNK) {
        let args = chunk.iter().map(|d| shq(d)).collect::<Vec<_>>().join(" ");
        crate::remote::run_remote(host, &format!("mkdir -p {args}"))
            .map_err(|e| format!("远端 mkdir 失败: {e}"))?;
    }
    Ok(())
}

/// 下载前:在本地创建所有目标文件的父目录。
fn precreate_local_dirs(items: &[Item]) -> Result<(), String> {
    let mut seen: BTreeSet<PathBuf> = BTreeSet::new();
    for it in items {
        if let Some(parent) = Path::new(&it.dst).parent() {
            if seen.insert(parent.to_path_buf()) {
                fs::create_dir_all(parent).map_err(|e| format!("{}: {e}", parent.display()))?;
            }
        }
    }
    Ok(())
}

// ============ 单文件 scp ============

fn scp_one(dir: Direction, host: &str, item: &Item) -> Result<(), String> {
    let mut c = Command::new(scp_exe());
    c.arg("-o").arg("BatchMode=yes");
    c.arg("-p"); // 保留修改时间/权限位
    for o in crate::remote::ssh_opts() {
        c.arg(o);
    }
    match dir {
        Direction::Upload => {
            c.arg(&item.src);
            // 远端路径作为单个 argv 传给 scp,不能 shell 引号:
            // OpenSSH 9+ 默认走 SFTP 协议,远端路径不经 shell 解析,加引号会变字面字符 → No such file。
            c.arg(format!("{host}:{}", item.dst));
        }
        Direction::Download => {
            c.arg(format!("{host}:{}", item.src));
            c.arg(&item.dst);
        }
    }
    crate::proc_ext::no_window(&mut c);
    let out = c.output().map_err(|e| format!("scp 启动失败: {e}"))?;
    if out.status.success() {
        Ok(())
    } else {
        let err = String::from_utf8_lossy(&out.stderr).trim().to_string();
        Err(if err.is_empty() {
            format!("scp 退出码 {:?}", out.status.code())
        } else {
            err
        })
    }
}

// ============ 进度事件 ============

#[allow(clippy::too_many_arguments)]
fn emit_progress(
    app: &AppHandle,
    id: u64,
    phase: &str,
    done: u64,
    total: u64,
    bytes_done: u64,
    bytes_total: u64,
    current: &str,
) {
    let _ = app.emit(
        "transfer-progress",
        json!({
            "jobId": id,
            "phase": phase,
            "done": done,
            "total": total,
            "bytesDone": bytes_done,
            "bytesTotal": bytes_total,
            "current": current,
        }),
    );
}

fn emit_from_shared(
    app: &AppHandle,
    id: u64,
    phase: &str,
    total: u64,
    bytes_total: u64,
    shared: &Arc<Mutex<Shared>>,
) {
    if let Ok(s) = shared.lock() {
        emit_progress(
            app,
            id,
            phase,
            s.done,
            total,
            s.bytes_done,
            bytes_total,
            &s.current,
        );
    }
}

fn emit_done(app: &AppHandle, id: u64, ok: bool, error: &str, total: u64) {
    let _ = app.emit(
        "transfer-done",
        json!({
            "jobId": id,
            "ok": ok,
            "error": error,
            "total": total,
        }),
    );
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn shq_escapes_single_quotes() {
        assert_eq!(shq("a b"), "'a b'");
        assert_eq!(shq("a'b"), "'a'\\''b'");
        assert_eq!(shq("/p/x.txt"), "'/p/x.txt'");
    }

    #[test]
    fn ids_are_unique_and_increasing() {
        let a = next_id();
        let b = next_id();
        assert!(b > a);
    }

    #[test]
    fn register_and_cancel_flag_roundtrip() {
        let id = next_id();
        let flag = register(id);
        assert!(!flag.load(Ordering::Relaxed));
        let _ = transfer_cancel(id);
        assert!(flag.load(Ordering::Relaxed));
        unregister(id);
        assert!(registry().lock().unwrap().get(&id).is_none());
    }

    #[test]
    fn expand_local_collects_files_with_remote_dst() {
        let dir = std::env::temp_dir().join(format!("linco_xfer_test_{}", next_id()));
        let sub = dir.join("sub");
        fs::create_dir_all(&sub).unwrap();
        fs::write(dir.join("a.txt"), b"hello").unwrap();
        fs::write(sub.join("b.txt"), b"world!!").unwrap();

        let items = expand_local(&[dir.to_string_lossy().to_string()], "/remote/dest").unwrap();
        let base = dir.file_name().unwrap().to_string_lossy().to_string();

        assert_eq!(items.len(), 2);
        // 所有远端 dst 都在 /remote/dest/<base>/ 下,且用 '/' 分隔
        for it in &items {
            assert!(it.dst.starts_with(&format!("/remote/dest/{base}/")));
            assert!(!it.dst.contains('\\'));
        }
        let total: u64 = items.iter().map(|i| i.size).sum();
        assert_eq!(total, 5 + 7);

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn expand_local_single_file_targets_dest_basename() {
        let dir = std::env::temp_dir().join(format!("linco_xfer_one_{}", next_id()));
        fs::create_dir_all(&dir).unwrap();
        let f = dir.join("only.bin");
        fs::write(&f, b"1234").unwrap();

        let items = expand_local(&[f.to_string_lossy().to_string()], "/r/d/").unwrap();
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].dst, "/r/d/only.bin");
        assert_eq!(items[0].size, 4);

        let _ = fs::remove_dir_all(&dir);
    }
}
