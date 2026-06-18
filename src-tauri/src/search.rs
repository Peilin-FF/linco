// 全局内容搜索与替换(类似 VS Code 的 Cmd+Shift+F)。
//
// 支持:大小写敏感、全词匹配、正则;include/exclude glob 过滤;
// 按文件分组返回匹配(行号、行内容、匹配区间);单处/全部替换。

use std::fs;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use regex::{Regex, RegexBuilder};
use serde::Serialize;

#[derive(Serialize)]
pub struct MatchLine {
    pub line: usize,        // 1-based 行号
    pub text: String,       // 该行内容
    pub ranges: Vec<[usize; 2]>, // 匹配在行内的 [起, 止) 字符区间(按 char)
}

#[derive(Serialize)]
pub struct FileMatches {
    pub path: String,
    pub matches: Vec<MatchLine>,
}

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
const MAX_FILES: usize = 2000;
const MAX_MATCHES: usize = 3000;
const MAX_FILE_BYTES: u64 = 2 * 1024 * 1024;

fn build_regex(
    query: &str,
    case_sensitive: bool,
    whole_word: bool,
    is_regex: bool,
) -> Result<Regex, String> {
    let pattern = if is_regex {
        query.to_string()
    } else {
        regex::escape(query)
    };
    let pattern = if whole_word {
        format!(r"\b{pattern}\b")
    } else {
        pattern
    };
    RegexBuilder::new(&pattern)
        .case_insensitive(!case_sensitive)
        .build()
        .map_err(|e| format!("正则错误: {e}"))
}

/// 把逗号分隔的 glob 模式编译成一个正则(任一匹配即命中)。
/// 支持 `*`(单层任意)、`**`(跨层)、`?`(单字符)。空模式返回 None。
fn build_glob_regex(patterns: &str) -> Option<Regex> {
    let trimmed = patterns.trim();
    if trimmed.is_empty() {
        return None;
    }
    let mut alts: Vec<String> = Vec::new();
    for raw in trimmed.split(',') {
        let p = raw.trim();
        if p.is_empty() {
            continue;
        }
        // 形如 "*.ts" 的裸模式,补一个跨层变体,允许匹配任意深度
        let variants: Vec<String> = if p.contains('/') {
            vec![p.to_string()]
        } else {
            vec![p.to_string(), format!("**/{p}")]
        };
        for v in variants {
            alts.push(glob_to_regex(&v));
        }
    }
    if alts.is_empty() {
        return None;
    }
    let pattern = format!("^(?:{})$", alts.join("|"));
    Regex::new(&pattern).ok()
}

fn glob_to_regex(glob: &str) -> String {
    let mut re = String::new();
    let bytes: Vec<char> = glob.chars().collect();
    let mut i = 0;
    while i < bytes.len() {
        let c = bytes[i];
        match c {
            '*' => {
                if i + 1 < bytes.len() && bytes[i + 1] == '*' {
                    // ** 跨目录
                    re.push_str(".*");
                    i += 1;
                    // 跳过紧随的 /
                    if i + 1 < bytes.len() && bytes[i + 1] == '/' {
                        i += 1;
                    }
                } else {
                    // * 单层(不跨 /)
                    re.push_str("[^/]*");
                }
            }
            '?' => re.push_str("[^/]"),
            '.' | '+' | '(' | ')' | '|' | '^' | '$' | '{' | '}' | '[' | ']'
            | '\\' => {
                re.push('\\');
                re.push(c);
            }
            _ => re.push(c),
        }
        i += 1;
    }
    re
}

