// 后台进程监控:把 code agent(claude/codex)在后台起的 shell/子进程从盲盒里暴露出来。
//
// 用户痛点:agent 经常在后台起 shell、subagent,这些进程程序员看不到,不知道 agent
// 在后台干了什么。本模块列出「agent 进程子树」下的所有后代进程(命令/PID/时长/CPU/内存/状态)。
//
// PID 发现:不靠 PID 交接(远程拿不到 agent 的远端 pid)。统一用「命令名 + cwd 匹配定位
// agent 根进程,再沿 ppid 向下 BFS 收后代」:
// - 远程:走常驻 agent 的 `ps` op(在远端跑 ps + /proc cwd 收窄 + BFS),失败回退 shell。
// - 本地:直接跑 `ps`,Rust 端解析 + BFS(macOS 无 /proc,仅按命令名匹配)。
//
// ps 字段 `pid,ppid,etime,pcpu,pmem,stat,args` 在 macOS BSD 与 Linux GNU 输出列一致。

use std::collections::HashMap;
use std::process::Command;

use base64::engine::general_purpose::STANDARD as B64;
use base64::Engine;
use serde::Serialize;

#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct ProcInfo {
    pub pid: i64,
    pub ppid: i64,
    pub etime: String,
    pub pcpu: String,
    pub pmem: String,
    pub stat: String,
    pub args: String,
}

/// 列出 agent 进程子树下的后代进程。host 空=本地。
#[tauri::command]
pub async fn agent_processes(
    host: Option<String>,
    cwd: Option<String>,
    command_base: Option<String>,
) -> Result<Vec<ProcInfo>, String> {
    crate::blocking::run(move || {
        let base = command_base.unwrap_or_default();
        let cwd = cwd.unwrap_or_default();

        if let Some(h) = host.filter(|s| !s.is_empty()) {
            // 远程:优先常驻 agent 的 ps op(已在远端做 cwd 收窄 + BFS)
            if let Ok(v) = crate::agent_rpc::call(
                &h,
                "ps",
                serde_json::json!({ "command_base": base, "cwd": cwd }),
            ) {
                if let Some(arr) = v.get("procs").and_then(|x| x.as_array()) {
                    return Ok(arr.iter().filter_map(proc_from_json).collect());
                }
            }
            // 回退:远端跑 ps,Rust 端解析 + BFS(无 /proc cwd 收窄,仅命令名)
            let raw = crate::remote::run_remote(&h, PS_CMD)
                .map(|b| String::from_utf8_lossy(&b).to_string())?;
            return Ok(parse_and_filter(&raw, &base, None));
        }

        // 本地:直接跑 ps
        let out = Command::new("ps")
            .args(["-eo", "pid=,ppid=,etime=,pcpu=,pmem=,stat=,args="])
            .output()
            .map_err(|e| format!("无法执行 ps: {e}"))?;
        let raw = String::from_utf8_lossy(&out.stdout).to_string();
        Ok(parse_and_filter(&raw, &base, None))
    })
    .await
}

/// 远端 shell 回退用的 ps 命令(字段与 agent op_ps 一致)。
const PS_CMD: &str = "ps -eo pid=,ppid=,etime=,pcpu=,pmem=,stat=,args=";

/// 进程 stdout/stderr(fd 1/2)指向的输出文件。code agent 起的后台进程输出会被
/// 重定向到文件,拿到这个路径就能实时 tail 它的 log(训练进度/报错等)。
/// 返回 (fd1_path, fd2_path),拿不到为 None。
#[derive(serde::Serialize)]
pub struct ProcOutput {
    pub fd1: Option<String>,
    pub fd2: Option<String>,
}

#[tauri::command]
pub async fn proc_output_file(host: Option<String>, pid: i64) -> Result<ProcOutput, String> {
    crate::blocking::run(move || {
        if let Some(h) = host.filter(|s| !s.is_empty()) {
            // 远程:优先 agent op,失败回退 shell(readlink /proc 或 lsof)
            if let Ok(v) = crate::agent_rpc::call(&h, "proc_output", serde_json::json!({ "pid": pid }))
            {
                return Ok(ProcOutput {
                    fd1: v.get("fd1").and_then(|x| x.as_str()).map(String::from),
                    fd2: v.get("fd2").and_then(|x| x.as_str()).map(String::from),
                });
            }
            let cmd = format!(
                "readlink /proc/{pid}/fd/1 2>/dev/null || lsof -p {pid} -a -d 1 -F n 2>/dev/null | sed -n 's/^n//p' | head -1"
            );
            let fd1 = crate::remote::run_remote(&h, &cmd)
                .map(|b| String::from_utf8_lossy(&b).trim().to_string())
                .ok()
                .filter(|s| s.starts_with('/') && !s.starts_with("/dev/"));
            return Ok(ProcOutput { fd1, fd2: None });
        }
        // 本地:Linux 读 /proc,macOS 用 lsof
        Ok(local_proc_output(pid))
    })
    .await
}

