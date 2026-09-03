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
// Command 仅在非 Windows 用到(ps/lsof);Windows 走 sysinfo,不起子进程。
#[cfg(not(windows))]
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
                    let tasks: Vec<AgentTask> = arr.iter().filter_map(task_from_json).collect();
                    return Ok(dedup_tasks(tasks, &HashMap::new()));
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
        // Windows:无 ps/lsof,改用 sysinfo 快照(零子进程,不闪黑窗)。能列出后台
        // 任务(命令/PID),但拿不到 stdout 重定向文件 → file 留空(前端会优雅留白)。
        #[cfg(windows)]
        {
            let (procs, cwds) = snapshot_all();
            let mut cand: HashMap<i64, ProcInfo> = HashMap::new();
            // (a) agent 子树
            for p in filter_descendants(&procs, &base) {
                cand.insert(p.pid, p);
            }
            // (b) cwd 命中项目目录(脱离子树的后台任务靠 cwd 锚点保住)
            if !cwd.is_empty() {
                let base_name = base.rsplit('/').next().unwrap_or(&base);
                for p in &procs {
                    if cand.contains_key(&p.pid) {
                        continue;
                    }
                    if !base_name.is_empty() && p.args.contains(base_name) {
                        continue; // 跳过 agent 本体
                    }
                    if cwd_matches(cwds.get(&p.pid).map(|s| s.as_str()), &cwd) {
                        cand.insert(p.pid, p.clone());
                    }
                }
            }
            // 去噪 + 穿透外壳(与非 Windows 对称)
            let by_pid: HashMap<i64, ProcInfo> =
                procs.iter().map(|p| (p.pid, p.clone())).collect();
            let mut children: HashMap<i64, Vec<i64>> = HashMap::new();
            for p in &procs {
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
                        .map(|ks| {
                            ks.iter()
                                .filter_map(|c| by_pid.get(c))
                                .filter(|k| !is_noise(k))
                                .collect()
                        })
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
                // 输出文件:先从进程 PEB 的 StandardOutput/StandardError 句柄解析真实重定向
                // 文件(Git Bash / cmd 的 `> x.log` 传的就是文件句柄);拿不到(PowerShell 的
                // `>` 走管道、跨权限进程)再从本进程及祖先 shell 的命令行里找 `> xxx.log`。
                let file = windows_output_file(
                    p.pid,
                    &by_pid,
                    cwds.get(&p.pid).map(|s| s.as_str()),
                    &cwd,
                )
                .unwrap_or_default();
                // 与 macOS/Linux 同一契约:只列输出落盘的任务。stdout 是管道/控制台的前台
                // 命令没有文件可 tail,列出来也只是一个空白 tab(此前 Windows 上全是这种)。
                if file.is_empty() {
                    continue;
                }
                tasks.push(AgentTask { pid: p.pid, args: p.args, file, etime: p.etime });
            }
            return Ok(dedup_tasks(tasks, &by_pid));
        }
        #[cfg(not(windows))]
        {
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

        // (c) 输出文件落在项目目录下(launchctl/nohup 起的任务 cwd=/、ppid=1,两条
        // 锚点都失效,但日志写进了项目目录 → 用输出文件路径兜底锚定)。
        if !cwd.is_empty() {
            let base_name = base.rsplit('/').next().unwrap_or(&base);
            let fdfiles = all_fd_files();
            for p in parse_all(&raw) {
                if cand.contains_key(&p.pid) {
                    continue;
                }
                if !base_name.is_empty() && p.args.contains(base_name) {
                    continue;
                }
                if let Some(f) = fdfiles.get(&p.pid) {
                    if cwd_matches(Some(f.as_str()), &cwd) {
                        cand.insert(p.pid, p);
                    }
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
        Ok(dedup_tasks(tasks, &by_pid))
        }
    })
    .await
}

fn task_from_json(v: &serde_json::Value) -> Option<AgentTask> {
    Some(AgentTask {
        pid: v.get("pid")?.as_i64()?,
        args: v
            .get("args")
            .and_then(|x| x.as_str())
            .unwrap_or("")
            .to_string(),
        file: v.get("file")?.as_str()?.to_string(),
        etime: v
            .get("etime")
            .and_then(|x| x.as_str())
            .unwrap_or("")
            .to_string(),
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

        // 本地:直接跑 ps。Windows 无 ps,直接返回空(避免每次轮询闪黑窗)。
        #[cfg(windows)]
        {
            return Ok(Vec::new());
        }
        #[cfg(not(windows))]
        {
            let out = Command::new("ps")
                .args(["-eo", "pid=,ppid=,etime=,pcpu=,pmem=,stat=,args="])
                .output()
                .map_err(|e| format!("无法执行 ps: {e}"))?;
            let raw = String::from_utf8_lossy(&out.stdout).to_string();
            Ok(parse_and_filter(&raw, &base, None))
        }
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
        // 本地:Linux 读 /proc,macOS 用 lsof;Windows 拿不到(返回空)。
        #[cfg(windows)]
        {
            let (fd1, fd2) = crate::win_stdout::std_files(pid);
            return Ok(ProcOutput { fd1, fd2 });
        }
        #[cfg(not(windows))]
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
            let szout =
                crate::remote::run_remote(&h, &format!("wc -c < {}", crate::remote::shq(&path)))
                    .map(|b| String::from_utf8_lossy(&b).trim().to_string())?;
            let size: i64 = szout.parse().unwrap_or(0);
            let mut start = if offset > size { 0 } else { offset };
            if start == 0 && size > MAX {
                start = size - MAX;
            }
            let cmd = format!(
                "tail -c +{} {} | head -c {}",
                start + 1,
                crate::remote::shq(&path),
                MAX
            );
            let data = crate::remote::run_remote(&h, &cmd)
                .map(|b| String::from_utf8_lossy(&b).to_string())?;
            return Ok(TailChunk { data, size, start });
        }
        // 本地
        local_tail(&path, offset, MAX)
    })
    .await
}