#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub fn search_content(
    root: String,
    query: String,
    case_sensitive: bool,
    whole_word: bool,
    is_regex: bool,
    include: String,
    exclude: String,
    host: Option<String>,
) -> Result<Vec<FileMatches>, String> {
    if query.is_empty() {
        return Ok(vec![]);
    }
    let re = build_regex(&query, case_sensitive, whole_word, is_regex)?;

    // 远程:用 grep 拿到 path:line:text,再用同一正则算行内匹配区间。
    // (include/exclude 暂只在本地生效;远程靠 grep --exclude-dir 跳过重目录)
    if let Some(h) = host.as_deref().filter(|s| !s.is_empty()) {
        let rows = crate::remote::grep_content(
            h,
            &root,
            &query,
            case_sensitive,
            is_regex || whole_word,
        )?;
        let mut files: Vec<FileMatches> = Vec::new();
        for (path, line_no, text) in rows {
            let mut ranges: Vec<[usize; 2]> = Vec::new();
            for m in re.find_iter(&text) {
                let start = text[..m.start()].chars().count();
                let end = text[..m.end()].chars().count();
                ranges.push([start, end]);
            }
            if ranges.is_empty() {
                continue;
            }
            let ml = MatchLine {
                line: line_no,
                text: text.chars().take(400).collect(),
                ranges,
            };
            if let Some(f) = files.iter_mut().find(|f| f.path == path) {
                f.matches.push(ml);
            } else {
                files.push(FileMatches {
                    path,
                    matches: vec![ml],
                });
            }
        }
        files.sort_by(|a, b| a.path.to_lowercase().cmp(&b.path.to_lowercase()));
        return Ok(files);
    }

    let inc = build_glob_regex(&include);
    let exc = build_glob_regex(&exclude);
    let root_path = PathBuf::from(&root);

    let mut out: Vec<FileMatches> = Vec::new();
    let mut total_matches = 0usize;
    let mut file_count = 0usize;
    let mut stack: Vec<PathBuf> = vec![root_path.clone()];
    let deadline = Instant::now() + Duration::from_secs(3);

    while let Some(dir) = stack.pop() {
        if Instant::now() >= deadline || total_matches >= MAX_MATCHES {
            break;
        }
        let rd = match fs::read_dir(&dir) {
            Ok(r) => r,
            Err(_) => continue,
        };
        for entry in rd.flatten() {
            let path = entry.path();
            let name = entry.file_name().to_string_lossy().to_string();
            let is_dir = entry.file_type().map(|t| t.is_dir()).unwrap_or(false);
            if is_dir {
                if SKIP.contains(&name.as_str()) || name.starts_with('.') {
                    continue;
                }
                stack.push(path);
                continue;
            }
            if file_count >= MAX_FILES || total_matches >= MAX_MATCHES {
                break;
            }
            // 相对路径用于 glob 过滤
            let rel = path
                .strip_prefix(&root_path)
                .unwrap_or(&path)
                .to_string_lossy()
                .to_string();
            if let Some(inc) = &inc {
                if !inc.is_match(&rel) {
                    continue;
                }
            }
            if let Some(exc) = &exc {
                if exc.is_match(&rel) {
                    continue;
                }
            }
            // 跳过过大/二进制文件
            if let Ok(meta) = fs::metadata(&path) {
                if meta.len() > MAX_FILE_BYTES {
                    continue;
                }
            }
            let content = match fs::read(&path) {
                Ok(b) => b,
                Err(_) => continue,
            };
            if content.iter().take(8000).any(|&b| b == 0) {
                continue; // 二进制
            }
            let text = match String::from_utf8(content) {
                Ok(t) => t,
                Err(_) => continue,
            };

            let mut matches: Vec<MatchLine> = Vec::new();
            for (i, line) in text.lines().enumerate() {
                let mut ranges: Vec<[usize; 2]> = Vec::new();
                for m in re.find_iter(line) {
                    // 字节偏移转 char 偏移
                    let start = line[..m.start()].chars().count();
                    let end = line[..m.end()].chars().count();
                    ranges.push([start, end]);
                }
                if !ranges.is_empty() {
                    matches.push(MatchLine {
                        line: i + 1,
                        text: line.chars().take(400).collect(),
                        ranges,
                    });
                    total_matches += 1;
                    if total_matches >= MAX_MATCHES {
                        break;
                    }
                }
            }
            if !matches.is_empty() {
                file_count += 1;
                out.push(FileMatches {
                    path: path.to_string_lossy().to_string(),
                    matches,
                });
            }
        }
    }

    out.sort_by(|a, b| a.path.to_lowercase().cmp(&b.path.to_lowercase()));
    Ok(out)
}

/// 在单个文件中替换所有匹配,返回替换次数。
#[tauri::command]
pub fn replace_in_file(
    path: String,
    query: String,
    replacement: String,
    case_sensitive: bool,
    whole_word: bool,
    is_regex: bool,
    host: Option<String>,
) -> Result<usize, String> {
    let re = build_regex(&query, case_sensitive, whole_word, is_regex)?;
    // 远程:读远端文件 → 本地正则替换 → 写回远端。
    if let Some(h) = host.as_deref().filter(|s| !s.is_empty()) {
        let text = crate::remote::read_file(h, &path)?;
        let count = re.find_iter(&text).count();
        if count == 0 {
            return Ok(0);
        }
        let replaced = re.replace_all(&text, replacement.as_str());
        crate::remote::write_file(h, &path, replaced.as_ref())?;
        return Ok(count);
    }
    let text = fs::read_to_string(&path).map_err(|e| e.to_string())?;
    let count = re.find_iter(&text).count();
    if count == 0 {
        return Ok(0);
    }
    let replaced = re.replace_all(&text, replacement.as_str());
    fs::write(Path::new(&path), replaced.as_ref()).map_err(|e| e.to_string())?;
    Ok(count)
}
