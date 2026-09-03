// Windows:解析目标进程 stdout/stderr 重定向到的**磁盘文件**路径。
//
// 痛点:Windows 没有 /proc/PID/fd 与 lsof,后台任务(`python -u main.py > main.log 2>&1 &`)
// 的输出文件此前拿不到 → 终端区的后台任务 tab 只有标题、没有日志,用户完全看不到
// agent 在后台干什么。
//
// 原理:每个进程的 PEB → RTL_USER_PROCESS_PARAMETERS 里保存着 StandardInput/Output/Error
// 三个句柄值(继承自父进程,shell 做 `>` 重定向时传进来的正是打开的日志文件句柄)。
// 用 NtQueryInformationProcess 取 PEB 地址 → ReadProcessMemory 读出句柄值 →
// DuplicateHandle 复制到本进程 → GetFileType 判定是磁盘文件(管道/控制台直接跳过,
// 不会像 NtQueryObject 查管道名那样挂死)→ GetFinalPathNameByHandleW 拿到 DOS 路径。
//
// 纯 FFI(kernel32/ntdll),不引入新 crate;只对同用户进程有效(需要 QUERY/VM_READ/DUP 权限),
// 跨权限/32 位进程失败时静默返回 None,由调用方回退到命令行启发式。

#![cfg(windows)]

use std::ffi::c_void;

type Handle = *mut c_void;

#[repr(C)]
struct ProcessBasicInformation {
    exit_status: i32,
    peb_base_address: *mut c_void,
    affinity_mask: usize,
    base_priority: i32,
    unique_process_id: usize,
    inherited_from_unique_process_id: usize,
}

#[link(name = "kernel32")]
extern "system" {
    fn OpenProcess(desired_access: u32, inherit: i32, pid: u32) -> Handle;
    fn CloseHandle(h: Handle) -> i32;
    fn GetCurrentProcess() -> Handle;
    fn ReadProcessMemory(
        process: Handle,
        base: *const c_void,
        buf: *mut c_void,
        size: usize,
        read: *mut usize,
    ) -> i32;
    fn DuplicateHandle(
        src_process: Handle,
        src_handle: Handle,
        dst_process: Handle,
        dst_handle: *mut Handle,
        desired_access: u32,
        inherit: i32,
        options: u32,
    ) -> i32;
    fn GetFileType(h: Handle) -> u32;
    fn GetFinalPathNameByHandleW(h: Handle, buf: *mut u16, len: u32, flags: u32) -> u32;
}

#[link(name = "ntdll")]
extern "system" {
    fn NtQueryInformationProcess(
        process: Handle,
        class: u32,
        info: *mut c_void,
        len: u32,
        ret_len: *mut u32,
    ) -> i32;
}

const PROCESS_QUERY_INFORMATION: u32 = 0x0400;
const PROCESS_VM_READ: u32 = 0x0010;
const PROCESS_DUP_HANDLE: u32 = 0x0040;
const DUPLICATE_SAME_ACCESS: u32 = 0x0002;
const FILE_TYPE_DISK: u32 = 0x0001;
const PROCESS_BASIC_INFORMATION_CLASS: u32 = 0;

// x64 布局偏移(Linco 仅发布 x86_64 Windows 构建)。
// PEB.ProcessParameters @ 0x20;RTL_USER_PROCESS_PARAMETERS.StandardOutput @ 0x28、StandardError @ 0x30。
#[cfg(target_pointer_width = "64")]
const PEB_PROCESS_PARAMETERS_OFFSET: usize = 0x20;
#[cfg(target_pointer_width = "64")]
const PARAMS_STDOUT_OFFSET: usize = 0x28;
#[cfg(target_pointer_width = "64")]
const PARAMS_STDERR_OFFSET: usize = 0x30;
#[cfg(target_pointer_width = "32")]
const PEB_PROCESS_PARAMETERS_OFFSET: usize = 0x10;
#[cfg(target_pointer_width = "32")]
const PARAMS_STDOUT_OFFSET: usize = 0x1C;
#[cfg(target_pointer_width = "32")]
const PARAMS_STDERR_OFFSET: usize = 0x20;

struct OwnedHandle(Handle);
impl Drop for OwnedHandle {
    fn drop(&mut self) {
        if !self.0.is_null() {
            unsafe {
                CloseHandle(self.0);
            }
        }
    }
}

/// 读目标进程内存中的一个指针大小的值。
unsafe fn read_ptr(process: Handle, addr: usize) -> Option<usize> {
    let mut val: usize = 0;
    let mut got: usize = 0;
    let ok = ReadProcessMemory(
        process,
        addr as *const c_void,
        &mut val as *mut usize as *mut c_void,
        std::mem::size_of::<usize>(),
        &mut got,
    );
    if ok == 0 || got != std::mem::size_of::<usize>() {
        return None;
    }
    Some(val)
}

