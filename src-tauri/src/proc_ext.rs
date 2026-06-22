// 进程生成的跨平台辅助。
//
// Windows 痛点:每次 `std::process::Command` 起一个控制台子进程(git/ssh/…),
// 系统会**闪一个黑色 cmd 窗口**。频繁轮询 git 状态时尤其烦人。
// 解决:给 Command 设 CREATE_NO_WINDOW(0x0800_0000)创建标志,子进程不分配控制台。
// macOS/Linux 无此问题,helper 在这些平台是空操作。

use std::process::Command;

/// 对本地 Command 应用「无控制台窗口」设置(仅 Windows 生效)。
/// 用法:`no_window(&mut cmd);` 然后照常 `.output()/.spawn()`。
#[allow(unused_variables)]
pub fn no_window(cmd: &mut Command) {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
}

/// 在现有 PATH 前面补上常见的 node / CLI 安装目录(homebrew、nvm 当前各版本、~/.local/bin、
/// cargo、bun,以及 `extra_dir`——通常是被执行 CLI 自身所在目录)。
///
/// 为什么需要:GUI(Finder/launchd)启动的 app 拿到的是精简 PATH(`/usr/bin:/bin`),不含
/// homebrew/nvm。而 claude/codex 这类 CLI 多是 **node 包装脚本**,运行时自己要去 PATH 找 `node`;
/// 精简 PATH 里没有 node → CLI 启动即 `node: No such file or directory`(退出码 127)→ 被误判成
/// "该 CLI 不支持 plugin 子命令"。所以光解析出 CLI 绝对路径不够,还得让它运行时找得到 node。
/// 返回值用于 `Command::env("PATH", …)`。Windows 上 node 一般已在用户 PATH,影响小但同样无害。
#[cfg(not(windows))]
fn augmented_path(extra_dir: Option<&str>) -> String {
    let home = std::env::var("HOME").unwrap_or_default();
    let mut dirs: Vec<String> = Vec::new();
    if let Some(d) = extra_dir {
        if !d.is_empty() {
            dirs.push(d.to_string());
        }
    }
    dirs.push("/opt/homebrew/bin".into());
    dirs.push("/usr/local/bin".into());
    dirs.push(format!("{home}/.local/bin"));
    dirs.push(format!("{home}/.cargo/bin"));
    dirs.push(format!("{home}/.bun/bin"));
    // nvm 各版本 bin(node 本体常在此);全加进去,谁在就用谁。
    let nvm = format!("{home}/.nvm/versions/node");
    if let Ok(rd) = std::fs::read_dir(&nvm) {
        for e in rd.flatten() {
            dirs.push(format!("{}/bin", e.path().to_string_lossy()));
        }
    }
    let existing = std::env::var("PATH").unwrap_or_default();
    if !existing.is_empty() {
        dirs.push(existing);
    }
    dirs.join(":")
}