/// 从 offset 字节增量读输出文件,返回新增内容 + 当前总大小(供前端实时滚动)。
#[derive(serde::Serialize)]
pub struct TailChunk {
    pub data: String, // 新增的文本内容
    pub size: i64,    // 文件当前总字节数(下次作 offset)
    pub start: i64,   // 本次实际起始字节(初次取尾部时 > 0)
}

#[tauri::command]
pub async fn tail_file(
    host: Option<String>,
    path: String,
    offset: i64,
) -> Result<TailChunk, String> {
    const MAX: i64 = 256 * 1024;
    crate::blocking::run(move || {
        if let Some(h) = host.filter(|s| !s.is_empty()) {
            // 远程:优先 agent op(返回 b64),失败回退 shell(wc -c + tail -c)
            if let Ok(v) = crate::agent_rpc::call(
                &h,
                "tail_file",
                serde_json::json!({ "path": path, "offset": offset, "max": MAX }),
            ) {
                let b64 = v.get("b64").and_then(|x| x.as_str()).unwrap_or("");
                let bytes = B64.decode(b64).unwrap_or_default();
                return Ok(TailChunk {
                    data: String::from_utf8_lossy(&bytes).to_string(),
                    size: v.get("size").and_then(|x| x.as_i64()).unwrap_or(0),
                    start: v.get("start").and_then(|x| x.as_i64()).unwrap_or(offset),
                });
            }
            let szout = crate::remote::run_remote(&h, &format!("wc -c < {}", crate::remote::shq(&path)))
                .map(|b| String::from_utf8_lossy(&b).trim().to_string())?;
            let size: i64 = szout.parse().unwrap_or(0);
            let mut start = if offset > size { 0 } else { offset };
            if start == 0 && size > MAX {
                start = size - MAX;
            }
            let cmd = format!("tail -c +{} {} | head -c {}", start + 1, crate::remote::shq(&path), MAX);
            let data = crate::remote::run_remote(&h, &cmd)
                .map(|b| String::from_utf8_lossy(&b).to_string())?;
            return Ok(TailChunk { data, size, start });
        }
        // 本地
        local_tail(&path, offset, MAX)
    })
    .await
}

/// 本地解析进程 fd 1/2 的输出文件(Linux /proc;macOS lsof)。
fn local_proc_output(pid: i64) -> ProcOutput {
    let resolve = |fd: i64| -> Option<String> {
        // Linux:readlink /proc/PID/fd/N
        #[cfg(target_os = "linux")]
        if let Ok(p) = std::fs::read_link(format!("/proc/{pid}/fd/{fd}")) {
            let s = p.to_string_lossy().to_string();
            if s.starts_with('/') && !s.starts_with("/dev/") {
                return Some(s);
            }
            return None;
        }
        // 其它(macOS):lsof
        let out = Command::new("lsof")
            .args(["-p", &pid.to_string(), "-a", "-d", &fd.to_string(), "-F", "n"])
            .output()
            .ok()?;
        for line in String::from_utf8_lossy(&out.stdout).lines() {
            if let Some(rest) = line.strip_prefix("n/") {
                let path = format!("/{rest}");
                if !path.starts_with("/dev/") {
                    return Some(path);
                }
            }
        }
        None
    };
    ProcOutput { fd1: resolve(1), fd2: resolve(2) }
}

/// 本地从 offset 增量读文件。
fn local_tail(path: &str, offset: i64, max: i64) -> Result<TailChunk, String> {
    use std::io::{Read, Seek, SeekFrom};
    let size = std::fs::metadata(path).map_err(|e| format!("无法读取输出文件: {e}"))?.len() as i64;
    let mut start = if offset > size { 0 } else { offset };
    if start == 0 && size > max {
        start = size - max;
    }
    let mut f = std::fs::File::open(path).map_err(|e| e.to_string())?;
    f.seek(SeekFrom::Start(start as u64)).map_err(|e| e.to_string())?;
    let mut buf = vec![0u8; max as usize];
    let n = f.read(&mut buf).map_err(|e| e.to_string())?;
    Ok(TailChunk {
        data: String::from_utf8_lossy(&buf[..n]).to_string(),
        size,
        start,
    })
}

