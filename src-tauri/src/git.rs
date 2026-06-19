// Git 操作:供「Git」视图使用,用于可视化 agent 对项目的每次改动。
//
// 实现方式:直接调用系统 `git` 命令并解析输出 —— 零外部依赖,不需要安装
// lazygit 等工具。借鉴 lazygit 的交互理念(看着 diff 点一点完成日常流程),
// 但 UI 是我们自己的。
//
// 远程支持:每个命令带 host(空=本地)。远程时通过 SSH 在服务器上执行
// `cd <repo> && git <args>`,于是 Git 视图看到的就是远程仓库的改动。

use std::path::Path;
use std::process::Command;

use serde::Serialize;

use crate::remote::{run_remote, shq};

fn host_opt(h: &Option<String>) -> Option<&str> {
    h.as_deref().filter(|s| !s.is_empty())
}

/// 公开的 git 执行(供 shadow.rs 复用同一套 agent/shell 路由)。
pub fn git_raw(host: &Option<String>, repo: &str, args: &[&str]) -> Result<String, String> {
    git(host, repo, args)
}

/// 执行 git 命令(本地或远程),返回 stdout(失败返回 Err(stderr))。
fn git(host: &Option<String>, repo: &str, args: &[&str]) -> Result<String, String> {
    if let Some(h) = host_opt(host) {
        // 优先走常驻 agent(RPC,一次往返);失败回退 shell。
        if let Ok(v) = crate::agent_rpc::call_background(
            h,
            "git",
            serde_json::json!({ "repo": repo, "args": args }),
        )
        {
            let code = v.get("code").and_then(|x| x.as_i64()).unwrap_or(-1);
            if code == 0 {
                return Ok(v
                    .get("stdout")
                    .and_then(|x| x.as_str())
                    .unwrap_or("")
                    .to_string());
            }
            return Err(v
                .get("stderr")
                .and_then(|x| x.as_str())
                .unwrap_or("git 失败")
                .to_string());
        }
        let joined = args.iter().map(|a| shq(a)).collect::<Vec<_>>().join(" ");
        let cmd = format!("cd {} && git {}", shq(repo), joined);
        return run_remote(h, &cmd).map(|b| String::from_utf8_lossy(&b).to_string());
    }
    let out = Command::new("git")
        .args(args)
        .current_dir(Path::new(repo))
        .output()
        .map_err(|e| format!("无法执行 git: {e}"))?;
    if out.status.success() {
        Ok(String::from_utf8_lossy(&out.stdout).to_string())
    } else {
        Err(String::from_utf8_lossy(&out.stderr).to_string())
    }
}

#[derive(Serialize)]
pub struct GitFile {
    pub path: String,
    pub work: String,
    pub index: String,
    pub staged: bool,
    pub unstaged: bool,
    pub untracked: bool,
}

#[derive(Serialize)]
pub struct GitStatus {
    pub is_repo: bool,
    pub branch: String,
    pub ahead: i32,
    pub behind: i32,
    pub files: Vec<GitFile>,
}

/// 是否为 git 仓库。
#[tauri::command]
pub async fn git_is_repo(repo: String, host: Option<String>) -> bool {
    crate::blocking::run(move || {
        Ok(git(&host, &repo, &["rev-parse", "--is-inside-work-tree"])
            .map(|s| s.trim() == "true")
            .unwrap_or(false))
    })
    .await
    .unwrap_or(false)
}

/// 仓库状态:分支、ahead/behind、变更文件列表(porcelain v1 + 分支头)。
#[tauri::command]
pub async fn git_status(repo: String, host: Option<String>) -> Result<GitStatus, String> {
    crate::blocking::run(move || {
        if !git(&host, &repo, &["rev-parse", "--is-inside-work-tree"])
            .map(|s| s.trim() == "true")
            .unwrap_or(false)
        {
            return Ok(GitStatus {
                is_repo: false,
                branch: String::new(),
                ahead: 0,
                behind: 0,
                files: vec![],
            });
        }
        let raw = git(&host, &repo, &["status", "--porcelain=v1", "--branch"])?;

        let mut branch = String::new();
        let mut ahead = 0;
        let mut behind = 0;
        let mut files: Vec<GitFile> = Vec::new();

        for line in raw.lines() {
            if let Some(rest) = line.strip_prefix("## ") {
                let name_part = rest.split("...").next().unwrap_or(rest);
                branch = name_part.trim().to_string();
                if let Some(bracket) = rest.find('[') {
                    let inside = &rest[bracket + 1..rest.len().saturating_sub(1)];
                    for tok in inside.split(',') {
                        let tok = tok.trim();
                        if let Some(n) = tok.strip_prefix("ahead ") {
                            ahead = n.trim().parse().unwrap_or(0);
                        } else if let Some(n) = tok.strip_prefix("behind ") {
                            behind = n.trim().parse().unwrap_or(0);
                        }
                    }
                }
                continue;
            }
            if line.len() < 3 {
                continue;
            }
            let index = &line[0..1];
            let work = &line[1..2];
            let mut path = line[3..].to_string();
            if let Some(idx) = path.find(" -> ") {
                path = path[idx + 4..].to_string();
            }
            let untracked = index == "?" && work == "?";
            let staged = index != " " && index != "?";
            let unstaged = work != " " && work != "?";
            files.push(GitFile {
                path,
                work: work.to_string(),
                index: index.to_string(),
                staged,
                unstaged: unstaged || untracked,
                untracked,
            });
        }

        Ok(GitStatus {
            is_repo: true,
            branch,
            ahead,
            behind,
            files,
        })
    })
    .await
}

