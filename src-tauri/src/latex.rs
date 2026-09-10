use std::collections::HashMap;
use std::env;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use base64::engine::general_purpose::STANDARD;
use base64::Engine;
use serde::Serialize;
use tauri::{AppHandle, Manager};

#[path = "latex_merge.rs"]
mod merge;

#[derive(Serialize)]
pub struct OverleafProjectInfo {
    pub connected: bool,
    pub remote_name: String,
    pub remote_url: String,
    pub project_id: String,
    pub branch: String,
    pub dirty: bool,
    pub ahead: i32,
    pub behind: i32,
}

#[derive(Serialize)]
pub struct OverleafCollaborationResult {
    pub remote_head: Option<String>,
    pub remote_updated: bool,
    pub incoming: bool,
    pub applied: bool,
    pub pending: bool,
    pub info: Option<OverleafProjectInfo>,
}

#[derive(Clone, Serialize, serde::Deserialize)]
pub struct LatexCompileResult {
    pub success: bool,
    pub pdf_path: String,
    pub log: String,
    pub duration_ms: u64,
    pub tool_missing: bool,
    pub pdf_is_local: bool,
    pub provenance_path: String,
    #[serde(default)]
    pub cached: bool,
}

struct GitOutput {
    code: i32,
    stdout: String,
    stderr: String,
}

fn proxy_for(host: &Option<String>) -> String {
    let Ok(cfg) = crate::config::load_config() else {
        return String::new();
    };
    match host.as_deref().filter(|value| !value.is_empty()) {
        None => cfg.http_proxy,
        Some(target) => cfg
            .connections
            .iter()
            .find(|connection| connection.host == target)
            .map(|connection| connection.http_proxy.clone())
            .unwrap_or_default(),
    }
}

fn auth_env(token: Option<&str>) -> HashMap<String, String> {
    let mut env = HashMap::from([
        ("GIT_TERMINAL_PROMPT".into(), "0".into()),
        ("GCM_INTERACTIVE".into(), "Never".into()),
    ]);
    if let Some(token) = token.filter(|value| !value.trim().is_empty()) {
        env.insert("GIT_CONFIG_COUNT".into(), "1".into());
        env.insert("GIT_CONFIG_KEY_0".into(), "http.extraHeader".into());
        env.insert(
            "GIT_CONFIG_VALUE_0".into(),
            format!(
                "Authorization: Basic {}",
                STANDARD.encode(format!("git:{token}"))
            ),
        );
    }
    env
}

fn git_env(host: &Option<String>, token: Option<&str>) -> HashMap<String, String> {
    let mut env = auth_env(token);
    let proxy = proxy_for(host);
    if !proxy.trim().is_empty() {
        for name in ["http_proxy", "https_proxy", "HTTP_PROXY", "HTTPS_PROXY"] {
            env.insert(name.into(), proxy.trim().into());
        }
    }
    env
}

fn kill_child_tree(child: &mut Child) {
    #[cfg(windows)]
    {
        let mut command = Command::new("taskkill");
        command.args(["/PID", &child.id().to_string(), "/T", "/F"]);
        crate::proc_ext::no_window(&mut command);
        let _ = command.output();
    }
    #[cfg(not(windows))]
    {
        let _ = child.kill();
    }
    let _ = child.wait();
}

fn wait_child_output(mut child: Child, timeout: Duration) -> Result<GitOutput, String> {
    let mut stdout = child.stdout.take();
    let mut stderr = child.stderr.take();
    let deadline = Instant::now() + timeout;
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) if Instant::now() < deadline => {
                std::thread::sleep(Duration::from_millis(25));
            }
            Ok(None) => {
                kill_child_tree(&mut child);
                return Err(format!(
                    "Git operation timed out after {} seconds",
                    timeout.as_secs()
                ));
            }
            Err(error) => {
                kill_child_tree(&mut child);
                return Err(format!("Unable to wait for Git: {error}"));
            }
        }
    };
    let mut stdout_bytes = Vec::new();
    let mut stderr_bytes = Vec::new();
    if let Some(ref mut pipe) = stdout {
        pipe.read_to_end(&mut stdout_bytes)
            .map_err(|error| error.to_string())?;
    }
    if let Some(ref mut pipe) = stderr {
        pipe.read_to_end(&mut stderr_bytes)
            .map_err(|error| error.to_string())?;
    }
    Ok(GitOutput {
        code: status.code().unwrap_or(-1),
        stdout: String::from_utf8_lossy(&stdout_bytes).to_string(),
        stderr: String::from_utf8_lossy(&stderr_bytes).to_string(),
    })
}

fn run_git(
    host: &Option<String>,
    cwd: &str,
    args: &[&str],
    token: Option<&str>,
) -> Result<GitOutput, String> {
    let env = git_env(host, token);

    if let Some(remote_host) = host.as_deref().filter(|value| !value.is_empty()) {
        let value = crate::agent_rpc::call_background_timeout(
            remote_host,
            "git",
            serde_json::json!({ "repo": cwd, "args": args, "env": env, "timeout": 180 }),
            Duration::from_secs(190),
        )?;
        return Ok(GitOutput {
            code: value
                .get("code")
                .and_then(|item| item.as_i64())
                .unwrap_or(-1) as i32,
            stdout: value
                .get("stdout")
                .and_then(|item| item.as_str())
                .unwrap_or_default()
                .to_string(),
            stderr: value
                .get("stderr")
                .and_then(|item| item.as_str())
                .unwrap_or_default()
                .to_string(),
        });
    }

    let mut command = Command::new("git");
    command.args(args).current_dir(cwd).envs(env);
    crate::proc_ext::no_window(&mut command);
    let output = command
        .output()
        .map_err(|error| format!("Unable to run Git: {error}"))?;
    Ok(GitOutput {
        code: output.status.code().unwrap_or(-1),
        stdout: String::from_utf8_lossy(&output.stdout).to_string(),
        stderr: String::from_utf8_lossy(&output.stderr).to_string(),
    })
}

fn run_git_quick(
    host: &Option<String>,
    cwd: &str,
    args: &[&str],
    token: Option<&str>,
) -> Result<GitOutput, String> {
    const QUICK_TIMEOUT: Duration = Duration::from_secs(15);
    let env = git_env(host, token);
    if let Some(remote_host) = host.as_deref().filter(|value| !value.is_empty()) {
        let value = crate::agent_rpc::call_background_timeout(
            remote_host,
            "git",
            serde_json::json!({ "repo": cwd, "args": args, "env": env, "timeout": 15 }),
            Duration::from_secs(20),
        )?;
        return Ok(GitOutput {
            code: value
                .get("code")
                .and_then(|item| item.as_i64())
                .unwrap_or(-1) as i32,
            stdout: value
                .get("stdout")
                .and_then(|item| item.as_str())
                .unwrap_or_default()
                .to_string(),
            stderr: value
                .get("stderr")
                .and_then(|item| item.as_str())
                .unwrap_or_default()
                .to_string(),
        });
    }

    let mut command = Command::new("git");
    command
        .args(args)
        .current_dir(cwd)
        .envs(env)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    crate::proc_ext::no_window(&mut command);
    let child = command
        .spawn()
        .map_err(|error| format!("Unable to run Git: {error}"))?;
    wait_child_output(child, QUICK_TIMEOUT)
}

