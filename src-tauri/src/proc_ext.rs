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
