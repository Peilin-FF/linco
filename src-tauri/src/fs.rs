// 文件系统操作:供「文件」视图(VS Code 风格资源管理器)使用。
//
// 提供:列目录(懒加载)、读/写文件、新建文件/文件夹、重命名、删除。
// 所有路径为绝对路径;读文件对二进制做保护(只返回文本)。

use std::fs;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use serde::Serialize;

#[derive(Serialize)]
pub struct DirEntry {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
}

/// 列出目录内容,文件夹在前、各自按名称排序(忽略大小写)。
#[tauri::command]
pub fn fs_list_dir(path: String, host: Option<String>) -> Result<Vec<DirEntry>, String> {
    if let Some(h) = host.filter(|s| !s.is_empty()) {
        return crate::remote::list_dir(&h, &path).map(|v| {
            v.into_iter()
                .map(|e| DirEntry {
                    name: e.name,
                    path: e.path,
                    is_dir: e.is_dir,
                })
                .collect()
        });
    }
    let dir = Path::new(&path);
    if !dir.is_dir() {
        return Err("不是目录".into());
    }
    let mut entries: Vec<DirEntry> = Vec::new();
    for entry in fs::read_dir(dir).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let name = entry.file_name().to_string_lossy().to_string();
        let is_dir = entry.file_type().map(|t| t.is_dir()).unwrap_or(false);
        entries.push(DirEntry {
            name,
            path: entry.path().to_string_lossy().to_string(),
            is_dir,
        });
    }
    entries.sort_by(|a, b| {
        b.is_dir
            .cmp(&a.is_dir)
            .then(a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });
    Ok(entries)
}

const MAX_READ_BYTES: u64 = 5 * 1024 * 1024; // 5MB 上限

/// 读取文本文件;过大或疑似二进制时返回错误(前端给出提示)。
#[tauri::command]
pub fn fs_read_file(path: String, host: Option<String>) -> Result<String, String> {
    if let Some(h) = host.filter(|s| !s.is_empty()) {
        return crate::remote::read_file(&h, &path);
    }
    let p = Path::new(&path);
    let meta = fs::metadata(p).map_err(|e| e.to_string())?;
    if meta.len() > MAX_READ_BYTES {
        return Err("文件过大,无法预览(>5MB)".into());
    }
    let bytes = fs::read(p).map_err(|e| e.to_string())?;
    // 含 NUL 字节视为二进制
    if bytes.iter().take(8000).any(|&b| b == 0) {
        return Err("二进制文件,无法预览".into());
    }
    String::from_utf8(bytes).map_err(|_| "非 UTF-8 文本,无法预览".to_string())
}

const MAX_PREVIEW_BYTES: u64 = 50 * 1024 * 1024; // 二进制预览上限 50MB

/// 读文件为 base64(供图片/视频/音频/PDF 等二进制预览)。
#[tauri::command]
pub fn fs_read_bytes(path: String, host: Option<String>) -> Result<String, String> {
    use base64::Engine;
    if let Some(h) = host.filter(|s| !s.is_empty()) {
        return crate::remote::read_bytes_b64(&h, &path, MAX_PREVIEW_BYTES);
    }
    let p = Path::new(&path);
    let meta = fs::metadata(p).map_err(|e| e.to_string())?;
    if meta.len() > MAX_PREVIEW_BYTES {
        return Err("文件过大,无法预览(>50MB)".into());
    }
    let bytes = fs::read(p).map_err(|e| e.to_string())?;
    Ok(base64::engine::general_purpose::STANDARD.encode(bytes))
}

/// 写入文件(保存)。
#[tauri::command]
pub fn fs_write_file(path: String, content: String, host: Option<String>) -> Result<(), String> {
    if let Some(h) = host.filter(|s| !s.is_empty()) {
        return crate::remote::write_file(&h, &path, &content);
    }
    fs::write(Path::new(&path), content).map_err(|e| e.to_string())
}