/// 本地解析进程 fd 1/2 的输出文件(Linux /proc;macOS lsof)。Windows 无此机制。
#[cfg(not(windows))]
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
            .args([
                "-p",
                &pid.to_string(),
                "-a",
                "-d",
                &fd.to_string(),
                "-F",
                "n",
            ])
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
    ProcOutput {
        fd1: resolve(1),
        fd2: resolve(2),
    }
}

/// 一次性拿到所有进程的 cwd(pid→cwd)。性能关键:对每个进程单独 lsof 在 macOS 上
/// 几百进程要数十秒,会把前端轮询挂死。Linux 批量 readlink /proc/*/cwd;macOS 一条
/// `lsof -d cwd -F pn` 拿全部(~0.4s)。Windows 走 sysinfo 的 snapshot_cwds,不用此函数。
#[cfg(not(windows))]
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
    if let Ok(o) = Command::new("lsof")
        .args(["-d", "cwd", "-F", "pn"])
        .output()
    {
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

/// 一次性拿到所有进程 stdout/stderr(fd 1/2)指向的普通文件:{pid: path}。
/// 用途:launchctl/nohup 起的任务 cwd=/、不在 agent 子树,唯一线索是日志写进了项目
/// 目录,用输出文件路径兜底锚定。性能同 all_cwds(批量,避免逐进程 lsof)。Windows 不用。
#[cfg(not(windows))]
fn all_fd_files() -> HashMap<i64, String> {
    let mut out = HashMap::new();
    #[cfg(target_os = "linux")]
    {
        if let Ok(rd) = std::fs::read_dir("/proc") {
            for e in rd.flatten() {
                let name = e.file_name().to_string_lossy().to_string();
                if let Ok(pid) = name.parse::<i64>() {
                    for fd in [1, 2] {
                        if out.contains_key(&pid) {
                            break;
                        }
                        if let Ok(p) = std::fs::read_link(format!("/proc/{pid}/fd/{fd}")) {
                            let s = p.to_string_lossy().to_string();
                            if s.starts_with('/') && !s.starts_with("/dev/") {
                                out.insert(pid, s);
                            }
                        }
                    }
                }
            }
        }
        if !out.is_empty() {
            return out;
        }
    }
    if let Ok(o) = Command::new("lsof")
        .args(["-d", "1,2", "-F", "ptn"])
        .output()
    {
        let mut cur: Option<i64> = None;
        let mut is_reg = false;
        for line in String::from_utf8_lossy(&o.stdout).lines() {
            match line.split_at(1) {
                ("p", rest) => {
                    cur = rest.parse::<i64>().ok();
                    is_reg = false;
                }
                ("t", rest) => is_reg = rest == "REG",
                ("n", rest) => {
                    if let Some(pid) = cur {
                        if is_reg
                            && !out.contains_key(&pid)
                            && rest.starts_with('/')
                            && !rest.starts_with("/dev/")
                        {
                            out.insert(pid, rest.to_string());
                        }
                    }
                }
                _ => {}
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
        // 展开 ~(canonicalize 不展开),再归一化解 symlink;失败则退化为去尾斜杠。
        let home_str = || {
            crate::config::home_dir()
                .map(|p| p.to_string_lossy().to_string())
                .ok()
        };
        let expanded = if s == "~" {
            home_str().unwrap_or_else(|| s.to_string())
        } else if let Some(rest) = s.strip_prefix("~/") {
            match home_str() {
                Some(h) => format!("{}/{}", h.trim_end_matches('/'), rest),
                None => s.to_string(),
            }
        } else {
            s.to_string()
        };
        let s = std::fs::canonicalize(&expanded)
            .map(|p| p.to_string_lossy().to_string())
            .unwrap_or(expanded);
        normalize_path_str(&s)
    };
    let a = norm(pc);
    let b = norm(project_cwd);
    a == b || a.starts_with(&format!("{}/", b.trim_end_matches('/')))
}

/// 路径归一化供前缀比较:`\` → `/`、剥 `\\?\` verbatim 前缀、去尾斜杠;Windows 大小写不敏感。
/// 修复点:此前 Windows 上 canonicalize 得到 `\\?\C:\..\linco`,再用 `/` 拼前缀永远匹配不上
/// 子目录 → 在项目子目录里起的后台任务全部漏掉。
fn normalize_path_str(s: &str) -> String {
    let mut s = s.replace('\\', "/");
    if let Some(r) = s.strip_prefix("//?/UNC/") {
        s = format!("//{r}");
    } else if let Some(r) = s.strip_prefix("//?/") {
        s = r.to_string();
    }
    let s = s.trim_end_matches('/').to_string();
    if cfg!(windows) {
        s.to_ascii_lowercase()
    } else {
        s
    }
}

/// 从一条 shell 命令行里找出 stdout 重定向目标(`> x.log` / `>> x.log` / `1> x.log` / `&> x.log`),
/// 优先 stdout,没有再取 `2> x.log`;跳过 `&1`/`&2`/`/dev/null`/`nul`。
/// 用途:Windows 上拿不到句柄时,从 `bash -c "python -u main.py > main.log 2>&1 &"` 这类
/// 祖先 shell 的命令行里推断日志文件。
fn redirect_target_from_cmdline(cmd: &str) -> Option<String> {
    use regex::Regex;
    use std::sync::OnceLock;
    static RE: OnceLock<Regex> = OnceLock::new();
    let re = RE.get_or_init(|| {
        Regex::new(r#"(?:^|[\s;&|(])(&>|1?>>?|2>>?)\s*(?:"([^"]*)"|'([^']*)'|([^\s;&|)]+))"#)
            .expect("redirect regex")
    });
    let mut stderr_only: Option<String> = None;
    for cap in re.captures_iter(cmd) {
        let op = cap.get(1).map(|m| m.as_str()).unwrap_or("");
        let target = cap
            .get(2)
            .or_else(|| cap.get(3))
            .or_else(|| cap.get(4))
            .map(|m| m.as_str().trim().to_string())
            .unwrap_or_default();
        if target.is_empty() || target.starts_with('&') {
            continue;
        }
        let tl = target.to_ascii_lowercase();
        if tl == "/dev/null" || tl == "nul" {
            continue;
        }
        if op.starts_with('2') {
            if stderr_only.is_none() {
                stderr_only = Some(target);
            }
            continue;
        }
        return Some(target);
    }
    stderr_only
}

/// 把重定向目标解析成存在的绝对路径:绝对路径直接验存在;相对路径依次按进程 cwd、项目 cwd 拼接。
#[cfg_attr(not(windows), allow(dead_code))]
fn resolve_log_path(target: &str, proc_cwd: Option<&str>, project_cwd: &str) -> Option<String> {
    use std::path::{Path, PathBuf};
    let p = Path::new(target);
    let cands: Vec<PathBuf> = if p.is_absolute() {
        vec![p.to_path_buf()]
    } else {
        [proc_cwd, Some(project_cwd)]
            .into_iter()
            .flatten()
            .filter(|d| !d.is_empty())
            .map(|d| Path::new(d).join(target))
            .collect()
    };
    cands
        .into_iter()
        .find(|c| c.is_file())
        .map(|c| c.to_string_lossy().to_string())
}

/// Windows:后台任务的输出文件。① PEB 标准句柄(精确);② 本进程与最多 4 层祖先命令行里的
/// `> xxx.log`(启发式,PowerShell 重定向走管道时唯一线索)。
#[cfg(windows)]
fn windows_output_file(
    pid: i64,
    by_pid: &HashMap<i64, ProcInfo>,
    proc_cwd: Option<&str>,
    project_cwd: &str,
) -> Option<String> {
    let (out, err) = crate::win_stdout::std_files(pid);
    if let Some(f) = out.or(err) {
        return Some(f);
    }
    let own = by_pid.get(&pid)?;
    let needle = task_needle(&own.args);
    let mut cur = Some(own);
    let mut hops = 0;
    while let Some(p) = cur {
        // 祖先 shell 的 -c 脚本可能串了好几条命令(`cat > a.txt <<EOF ... && python x.py > x.log`),
        // 只在提到本任务脚本名的那一段里找重定向,避免把别的命令的 `>` 当成日志。
        let segment: Option<&str> = if p.pid == pid {
            Some(p.args.as_str())
        } else {
            command_segment_mentioning(&p.args, &needle)
        };
        if let Some(seg) = segment {
            if let Some(t) = redirect_target_from_cmdline(seg) {
                if let Some(abs) = resolve_log_path(&t, proc_cwd, project_cwd) {
                    return Some(abs);
                }
            }
        }
        hops += 1;
        if hops > 4 || p.ppid == p.pid {
            break;
        }
        cur = by_pid.get(&p.ppid);
    }
    None
}

/// 任务的"识别词":命令行里第一个脚本文件名(main.py / run.sh),没有就是程序裸名(python)。
fn task_needle(args: &str) -> String {
    for t in args.split_whitespace() {
        let base = t.trim_matches('"').rsplit(['/', '\\']).next().unwrap_or(t);
        let bl = base.to_ascii_lowercase();
        if [".py", ".sh", ".js", ".mjs", ".ts", ".ps1", ".bat", ".cmd", ".rb", ".pl", ".r"]
            .iter()
            .any(|suf| bl.ends_with(suf))
        {
            return base.to_string();
        }
    }
    exe_name(args)
}

/// 在多条命令串起来的 shell 脚本里,截出「提到 needle 的那一条命令」(从 needle 所在位置
/// 起,到下一个 `;`/`&&`/`||`/换行为止;`2>&1 &` 里的 `&` 不截)。找不到 needle 返回 None。
fn command_segment_mentioning<'a>(script: &'a str, needle: &str) -> Option<&'a str> {
    if needle.is_empty() {
        return None;
    }
    let start = script.find(needle)?;
    let rest = &script[start..];
    let mut end = rest.len();
    for (i, ch) in rest.char_indices() {
        let two = rest.get(i..i + 2).unwrap_or("");
        if ch == ';' || ch == '\n' || two == "&&" || two == "||" {
            end = i;
            break;
        }
    }
    Some(&rest[..end])
}

/// a 是否为 b 的祖先(沿 ppid 上溯,最多 32 层;by_pid 为空时恒 false)。
fn is_ancestor(a: i64, b: i64, by_pid: &HashMap<i64, ProcInfo>) -> bool {
    let mut cur = b;
    for _ in 0..32 {
        let p = match by_pid.get(&cur) {
            Some(p) => p.ppid,
            None => return false,
        };
        if p == a {
            return true;
        }
        if p <= 0 || p == cur {
            return false;
        }
        cur = p;
    }
    false
}

/// 一个后台任务只留一个 tab:
/// - 共享同一输出文件的多进程(launcher→python、multiprocessing/DataLoader worker、DDP 子进程)
///   只保留树上最顶层那个(没有的话取运行最久 / pid 最小);
/// - 没拿到输出文件的,若祖先里已有命令行完全相同的任务(venv/py 启动器再起一个同参 python),去掉子进程。
/// 这就是「终端区一次冒出好几个 main.py」的修复点。
fn dedup_tasks(mut tasks: Vec<AgentTask>, by_pid: &HashMap<i64, ProcInfo>) -> Vec<AgentTask> {
    tasks.sort_by_key(|t| t.pid);
    let key = |f: &str| normalize_path_str(f);
    // ① 按输出文件分组
    let mut groups: HashMap<String, Vec<usize>> = HashMap::new();
    for (i, t) in tasks.iter().enumerate() {
        if !t.file.is_empty() {
            groups.entry(key(&t.file)).or_default().push(i);
        }
    }
    let mut drop = vec![false; tasks.len()];
    for idxs in groups.values() {
        if idxs.len() < 2 {
            continue;
        }
        let mut best: Option<usize> = None;
        for &i in idxs {
            let has_ancestor_in_group = idxs
                .iter()
                .any(|&j| j != i && is_ancestor(tasks[j].pid, tasks[i].pid, by_pid));
            if has_ancestor_in_group {
                continue;
            }
            best = Some(match best {
                None => i,
                Some(b) => {
                    let (eb, ei) = (etime_secs(&tasks[b].etime), etime_secs(&tasks[i].etime));
                    if ei > eb {
                        i
                    } else {
                        b
                    }
                }
            });
        }
        let keep = best.unwrap_or(idxs[0]);
        for &i in idxs {
            if i != keep {
                drop[i] = true;
            }
        }
    }
    // ② 祖先/后代命令行完全相同(py/venv 启动器再起一个同参 python):只留一个——
    //    优先留拿到输出文件的那个;都没有文件则留祖先。两个都有(不同)文件的不动。
    for i in 0..tasks.len() {
        if drop[i] {
            continue;
        }
        for j in 0..tasks.len() {
            if i == j || drop[j] || tasks[i].args != tasks[j].args {
                continue;
            }
            let (fi, fj) = (!tasks[i].file.is_empty(), !tasks[j].file.is_empty());
            if fi && fj {
                continue;
            }
            let j_is_anc = is_ancestor(tasks[j].pid, tasks[i].pid, by_pid);
            let related = j_is_anc || is_ancestor(tasks[i].pid, tasks[j].pid, by_pid);
            if !related {
                continue;
            }
            if (!fi && fj) || (!fi && !fj && j_is_anc) {
                drop[i] = true;
                break;
            }
        }
    }
    tasks
        .into_iter()
        .enumerate()
        .filter(|(i, _)| !drop[*i])
        .map(|(_, t)| t)
        .collect()
}

// 一闪而过的短命工具 / 纯 shell 外壳:不是用户想看的训练任务,剔除。
const NOISE_CMDS: &[&str] = &[
    "sh",
    "bash",
    "zsh",
    "dash",
    "fish",
    "ksh",
    "head",
    "tail",
    "cat",
    "grep",
    "egrep",
    "fgrep",
    "ugrep",
    "rg",
    "ag",
    "ls",
    "sed",
    "awk",
    "find",
    "fd",
    "wc",
    "sort",
    "uniq",
    "cut",
    "tr",
    "which",
    "env",
    "echo",
    "printf",
    "true",
    "false",
    "test",
    "expr",
    "date",
    "basename",
    "dirname",
    "readlink",
    "stat",
    "cmp",
    "diff",
    "git",
    "ssh",
    "scp",
    "rsync",
    "tee",
    "xargs",
    "cp",
    "mv",
    "rm",
    "mkdir",
    "sleep",
    // 开发工具链 / dev server:用户自己长驻的开发进程,不是 agent 起的后台任务,过滤掉。
    "node",
    "npm",
    "npx",
    "yarn",
    "pnpm",
    "bun",
    "deno",
    "vite",
    "tauri",
    "esbuild",
    "rollup",
    "webpack",
    "tsc",
    "tsserver",
    "next",
    "nuxt",
    "nodemon",
    "ts-node",
    "cargo",
    "rustc",
    "go",
    "gradle",
    "mvn",
    "make",
    "cmake",
    "ninja",
    "linco",
    // Windows 外壳 / 终端宿主 / REPL:agent 每跑一条命令就会起一批这些壳进程,
    // 不是用户想盯的长任务,全部过滤(exe_name 已剥 .exe 后缀,故这里写裸名)。
    "powershell",
    "pwsh",
    "cmd",
    "conhost",
    "node_repl",
    "windowsterminal",
    "wt",
    "openconsole",
    "csrss",
    "where",
    "findstr",
    "more",
    "type",
    "cscript",
    "wscript",
];

/// 从命令行取真正执行的程序名(跳过 env/nohup 前缀与 VAR=val,取首个非选项 token 的 basename)。
/// 归一化处理 Windows:basename 同时按 `/` 和 `\` 切,并剥掉 `.exe`/`.cmd`/`.bat` 等后缀,
/// 这样 `C:\...\powershell.exe` / `node_repl.exe` 都能正确取到 `powershell` / `node_repl`,
/// 与 NOISE_CMDS 里不带后缀的名字比对得上(否则 Windows 上 shell/外壳全都漏过滤)。
fn exe_name(args: &str) -> String {
    // 首 token 带引号(路径含空格,如 `"C:\Program Files\nodejs\node.exe" x.js`)→ 整段取出
    let trimmed = args.trim_start();
    if let Some(rest) = trimmed.strip_prefix('"') {
        if let Some(end) = rest.find('"') {
            return strip_exe_suffix(&rest[..end]);
        }
    }
    let toks: Vec<&str> = args.split_whitespace().collect();
    let mut i = 0;
    while i < toks.len()
        && (toks[i].contains('=') || matches!(toks[i], "env" | "nohup" | "setsid" | "stdbuf"))
    {
        i += 1;
    }
    let t = toks.get(i).or_else(|| toks.first()).copied().unwrap_or("");
    strip_exe_suffix(t)
}

/// 路径 → 裸程序名:basename(`/` 与 `\` 都切)+ 剥掉 Windows 可执行后缀(大小写不敏感)。
fn strip_exe_suffix(t: &str) -> String {
    let base = t.rsplit(['/', '\\']).next().unwrap_or(t);
    let lower = base.to_ascii_lowercase();
    for suf in [".exe", ".cmd", ".bat", ".com"] {
        if let Some(stripped) = lower.strip_suffix(suf) {
            return stripped.to_string();
        }
    }
    lower
}

/// argv 元素含空白/引号时加双引号(内部 `"` 转义为 `\"`),供拼成一行命令行。
#[cfg_attr(not(windows), allow(dead_code))]
fn quote_arg(s: &str) -> String {
    if s.is_empty() || s.chars().any(|c| c.is_whitespace() || c == '"') {
        format!("\"{}\"", s.replace('"', "\\\""))
    } else {
        s.to_string()
    }
}

/// shell 调用是否在"跑一个脚本文件"(如 `bash deploy.sh` / `powershell -File run.ps1`),
/// 而非临时壳。判据:跳过 env/nohup 前缀 + shell 名后,首个非选项 token 是脚本文件
/// (`.sh`/`.bash`/`.ps1`/`.bat`/`.cmd` 后缀,或带路径分隔符的文件名)。
/// 内联命令壳不算:POSIX 的 `-c`、PowerShell 的 `-Command`/`-EncodedCommand`、cmd 的 `/c`/`/k`。
fn shell_runs_script(args: &str) -> bool {
    let toks: Vec<&str> = args.split_whitespace().collect();
    let mut i = 0;
    // 跳过 env/nohup/VAR=val 前缀
    while i < toks.len()
        && (toks[i].contains('=') || matches!(toks[i], "env" | "nohup" | "setsid" | "stdbuf"))
    {
        i += 1;
    }
    // 跳过 shell 名本身
    if i < toks.len() {
        i += 1;
    }
    // 看后续 token:遇到内联命令开关即临时壳(非脚本);遇到脚本文件即 true
    while i < toks.len() {
        let t = toks[i];
        let tl = t.to_ascii_lowercase();
        // 内联命令壳:POSIX -c;PowerShell -Command/-EncodedCommand;cmd /c /k
        if tl == "-c" || tl == "-command" || tl == "-encodedcommand" || tl == "/c" || tl == "/k" {
            return false;
        }
        // PowerShell 显式脚本开关:-File <script> → 是脚本
        if tl == "-file" || tl == "-f" {
            return true;
        }
        // 跳过选项:POSIX/PowerShell 的 `-x`,以及 cmd 的单字母开关 `/q`、`/s` 等。
        // 注意:不能笼统跳过所有 `/` 前缀 token —— POSIX 绝对路径脚本 `/opt/run.sh` 也以 `/` 开头,
        // 那是位置参数不是选项。只把「/ + 单字母」视作 cmd 开关跳过。
        let is_cmd_switch = t.len() == 2 && t.starts_with('/');
        if t.starts_with('-') || is_cmd_switch {
            i += 1;
            continue;
        }
        // 第一个非选项位置参数:是脚本文件吗?(basename 同时按 / 和 \ 切)
        let name = t.rsplit(['/', '\\']).next().unwrap_or(t);
        let nl = name.to_ascii_lowercase();
        return nl.ends_with(".sh")
            || nl.ends_with(".bash")
            || nl.ends_with(".ps1")
            || nl.ends_with(".bat")
            || nl.ends_with(".cmd")
            || t.contains('/')
            || t.contains('\\'); // 带路径的可执行脚本
    }
    false // 裸 shell / 交互壳
}

/// Linco 自身基础设施(html-vibe 预览服务器、linco agent 自己)。
/// 例外:`bash deploy.sh` 这种**带脚本文件参数**的 shell 不算噪声——那是用户在跑的
/// 长脚本,应显示;而裸 shell / `bash -c "..."` 临时壳仍过滤。
fn is_noise(p: &ProcInfo) -> bool {
    if p.args.contains("shell-snapshot")
        || p.args.contains("snapshot-zsh")
        || p.args.contains("snapshot-bash")
    {
        return true;
    }
    if p.args.contains("artifacts_server.py") || p.args.contains("linco_agent.py") {
        return true;
    }
    let exe = exe_name(&p.args);
    // shell 类(含 Windows 的 powershell/pwsh/cmd):只有"带脚本文件参数"时才放行,
    // 其余(裸壳 / 内联命令壳)仍过滤。这是 Windows 上挡住 powershell.exe 刷屏的关键。
    if matches!(
        exe.as_str(),
        "sh" | "bash" | "zsh" | "dash" | "fish" | "ksh" | "powershell" | "pwsh" | "cmd"
    ) {
        return !shell_runs_script(&p.args);
    }
    NOISE_CMDS.contains(&exe.as_str())
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
    let size = std::fs::metadata(path)
        .map_err(|e| format!("无法读取输出文件: {e}"))?
        .len() as i64;
    let mut start = if offset > size { 0 } else { offset };
    if start == 0 && size > max {
        start = size - max;
    }
    let mut f = std::fs::File::open(path).map_err(|e| e.to_string())?;
    f.seek(SeekFrom::Start(start as u64))
        .map_err(|e| e.to_string())?;
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
        etime: v
            .get("etime")
            .and_then(|x| x.as_str())
            .unwrap_or("")
            .to_string(),
        pcpu: v
            .get("pcpu")
            .and_then(|x| x.as_str())
            .unwrap_or("")
            .to_string(),
        pmem: v
            .get("pmem")
            .and_then(|x| x.as_str())
            .unwrap_or("")
            .to_string(),
        stat: v
            .get("stat")
            .and_then(|x| x.as_str())
            .unwrap_or("")
            .to_string(),
        args: v
            .get("args")
            .and_then(|x| x.as_str())
            .unwrap_or("")
            .to_string(),
    })
}

