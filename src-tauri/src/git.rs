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

/// 按位置读 http 代理:host 空=本地(config.http_proxy);否则取该远程连接的 http_proxy。
/// 本地/远程代理常不同,各自独立存储,不互相同步。
fn http_proxy_for(host: &Option<String>) -> String {
    let cfg = match crate::config::load_config() {
        Ok(c) => c,
        Err(_) => return String::new(),
    };
    match host_opt(host) {
        None => cfg.http_proxy,
        Some(h) => cfg
            .connections
            .iter()
            .find(|c| c.host == h)
            .map(|c| c.http_proxy.clone())
            .unwrap_or_default(),
    }
}

/// 执行 git 命令(本地或远程),返回 stdout(失败返回 Err(stderr))。
/// 周期性/后台 git(status、log 等)默认走后台 lane,见 `git`;
/// 用户**主动点击**触发的(看 diff、stage、discard…)走 `git_ix`(交互 lane),
/// 不与频繁的 status/shadow/watch 在后台 lane 排队,点开即出、不卡顿。
fn git(host: &Option<String>, repo: &str, args: &[&str]) -> Result<String, String> {
    git_lane(host, repo, args, false)
}

/// 交互 lane 版本:供用户主动触发的 git 操作使用(点 diff、stage/unstage、discard、commit)。
fn git_ix(host: &Option<String>, repo: &str, args: &[&str]) -> Result<String, String> {
    git_lane(host, repo, args, true)
}

fn git_lane(
    host: &Option<String>,
    repo: &str,
    args: &[&str],
    interactive: bool,
) -> Result<String, String> {
    if let Some(h) = host_opt(host) {
        // 优先走常驻 agent(RPC,一次往返);失败回退 shell。
        // interactive=true 走 Interactive lane(只有文件树/打开文件,基本空闲),
        // 否则走 Background lane(与 watch/shadow/status 共用)。
        let rpc = if interactive {
            crate::agent_rpc::call(h, "git", serde_json::json!({ "repo": repo, "args": args }))
        } else {
            crate::agent_rpc::call_background(
                h,
                "git",
                serde_json::json!({ "repo": repo, "args": args }),
            )
        };
        if let Ok(v) = rpc {
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
        // 远程:把该远程的代理作为环境变量前缀注入(国内远端 push GitHub 常需代理)
        let proxy = http_proxy_for(host);
        let env_prefix = if proxy.is_empty() {
            String::new()
        } else {
            let p = shq(&proxy);
            format!("http_proxy={p} https_proxy={p} HTTP_PROXY={p} HTTPS_PROXY={p} ")
        };
        let cmd = format!("cd {} && {env_prefix}git {}", shq(repo), joined);
        return run_remote(h, &cmd).map(|b| String::from_utf8_lossy(&b).to_string());
    }
    let mut c = Command::new("git");
    c.args(args).current_dir(Path::new(repo));
    // 本地:有代理则注入 http_proxy/https_proxy 环境变量(只影响 Linco 起的 git)
    let proxy = http_proxy_for(host);
    if !proxy.is_empty() {
        c.env("http_proxy", &proxy)
            .env("https_proxy", &proxy)
            .env("HTTP_PROXY", &proxy)
            .env("HTTPS_PROXY", &proxy);
    }
    crate::proc_ext::no_window(&mut c);
    let out = c
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
        // -uall:把未跟踪「目录」展开到文件级。默认 git 会把整个新目录折叠成一条
        // `?? dir/`,导致 Git 视图只看得到「文件夹有改动」却展不开看里面具体哪些文件。
        let raw = git(
            &host,
            &repo,
            &["status", "--porcelain=v1", "--branch", "-uall"],
        )?;

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
            // 未跟踪:no-index 对比 /dev/null。有差异时退出码为 1(正常,不当失败)。
            // 走交互 lane 的 agent op_git(与点 diff 同一条快路径);本地直接跑。
            if host_opt(&host).is_some() {
                // op_git 返回 stdout 不看退出码,故 no-index 的 code=1 不影响取 diff
                return git_ix(
                    &host,
                    &repo,
                    &["diff", "--no-index", "--no-color", "--", "/dev/null", &path],
                )
                .or_else(|_| {
                    // 回退:shell(no-index code=1,加 ; true)
                    let h = host_opt(&host).unwrap();
                    let cmd = format!(
                        "cd {} && git diff --no-index --no-color -- /dev/null {} 2>/dev/null; true",
                        shq(&repo),
                        shq(&path)
                    );
                    run_remote(h, &cmd).map(|b| String::from_utf8_lossy(&b).to_string())
                });
            }
            let mut c = Command::new("git");
            c.args(["diff", "--no-index", "--", "/dev/null", &path])
                .current_dir(Path::new(&repo));
            crate::proc_ext::no_window(&mut c);
            let out = c.output().map_err(|e| e.to_string())?;
            return Ok(String::from_utf8_lossy(&out.stdout).to_string());
        }
        let mut args = vec!["diff"];
        if staged {
            args.push("--staged");
        }
        args.push("--");
        args.push(&path);
        git_ix(&host, &repo, &args)
    })
    .await
}