/// 构造一条执行 CLI(claude/codex/git 等)的 Command,已处理好跨平台细节:
/// - 先用 `resolve_exe` 解析出真实路径并**缓存**(macOS 上 resolve_exe 会 shell-out 取 which,
///   较慢;缓存避免每条命令都解析一次)。
/// - **注入增强 PATH**(见 `augmented_path`):node 包装类 CLI 运行时要找 node,GUI 精简 PATH
///   里没有 node 会导致 CLI 启动失败(退出码 127)被误判成不支持子命令。
/// - Windows 上若解析到的是 `.cmd`/`.bat` 批处理 shim(npm 全局装的 CLI 即如此),
///   **不能**用 CreateProcess 直接执行(会"程序无法识别"启动失败),必须经 `cmd.exe /c <shim>`。
/// - 已套 `no_window`(不闪黑窗)。
///
/// 用法:`let mut c = cli_command("codex", &["plugin", "--help"]); c.output()`。
pub fn cli_command(name: &str, args: &[&str]) -> Command {
    use std::sync::{Mutex, OnceLock};
    static CACHE: OnceLock<Mutex<std::collections::HashMap<String, String>>> = OnceLock::new();
    let cache = CACHE.get_or_init(|| Mutex::new(std::collections::HashMap::new()));
    let exe = if let Some(p) = cache.lock().ok().and_then(|m| m.get(name).cloned()) {
        p
    } else {
        let r = resolve_exe(name);
        if let Ok(mut m) = cache.lock() {
            m.insert(name.to_string(), r.clone());
        }
        r
    };
    // CLI 自身所在目录(node 包装器常与 node 同目录,如 nvm/homebrew bin)放进 PATH 优先位。
    #[cfg(not(windows))]
    let exe_dir: Option<String> = std::path::Path::new(&exe)
        .parent()
        .map(|p| p.to_string_lossy().to_string());
    #[cfg(windows)]
    {
        let lower = exe.to_ascii_lowercase();
        if lower.ends_with(".cmd") || lower.ends_with(".bat") {
            // cmd.exe /c <shim> <args...>:让命令解释器去跑批处理 shim。
            let comspec = std::env::var("ComSpec").unwrap_or_else(|_| "cmd.exe".to_string());
            let mut c = Command::new(comspec);
            c.arg("/c").arg(&exe);
            c.args(args);
            no_window(&mut c);
            return c;
        }
    }
    let mut c = Command::new(&exe);
    c.args(args);
    #[cfg(not(windows))]
    c.env("PATH", augmented_path(exe_dir.as_deref()));
    no_window(&mut c);
    c
}


/// 痛点:GUI 启动的 app(Finder/launchd)PATH 是精简的(`/usr/bin:/bin:...`),
/// 不含 nvm / homebrew / `~/.local/bin` 等。于是 `Command::new("claude")` 找不到,
/// 误报「不支持」。这里依次:① 常见安装目录直查;② 登录 shell 取 `which`;
/// ③ 兜底返回裸名(交给系统 PATH,聊胜于无)。结果可直接喂给 `Command::new`。
#[cfg(not(windows))]
pub fn resolve_exe(name: &str) -> String {
    use std::path::Path;
    // ① 常见安装位置(homebrew / 系统 / ~/.local/bin / cargo / nvm 当前 bin)
    let home = std::env::var("HOME").unwrap_or_default();
    let mut cands = vec![
        format!("/opt/homebrew/bin/{name}"),
        format!("/usr/local/bin/{name}"),
        format!("/usr/bin/{name}"),
        format!("{home}/.local/bin/{name}"),
        format!("{home}/.cargo/bin/{name}"),
        format!("{home}/.bun/bin/{name}"),
    ];
    // nvm:取最新 node 版本的 bin(claude/codex 常作为 npm 全局装在这里)
    let nvm = format!("{home}/.nvm/versions/node");
    if let Ok(rd) = std::fs::read_dir(&nvm) {
        for e in rd.flatten() {
            cands.push(format!("{}/bin/{name}", e.path().to_string_lossy()));
        }
    }
    for c in &cands {
        if Path::new(c).is_file() {
            return c.clone();
        }
    }
    // ② 登录 shell 取 which(拿到用户完整 PATH 下的解析)
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".into());
    if let Ok(out) = Command::new(&shell)
        .args(["-lic", &format!("command -v {name}")])
        .output()
    {
        let p = String::from_utf8_lossy(&out.stdout).trim().to_string();
        if !p.is_empty() && Path::new(&p).is_file() {
            return p;
        }
    }
    // ③ 兜底:裸名(交给系统 PATH)
    name.to_string()
}

/// Windows:沿 PATH × PATHEXT 解析出真实可执行文件的绝对路径。
///
/// 为什么不能用裸名:`std::process::Command`(→ CreateProcess)在 Windows 上**不应用 PATHEXT**,
/// 只按"原样文件名"在 PATH 里找。npm 全局装的 CLI(claude/codex)是 `codex.cmd` 批处理 shim,
/// 裸名 "codex" 既找不到文件、也无法直接执行 → `codex plugin --help` 直接启动失败,
/// 被误判成"该 CLI 不支持 plugin 子命令"(就是设置页三个开关变灰、报"无 plugin 子命令"的根因)。
/// 这里显式枚举 PATH 下每个目录 × PATHEXT(含无扩展名)找到第一个存在的文件,返回其绝对路径;
/// 找不到则回退裸名(交给系统,至少不比现状差)。
#[cfg(windows)]
pub fn resolve_exe(name: &str) -> String {
    use std::path::Path;
    let path = std::env::var("PATH").unwrap_or_default();
    let pathext =
        std::env::var("PATHEXT").unwrap_or_else(|_| ".COM;.EXE;.BAT;.CMD".to_string());
    resolve_exe_in(name, &path, &pathext, |p| Path::new(p).is_file())
}