/// Windows:用 sysinfo 拿全部进程的快照(零子进程,不闪黑窗),一次扫描同时产出
/// ProcInfo 列表与 pid→cwd 映射。
///
/// 关键:必须显式要 `cmd` 与 `cwd`。sysinfo 0.39 的 `refresh_processes()` 默认只刷
/// memory/cpu/disk/exe,**不读 PEB 里的命令行和工作目录** → 此前 cwd 映射恒为空,
/// 「cwd 命中项目目录」这条锚点在 Windows 上从未生效;后台任务一旦脱离 agent 子树
/// (Git Bash 的 `cmd &` 子壳退出后 python 的父进程已死)就完全检测不到——这就是
/// Windows 上「终端区看不到 agent 后台任务日志」的根因之一。
#[cfg(windows)]
fn snapshot_all() -> (Vec<ProcInfo>, HashMap<i64, String>) {
    use sysinfo::{ProcessRefreshKind, ProcessesToUpdate, System, UpdateKind};
    let mut sys = System::new();
    sys.refresh_processes_specifics(
        ProcessesToUpdate::All,
        true,
        ProcessRefreshKind::nothing()
            .with_cpu()
            .with_memory()
            .with_exe(UpdateKind::OnlyIfNotSet)
            .with_cmd(UpdateKind::Always)
            .with_cwd(UpdateKind::Always),
    );
    let mut cwds = HashMap::new();
    let procs = sys
        .processes()
        .iter()
        .map(|(pid, p)| {
            let id = pid.as_u32() as i64;
            if let Some(cwd) = p.cwd() {
                cwds.insert(id, cwd.to_string_lossy().to_string());
            }
            // argv 元素含空白(`C:\Program Files\nodejs\node.exe`)时加引号,否则按空白分词的
            // exe_name/去噪会把 `C:\Program` 当程序名 → node/npm 等噪声全部漏过滤、标签也乱。
            let args = p
                .cmd()
                .iter()
                .map(|s| quote_arg(&s.to_string_lossy()))
                .collect::<Vec<_>>()
                .join(" ");
            let args = if args.trim().is_empty() {
                p.name().to_string_lossy().to_string()
            } else {
                args
            };
            ProcInfo {
                pid: id,
                ppid: p.parent().map(|pp| pp.as_u32() as i64).unwrap_or(0),
                etime: fmt_etime(p.run_time()),
                pcpu: format!("{:.1}", p.cpu_usage()),
                pmem: format!("{}", p.memory() / (1024 * 1024)), // MiB
                stat: status_letter(p.status()),
                args,
            }
        })
        .collect();
    (procs, cwds)
}