#[tauri::command]
pub async fn git_stage(repo: String, path: String, host: Option<String>) -> Result<(), String> {
    crate::blocking::run(move || git_ix(&host, &repo, &["add", "--", &path]).map(|_| ())).await
}

#[tauri::command]
pub async fn git_unstage(repo: String, path: String, host: Option<String>) -> Result<(), String> {
    crate::blocking::run(move || {
        git_ix(&host, &repo, &["restore", "--staged", "--", &path]).map(|_| ())
    })
    .await
}

#[tauri::command]
pub async fn git_stage_all(repo: String, host: Option<String>) -> Result<(), String> {
    crate::blocking::run(move || git_ix(&host, &repo, &["add", "-A"]).map(|_| ())).await
}

#[tauri::command]
pub async fn git_unstage_all(repo: String, host: Option<String>) -> Result<(), String> {
    crate::blocking::run(move || git_ix(&host, &repo, &["reset"]).map(|_| ())).await
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
            git_ix(&host, &repo, &["checkout", "--", &path]).map(|_| ())
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

/// 远端仓库信息:origin 的 URL(供 Git 视图在分支旁显示上游仓库)。
#[derive(Serialize)]
pub struct GitRemoteInfo {
    /// origin 的 URL(如 https://github.com/user/repo.git);拿不到为空
    pub url: String,
    /// 从 URL 提取的 owner/repo(如 user/repo);拿不到为空
    pub slug: String,
}

#[tauri::command]
pub async fn git_remote_url(repo: String, host: Option<String>) -> Result<GitRemoteInfo, String> {
    crate::blocking::run(move || {
        let url = git(&host, &repo, &["remote", "get-url", "origin"])
            .map(|s| s.trim().to_string())
            .unwrap_or_default();
        let slug = remote_slug(&url);
        Ok(GitRemoteInfo { url, slug })
    })
    .await
}

/// 从 git remote URL 提取 owner/repo(支持 https 与 ssh 两种形式)。
fn remote_slug(url: &str) -> String {
    let u = url.trim().trim_end_matches(".git");
    // git@github.com:owner/repo  或  https://github.com/owner/repo
    let tail = if let Some(idx) = u.find('@') {
        // ssh: 取 ':' 之后
        u[idx..].split_once(':').map(|(_, r)| r).unwrap_or("")
    } else if let Some(idx) = u.find("://") {
        // https: 取 host 之后的第一个 '/' 之后
        let after = &u[idx + 3..];
        after.split_once('/').map(|(_, r)| r).unwrap_or("")
    } else {
        ""
    };
    tail.to_string()
}

/// 把任意 git remote URL 归一化成 smart-HTTP 探测地址:
/// `<https-base>/info/refs?service=git-upload-pack`。ssh(git@host:owner/repo)→ https。
fn probe_url(url: &str) -> Option<String> {
    let u = url.trim();
    if u.is_empty() {
        return None;
    }
    let base = if let Some(rest) = u.strip_prefix("git@") {
        // git@github.com:owner/repo(.git) → https://github.com/owner/repo
        let (host, path) = rest.split_once(':')?;
        format!("https://{host}/{}", path.trim_start_matches('/'))
    } else if u.starts_with("ssh://") {
        // ssh://git@github.com/owner/repo → https://github.com/owner/repo
        let rest = &u["ssh://".len()..];
        let rest = rest.split_once('@').map(|(_, r)| r).unwrap_or(rest);
        format!("https://{rest}")
    } else if u.starts_with("http://") || u.starts_with("https://") {
        u.to_string()
    } else {
        return None;
    };
    let base = base.trim_end_matches('/');
    Some(format!("{base}/info/refs?service=git-upload-pack"))
}

/// Git 连通性测试结果(供 Git 视图显示 200 绿点等)。
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitConnTest {
    /// 是否连通(HTTP 2xx / 或鉴权前可达)
    pub ok: bool,
    /// HTTP 状态码(拿不到为 None,如 DNS/代理失败)
    pub status: Option<u16>,
    /// 提示信息(成功/错误原因)
    pub message: String,
    /// 往返耗时 ms
    pub latency_ms: u64,
    /// 被探测的仓库 slug(owner/repo)
    pub slug: String,
}

/// 测试 origin 仓库的连通性:打 smart-HTTP `info/refs`,返回真实 HTTP 状态。
/// 本地用 reqwest(带配置的 http 代理 + token Basic 鉴权);远程经 SSH 用 curl。
#[tauri::command]
pub async fn git_test_connection(repo: String, host: Option<String>) -> Result<GitConnTest, String> {
    crate::blocking::run(move || {
        let url = git(&host, &repo, &["remote", "get-url", "origin"])
            .map(|s| s.trim().to_string())
            .unwrap_or_default();
        let slug = remote_slug(&url);
        let probe = match probe_url(&url) {
            Some(p) => p,
            None => {
                return Ok(GitConnTest {
                    ok: false,
                    status: None,
                    message: if url.is_empty() {
                        "未配置 origin 远程仓库".into()
                    } else {
                        format!("无法识别的 remote URL: {url}")
                    },
                    latency_ms: 0,
                    slug,
                })
            }
        };
        let cfg = crate::config::load_config().unwrap_or_default();
        let proxy = http_proxy_for(&host);
        let start = std::time::Instant::now();
        let result = if let Some(h) = host_opt(&host) {
            test_remote(h, &probe, &cfg, &proxy)
        } else {
            test_local(&probe, &cfg, &proxy)
        };
        let latency_ms = start.elapsed().as_millis() as u64;
        Ok(match result {
            Ok(code) => GitConnTest {
                ok: (200..400).contains(&code) || code == 401 || code == 403,
                status: Some(code),
                message: conn_message(code),
                latency_ms,
                slug,
            },
            Err(e) => GitConnTest {
                ok: false,
                status: None,
                message: format!("连接失败: {e}"),
                latency_ms,
                slug,
            },
        })
    })
    .await
}

/// 状态码 → 人类可读提示。
fn conn_message(code: u16) -> String {
    match code {
        200..=299 => format!("连接正常({code})"),
        401 => "可达,但凭据无效/缺失(401)".into(),
        403 => "可达,但被拒绝(403)".into(),
        404 => "仓库不存在或无权限(404)".into(),
        407 => "代理需要认证(407)".into(),
        c => format!("HTTP {c}"),
    }
}

/// 本地探测:reqwest GET info/refs,带 http 代理 + token Basic 鉴权。
fn test_local(probe: &str, cfg: &crate::config::AppConfig, proxy: &str) -> Result<u16, String> {
    let mut builder = reqwest::blocking::Client::builder()
        .timeout(std::time::Duration::from_secs(20))
        .user_agent("git/2.0 linco");
    if !proxy.trim().is_empty() {
        let p = reqwest::Proxy::all(proxy.trim()).map_err(|e| e.to_string())?;
        builder = builder.proxy(p);
    }
    let client = builder.build().map_err(|e| e.to_string())?;
    let mut req = client.get(probe);
    let user = cfg.github_user.trim();
    let token = cfg.github_token.trim();
    if !token.is_empty() {
        // GitHub 接受 user 任意 + token 作密码;user 空则用 token 作 user
        let u = if user.is_empty() { token } else { user };
        req = req.basic_auth(u, Some(token));
    }
    let resp = req.send().map_err(|e| e.to_string())?;
    Ok(resp.status().as_u16())
}

/// 远程探测:经 SSH 在远端用 curl 打 info/refs(带代理 + 凭据)。
fn test_remote(
    host: &str,
    probe: &str,
    cfg: &crate::config::AppConfig,
    proxy: &str,
) -> Result<u16, String> {
    let mut cmd = String::from("curl -s -o /dev/null -m 20 -w '%{http_code}'");
    if !proxy.trim().is_empty() {
        cmd.push_str(&format!(" -x {}", shq(proxy.trim())));
    }
    let user = cfg.github_user.trim();
    let token = cfg.github_token.trim();
    if !token.is_empty() {
        let u = if user.is_empty() { token } else { user };
        cmd.push_str(&format!(" -u {}", shq(&format!("{u}:{token}"))));
    }
    cmd.push_str(&format!(" {}", shq(probe)));
    let out = run_remote(host, &cmd)?;
    let s = String::from_utf8_lossy(&out);
    s.trim()
        .parse::<u16>()
        .map_err(|_| format!("远端 curl 无有效状态: {}", s.trim()))
}

/// 本地应用 GitHub 凭据:写 ~/.git-credentials + 设 credential.helper=store。
/// 在保存 Git 设置时调用(用户名/token 非空才写)。
#[tauri::command]
pub async fn git_apply_credentials() -> Result<(), String> {
    crate::blocking::run(move || {
        let cfg = crate::config::load_config()?;
        let user = cfg.github_user.trim().to_string();
        let token = cfg.github_token.trim().to_string();
        if user.is_empty() || token.is_empty() {
            return Ok(()); // 没填则不动
        }
        // 设 credential.helper=store(全局)
        let mut c = Command::new("git");
        c.args(["config", "--global", "credential.helper", "store"]);
        crate::proc_ext::no_window(&mut c);
        let _ = c.output();
        // 写 ~/.git-credentials(https://user:token@github.com),去重同 host 旧行
        let home = crate::config::home_dir()?;
        let path = home.join(".git-credentials");
        let line = format!("https://{user}:{token}@github.com");
        let existing = std::fs::read_to_string(&path).unwrap_or_default();
        let mut kept: Vec<String> = existing
            .lines()
            .filter(|l| !l.contains("@github.com"))
            .map(|s| s.to_string())
            .collect();
        kept.push(line);
        std::fs::write(&path, kept.join("\n") + "\n").map_err(|e| e.to_string())?;
        // 权限 600(避免 token 泄露)
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600));
        }
        Ok(())
    })
    .await
}

/// 同步 GitHub 凭据到远程主机:写远端 ~/.git-credentials + credential.helper=store。
/// 注意:**不同步代理** —— 本地/远程代理常不同,各自在 Git 界面独立配置。
#[tauri::command]
pub async fn sync_git_to_remote(host: String) -> Result<(), String> {
    crate::blocking::run(move || {
        let cfg = crate::config::load_config()?;
        let user = cfg.github_user.trim().to_string();
        let token = cfg.github_token.trim().to_string();
        if user.is_empty() || token.is_empty() {
            return Err("请先填写 GitHub 用户名和 token".into());
        }
        let line = format!("https://{user}:{token}@github.com");
        // 去掉远端旧 github 行,追加新行,设权限 600 + helper=store
        let sh = format!(
            "git config --global credential.helper store; \
             f=~/.git-credentials; touch \"$f\"; \
             grep -v '@github.com' \"$f\" > \"$f.tmp\" 2>/dev/null || true; \
             mv \"$f.tmp\" \"$f\" 2>/dev/null || true; \
             echo {} >> \"$f\"; chmod 600 \"$f\"",
            shq(&line)
        );
        run_remote(&host, &sh).map(|_| ())
    })
    .await
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