/// 把目标进程里的句柄值复制到本进程,若指向磁盘文件则返回其 DOS 路径。
unsafe fn handle_to_disk_path(process: Handle, remote_handle: usize) -> Option<String> {
    if remote_handle == 0 || remote_handle == usize::MAX {
        return None;
    }
    let mut dup: Handle = std::ptr::null_mut();
    let ok = DuplicateHandle(
        process,
        remote_handle as Handle,
        GetCurrentProcess(),
        &mut dup,
        0,
        0,
        DUPLICATE_SAME_ACCESS,
    );
    if ok == 0 || dup.is_null() {
        return None;
    }
    let dup = OwnedHandle(dup);
    // 管道/控制台/字符设备直接跳过;只有磁盘文件才可 tail。
    if GetFileType(dup.0) != FILE_TYPE_DISK {
        return None;
    }
    let mut buf = vec![0u16; 1024];
    let n = GetFinalPathNameByHandleW(dup.0, buf.as_mut_ptr(), buf.len() as u32, 0);
    if n == 0 {
        return None;
    }
    if n as usize >= buf.len() {
        buf = vec![0u16; n as usize + 1];
        let n2 = GetFinalPathNameByHandleW(dup.0, buf.as_mut_ptr(), buf.len() as u32, 0);
        if n2 == 0 || n2 as usize >= buf.len() {
            return None;
        }
        buf.truncate(n2 as usize);
    } else {
        buf.truncate(n as usize);
    }
    Some(strip_verbatim(&String::from_utf16_lossy(&buf)))
}

/// `\\?\C:\x\y` → `C:\x\y`;`\\?\UNC\srv\share` → `\\srv\share`。
pub fn strip_verbatim(p: &str) -> String {
    if let Some(rest) = p.strip_prefix(r"\\?\UNC\") {
        return format!(r"\\{rest}");
    }
    if let Some(rest) = p.strip_prefix(r"\\?\") {
        return rest.to_string();
    }
    p.to_string()
}

/// 目标进程 (stdout 文件, stderr 文件)。任一拿不到即 None。
pub fn std_files(pid: i64) -> (Option<String>, Option<String>) {
    if pid <= 0 || pid > u32::MAX as i64 {
        return (None, None);
    }
    unsafe {
        let h = OpenProcess(
            PROCESS_QUERY_INFORMATION | PROCESS_VM_READ | PROCESS_DUP_HANDLE,
            0,
            pid as u32,
        );
        if h.is_null() {
            return (None, None);
        }
        let process = OwnedHandle(h);
        let mut pbi = ProcessBasicInformation {
            exit_status: 0,
            peb_base_address: std::ptr::null_mut(),
            affinity_mask: 0,
            base_priority: 0,
            unique_process_id: 0,
            inherited_from_unique_process_id: 0,
        };
        let mut ret = 0u32;
        let status = NtQueryInformationProcess(
            process.0,
            PROCESS_BASIC_INFORMATION_CLASS,
            &mut pbi as *mut _ as *mut c_void,
            std::mem::size_of::<ProcessBasicInformation>() as u32,
            &mut ret,
        );
        if status != 0 || pbi.peb_base_address.is_null() {
            return (None, None);
        }
        let peb = pbi.peb_base_address as usize;
        let params = match read_ptr(process.0, peb + PEB_PROCESS_PARAMETERS_OFFSET) {
            Some(p) if p != 0 => p,
            _ => return (None, None),
        };
        let out = read_ptr(process.0, params + PARAMS_STDOUT_OFFSET)
            .and_then(|hv| handle_to_disk_path(process.0, hv));
        let err = read_ptr(process.0, params + PARAMS_STDERR_OFFSET)
            .and_then(|hv| handle_to_disk_path(process.0, hv));
        (out, err)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn strips_verbatim_prefix() {
        assert_eq!(strip_verbatim(r"\\?\C:\a\b.log"), r"C:\a\b.log");
        assert_eq!(strip_verbatim(r"\\?\UNC\srv\share\x"), r"\\srv\share\x");
        assert_eq!(strip_verbatim(r"C:\plain"), r"C:\plain");
    }

    #[test]
    fn resolves_own_redirected_stdout_of_child() {
        // 起一个 stdout 重定向到临时文件的子进程,验证能从它的 PEB 解析出该文件路径。
        use std::process::{Command, Stdio};
        let dir = std::env::temp_dir().join(format!("linco-win-stdout-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let log = dir.join("child.log");
        let f = std::fs::File::create(&log).unwrap();
        // 注意不能经 cmd.exe 套壳:cmd 实现内部 `>` 重定向时会临时 SetStdHandle 换掉自己的
        // 标准句柄,读到的就不是我们传入的文件了。直接起一个普通控制台程序。
        let mut child = Command::new("ping")
            .args(["-n", "4", "127.0.0.1"])
            .stdout(Stdio::from(f))
            .spawn()
            .expect("spawn cmd");
        // 给子进程一点时间完成初始化(PEB 参数在创建时即写好,通常立即可读)。
        std::thread::sleep(std::time::Duration::from_millis(200));
        let (out, _) = std_files(child.id() as i64);
        let _ = child.kill();
        let _ = child.wait();
        let _ = std::fs::remove_dir_all(&dir);
        let got = out.expect("stdout file should resolve");
        assert!(
            got.eq_ignore_ascii_case(&log.to_string_lossy()),
            "got {got}, want {}",
            log.display()
        );
    }
}