/// run_time(秒)→ ps 风格 ELAPSED 字符串(MM:SS / HH:MM:SS / DD-HH:MM:SS)。
#[cfg(windows)]
fn fmt_etime(secs: u64) -> String {
    let d = secs / 86400;
    let h = (secs % 86400) / 3600;
    let m = (secs % 3600) / 60;
    let s = secs % 60;
    if d > 0 {
        format!("{d}-{h:02}:{m:02}:{s:02}")
    } else if h > 0 {
        format!("{h:02}:{m:02}:{s:02}")
    } else {
        format!("{m:02}:{s:02}")
    }
}

/// sysinfo 进程状态 → ps 风格单字母(够前端/去噪用)。
#[cfg(windows)]
fn status_letter(st: sysinfo::ProcessStatus) -> String {
    use sysinfo::ProcessStatus as S;
    match st {
        S::Run => "R",
        S::Sleep => "S",
        S::Idle => "I",
        S::Stop => "T",
        S::Zombie => "Z",
        _ => "S",
    }
    .to_string()
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
        procs.push(ProcInfo {
            pid,
            ppid,
            etime,
            pcpu,
            pmem,
            stat,
            args,
        });
    }
    procs
}

fn parse_and_filter(raw: &str, base: &str, _cwd: Option<&str>) -> Vec<ProcInfo> {
    filter_descendants(&parse_all(raw), base)
}

