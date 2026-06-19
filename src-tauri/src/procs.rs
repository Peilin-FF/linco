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

/// agent 起的、输出已落盘成文件的后台任务(可实时 tail)。每个 → 终端区一个 tab。
#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct AgentTask {
    pub pid: i64,
    pub args: String,
    pub file: String, // stdout/stderr 落盘的文件路径(实时 tail 它)
    pub etime: String,
}

/// 列出 agent 起的、**输出落盘成文件**的后台任务(过滤掉 npm/lark 等管道噪声)。
/// 这正是训练/长任务:stdout 重定向到文件,可 tail;前台命令是直连 agent 的管道,
/// 没有文件可读 → 不列出。host 空=本地。
#[tauri::command]
pub async fn agent_tasks(
    host: Option<String>,
    cwd: Option<String>,
    command_base: Option<String>,
) -> Result<Vec<AgentTask>, String> {
    crate::blocking::run(move || {
        let base = command_base.unwrap_or_default();
        let cwd = cwd.unwrap_or_default();

        if let Some(h) = host.filter(|s| !s.is_empty()) {
            // 远程:agent op 已在远端做「树走 + 落盘过滤」
            if let Ok(v) = crate::agent_rpc::call(
                &h,
                "agent_tasks",
                serde_json::json!({ "command_base": base, "cwd": cwd }),
            ) {
                if let Some(arr) = v.get("tasks").and_then(|x| x.as_array()) {
                    return Ok(arr.iter().filter_map(task_from_json).collect());
                }
            }
            // 回退:列进程后逐个解析 fd(多往返,少用)
            let raw = crate::remote::run_remote(&h, PS_CMD)
                .map(|b| String::from_utf8_lossy(&b).to_string())?;
            let procs = parse_and_filter(&raw, &base, None);
            let mut tasks = Vec::new();
            for p in procs {
                let cmd = format!(
                    "readlink /proc/{pid}/fd/1 2>/dev/null || lsof -p {pid} -a -d 1 -F n 2>/dev/null | sed -n 's/^n//p' | head -1",
                    pid = p.pid
                );
                if let Ok(b) = crate::remote::run_remote(&h, &cmd) {
                    let f = String::from_utf8_lossy(&b).trim().to_string();
                    if f.starts_with('/') && !f.starts_with("/dev/") {
                        tasks.push(AgentTask { pid: p.pid, args: p.args, file: f, etime: p.etime });
                    }
                }
            }
            return Ok(tasks);
        }

        // 本地:并集策略(与远端 op_agent_tasks 对称)——
        // (a) agent 子树下的进程 + (b) cwd 命中项目目录的进程,去重,只留输出落盘的。
        let out = Command::new("ps")
            .args(["-eo", "pid=,ppid=,etime=,pcpu=,pmem=,stat=,args="])
            .output()
            .map_err(|e| format!("无法执行 ps: {e}"))?;
        let raw = String::from_utf8_lossy(&out.stdout).to_string();

        let mut cand: HashMap<i64, ProcInfo> = HashMap::new();
        // (a) 子树
        for p in parse_and_filter(&raw, &base, None) {
            cand.insert(p.pid, p);
        }
        // (b) cwd 命中项目目录(后台任务被 init 收养后脱离子树,靠 cwd 锚点保住)。
        // 用一次性批量 all_cwds() 避免对每个进程单独 lsof(macOS 几百进程要数十秒)。
        if !cwd.is_empty() {
            let base_name = base.rsplit('/').next().unwrap_or(&base);
            let cwds = all_cwds();
            for p in parse_all(&raw) {
                if cand.contains_key(&p.pid) {
                    continue;
                }
                if !base_name.is_empty() && p.args.contains(base_name) {
                    continue; // 跳过 agent 本体
                }
                if cwd_matches(cwds.get(&p.pid).map(|s| s.as_str()), &cwd) {
                    cand.insert(p.pid, p);
                }
            }
        }

        // 去噪 + 穿透外壳(与 python op_agent_tasks 对称):
        // sh -c "python train.py" → 显示里层 python;剔除纯 shell/短命工具;跳过 <5s。
        let all = parse_all(&raw);
        let by_pid: HashMap<i64, ProcInfo> = all.iter().map(|p| (p.pid, p.clone())).collect();
        let mut children: HashMap<i64, Vec<i64>> = HashMap::new();
        for p in &all {
            children.entry(p.ppid).or_default().push(p.pid);
        }
        let mut resolved: HashMap<i64, ProcInfo> = HashMap::new();
        for p in cand.into_values() {
            let mut target = p;
            for _ in 0..4 {
                if !is_noise(&target) {
                    break;
                }
                let real: Vec<&ProcInfo> = children
                    .get(&target.pid)
                    .map(|ks| ks.iter().filter_map(|c| by_pid.get(c)).filter(|k| !is_noise(k)).collect())
                    .unwrap_or_default();
                if real.len() == 1 {
                    target = real[0].clone();
                } else {
                    break;
                }
            }
            resolved.insert(target.pid, target);
        }

        let mut tasks = Vec::new();
        for p in resolved.into_values() {
            if is_noise(&p) || etime_secs(&p.etime) < 5 {
                continue;
            }
            if let Some(f) = local_proc_output(p.pid).fd1 {
                tasks.push(AgentTask { pid: p.pid, args: p.args, file: f, etime: p.etime });
            }
        }
        tasks.sort_by_key(|t| t.pid);
        Ok(tasks)
    })
    .await
}