/// 单文件 diff。staged=true 看暂存区 diff,否则看工作区 diff;
/// 未跟踪文件返回其全部内容作为新增。
#[tauri::command]
pub async fn git_diff_file(
    repo: String,
    path: String,
    staged: bool,
    untracked: bool,
    host: Option<String>,
) -> Result<String, String> {
    crate::blocking::run(move || {
        if untracked {
            // 未跟踪:no-index 对比 /dev/null。有差异时退出码为 1(正常),
            // 故远程加 `; true`、本地忽略退出码。
            if let Some(h) = host_opt(&host) {
                let cmd = format!(
                    "cd {} && git diff --no-index --no-color -- /dev/null {} 2>/dev/null; true",
                    shq(&repo),
                    shq(&path)
                );
                return run_remote(h, &cmd).map(|b| String::from_utf8_lossy(&b).to_string());
            }
            let out = Command::new("git")
                .args(["diff", "--no-index", "--", "/dev/null", &path])
                .current_dir(Path::new(&repo))
                .output()
                .map_err(|e| e.to_string())?;
            return Ok(String::from_utf8_lossy(&out.stdout).to_string());
        }
        let mut args = vec!["diff"];
        if staged {
            args.push("--staged");
        }
        args.push("--");
        args.push(&path);
        git(&host, &repo, &args)
    })
    .await
}

#[tauri::command]
pub async fn git_stage(repo: String, path: String, host: Option<String>) -> Result<(), String> {
    crate::blocking::run(move || git(&host, &repo, &["add", "--", &path]).map(|_| ())).await
}

#[tauri::command]
pub async fn git_unstage(repo: String, path: String, host: Option<String>) -> Result<(), String> {
    crate::blocking::run(move || {
        git(&host, &repo, &["restore", "--staged", "--", &path]).map(|_| ())
    })
    .await
}

#[tauri::command]
pub async fn git_stage_all(repo: String, host: Option<String>) -> Result<(), String> {
    crate::blocking::run(move || git(&host, &repo, &["add", "-A"]).map(|_| ())).await
}

#[tauri::command]
pub async fn git_unstage_all(repo: String, host: Option<String>) -> Result<(), String> {
    crate::blocking::run(move || git(&host, &repo, &["reset"]).map(|_| ())).await
}

/// 丢弃单个文件的工作区改动(未跟踪文件则删除)。
#[tauri::command]
pub async fn git_discard(
    repo: String,
    path: String,
    untracked: bool,
    host: Option<String>,
) -> Result<(), String> {
    crate::blocking::run(move || {
        if untracked {
            if let Some(h) = host_opt(&host) {
                let full = format!("{}/{}", repo.trim_end_matches('/'), path);
                return crate::remote::delete(h, &full);
            }
            let p = Path::new(&repo).join(&path);
            if p.is_dir() {
                std::fs::remove_dir_all(p).map_err(|e| e.to_string())
            } else {
                std::fs::remove_file(p).map_err(|e| e.to_string())
            }
        } else {
            git(&host, &repo, &["checkout", "--", &path]).map(|_| ())
        }
    })
    .await
}

#[tauri::command]
pub async fn git_commit(
    repo: String,
    message: String,
    host: Option<String>,
) -> Result<String, String> {
    crate::blocking::run(move || {
        if message.trim().is_empty() {
            return Err("提交信息不能为空".into());
        }
        git(&host, &repo, &["commit", "-m", &message])
    })
    .await
}

#[tauri::command]
pub async fn git_pull(repo: String, host: Option<String>) -> Result<String, String> {
    crate::blocking::run(move || git(&host, &repo, &["pull", "--ff-only"])).await
}

#[tauri::command]
pub async fn git_push(repo: String, host: Option<String>) -> Result<String, String> {
    crate::blocking::run(move || git(&host, &repo, &["push"])).await
}

#[tauri::command]
pub async fn git_fetch(repo: String, host: Option<String>) -> Result<String, String> {
    crate::blocking::run(move || git(&host, &repo, &["fetch", "--all", "--prune"])).await
}

#[derive(Serialize)]
pub struct GitBranch {
    pub name: String,
    pub current: bool,
    pub upstream: String,
    pub remote: bool,
}