fn git_ok(
    host: &Option<String>,
    cwd: &str,
    args: &[&str],
    token: Option<&str>,
) -> Result<String, String> {
    let output = run_git(host, cwd, args, token)?;
    if output.code == 0 {
        Ok(output.stdout)
    } else {
        let detail = if output.stderr.trim().is_empty() {
            output.stdout
        } else {
            output.stderr
        };
        Err(detail.trim().to_string())
    }
}

fn git_ok_quick(
    host: &Option<String>,
    cwd: &str,
    args: &[&str],
    token: Option<&str>,
) -> Result<String, String> {
    let output = run_git_quick(host, cwd, args, token)?;
    if output.code == 0 {
        Ok(output.stdout)
    } else {
        let detail = if output.stderr.trim().is_empty() {
            output.stdout
        } else {
            output.stderr
        };
        Err(detail.trim().to_string())
    }
}

fn normalize_overleaf_url(input: &str) -> Result<String, String> {
    let raw = input.trim().trim_end_matches('/');
    if raw.is_empty() {
        return Err("Enter an Overleaf project or Git URL".into());
    }
    if raw.chars().all(|character| character.is_ascii_hexdigit()) && raw.len() >= 16 {
        return Ok(format!("https://git.overleaf.com/{raw}"));
    }

    let mut url = raw.to_string();
    if let Some((origin, tail)) = raw.split_once("/project/") {
        let project_id = tail.split(['/', '?', '#']).next().unwrap_or_default();
        if project_id.is_empty() {
            return Err("The Overleaf project URL has no project ID".into());
        }
        url = if origin.contains("overleaf.com") {
            format!("https://git.overleaf.com/{project_id}")
        } else {
            format!("{origin}/git/{project_id}")
        };
    }
    url = url
        .replacen("https://git@", "https://", 1)
        .replacen("http://git@", "http://", 1);
    if !(url.starts_with("https://") || url.starts_with("http://"))
        || url.chars().any(char::is_whitespace)
    {
        return Err("Only HTTP(S) Overleaf Git URLs are supported".into());
    }
    Ok(url)
}

fn url_host(url: &str) -> Option<&str> {
    let authority = url.split_once("://")?.1.split('/').next()?;
    Some(authority.rsplit('@').next().unwrap_or(authority))
}

fn project_id(url: &str) -> String {
    url.trim_end_matches('/')
        .rsplit('/')
        .next()
        .unwrap_or_default()
        .trim_end_matches(".git")
        .to_string()
}

fn remember_token(url: &str, token: &str) -> Result<(), String> {
    let host = url_host(url).ok_or("Invalid Overleaf Git URL")?;
    let mut child = Command::new("git");
    child
        .args(["credential", "approve"])
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GCM_INTERACTIVE", "Never")
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::piped());
    crate::proc_ext::no_window(&mut child);
    let mut child = child.spawn().map_err(|error| error.to_string())?;
    if let Some(mut stdin) = child.stdin.take() {
        stdin
            .write_all(
                format!("protocol=https\nhost={host}\nusername=git\npassword={token}\n\n")
                    .as_bytes(),
            )
            .map_err(|error| error.to_string())?;
    }
    let output = wait_child_output(child, Duration::from_secs(10))?;
    if output.code == 0 {
        Ok(())
    } else {
        Err(output.stderr.trim().to_string())
    }
}

fn saved_token(url: &str) -> Option<String> {
    let host = url_host(url)?;
    let mut command = Command::new("git");
    command
        .args(["credential", "fill"])
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GCM_INTERACTIVE", "Never")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    crate::proc_ext::no_window(&mut command);
    let mut child = command.spawn().ok()?;
    child
        .stdin
        .take()?
        .write_all(format!("protocol=https\nhost={host}\nusername=git\n\n").as_bytes())
        .ok()?;
    let output = wait_child_output(child, Duration::from_secs(3)).ok()?;
    if output.code != 0 {
        return None;
    }
    output
        .stdout
        .lines()
        .find_map(|line| line.strip_prefix("password=").map(str::to_string))
}

fn token_cache() -> &'static Mutex<HashMap<String, String>> {
    static TOKENS: OnceLock<Mutex<HashMap<String, String>>> = OnceLock::new();
    TOKENS.get_or_init(|| Mutex::new(HashMap::new()))
}

fn token_cache_key(url: &str) -> String {
    url_host(url).unwrap_or(url).to_ascii_lowercase()
}

fn cache_token(url: &str, token: &str) {
    if let Ok(mut tokens) = token_cache().lock() {
        tokens.insert(token_cache_key(url), token.to_string());
    }
}

fn cached_token(url: &str) -> Option<String> {
    token_cache()
        .lock()
        .ok()
        .and_then(|tokens| tokens.get(&token_cache_key(url)).cloned())
}

fn overleaf_remote(host: &Option<String>, repo: &str) -> Result<(String, String), String> {
    let names = git_ok(host, repo, &["remote"], None)?;
    for name in names.lines().map(str::trim).filter(|name| !name.is_empty()) {
        let url = git_ok(host, repo, &["remote", "get-url", name], None)?
            .trim()
            .to_string();
        if url.contains("overleaf") || url.contains("/git/") {
            return Ok((name.to_string(), url));
        }
    }
    Err("This repository is not connected to Overleaf".into())
}

fn collaboration_heads() -> &'static Mutex<HashMap<String, String>> {
    static HEADS: OnceLock<Mutex<HashMap<String, String>>> = OnceLock::new();
    HEADS.get_or_init(|| Mutex::new(HashMap::new()))
}

fn collaboration_remotes() -> &'static Mutex<HashMap<String, (String, String)>> {
    static REMOTES: OnceLock<Mutex<HashMap<String, (String, String)>>> = OnceLock::new();
    REMOTES.get_or_init(|| Mutex::new(HashMap::new()))
}

fn collaboration_repo_key(host: &Option<String>, repo: &str) -> String {
    format!("{}\n{repo}", host.as_deref().unwrap_or_default())
}

fn collaboration_remote(host: &Option<String>, repo: &str) -> Result<(String, String), String> {
    let key = collaboration_repo_key(host, repo);
    if let Some(remote) = collaboration_remotes()
        .lock()
        .ok()
        .and_then(|remotes| remotes.get(&key).cloned())
    {
        return Ok(remote);
    }
    let remote = overleaf_remote(host, repo)?;
    if let Ok(mut remotes) = collaboration_remotes().lock() {
        remotes.insert(key, remote.clone());
    }
    Ok(remote)
}

fn collaboration_key(host: &Option<String>, repo: &str, remote: &str) -> String {
    format!("{}\n{repo}\n{remote}", host.as_deref().unwrap_or_default())
}

fn remember_collaboration_head(key: String, oid: String) {
    if let Ok(mut heads) = collaboration_heads().lock() {
        heads.insert(key, oid);
    }
}

fn remembered_collaboration_head(key: &str) -> Option<String> {
    collaboration_heads()
        .lock()
        .ok()
        .and_then(|heads| heads.get(key).cloned())
}

fn collaboration_branches() -> &'static Mutex<HashMap<String, String>> {
    static BRANCHES: OnceLock<Mutex<HashMap<String, String>>> = OnceLock::new();
    BRANCHES.get_or_init(|| Mutex::new(HashMap::new()))
}

