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

/// 解析一个 CLI 可执行文件的真实路径。
///
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

/// Windows:暂用裸名(Windows 上 PATH 一般正常,且 claude/codex 多在标准位置)。
#[cfg(windows)]
pub fn resolve_exe(name: &str) -> String {
    name.to_string()
}