#[tauri::command]
pub async fn git_branches(repo: String, host: Option<String>) -> Result<Vec<GitBranch>, String> {
    crate::blocking::run(move || {
        let raw = git(
            &host,
            &repo,
            &[
                "branch",
                "-a",
                "--format=%(HEAD)\t%(refname:short)\t%(upstream:short)",
            ],
        )?;
        let mut out = Vec::new();
        for line in raw.lines() {
            let parts: Vec<&str> = line.split('\t').collect();
            if parts.len() < 2 {
                continue;
            }
            let name = parts[1].to_string();
            if name.contains("HEAD ->") || name.ends_with("/HEAD") {
                continue;
            }
            let remote = name.starts_with("remotes/") || name.starts_with("origin/");
            out.push(GitBranch {
                current: parts[0] == "*",
                name: name.trim_start_matches("remotes/").to_string(),
                upstream: parts.get(2).unwrap_or(&"").to_string(),
                remote,
            });
        }
        Ok(out)
    })
    .await
}

#[tauri::command]
pub async fn git_checkout(
    repo: String,
    branch: String,
    host: Option<String>,
) -> Result<String, String> {
    crate::blocking::run(move || git(&host, &repo, &["checkout", &branch])).await
}

#[tauri::command]
pub async fn git_create_branch(
    repo: String,
    name: String,
    host: Option<String>,
) -> Result<String, String> {
    crate::blocking::run(move || git(&host, &repo, &["checkout", "-b", &name])).await
}

#[derive(Serialize)]
pub struct GitCommit {
    pub hash: String,
    pub short: String,
    pub author: String,
    pub date: String,
    pub subject: String,
}

#[tauri::command]
pub async fn git_log(
    repo: String,
    limit: u32,
    rev: Option<String>,
    host: Option<String>,
) -> Result<Vec<GitCommit>, String> {
    crate::blocking::run(move || {
        let fmt = "%H%x1f%h%x1f%an%x1f%ar%x1f%s";
        let n = format!("-{}", limit.clamp(1, 500));
        let pretty = format!("--pretty=format:{fmt}");
        let mut args = vec!["log", &n, &pretty];
        let rev_str;
        if let Some(r) = &rev {
            if !r.trim().is_empty() {
                rev_str = r.clone();
                args.push(&rev_str);
            }
        }
        let raw = git(&host, &repo, &args)?;
        let mut out = Vec::new();
        for line in raw.lines() {
            let p: Vec<&str> = line.split('\u{1f}').collect();
            if p.len() < 5 {
                continue;
            }
            out.push(GitCommit {
                hash: p[0].to_string(),
                short: p[1].to_string(),
                author: p[2].to_string(),
                date: p[3].to_string(),
                subject: p[4].to_string(),
            });
        }
        Ok(out)
    })
    .await
}

/// 某次提交的 diff(用于历史查看)。
#[tauri::command]
pub async fn git_show(repo: String, hash: String, host: Option<String>) -> Result<String, String> {
    crate::blocking::run(move || git(&host, &repo, &["show", "--no-color", &hash])).await
}

#[derive(Serialize)]
pub struct GitStash {
    pub index: u32,
    pub message: String,
}

#[tauri::command]
pub async fn git_stash_list(repo: String, host: Option<String>) -> Result<Vec<GitStash>, String> {
    crate::blocking::run(move || {
        let raw = git(&host, &repo, &["stash", "list", "--format=%gd%x1f%gs"])?;
        let mut out = Vec::new();
        for (i, line) in raw.lines().enumerate() {
            let msg = line.split('\u{1f}').nth(1).unwrap_or(line);
            out.push(GitStash {
                index: i as u32,
                message: msg.to_string(),
            });
        }
        Ok(out)
    })
    .await
}

#[tauri::command]
pub async fn git_stash_push(
    repo: String,
    message: String,
    host: Option<String>,
) -> Result<String, String> {
    crate::blocking::run(move || {
        if message.trim().is_empty() {
            git(&host, &repo, &["stash", "push"])
        } else {
            git(&host, &repo, &["stash", "push", "-m", &message])
        }
    })
    .await
}

#[tauri::command]
pub async fn git_stash_apply(
    repo: String,
    index: u32,
    host: Option<String>,
) -> Result<String, String> {
    crate::blocking::run(move || {
        git(
            &host,
            &repo,
            &["stash", "apply", &format!("stash@{{{index}}}")],
        )
    })
    .await
}

#[tauri::command]
pub async fn git_stash_pop(
    repo: String,
    index: u32,
    host: Option<String>,
) -> Result<String, String> {
    crate::blocking::run(move || {
        git(
            &host,
            &repo,
            &["stash", "pop", &format!("stash@{{{index}}}")],
        )
    })
    .await
}

#[tauri::command]
pub async fn git_stash_drop(
    repo: String,
    index: u32,
    host: Option<String>,
) -> Result<String, String> {
    crate::blocking::run(move || {
        git(
            &host,
            &repo,
            &["stash", "drop", &format!("stash@{{{index}}}")],
        )
    })
    .await
}