fn parse_remote_branch(output: &str, preferred: Option<&str>) -> Result<(String, String), String> {
    let mut heads = HashMap::new();
    let mut default = None;
    for line in output.lines() {
        let fields: Vec<_> = line.split_whitespace().collect();
        if fields.len() == 3 && fields[0] == "ref:" && fields[2] == "HEAD" {
            default = fields[1].strip_prefix("refs/heads/");
        } else if fields.len() == 2 && [40, 64].contains(&fields[0].len()) && fields[0].bytes().all(|b| b.is_ascii_hexdigit()) {
            if let Some(branch) = fields[1].strip_prefix("refs/heads/") { heads.insert(branch, fields[0]); }
        }
    }
    for name in preferred.into_iter().chain(default) {
        if let Some(oid) = heads.get(name) { return Ok((name.to_string(), oid.to_string())); }
    }
    if heads.len() == 1 {
        let (name, oid) = heads.into_iter().next().unwrap();
        return Ok((name.to_string(), oid.to_string()));
    }
    Err(if heads.is_empty() { "The remote has no published branch. Create a branch on the remote before syncing." }
        else { "The remote has several branches but no default. Configure this branch's upstream or the remote's default branch before syncing." }.into())
}

fn tracked_remote_ref(host: &Option<String>, repo: &str, remote: &str) -> Option<String> {
    if let Some(branch) = collaboration_branches().lock().ok()?.get(&collaboration_key(host, repo, remote)).cloned() {
        return Some(format!("refs/remotes/{remote}/{branch}"));
    }
    let upstream = git_ok_quick(host, repo, &["rev-parse", "--symbolic-full-name", "@{upstream}"], None).unwrap_or_default();
    if upstream.trim().starts_with(&format!("refs/remotes/{remote}/")) { return Some(upstream.trim().into()); }
    git_ok_quick(host, repo, &["symbolic-ref", &format!("refs/remotes/{remote}/HEAD")], None).ok().map(|value| value.trim().into())
}

fn overleaf_branch(
    host: &Option<String>,
    repo: &str,
    remote: &str,
    token: &str,
) -> Result<(String, String), String> {
    let upstream = git_ok_quick(host, repo, &["rev-parse", "--symbolic-full-name", "@{upstream}"], None).unwrap_or_default();
    let prefix = format!("refs/remotes/{remote}/");
    let preferred = upstream.trim().strip_prefix(&prefix);
    let result = parse_remote_branch(&git_ok_quick(
        host,
        repo,
        &["ls-remote", "--symref", remote, "HEAD", "refs/heads/*"],
        Some(token),
    )?, preferred)?;
    if let Ok(mut branches) = collaboration_branches().lock() {
        branches.insert(collaboration_key(host, repo, remote), result.0.clone());
    }
    Ok(result)
}

fn fetch_overleaf_branch(
    host: &Option<String>,
    repo: &str,
    remote: &str,
    token: &str,
    branch: &str,
) -> Result<(), String> {
    let destination = format!("refs/remotes/{remote}/{branch}");
    git_ok(
        host,
        repo,
        &[
            "fetch",
            "--quiet",
            "--no-tags",
            remote,
            &format!("+refs/heads/{branch}:{destination}"),
        ],
        Some(token),
    )?;
    Ok(())
}

fn remember_published_head(host: &Option<String>, repo: &str, remote: &str) {
    if let Ok(oid) = git_ok(host, repo, &["rev-parse", "HEAD"], None) {
        remember_collaboration_head(
            collaboration_key(host, repo, remote),
            oid.trim().to_string(),
        );
    }
}

fn empty_info(branch: String) -> OverleafProjectInfo {
    OverleafProjectInfo {
        connected: false,
        remote_name: String::new(),
        remote_url: String::new(),
        project_id: String::new(),
        branch,
        dirty: false,
        ahead: 0,
        behind: 0,
    }
}

fn info(host: &Option<String>, repo: &str) -> Result<OverleafProjectInfo, String> {
    if run_git(host, repo, &["rev-parse", "--is-inside-work-tree"], None)?.code != 0 {
        return Ok(empty_info(String::new()));
    }
    let branch = git_ok(host, repo, &["branch", "--show-current"], None)
        .unwrap_or_default()
        .trim()
        .to_string();
    let dirty = !git_ok(host, repo, &["status", "--porcelain"], None)?
        .trim()
        .is_empty();
    let Ok((remote_name, remote_url)) = overleaf_remote(host, repo) else {
        let mut value = empty_info(branch);
        value.dirty = dirty;
        return Ok(value);
    };
    let counts = tracked_remote_ref(host, repo, &remote_name).and_then(|remote_ref| git_ok(
        host,
        repo,
        &[
            "rev-list",
            "--left-right",
            "--count",
            &format!("HEAD...{remote_ref}"),
        ],
        None,
    ).ok())
    .unwrap_or_default();
    let mut parts = counts.split_whitespace();
    let ahead = parts
        .next()
        .and_then(|value| value.parse().ok())
        .unwrap_or(0);
    let behind = parts
        .next()
        .and_then(|value| value.parse().ok())
        .unwrap_or(0);
    Ok(OverleafProjectInfo {
        connected: true,
        remote_name,
        project_id: project_id(&remote_url),
        remote_url,
        branch,
        dirty,
        ahead,
        behind,
    })
}

fn token_for(url: &str, supplied: Option<&str>) -> Result<String, String> {
    if let Some(token) = supplied.filter(|value| !value.trim().is_empty()) {
        cache_token(url, token);
        return Ok(token.to_string());
    }
    if let Some(token) = cached_token(url) {
        return Ok(token);
    }
    if let Some(token) = saved_token(url) {
        cache_token(url, &token);
        return Ok(token);
    }
    Err("OVERLEAF_AUTH_REQUIRED: Enter your Overleaf Git token".into())
}

#[tauri::command]
pub async fn overleaf_project_info(
    repo: String,
    host: Option<String>,
) -> Result<OverleafProjectInfo, String> {
    crate::blocking::run(move || info(&host, &repo)).await
}

#[tauri::command]
pub async fn overleaf_clone(
    git_url: String,
    destination: String,
    token: String,
    remember: bool,
    host: Option<String>,
) -> Result<OverleafProjectInfo, String> {
    crate::blocking::run(move || {
        let url = normalize_overleaf_url(&git_url)?;
        if token.trim().is_empty() {
            return Err("Enter your Overleaf Git token".into());
        }
        let (parent, name) = if host.as_deref().filter(|value| !value.is_empty()).is_some() {
            let clean = destination.trim_end_matches('/');
            let (parent, name) = clean
                .rsplit_once('/')
                .ok_or("Choose a destination inside an existing remote directory")?;
            crate::remote::run_remote(
                host.as_deref().unwrap_or_default(),
                &format!("mkdir -p -- {}", crate::remote::shq(parent)),
            )?;
            (parent.to_string(), name.to_string())
        } else {
            let path = PathBuf::from(&destination);
            let parent = path
                .parent()
                .ok_or("Choose a valid destination directory")?;
            std::fs::create_dir_all(parent).map_err(|error| error.to_string())?;
            let name = path
                .file_name()
                .and_then(|value| value.to_str())
                .ok_or("Choose a valid project folder name")?;
            (parent.to_string_lossy().to_string(), name.to_string())
        };
        git_ok(
            &host,
            &parent,
            &["clone", "--origin", "overleaf", "--", &url, &name],
            Some(token.trim()),
        )?;
        cache_token(&url, token.trim());
        if remember {
            remember_token(&url, token.trim())?;
        }
        info(&host, &destination)
    })
    .await
}