/// 在一组进程里定位命令名含 base 的根进程,沿 ppid 向下 BFS 收后代(不含根)。
/// 与进程来源无关(ps 文本 / sysinfo 快照都产出 Vec<ProcInfo>),供 Mac/Windows 共用。
fn filter_descendants(procs: &[ProcInfo], base: &str) -> Vec<ProcInfo> {
    let mut children: HashMap<i64, Vec<i64>> = HashMap::new();
    for p in procs {
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

    #[test]
    fn filter_descendants_equivalent_to_parse_and_filter() {
        // 重构保证:filter_descendants(parse_all(raw)) 与旧 parse_and_filter 等价。
        // Windows 分支也走 filter_descendants,这条锁住行为一致。
        let via_wrapper = parse_and_filter(SAMPLE, "claude", None);
        let via_direct = filter_descendants(&parse_all(SAMPLE), "claude");
        assert_eq!(via_wrapper, via_direct);
        let pids: Vec<i64> = via_direct.iter().map(|p| p.pid).collect();
        assert!(pids.contains(&200) && pids.contains(&300));
        assert!(!pids.contains(&100) && !pids.contains(&400));
    }

    fn noise(args: &str) -> bool {
        is_noise(&ProcInfo {
            pid: 1,
            ppid: 1,
            etime: "01:00".into(),
            pcpu: "0".into(),
            pmem: "0".into(),
            stat: "S".into(),
            args: args.into(),
        })
    }

    #[test]
    fn bash_with_script_is_not_noise() {
        // 带脚本文件的 shell → 显示(非噪声)
        assert!(!noise("bash deploy.sh"));
        assert!(!noise("bash /opt/run/benchmark.sh --fast"));
        assert!(!noise("sh ./train.sh"));
        assert!(!noise("bash scripts/eval.bash"));
    }

    #[test]
    fn bare_or_inline_shell_is_noise() {
        // 裸壳 / -c 内联命令壳 → 仍过滤
        assert!(noise("bash"));
        assert!(noise("bash -lc \"ls\""));
        assert!(noise("sh -c \"grep foo bar\""));
        assert!(noise("zsh -i"));
    }

    #[test]
    fn real_programs_still_show() {
        // 真实长任务程序仍显示(python 训练等)
        assert!(!noise("python -u train.py"));
        assert!(!noise("python eval.py --ckpt best.pt"));
        assert!(!noise("./my_binary --serve"));
    }

    #[test]
    fn dev_tools_are_noise() {
        // dev server / 构建工具链:用户长驻开发进程,不进后台监控
        for c in [
            "node /Users/x/linco/node_modules/.bin/vite",
            "npm run tauri:dev",
            "vite",
            "node /Users/x/.bin/tauri dev",
            "cargo build",
            "tsc --noEmit",
            "webpack serve",
            "target/debug/linco",
        ] {
            assert!(noise(c), "should be noise: {c}");
        }
        // 但带脚本的 bash 仍显示(不受 dev 名单影响)
        assert!(!noise("bash deploy.sh"));
    }

    #[test]
    fn windows_shells_and_hosts_are_noise() {
        // Windows 上 agent 每跑一条命令就刷一批这些壳/宿主进程 → 全部过滤。
        // 覆盖:带完整路径、带 .exe 后缀、大小写混合。
        for c in [
            r"C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe",
            "powershell.exe -NoProfile -Command \"ls\"",
            "pwsh.exe -Command \"Get-ChildItem\"",
            r"C:\Windows\System32\cmd.exe /c dir",
            "cmd.exe /k",
            r"C:\Windows\System32\conhost.exe 0x4",
            "node_repl.exe",
            "WindowsTerminal.exe",
            "OpenConsole.exe",
            "where.exe python",
            "findstr /i foo",
        ] {
            assert!(noise(c), "Windows 壳/宿主应被过滤: {c}");
        }
    }

    #[test]
    fn quoted_windows_exe_with_spaces_is_recognized() {
        // sysinfo 的 argv 拼接会给含空格的路径加引号;exe_name 必须整段取出再取 basename。
        assert_eq!(exe_name(r#""C:\Program Files\nodejs\node.exe" tmp/x.mjs"#), "node");
        assert!(noise(r#""C:\Program Files\nodejs\node.exe" tmp/x.mjs"#));
        assert!(!noise(r#""C:\Program Files\Python312\python.exe" -u main.py"#));
        assert_eq!(quote_arg(r"C:\Program Files\x.exe"), r#""C:\Program Files\x.exe""#);
        assert_eq!(quote_arg("plain"), "plain");
    }

    #[test]
    fn segment_picks_the_command_mentioning_the_task() {
        let script = "cd /c/p && cat > tmp/helper.mjs <<'EOF'\nfoo\nEOF\npython -u main.py > main.log 2>&1 &";
        assert_eq!(task_needle("python -u main.py"), "main.py");
        let seg = command_segment_mentioning(script, "main.py").unwrap();
        assert_eq!(seg, "main.py > main.log 2>&1 &");
        assert_eq!(redirect_target_from_cmdline(seg).as_deref(), Some("main.log"));
        // 没提到本任务 → None(不会误拿 `cat > tmp/helper.mjs`)
        assert!(command_segment_mentioning(script, "train.py").is_none());
        assert_eq!(task_needle(r#""C:\Program Files\nodejs\node.exe" tmp/x.mjs"#), "x.mjs");
    }

    #[test]
    fn redirect_target_prefers_stdout() {
        assert_eq!(
            redirect_target_from_cmdline("python -u main.py > main.log 2>&1 &").as_deref(),
            Some("main.log")
        );
        assert_eq!(
            redirect_target_from_cmdline(
                r#"bash -c "cd /c/x && python train.py >> logs/train.log 2>&1""#
            )
            .as_deref(),
            Some("logs/train.log")
        );
        assert_eq!(
            redirect_target_from_cmdline(r#"cmd.exe /c python main.py 1>"C:\my dir\out.log" 2>err.log"#)
                .as_deref(),
            Some(r"C:\my dir\out.log")
        );
        // 只有 stderr 重定向 → 退而取之;/dev/null、nul、&1 跳过
        assert_eq!(
            redirect_target_from_cmdline("python x.py > /dev/null 2> err.log").as_deref(),
            Some("err.log")
        );
        assert_eq!(redirect_target_from_cmdline("python x.py 2>&1 | tee t.log"), None);
        assert_eq!(redirect_target_from_cmdline("python x.py"), None);
    }

    fn task(pid: i64, args: &str, file: &str, etime: &str) -> AgentTask {
        AgentTask { pid, args: args.into(), file: file.into(), etime: etime.into() }
    }

    fn tree(edges: &[(i64, i64, &str)]) -> HashMap<i64, ProcInfo> {
        edges
            .iter()
            .map(|(pid, ppid, args)| {
                (
                    *pid,
                    ProcInfo {
                        pid: *pid,
                        ppid: *ppid,
                        etime: "01:00".into(),
                        pcpu: "0".into(),
                        pmem: "0".into(),
                        stat: "S".into(),
                        args: (*args).into(),
                    },
                )
            })
            .collect()
    }

    #[test]
    fn dedup_keeps_topmost_process_sharing_a_log_file() {
        // python main.py(300)起了两个 DataLoader worker(301/302)共享同一 stdout 文件
        // + 启动器 py.exe(250)同命令行无文件 → 只剩 300 一个 tab。
        let by_pid = tree(&[
            (200, 100, "bash -c \"python -u main.py > main.log 2>&1\""),
            (250, 200, "python -u main.py"),
            (300, 250, "python -u main.py"),
            (301, 300, "python -c from multiprocessing.spawn import spawn_main --multiprocessing-fork"),
            (302, 300, "python -c from multiprocessing.spawn import spawn_main --multiprocessing-fork"),
        ]);
        let got = dedup_tasks(
            vec![
                task(302, "python -c ...", r"C:\p\main.log", "00:50"),
                task(300, "python -u main.py", r"C:\p\main.log", "00:59"),
                task(301, "python -c ...", r"c:\P\MAIN.LOG", "00:50"),
                task(250, "python -u main.py", "", "01:00"),
            ],
            &by_pid,
        );
        let pids: Vec<i64> = got.iter().map(|t| t.pid).collect();
        if cfg!(windows) {
            assert_eq!(pids, vec![300]);
        } else {
            // 非 Windows 路径大小写敏感:301 视作另一个文件;250(无文件)被同命令行、有文件的 300 收掉
            assert_eq!(pids, vec![300, 301]);
        }
    }

    #[test]
    fn dedup_drops_same_cmdline_child_without_file() {
        // 启动器(250)→ 真 python(300)同命令行、都没拿到文件 → 只留祖先 250。
        let by_pid = tree(&[(250, 1, "python main.py"), (300, 250, "python main.py")]);
        let got = dedup_tasks(
            vec![task(300, "python main.py", "", "00:30"), task(250, "python main.py", "", "00:31")],
            &by_pid,
        );
        let pids: Vec<i64> = got.iter().map(|t| t.pid).collect();
        assert_eq!(pids, vec![250]);
    }

    #[test]
    fn dedup_keeps_unrelated_tasks_and_longest_running_sibling() {
        // 无树信息(远端)时:同文件取运行最久的;不同文件都保留。
        let got = dedup_tasks(
            vec![
                task(10, "python a.py", "/p/a.log", "00:10"),
                task(11, "python a.py", "/p/a.log", "05:00"),
                task(12, "python b.py", "/p/b.log", "00:10"),
                task(13, "python c.py", "", "00:10"),
            ],
            &HashMap::new(),
        );
        let pids: Vec<i64> = got.iter().map(|t| t.pid).collect();
        assert_eq!(pids, vec![11, 12, 13]);
    }

    #[test]
    fn normalize_path_handles_windows_forms() {
        assert_eq!(
            normalize_path_str(r"\\?\C:\Users\me\proj\"),
            if cfg!(windows) { "c:/users/me/proj" } else { "C:/Users/me/proj" }
        );
        assert_eq!(normalize_path_str("/home/me/proj/"), "/home/me/proj");
    }

    #[test]
    fn windows_shell_running_script_still_shows() {
        // PowerShell/cmd 跑脚本文件 = 用户的真实长任务 → 显示(不过滤)。
        assert!(!noise("powershell.exe -File train.ps1"));
        assert!(!noise(r"powershell -File C:\work\run.ps1 -Fast"));
        assert!(noise("cmd.exe /c quickcmd")); // /c 是内联壳 → 仍过滤
        assert!(!noise("cmd.exe deploy.bat"));
        // 真实程序(python.exe 训练)在 Windows 上也照常显示
        assert!(!noise("python.exe -u train.py"));
        assert!(!noise(r"C:\Python311\python.exe eval.py"));
    }
}