fn proc_from_json(v: &serde_json::Value) -> Option<ProcInfo> {
    Some(ProcInfo {
        pid: v.get("pid")?.as_i64()?,
        ppid: v.get("ppid")?.as_i64()?,
        etime: v.get("etime").and_then(|x| x.as_str()).unwrap_or("").to_string(),
        pcpu: v.get("pcpu").and_then(|x| x.as_str()).unwrap_or("").to_string(),
        pmem: v.get("pmem").and_then(|x| x.as_str()).unwrap_or("").to_string(),
        stat: v.get("stat").and_then(|x| x.as_str()).unwrap_or("").to_string(),
        args: v.get("args").and_then(|x| x.as_str()).unwrap_or("").to_string(),
    })
}

/// 解析 ps 输出,定位命令名为 base 的根进程,沿 ppid 向下 BFS 收后代(不含根)。
/// cwd 为本地/shell 回退路径,不做 cwd 收窄(远程 cwd 收窄在 agent op_ps 内完成)。
fn parse_and_filter(raw: &str, base: &str, _cwd: Option<&str>) -> Vec<ProcInfo> {
    let mut procs: Vec<ProcInfo> = Vec::new();
    let mut children: HashMap<i64, Vec<i64>> = HashMap::new();
    for line in raw.lines() {
        // 前 6 列定宽空白分隔,args 收尾(含空格)
        let mut it = line.split_whitespace();
        let pid = match it.next().and_then(|s| s.parse::<i64>().ok()) {
            Some(n) => n,
            None => continue,
        };
        let ppid = match it.next().and_then(|s| s.parse::<i64>().ok()) {
            Some(n) => n,
            None => continue,
        };
        let etime = it.next().unwrap_or("").to_string();
        let pcpu = it.next().unwrap_or("").to_string();
        let pmem = it.next().unwrap_or("").to_string();
        let stat = it.next().unwrap_or("").to_string();
        let args = it.collect::<Vec<_>>().join(" ");
        children.entry(ppid).or_default().push(pid);
        procs.push(ProcInfo { pid, ppid, etime, pcpu, pmem, stat, args });
    }
    let by_pid: HashMap<i64, &ProcInfo> = procs.iter().map(|p| (p.pid, p)).collect();

    // 命令名取 basename 容忍全路径;空 base 直接返回空(没 agent 命令名无从定位)
    let base = base.rsplit('/').next().unwrap_or(base);
    if base.is_empty() {
        return Vec::new();
    }
    let roots: Vec<i64> = procs
        .iter()
        .filter(|p| p.args.contains(base))
        .map(|p| p.pid)
        .collect();

    // BFS 收后代(排除根本身)
    let mut seen: std::collections::HashSet<i64> = roots.iter().copied().collect();
    let mut stack = roots;
    let mut result: Vec<ProcInfo> = Vec::new();
    while let Some(pid) = stack.pop() {
        if let Some(kids) = children.get(&pid) {
            for &ch in kids {
                if seen.insert(ch) {
                    if let Some(p) = by_pid.get(&ch) {
                        result.push((*p).clone());
                    }
                    stack.push(ch);
                }
            }
        }
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    // 构造一棵进程树:
    //   100 claude (根)
    //     200 sh -c "python train.py"  (后代)
    //       300 python train.py        (后代)
    //   400 unrelated bash             (不相关,不应出现)
    const SAMPLE: &str = "\
100 1 01:00 0.5 1.0 Ss /usr/bin/claude
200 100 00:30 1.0 2.0 S sh -c python train.py
300 200 00:29 99.0 5.0 R python train.py
400 1 10:00 0.0 0.1 Ss bash";

    #[test]
    fn collects_descendants_excluding_root() {
        let got = parse_and_filter(SAMPLE, "claude", None);
        let pids: Vec<i64> = got.iter().map(|p| p.pid).collect();
        // 只含后代 200、300;不含根 100,不含不相关 400
        assert!(pids.contains(&200));
        assert!(pids.contains(&300));
        assert!(!pids.contains(&100));
        assert!(!pids.contains(&400));
        assert_eq!(got.len(), 2);
    }

    #[test]
    fn args_preserved_with_spaces() {
        let got = parse_and_filter(SAMPLE, "claude", None);
        let py = got.iter().find(|p| p.pid == 300).expect("has 300");
        assert_eq!(py.args, "python train.py");
        assert_eq!(py.pcpu, "99.0");
    }

    #[test]
    fn empty_base_returns_empty() {
        assert!(parse_and_filter(SAMPLE, "", None).is_empty());
    }

    #[test]
    fn no_agent_returns_empty() {
        // base 不匹配任何进程 → 无根 → 空
        assert!(parse_and_filter(SAMPLE, "nonexistent", None).is_empty());
    }

    #[test]
    fn basename_tolerates_full_path() {
        // command_base 传全路径,取 basename 匹配
        let got = parse_and_filter(SAMPLE, "/opt/foo/claude", None);
        assert_eq!(got.len(), 2);
    }
}