#[tauri::command]
pub async fn overleaf_pull(
    repo: String,
    token: Option<String>,
    host: Option<String>,
) -> Result<OverleafProjectInfo, String> {
    crate::blocking::run(move || {
        let lock = merge::repo_lock(&host, &repo);
        let _guard = merge::lock(&lock)?;
        let (remote, url) = overleaf_remote(&host, &repo)?;
        let auth = token_for(&url, token.as_deref())?;
        let (branch, _) = overleaf_branch(&host, &repo, &remote, &auth)?;
        fetch_overleaf_branch(&host, &repo, &remote, &auth, &branch)?;
        let remote_ref = format!("refs/remotes/{remote}/{branch}");
        merge::checkpoint(&host, &repo, "Save manuscript checkpoint before pulling Overleaf changes")?;
        merge::integrate(&host, &repo, &remote_ref)?;
        if let Ok(oid) = git_ok(&host, &repo, &["rev-parse", &remote_ref], None) {
            remember_collaboration_head(
                collaboration_key(&host, &repo, &remote),
                oid.trim().to_string(),
            );
        }
        info(&host, &repo)
    })
    .await
}

#[tauri::command]
pub async fn overleaf_store_token(
    repo: String,
    token: String,
    remember: bool,
    host: Option<String>,
) -> Result<(), String> {
    crate::blocking::run(move || {
        if token.trim().is_empty() {
            return Err("Enter your Overleaf Git token".into());
        }
        if remember {
            let (_, url) = overleaf_remote(&host, &repo)?;
            remember_token(&url, token.trim())?;
            cache_token(&url, token.trim());
        } else if let Ok((_, url)) = overleaf_remote(&host, &repo) {
            cache_token(&url, token.trim());
        }
        Ok(())
    })
    .await
}

#[tauri::command]
pub async fn overleaf_publish(
    repo: String,
    message: String,
    token: Option<String>,
    host: Option<String>,
) -> Result<OverleafProjectInfo, String> {
    crate::blocking::run(move || {
        let lock = merge::repo_lock(&host, &repo);
        let _guard = merge::lock(&lock)?;
        let (remote, url) = overleaf_remote(&host, &repo)?;
        let auth = token_for(&url, token.as_deref())?;
        let (branch, _) = overleaf_branch(&host, &repo, &remote, &auth)?;
        fetch_overleaf_branch(&host, &repo, &remote, &auth, &branch)?;
        merge::checkpoint(&host, &repo, if message.trim().is_empty() { "Update manuscript from Linco" } else { message.trim() })?;
        let remote_ref = format!("refs/remotes/{remote}/{branch}");
        merge::integrate(&host, &repo, &remote_ref)?;
        git_ok(&host, &repo, &["push", &remote, &format!("HEAD:refs/heads/{branch}")], Some(&auth))?;
        remember_published_head(&host, &repo, &remote);
        info(&host, &repo)
    })
    .await
}

#[tauri::command]
pub fn overleaf_sync_capabilities() -> u32 { 1 }

fn collaboration_poll(
    repo: &str,
    token: Option<&str>,
    host: &Option<String>,
) -> Result<OverleafCollaborationResult, String> {
    let (remote, url) = collaboration_remote(host, repo)?;
    let auth = token_for(&url, token)?;
    let (branch, remote_oid) = overleaf_branch(host, repo, &remote, &auth)?;
    let key = collaboration_key(host, repo, &remote);
    if remembered_collaboration_head(&key).as_deref() == Some(remote_oid.as_str()) {
        return Ok(OverleafCollaborationResult {
            remote_head: Some(remote_oid),
            remote_updated: false,
            incoming: false,
            applied: false,
            pending: false,
            info: None,
        });
    }

    let remote_ref = format!("refs/remotes/{remote}/{branch}");
    let tracked_oid =
        git_ok(host, repo, &["rev-parse", "--verify", &remote_ref], None).unwrap_or_default();
    if tracked_oid.trim() != remote_oid {
        fetch_overleaf_branch(host, repo, &remote, &auth, &branch)?;
    }

    let next = info(host, repo)?;
    let incoming = next.behind > 0;
    let pending = next.behind > 0;
    if !pending {
        remember_collaboration_head(key, remote_oid.clone());
    }
    Ok(OverleafCollaborationResult {
        remote_head: Some(remote_oid),
        remote_updated: true,
        incoming,
        applied: false,
        pending,
        info: Some(next),
    })
}

fn collaboration_apply(
    repo: &str,
    host: &Option<String>,
) -> Result<OverleafCollaborationResult, String> {
    let lock = merge::repo_lock(host, repo);
    let _guard = merge::lock(&lock)?;
    let (remote, _) = collaboration_remote(host, repo)?;
    let remote_ref = tracked_remote_ref(host, repo, &remote).ok_or("Refresh the remote branch before applying changes")?;
    let mut next = info(host, repo)?;
    let incoming = next.behind > 0;
    let mut applied = false;
    if incoming && !next.dirty && next.ahead == 0 {
        merge::checkpoint(host, repo, "Save manuscript checkpoint before synchronization")?;
        git_ok(host, repo, &["merge", "--ff-only", &remote_ref], None)?;
        next = info(host, repo)?;
        applied = true;
    }
    let pending = next.behind > 0;
    if !pending {
        if let Ok(oid) = git_ok(host, repo, &["rev-parse", &remote_ref], None) {
            remember_collaboration_head(
                collaboration_key(host, repo, &remote),
                oid.trim().to_string(),
            );
        }
    }
    Ok(OverleafCollaborationResult {
        remote_head: git_ok(host, repo, &["rev-parse", &remote_ref], None).ok().map(|head| head.trim().to_string()),
        remote_updated: false,
        incoming,
        applied,
        pending,
        info: Some(next),
    })
}

#[tauri::command]
pub async fn overleaf_collaboration_poll(
    repo: String,
    token: Option<String>,
    host: Option<String>,
) -> Result<OverleafCollaborationResult, String> {
    crate::blocking::run(move || collaboration_poll(&repo, token.as_deref(), &host)).await
}

#[tauri::command]
pub async fn overleaf_collaboration_apply(
    repo: String,
    host: Option<String>,
) -> Result<OverleafCollaborationResult, String> {
    crate::blocking::run(move || collaboration_apply(&repo, &host)).await
}

fn compiler_flag(engine: &str) -> Result<&'static str, String> {
    match engine {
        "pdflatex" | "" => Ok("-pdf"),
        "xelatex" => Ok("-xelatex"),
        "lualatex" => Ok("-lualatex"),
        _ => Err("Unsupported LaTeX engine".into()),
    }
}

const BUNDLED_TEX_VERSION: &str = "2026.05";
const BUNDLED_TEX_SUPPLEMENT_VERSION: &str = "2";