fn task_from_json(v: &serde_json::Value) -> Option<AgentTask> {
    Some(AgentTask {
        pid: v.get("pid")?.as_i64()?,
        args: v.get("args").and_then(|x| x.as_str()).unwrap_or("").to_string(),
        file: v.get("file")?.as_str()?.to_string(),
        etime: v.get("etime").and_then(|x| x.as_str()).unwrap_or("").to_string(),
    })
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

/// 一次性拿到所有进程的 cwd(pid→cwd)。性能关键:对每个进程单独 lsof 在 macOS 上
/// 几百进程要数十秒,会把前端轮询挂死。Linux 批量 readlink /proc/*/cwd;macOS 一条
/// `lsof -d cwd -F pn` 拿全部(~0.4s)。
fn all_cwds() -> HashMap<i64, String> {
    let mut out = HashMap::new();
    #[cfg(target_os = "linux")]
    {
        if let Ok(rd) = std::fs::read_dir("/proc") {
            for e in rd.flatten() {
                let name = e.file_name().to_string_lossy().to_string();
                if let Ok(pid) = name.parse::<i64>() {
                    if let Ok(p) = std::fs::read_link(format!("/proc/{pid}/cwd")) {
                        out.insert(pid, p.to_string_lossy().to_string());
                    }
                }
            }
        }
        if !out.is_empty() {
            return out;
        }
    }
    if let Ok(o) = Command::new("lsof").args(["-d", "cwd", "-F", "pn"]).output() {
        let mut cur: Option<i64> = None;
        for line in String::from_utf8_lossy(&o.stdout).lines() {
            if let Some(rest) = line.strip_prefix('p') {
                cur = rest.parse::<i64>().ok();
            } else if let Some(rest) = line.strip_prefix('n') {
                if let Some(pid) = cur {
                    out.insert(pid, rest.to_string());
                }
            }
        }
    }
    out
}

/// 进程 cwd 是否落在项目目录下(含子目录)。canonicalize 归一化(解 symlink,如
/// macOS /tmp→/private/tmp)+ 前缀匹配,容忍尾斜杠与软链差异。
fn cwd_matches(proc_cwd: Option<&str>, project_cwd: &str) -> bool {
    let pc = match proc_cwd {
        Some(s) if !s.is_empty() => s,
        _ => return false,
    };
    if project_cwd.is_empty() {
        return false;
    }
    let norm = |s: &str| {
        std::fs::canonicalize(s)
            .map(|p| p.to_string_lossy().to_string())
            .unwrap_or_else(|_| s.trim_end_matches('/').to_string())
    };
    let a = norm(pc);
    let b = norm(project_cwd);
    a == b || a.starts_with(&format!("{}/", b.trim_end_matches('/')))
}

// 一闪而过的短命工具 / 纯 shell 外壳:不是用户想看的训练任务,剔除。
const NOISE_CMDS: &[&str] = &[
    "sh", "bash", "zsh", "dash", "fish", "ksh", "head", "tail", "cat", "grep", "egrep",
    "fgrep", "ugrep", "rg", "ag", "ls", "sed", "awk", "find", "fd", "wc", "sort", "uniq",
    "cut", "tr", "which", "env", "echo", "printf", "true", "false", "test", "expr", "date",
    "basename", "dirname", "readlink", "stat", "cmp", "diff", "git", "ssh", "scp", "rsync",
    "tee", "xargs", "cp", "mv", "rm", "mkdir", "sleep",
];

/// 从命令行取真正执行的程序名(跳过 env/nohup 前缀与 VAR=val,取首个非选项 token 的 basename)。
fn exe_name(args: &str) -> String {
    let toks: Vec<&str> = args.split_whitespace().collect();
    let mut i = 0;
    while i < toks.len()
        && (toks[i].contains('=')
            || matches!(toks[i], "env" | "nohup" | "setsid" | "stdbuf"))
    {
        i += 1;
    }
    let t = toks.get(i).or_else(|| toks.first()).copied().unwrap_or("");
    t.rsplit('/').next().unwrap_or(t).to_string()
}

/// 进程是否为噪声:纯 shell 外壳 / 短命工具 / claude snapshot shell。
fn is_noise(p: &ProcInfo) -> bool {
    if p.args.contains("shell-snapshot")
        || p.args.contains("snapshot-zsh")
        || p.args.contains("snapshot-bash")
    {
        return true;
    }
    NOISE_CMDS.contains(&exe_name(&p.args).as_str())
}

/// 解析 ps ELAPSED:[[DD-]HH:]MM:SS → 秒。解析失败返回大值(不误删长任务)。
fn etime_secs(etime: &str) -> i64 {
    let s = etime.trim();
    if s.is_empty() {
        return 1_000_000_000;
    }
    let (days, rest) = match s.split_once('-') {
        Some((d, r)) => (d.parse::<i64>().unwrap_or(0), r),
        None => (0, s),
    };
    let parts: Vec<i64> = rest.split(':').map(|x| x.parse().unwrap_or(-1)).collect();
    if parts.iter().any(|&n| n < 0) {
        return 1_000_000_000;
    }
    let (h, m, sec) = match parts.as_slice() {
        [h, m, s] => (*h, *m, *s),
        [m, s] => (0, *m, *s),
        [s] => (0, 0, *s),
        _ => return 1_000_000_000,
    };
    days * 86400 + h * 3600 + m * 60 + sec
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
fn parse_all(raw: &str) -> Vec<ProcInfo> {
    let mut procs: Vec<ProcInfo> = Vec::new();
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
        procs.push(ProcInfo { pid, ppid, etime, pcpu, pmem, stat, args });
    }
    procs
}

fn parse_and_filter(raw: &str, base: &str, _cwd: Option<&str>) -> Vec<ProcInfo> {
    let procs = parse_all(raw);
    let mut children: HashMap<i64, Vec<i64>> = HashMap::new();
    for p in &procs {
        children.entry(p.ppid).or_default().push(p.pid);
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