/// 写入二进制文件(保存):入参为 base64,解码成原始字节后落盘。
/// 供 xlsx 等二进制格式保存(文本 fs_write_file 会破坏字节)。
#[tauri::command]
pub fn fs_write_bytes(path: String, b64: String, host: Option<String>) -> Result<(), String> {
    use base64::Engine;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(b64.as_bytes())
        .map_err(|e| format!("base64 解码失败: {e}"))?;
    if let Some(h) = host.filter(|s| !s.is_empty()) {
        // 远程:经持久会话 stdin 管道(base64 heredoc,二进制安全)写入
        return crate::remote::write_bytes(&h, &path, &bytes);
    }
    fs::write(Path::new(&path), bytes).map_err(|e| e.to_string())
}

/// 在 parent 下新建空文件;若已存在则报错。
#[tauri::command]
pub fn fs_create_file(parent: String, name: String, host: Option<String>) -> Result<String, String> {
    if let Some(h) = host.filter(|s| !s.is_empty()) {
        return crate::remote::create_file(&h, &parent, &name);
    }
    let target = Path::new(&parent).join(&name);
    if target.exists() {
        return Err("同名文件已存在".into());
    }
    fs::write(&target, "").map_err(|e| e.to_string())?;
    Ok(target.to_string_lossy().to_string())
}

/// 在 parent 下新建文件夹。
#[tauri::command]
pub fn fs_create_dir(parent: String, name: String, host: Option<String>) -> Result<String, String> {
    if let Some(h) = host.filter(|s| !s.is_empty()) {
        return crate::remote::create_dir(&h, &parent, &name);
    }
    let target = Path::new(&parent).join(&name);
    if target.exists() {
        return Err("同名文件夹已存在".into());
    }
    fs::create_dir(&target).map_err(|e| e.to_string())?;
    Ok(target.to_string_lossy().to_string())
}

/// 重命名(同目录内改名)。
#[tauri::command]
pub fn fs_rename(path: String, new_name: String, host: Option<String>) -> Result<String, String> {
    if let Some(h) = host.filter(|s| !s.is_empty()) {
        return crate::remote::rename(&h, &path, &new_name);
    }
    let p = PathBuf::from(&path);
    let parent = p.parent().ok_or("无法定位父目录")?;
    let target = parent.join(&new_name);
    if target.exists() {
        return Err("目标名称已存在".into());
    }
    fs::rename(&p, &target).map_err(|e| e.to_string())?;
    Ok(target.to_string_lossy().to_string())
}

/// 删除文件或文件夹(文件夹递归删除)。
#[tauri::command]
pub fn fs_delete(path: String, host: Option<String>) -> Result<(), String> {
    if let Some(h) = host.filter(|s| !s.is_empty()) {
        return crate::remote::delete(&h, &path);
    }
    let p = Path::new(&path);
    if p.is_dir() {
        fs::remove_dir_all(p).map_err(|e| e.to_string())
    } else {
        fs::remove_file(p).map_err(|e| e.to_string())
    }
}

/// 在 Finder 中显示(macOS:open -R 选中该项)。
#[tauri::command]
pub fn fs_reveal(path: String) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .arg("-R")
            .arg(&path)
            .spawn()
            .map_err(|e| e.to_string())?;
        Ok(())
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = path;
        Err("仅 macOS 支持".into())
    }
}

/// 复制文件或文件夹到目标目录下(粘贴);自动避免重名。
#[tauri::command]
pub fn fs_copy(src: String, dest_dir: String, host: Option<String>) -> Result<String, String> {
    if let Some(h) = host.filter(|s| !s.is_empty()) {
        return crate::remote::copy(&h, &src, &dest_dir);
    }
    let src_path = PathBuf::from(&src);
    let name = src_path
        .file_name()
        .ok_or("无法获取源名称")?
        .to_string_lossy()
        .to_string();
    let target = unique_target(Path::new(&dest_dir), &name);
    copy_recursive(&src_path, &target).map_err(|e| e.to_string())?;
    Ok(target.to_string_lossy().to_string())
}