fn tex_provision_lock() -> &'static Mutex<()> {
    static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| Mutex::new(()))
}

fn latexmk_in_runtime(root: &Path) -> Option<PathBuf> {
    let mut roots = vec![root.to_path_buf(), root.join("TinyTeX")];
    roots.dedup();
    for runtime in roots {
        let bin = runtime.join("bin");
        if cfg!(windows) {
            let candidate = bin.join("windows").join("latexmk.exe");
            if candidate.is_file() {
                return Some(candidate);
            }
        }
        let Ok(entries) = std::fs::read_dir(&bin) else {
            continue;
        };
        for entry in entries.flatten() {
            let candidate = entry.path().join(if cfg!(windows) {
                "latexmk.exe"
            } else {
                "latexmk"
            });
            if candidate.is_file() {
                return Some(candidate);
            }
        }
    }
    None
}

fn configured_latexmk() -> Option<PathBuf> {
    env::var_os("LINCO_LATEXMK")
        .map(PathBuf::from)
        .filter(|path| path.is_file())
}

fn latexmk_on_path() -> Option<PathBuf> {
    let path = env::var_os("PATH")?;
    for directory in env::split_paths(&path) {
        for name in if cfg!(windows) {
            &["latexmk.exe"][..]
        } else {
            &["latexmk"][..]
        } {
            let candidate = directory.join(name);
            if candidate.is_file() {
                return Some(candidate);
            }
        }
    }
    None
}

fn bundled_tex_archive(app: &AppHandle) -> Option<PathBuf> {
    let archive_name = if cfg!(windows) {
        format!("TinyTeX-windows-v{BUNDLED_TEX_VERSION}.exe")
    } else if cfg!(target_os = "macos") {
        format!("TinyTeX-darwin-v{BUNDLED_TEX_VERSION}.tar.xz")
    } else {
        return None;
    };
    if let Ok(resources) = app.path().resource_dir() {
        let archive = resources.join("tex").join(&archive_name);
        if archive.is_file() {
            return Some(archive);
        }
    }
    let archive = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("resources")
        .join("tex")
        .join(archive_name);
    archive.is_file().then_some(archive)
}

fn bundled_tex_supplement_dirs(app: &AppHandle) -> Vec<PathBuf> {
    let platform = if cfg!(windows) {
        "windows"
    } else if cfg!(target_os = "macos") {
        "macos"
    } else {
        return Vec::new();
    };
    let mut roots = Vec::new();
    if let Ok(resources) = app.path().resource_dir() {
        roots.push(resources.join("tex").join("supplement"));
    }
    roots.push(
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("resources")
            .join("tex")
            .join("supplement"),
    );
    roots
        .into_iter()
        .find(|root| root.join("common").is_dir())
        .map(|root| vec![root.join("common"), root.join(platform)])
        .unwrap_or_default()
}

fn copy_missing_tree(source: &Path, destination: &Path) -> Result<bool, String> {
    if !source.is_dir() {
        return Ok(false);
    }
    let mut copied = false;
    for entry in std::fs::read_dir(source).map_err(|error| error.to_string())? {
        let entry = entry.map_err(|error| error.to_string())?;
        let target = destination.join(entry.file_name());
        if entry
            .file_type()
            .map_err(|error| error.to_string())?
            .is_dir()
        {
            copied |= copy_missing_tree(&entry.path(), &target)?;
        } else if !target.exists() {
            if let Some(parent) = target.parent() {
                std::fs::create_dir_all(parent).map_err(|error| error.to_string())?;
            }
            std::fs::copy(entry.path(), &target).map_err(|error| {
                format!(
                    "Unable to install bundled TeX package {}: {error}",
                    target.display()
                )
            })?;
            copied = true;
        }
    }
    Ok(copied)
}

fn tex_runtime_root(latexmk: &Path) -> Result<PathBuf, String> {
    latexmk
        .parent()
        .and_then(Path::parent)
        .and_then(Path::parent)
        .map(Path::to_path_buf)
        .ok_or_else(|| "Unable to resolve the bundled TinyTeX directory".to_string())
}

fn tex_supplement_marker(latexmk: &Path) -> Result<PathBuf, String> {
    Ok(tex_runtime_root(latexmk)?.join(format!(
        ".linco-supplement-{BUNDLED_TEX_SUPPLEMENT_VERSION}"
    )))
}

fn apply_bundled_tex_supplement(app: &AppHandle, latexmk: &Path) -> Result<(), String> {
    let marker = tex_supplement_marker(latexmk)?;
    if marker.is_file() {
        return Ok(());
    }
    let sources = bundled_tex_supplement_dirs(app);
    if sources.is_empty() {
        return Ok(());
    }
    let runtime = tex_runtime_root(latexmk)?;
    let mut copied = false;
    for source in sources {
        copied |= copy_missing_tree(&source, &runtime)?;
    }

    #[cfg(target_os = "macos")]
    {
        use std::os::unix::fs::PermissionsExt;

        let launcher = runtime
            .join("bin")
            .join("universal-darwin")
            .join("markdown2tex");
        if launcher.is_file() {
            let mut permissions = std::fs::metadata(&launcher)
                .map_err(|error| error.to_string())?
                .permissions();
            permissions.set_mode(0o755);
            std::fs::set_permissions(launcher, permissions).map_err(|error| error.to_string())?;
        }
    }

    if copied {
        let executable = latexmk
            .parent()
            .ok_or("Unable to resolve the bundled TinyTeX binaries")?
            .join(if cfg!(windows) {
                "mktexlsr.exe"
            } else {
                "mktexlsr"
            });
        if !executable.is_file() {
            return Err("The bundled TinyTeX file indexer is missing".into());
        }
        let mut command = Command::new(&executable);
        prepend_executable_dir(&mut command, &executable);
        run_tex_extractor(command)?;
    }
    std::fs::write(marker, b"Linco bundled TeX supplement\n")
        .map_err(|error| format!("Unable to finish bundled TeX package setup: {error}"))
}

fn run_tex_extractor(mut command: Command) -> Result<(), String> {
    crate::proc_ext::no_window(&mut command);
    let status = command
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map_err(|error| format!("Unable to unpack bundled TinyTeX: {error}"))?;
    if !status.success() {
        return Err(format!(
            "Unable to unpack bundled TinyTeX (exit {})",
            status.code().unwrap_or(-1),
        ));
    }
    Ok(())
}

#[cfg(windows)]
fn extract_bundled_tex(archive: &Path, staging: &Path) -> Result<(), String> {
    std::fs::create_dir_all(staging).map_err(|error| error.to_string())?;
    let mut command = Command::new(archive);
    command.arg("-y").current_dir(staging);
    run_tex_extractor(command)
}

#[cfg(target_os = "macos")]
fn extract_bundled_tex(archive: &Path, staging: &Path) -> Result<(), String> {
    std::fs::create_dir_all(staging).map_err(|error| error.to_string())?;
    let mut command = Command::new("tar");
    command.args(["-xJf"]).arg(archive).arg("-C").arg(staging);
    run_tex_extractor(command)
}

#[cfg(not(any(windows, target_os = "macos")))]
fn extract_bundled_tex(_archive: &Path, _staging: &Path) -> Result<(), String> {
    Err("Bundled TinyTeX is not available on this platform".into())
}