/// `resolve_exe` 的纯逻辑核心(把 PATH/PATHEXT/文件存在判定作为入参 → 可在任意平台单测)。
/// 沿 PATH 每个目录 × PATHEXT(先试无扩展名,再逐个后缀)找第一个 `exists` 为真的候选,
/// 返回其完整路径;带分隔符的入参原样返回;全不命中则回退裸名。
#[cfg_attr(not(windows), allow(dead_code))]
fn resolve_exe_in(
    name: &str,
    path: &str,
    pathext: &str,
    exists: impl Fn(&str) -> bool,
) -> String {
    // 已是带分隔符的路径(调用方已给绝对/相对路径)→ 原样返回。
    if name.contains('\\') || name.contains('/') {
        return name.to_string();
    }
    let mut exts: Vec<String> = vec![String::new()];
    exts.extend(pathext.split(';').filter(|s| !s.is_empty()).map(|s| s.to_string()));
    for dir in path.split(';').filter(|s| !s.is_empty()) {
        for ext in &exts {
            let cand = format!("{dir}\\{name}{ext}");
            if exists(&cand) {
                return cand;
            }
        }
    }
    name.to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    // Windows 路径解析的纯逻辑(在任意平台可跑)。
    const PATHEXT: &str = ".COM;.EXE;.BAT;.CMD";

    #[test]
    fn resolves_npm_cmd_shim() {
        // codex 是 npm 全局装的 .cmd shim:只有 codex.cmd 存在,裸名/.exe 都不存在。
        // 必须解析到 .cmd 全路径(这正是修复前裸名找不到、导致误判"无 plugin"的场景)。
        // 闭包用大小写不敏感比较,模拟 Windows 文件系统(PATHEXT 是大写,真实 FS 不区分大小写)。
        let path = r"C:\Users\me\AppData\Roaming\npm;C:\Windows\System32";
        let exists =
            |p: &str| p.eq_ignore_ascii_case(r"C:\Users\me\AppData\Roaming\npm\codex.cmd");
        assert_eq!(
            resolve_exe_in("codex", path, PATHEXT, exists).to_ascii_lowercase(),
            r"c:\users\me\appdata\roaming\npm\codex.cmd"
        );
    }

    #[test]
    fn prefers_earlier_path_dir_and_exe_over_cmd() {
        // PATH 顺序优先;同目录下扩展名顺序按 PATHEXT(.EXE 在 .CMD 前)。
        let path = r"C:\a;C:\b";
        let exists = |p: &str| {
            p.eq_ignore_ascii_case(r"C:\a\git.exe") || p.eq_ignore_ascii_case(r"C:\b\git.cmd")
        };
        assert_eq!(
            resolve_exe_in("git", path, PATHEXT, exists).to_ascii_lowercase(),
            r"c:\a\git.exe"
        );
    }

    #[test]
    fn passthrough_when_name_has_separator() {
        // 调用方已给出带分隔符的路径 → 原样返回,不再搜 PATH。
        let never = |_: &str| true;
        assert_eq!(
            resolve_exe_in(r"C:\tools\codex.cmd", "", PATHEXT, never),
            r"C:\tools\codex.cmd"
        );
        assert_eq!(resolve_exe_in("/usr/bin/git", "", PATHEXT, never), "/usr/bin/git");
    }

    #[test]
    fn falls_back_to_bare_name_when_not_found() {
        // PATH 里找不到 → 回退裸名(交给系统,不比现状差)。
        let none = |_: &str| false;
        assert_eq!(resolve_exe_in("codex", r"C:\x;C:\y", PATHEXT, none), "codex");
    }
}