/// 移动文件或文件夹到目标目录下(剪切粘贴);自动避免重名。
#[tauri::command]
pub fn fs_move(src: String, dest_dir: String, host: Option<String>) -> Result<String, String> {
    if let Some(h) = host.filter(|s| !s.is_empty()) {
        return crate::remote::move_to(&h, &src, &dest_dir);
    }
    let src_path = PathBuf::from(&src);
    let name = src_path
        .file_name()
        .ok_or("无法获取源名称")?
        .to_string_lossy()
        .to_string();
    let target = unique_target(Path::new(&dest_dir), &name);
    fs::rename(&src_path, &target).map_err(|e| e.to_string())?;
    Ok(target.to_string_lossy().to_string())
}

/// 生成不重名的目标路径(已存在则追加 " copy"/" copy 2"…)。
fn unique_target(dir: &Path, name: &str) -> PathBuf {
    let mut target = dir.join(name);
    if !target.exists() {
        return target;
    }
    let (stem, ext) = match name.rfind('.') {
        Some(i) if i > 0 => (&name[..i], &name[i..]),
        _ => (name, ""),
    };
    let mut n = 1;
    loop {
        let candidate = if n == 1 {
            format!("{stem} copy{ext}")
        } else {
            format!("{stem} copy {n}{ext}")
        };
        target = dir.join(candidate);
        if !target.exists() {
            return target;
        }
        n += 1;
    }
}

fn copy_recursive(src: &Path, dst: &Path) -> std::io::Result<()> {
    if src.is_dir() {
        fs::create_dir_all(dst)?;
        for entry in fs::read_dir(src)? {
            let entry = entry?;
            copy_recursive(&entry.path(), &dst.join(entry.file_name()))?;
        }
    } else {
        fs::copy(src, dst)?;
    }
    Ok(())
}

/// 在 root 下递归搜索文件名包含 query 的项(忽略大小写)。
/// 跳过常见重目录(.git/node_modules/target 等),限制返回数量。
#[tauri::command]
pub fn fs_search(root: String, query: String, host: Option<String>) -> Result<Vec<DirEntry>, String> {
    if let Some(h) = host.filter(|s| !s.is_empty()) {
        return crate::remote::search_files(&h, &root, query.trim()).map(|v| {
            v.into_iter()
                .map(|e| DirEntry {
                    name: e.name,
                    path: e.path,
                    is_dir: e.is_dir,
                })
                .collect()
        });
    }
    let q = query.trim().to_lowercase();
    if q.is_empty() {
        return Ok(vec![]);
    }
    let mut results: Vec<DirEntry> = Vec::new();
    let mut stack: Vec<PathBuf> = vec![PathBuf::from(&root)];
    const LIMIT: usize = 300;
    // 跳过常见重目录(构建产物、依赖、缓存、虚拟环境等)
    const SKIP: [&str; 12] = [
        ".git",
        "node_modules",
        "target",
        "dist",
        ".next",
        ".venv",
        "venv",
        "__pycache__",
        ".cache",
        "build",
        ".gradle",
        "vendor",
    ];
    // 遍历超时上限:避免在超大目录上长时间阻塞 UI
    let deadline = Instant::now() + Duration::from_millis(700);

    while let Some(dir) = stack.pop() {
        if results.len() >= LIMIT || Instant::now() >= deadline {
            break;
        }
        let rd = match fs::read_dir(&dir) {
            Ok(r) => r,
            Err(_) => continue,
        };
        for entry in rd.flatten() {
            let name = entry.file_name().to_string_lossy().to_string();
            let is_dir = entry.file_type().map(|t| t.is_dir()).unwrap_or(false);
            // 跳过重目录与隐藏目录(. 开头),减少无谓遍历
            if is_dir && (SKIP.contains(&name.as_str()) || name.starts_with('.')) {
                continue;
            }
            if name.to_lowercase().contains(&q) {
                results.push(DirEntry {
                    name,
                    path: entry.path().to_string_lossy().to_string(),
                    is_dir,
                });
                if results.len() >= LIMIT {
                    break;
                }
            }
            if is_dir {
                stack.push(entry.path());
            }
        }
    }
    // 文件夹在前,按路径排序
    results.sort_by(|a, b| {
        b.is_dir
            .cmp(&a.is_dir)
            .then(a.path.to_lowercase().cmp(&b.path.to_lowercase()))
    });
    Ok(results)
}