fn ensure_local_latexmk(app: &AppHandle) -> Result<PathBuf, String> {
    if let Some(path) = configured_latexmk() {
        return Ok(path);
    }
    let app_data = app
        .path()
        .app_local_data_dir()
        .map_err(|error| format!("Unable to resolve Linco application data: {error}"))?;
    let tex_root = app_data.join("tex").join(BUNDLED_TEX_VERSION);
    if let Some(path) = latexmk_in_runtime(&tex_root) {
        if tex_supplement_marker(&path)?.is_file() {
            return Ok(path);
        }
    }

    let _guard = tex_provision_lock()
        .lock()
        .map_err(|_| "The local TeX provisioning lock is unavailable".to_string())?;
    if let Some(path) = latexmk_in_runtime(&tex_root) {
        apply_bundled_tex_supplement(app, &path)?;
        return Ok(path);
    }
    let Some(archive) = bundled_tex_archive(app) else {
        return latexmk_on_path().ok_or_else(|| {
            "Linco's bundled TinyTeX archive is missing. Repair or reinstall Linco.".to_string()
        });
    };
    let tex_parent = tex_root
        .parent()
        .ok_or("Unable to resolve the local TeX directory")?;
    std::fs::create_dir_all(tex_parent).map_err(|error| error.to_string())?;
    let staging = tex_parent.join(format!(
        ".{BUNDLED_TEX_VERSION}-staging-{}",
        std::process::id()
    ));
    if staging.exists() {
        std::fs::remove_dir_all(&staging).map_err(|error| error.to_string())?;
    }
    if tex_root.exists() {
        std::fs::remove_dir_all(&tex_root).map_err(|error| error.to_string())?;
    }
    if let Err(error) = extract_bundled_tex(&archive, &staging) {
        let _ = std::fs::remove_dir_all(&staging);
        return Err(error);
    }
    let Some(staging_latexmk) = latexmk_in_runtime(&staging) else {
        let _ = std::fs::remove_dir_all(&staging);
        return Err("The bundled TinyTeX archive does not contain latexmk".into());
    };
    if let Err(error) = apply_bundled_tex_supplement(app, &staging_latexmk) {
        let _ = std::fs::remove_dir_all(&staging);
        return Err(error);
    }
    if let Some(path) = latexmk_in_runtime(&tex_root) {
        let _ = std::fs::remove_dir_all(&staging);
        apply_bundled_tex_supplement(app, &path)?;
        return Ok(path);
    }
    if let Err(error) = std::fs::rename(&staging, &tex_root) {
        if let Some(path) = latexmk_in_runtime(&tex_root) {
            let _ = std::fs::remove_dir_all(&staging);
            apply_bundled_tex_supplement(app, &path)?;
            return Ok(path);
        }
        return Err(format!("Unable to activate bundled TinyTeX: {error}"));
    }
    latexmk_in_runtime(&tex_root)
        .ok_or_else(|| "The bundled TinyTeX runtime could not be activated".into())
}

pub fn prepare_bundled_tex(app: AppHandle) {
    #[cfg(any(windows, target_os = "macos"))]
    let _ = std::thread::Builder::new()
        .name("linco-tex-prepare".into())
        .spawn(move || {
            std::thread::sleep(Duration::from_secs(2));
            if let Err(error) = ensure_local_latexmk(&app) {
                eprintln!("Unable to prepare bundled TinyTeX: {error}");
            }
        });

    #[cfg(not(any(windows, target_os = "macos")))]
    let _ = app;
}

fn prepend_executable_dir(command: &mut Command, executable: &Path) {
    let Some(directory) = executable.parent() else {
        return;
    };
    let mut paths = vec![directory.to_path_buf()];
    if let Some(current) = env::var_os("PATH") {
        paths.extend(env::split_paths(&current));
    }
    if let Ok(path) = env::join_paths(paths) {
        command.env("PATH", path);
    }
}

fn trim_log(mut log: String) -> String {
    const MAX_LOG: usize = 300_000;
    if log.len() > MAX_LOG {
        let mut start = log.len() - MAX_LOG;
        while !log.is_char_boundary(start) {
            start += 1;
        }
        log = format!("[Earlier compiler output omitted]\n{}", &log[start..]);
    }
    log
}

/// Reject sibling-prefix matches and option-like paths before invoking any tool.
fn compile_relative(repo: &str, main: &str) -> Result<String, String> {
    let base = repo.replace('\\', "/").trim_end_matches('/').to_string();
    let main = main.replace('\\', "/");
    let relative = if main.starts_with('/') || main.as_bytes().get(1) == Some(&b':') {
        main.strip_prefix(&(base + "/"))
            .ok_or("The main TeX file must be inside the paper folder")?
            .to_string()
    } else {
        main
    };
    crate::latex_snapshot::portable_relative(&relative)?;
    if !relative.to_ascii_lowercase().ends_with(".tex") {
        return Err("Select a .tex main file".into());
    }
    Ok(relative)
}

#[tauri::command]
pub async fn latex_compile(
    app: AppHandle,
    repo: String,
    main_file: String,
    engine: String,
    host: Option<String>,
    force: Option<bool>,
) -> Result<LatexCompileResult, String> {
    crate::blocking::run(move || {
        let started = Instant::now();
        let flag = compiler_flag(&engine)?;
        let relative = compile_relative(&repo, &main_file)?;
        let snapshot = if let Some(remote_host) = host.as_deref().filter(|h| !h.is_empty()) {
            let value = crate::agent_rpc::call_background_timeout(
                remote_host, "latex_snapshot", serde_json::json!({"repo": repo}), Duration::from_secs(90),
            )?;
            Some(serde_json::from_value::<crate::latex_snapshot::Snapshot>(value).map_err(|e| e.to_string())?)
        } else { None };
        let files = snapshot.as_ref().map(|snapshot| snapshot.files.iter().map(|f| {
            let data = STANDARD.decode(&f.data).map_err(|e| e.to_string())?;
            Ok(serde_json::json!({"path": f.path, "bytes": data.len(), "sha256": crate::latex_snapshot::fingerprint(&data)}))
        }).collect::<Result<Vec<_>, String>>()).transpose()?;
        let source_signature = if let Some(files) = &files {
            Some(crate::latex_snapshot::fingerprint(&serde_json::to_vec(files).map_err(|e| e.to_string())?))
        } else { crate::latex_cache::local_source_signature(Path::new(&repo)) };
        let main_bytes = if let Some(snapshot) = &snapshot {
            let main = snapshot.files.iter().find(|file| file.path == relative).ok_or("The main TeX file is missing")?;
            STANDARD.decode(&main.data).map_err(|e| e.to_string())?
        } else { std::fs::read(Path::new(&repo).join(&relative)).map_err(|e| e.to_string())? };
        if main_bytes.iter().all(u8::is_ascii_whitespace) { return Err("The main TeX file is empty. Add document content before compiling.".into()); }
        let runtime = ensure_local_latexmk(&app);
        let app_data = app.path().app_local_data_dir().map_err(|e| e.to_string())?;
        let build_key = {
            let environment = ["TEXINPUTS", "BIBINPUTS", "BSTINPUTS", "TEXMFHOME", "TEXMFCNF", "TEXMFVAR"].map(|name| (name, env::var_os(name).map(|value| value.to_string_lossy().into_owned())));
            let key = serde_json::json!(["latex-build-v1", host, repo, relative, engine, runtime.as_ref().ok(), BUNDLED_TEX_VERSION, BUNDLED_TEX_SUPPLEMENT_VERSION, environment]);
            crate::latex_snapshot::fingerprint(key.to_string().as_bytes())
        };
        let build_directory = app_data.join("production-builds").join(build_key);
        let _build_lock = crate::latex_build::lock(&build_directory)?;
        let cache_file = runtime.as_ref().ok().map(|latexmk| {
            let environment = ["TEXINPUTS", "BIBINPUTS", "BSTINPUTS", "TEXMFHOME", "TEXMFCNF", "TEXMFVAR"].map(|name| (name, env::var_os(name).map(|value| value.to_string_lossy().into_owned())));
            let day = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_secs() / 86400;
            let key = serde_json::json!(["latex-cache-v1", host, repo, relative, engine, latexmk, BUNDLED_TEX_VERSION, BUNDLED_TEX_SUPPLEMENT_VERSION, environment, day]);
            app_data.join("production-cache").join(format!("{}.json", crate::latex_snapshot::fingerprint(key.to_string().as_bytes())))
        });
        if !force.unwrap_or(false) {
            if let (Some(cache), Some(signature)) = (&cache_file, &source_signature) {
                if let Some(mut result) = crate::latex_cache::load(cache, signature, &app_data.join("production-jobs")) {
                    result.cached = true;
                    result.duration_ms = started.elapsed().as_millis() as u64;
                    result.log = format!("Unchanged paper and compiler inputs; reused the verified local PDF. Shift-click Compile to rebuild.\n{}", result.log);
                    return Ok(result);
                }
            }
        }
        let job = crate::latex_snapshot::new_job(&app, "latex")?;
        let archive_out = job.join("output");
        std::fs::create_dir(&archive_out).map_err(|e| e.to_string())?;
        let out = build_directory.join("output");
        std::fs::create_dir_all(&out).map_err(|e| e.to_string())?;
        let stem = Path::new(&relative).file_stem().and_then(|s| s.to_str()).ok_or("Invalid TeX filename")?;
        let incremental = !force.unwrap_or(false) && out.join(format!("{stem}.fdb_latexmk")).is_file();
        let mut manifest = serde_json::json!({
            "version": 1, "kind": "latex", "source_host": host, "source_repo": repo,
            "main_file": relative, "engine": engine, "execution": "local",
            "shell_escape": false, "project_rc": false,
            "build_state_reused": incremental,
            "build_directory": build_directory,
            "note": "Snapshot records source bytes, not proof of which code produced an experiment."
        });
        let working = if let Some(snapshot) = snapshot {
            manifest["files"] = serde_json::json!(files);
            let source = job.join("source");
            std::fs::create_dir(&source).map_err(|e| e.to_string())?;
            crate::latex_snapshot::materialize(snapshot, &source)?;
            let mirror = build_directory.join("source");
            manifest["source_files_changed"] = serde_json::json!(crate::latex_build::sync_sources(&source, &mirror)?);
            mirror
        } else { PathBuf::from(&repo) };
        if !working.join(&relative).is_file() { return Err("The main TeX file was not present in the captured paper".into()); }
        let provenance = job.join("provenance.json");
        std::fs::write(&provenance, serde_json::to_vec_pretty(&manifest).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
        let pdf = archive_out.join(format!("{stem}.pdf"));
        let log_path = job.join("compile.log");
        let mut tool_missing = false;
        let compiler_started = Instant::now();
        manifest["prepare_ms"] = serde_json::json!(started.elapsed().as_millis() as u64);
        let (code, log) = match &runtime {
            Err(error) => { tool_missing = true; (127, format!("Local TeX runtime unavailable: {error}")) }
            Ok(latexmk) => {
                manifest["compiler_path"] = serde_json::json!(latexmk);
                manifest["compiler_version_record"] = serde_json::json!("compile.log");
                manifest["linco_bundled_tex_version_available"] = serde_json::json!(BUNDLED_TEX_VERSION);
                manifest["linco_supplement_version_available"] = serde_json::json!(BUNDLED_TEX_SUPPLEMENT_VERSION);
                manifest["runtime_note"] = serde_json::json!("Compiler overrides are respected. Tool versions are in compile.log; bundle versions are not an inventory of user-installed packages.");
                let log_file = std::fs::File::create(&log_path).map_err(|e| e.to_string())?;
                let out_arg = format!("-outdir={}", out.to_string_lossy());
                let mut command = Command::new(&latexmk);
                command.current_dir(&working).args([
                    "-norc", "-no-shell-escape", flag, "-interaction=nonstopmode",
                    "-file-line-error", "-synctex=1", "-halt-on-error", &out_arg, &format!("./{relative}"),
                ]);
                // Explicit clean rebuild only; ordinary edits keep auxiliary files.
                if force.unwrap_or(false) { command.arg("-gg"); }
                prepend_executable_dir(&mut command, &latexmk);
                command.stdin(Stdio::null()).stdout(log_file.try_clone().map_err(|e| e.to_string())?).stderr(log_file);
                crate::proc_ext::no_window(&mut command);
                #[cfg(unix)]
                {
                    use std::os::unix::process::CommandExt;
                    command.process_group(0);
                }
                let mut child = command.spawn().map_err(|e| format!("Unable to start local latexmk: {e}"))?;
                let deadline = Instant::now() + Duration::from_secs(180);
                let mut stopped = false;
                let code = loop {
                    match child.try_wait() {
                        Ok(Some(status)) => break status.code().unwrap_or(-1),
                        result => {
                            let wait_failed = result.is_err();
                            if wait_failed || Instant::now() >= deadline || std::fs::metadata(&log_path).map(|m| m.len() > 10_000_000).unwrap_or(false) {
                                // This process group was created above solely for this compilation.
                                #[cfg(unix)]
                                let _ = Command::new("/bin/kill").args(["-KILL", &format!("-{}", child.id())]).status();
                                kill_child_tree(&mut child);
                                stopped = true;
                                break -1;
                            }
                            std::thread::sleep(Duration::from_millis(50));
                        }
                    }
                };
                use std::io::{Seek, SeekFrom};
                let mut file = std::fs::File::open(&log_path).map_err(|e| e.to_string())?;
                let length = file.metadata().map_err(|e| e.to_string())?.len();
                file.seek(SeekFrom::Start(length.saturating_sub(300_000))).map_err(|e| e.to_string())?;
                let mut bytes = Vec::new();
                file.take(300_000).read_to_end(&mut bytes).map_err(|e| e.to_string())?;
                let mut log = String::from_utf8_lossy(&bytes).to_string();
                if stopped { log.push_str("\nCompilation stopped: time or log-size limit reached.\n"); }
                (code, log)
            }
        };
        manifest["compiler_ms"] = serde_json::json!(compiler_started.elapsed().as_millis() as u64);
        // Never expose a mutable build PDF (or an old PDF after a failed build).
        // Source captures and published PDFs stay immutable and independently hashed.
        if code == 0 {
            for extension in ["pdf", "fls", "log", "synctex.gz"] {
                let name = format!("{stem}.{extension}");
                let source = out.join(&name);
                if source.is_file() { std::fs::copy(source, archive_out.join(name)).map_err(|e| e.to_string())?; }
            }
        }
        manifest["exit_code"] = serde_json::json!(code);
        manifest["pdf_sha256"] = std::fs::read(&pdf).ok().map(|data| serde_json::json!(crate::latex_snapshot::fingerprint(&data))).unwrap_or(serde_json::Value::Null);
        std::fs::write(&provenance, serde_json::to_vec_pretty(&manifest).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
        let result = LatexCompileResult {
            success: code == 0 && pdf.is_file(), pdf_path: pdf.to_string_lossy().into_owned(),
            log: trim_log(format!("Compiled locally ({}). Source: {}\nReproduction record: {}\n{}", if incremental { "incremental build" } else { "clean build" }, host.as_deref().unwrap_or("local"), provenance.display(), log)),
            duration_ms: started.elapsed().as_millis() as u64, tool_missing, pdf_is_local: true,
            provenance_path: provenance.to_string_lossy().into_owned(),
            cached: false,
        };
        if let (Some(cache), Some(signature), Ok(latexmk)) = (&cache_file, &source_signature, &runtime) {
            if host.as_deref().filter(|h| !h.is_empty()).is_some()
                || crate::latex_cache::local_source_signature(&working).as_ref() == Some(signature) {
                let _ = crate::latex_cache::save(cache, signature, &working, &out, latexmk, &result);
            }
        }
        Ok(result)
    }).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn test_git(cwd: &Path, args: &[&str]) -> String {
        let output = Command::new("git")
            .current_dir(cwd)
            .args(args)
            .output()
            .expect("git should run in collaboration test");
        assert!(
            output.status.success(),
            "git {:?} failed: {}",
            args,
            String::from_utf8_lossy(&output.stderr)
        );
        String::from_utf8_lossy(&output.stdout).trim().to_string()
    }

    fn configure_test_author(repo: &Path) {
        test_git(repo, &["config", "user.name", "Linco Test"]);
        test_git(
            repo,
            &["config", "user.email", "linco-test@example.invalid"],
        );
    }

    #[test]
    fn normalizes_cloud_project_urls() {
        assert_eq!(
            normalize_overleaf_url("https://www.overleaf.com/project/abc123").unwrap(),
            "https://git.overleaf.com/abc123"
        );
        assert_eq!(
            normalize_overleaf_url("https://git@git.overleaf.com/abc123").unwrap(),
            "https://git.overleaf.com/abc123"
        );
    }

    #[test]
    fn rejects_non_http_git_urls() {
        assert!(normalize_overleaf_url("git@git.overleaf.com:abc123").is_err());
    }

    #[test]
    fn discovers_remote_default_or_upstream_without_assuming_master() {
        let oid = "0123456789abcdef0123456789abcdef01234567";
        let output = format!("ref: refs/heads/main\tHEAD\n{oid}\tHEAD\n{oid}\trefs/heads/main\n{oid}\trefs/heads/paper\n");
        assert_eq!(parse_remote_branch(&output, None).unwrap().0, "main");
        assert_eq!(parse_remote_branch(&output, Some("paper")).unwrap().0, "paper");
        assert_eq!(parse_remote_branch(&output, Some("master")).unwrap().0, "main");
        assert_eq!(parse_remote_branch(&format!("{oid}\trefs/heads/main\n"), None).unwrap().0, "main");
        assert!(parse_remote_branch(&format!("{oid}\trefs/heads/main\n{oid}\trefs/heads/paper\n"), None).is_err());
        assert!(parse_remote_branch("", None).is_err());
    }

    #[test]
    fn collaboration_poll_fetches_only_new_heads_and_preserves_dirty_drafts() {
        collaboration_roundtrip("master");
    }

    #[test]
    fn collaboration_works_when_only_main_exists_on_the_remote() {
        collaboration_roundtrip("main");
    }

    fn collaboration_roundtrip(branch: &str) {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root = env::temp_dir().join(format!("linco-overleaf-collaboration-{nonce}"));
        let remote = root.join("overleaf-origin.git");
        let author = root.join("author");
        let local = root.join("local");
        std::fs::create_dir_all(&root).unwrap();

        test_git(&root, &["init", "--bare", remote.to_str().unwrap()]);
        test_git(&remote, &["symbolic-ref", "HEAD", &format!("refs/heads/{branch}")]);
        std::fs::create_dir_all(&author).unwrap();
        test_git(&author, &["init", "-b", branch]);
        configure_test_author(&author);
        std::fs::write(author.join("main.tex"), "version one\n").unwrap();
        test_git(&author, &["add", "main.tex"]);
        test_git(&author, &["commit", "-m", "initial"]);
        test_git(
            &author,
            &["remote", "add", "overleaf", remote.to_str().unwrap()],
        );
        test_git(&author, &["push", "-u", "overleaf", branch]);
        test_git(
            &root,
            &[
                "clone",
                "--origin",
                "overleaf",
                remote.to_str().unwrap(),
                local.to_str().unwrap(),
            ],
        );
        configure_test_author(&local);

        let local_path = local.to_string_lossy().to_string();
        let first = collaboration_poll(&local_path, Some("test-token"), &None).unwrap();
        assert!(first.remote_updated);
        assert!(!first.incoming);
        assert!(!first.pending);
        let unchanged = collaboration_poll(&local_path, Some("test-token"), &None).unwrap();
        assert!(!unchanged.remote_updated);
        assert!(unchanged.info.is_none());

        std::fs::write(author.join("main.tex"), "version two\n").unwrap();
        test_git(&author, &["add", "main.tex"]);
        test_git(&author, &["commit", "-m", "collaborator update"]);
        test_git(&author, &["push", "overleaf", branch]);

        let fetched = collaboration_poll(&local_path, Some("test-token"), &None).unwrap();
        assert!(fetched.remote_updated);
        assert!(fetched.incoming);
        assert!(!fetched.applied);
        assert!(fetched.pending);
        assert_eq!(
            std::fs::read_to_string(local.join("main.tex")).unwrap(),
            "version one\n"
        );

        let applied = collaboration_apply(&local_path, &None).unwrap();
        assert!(applied.applied);
        assert!(!applied.pending);
        assert_eq!(
            std::fs::read_to_string(local.join("main.tex")).unwrap(),
            "version two\n"
        );

        std::fs::write(local.join("main.tex"), "local draft\n").unwrap();
        std::fs::write(author.join("main.tex"), "version three\n").unwrap();
        test_git(&author, &["add", "main.tex"]);
        test_git(
            &author,
            &["commit", "-m", "overlapping collaborator update"],
        );
        test_git(&author, &["push", "overleaf", branch]);

        let pending = collaboration_poll(&local_path, Some("test-token"), &None).unwrap();
        assert!(pending.remote_updated);
        assert!(pending.incoming);
        assert!(!pending.applied);
        assert!(pending.pending);
        let guarded = collaboration_apply(&local_path, &None).unwrap();
        assert!(!guarded.applied);
        assert!(guarded.pending);
        assert_eq!(
            std::fs::read_to_string(local.join("main.tex")).unwrap(),
            "local draft\n"
        );

        let _ = std::fs::remove_dir_all(root);
    }
}
