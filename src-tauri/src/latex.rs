use std::collections::HashMap;
use std::env;
use std::hash::{Hash, Hasher};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use base64::engine::general_purpose::STANDARD;
use base64::Engine;
use serde::Serialize;
use tauri::{AppHandle, Manager};

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
pub struct LatexCompileResult {
    pub success: bool,
    pub pdf_path: String,
    pub log: String,
    pub duration_ms: u64,
    pub tool_missing: bool,
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
    let mut env = HashMap::from([("GIT_TERMINAL_PROMPT".into(), "0".into())]);
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

fn run_git(
    host: &Option<String>,
    cwd: &str,
    args: &[&str],
    token: Option<&str>,
) -> Result<GitOutput, String> {
    let mut env = auth_env(token);
    let proxy = proxy_for(host);
    if !proxy.trim().is_empty() {
        for name in ["http_proxy", "https_proxy", "HTTP_PROXY", "HTTPS_PROXY"] {
            env.insert(name.into(), proxy.trim().into());
        }
    }

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
    let output = child
        .wait_with_output()
        .map_err(|error| error.to_string())?;
    if output.status.success() {
        Ok(())
    } else {
        Err(String::from_utf8_lossy(&output.stderr).trim().to_string())
    }
}

fn saved_token(url: &str) -> Option<String> {
    let host = url_host(url)?;
    let mut command = Command::new("git");
    command
        .args(["credential", "fill"])
        .env("GIT_TERMINAL_PROMPT", "0")
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
    let output = child.wait_with_output().ok()?;
    if !output.status.success() {
        return None;
    }
    String::from_utf8_lossy(&output.stdout)
        .lines()
        .find_map(|line| line.strip_prefix("password=").map(str::to_string))
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
    let counts = git_ok(
        host,
        repo,
        &[
            "rev-list",
            "--left-right",
            "--count",
            &format!("HEAD...{remote_name}/master"),
        ],
        None,
    )
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
    supplied
        .filter(|value| !value.trim().is_empty())
        .map(str::to_string)
        .or_else(|| saved_token(url))
        .ok_or_else(|| "OVERLEAF_AUTH_REQUIRED: Enter your Overleaf Git token".into())
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
        let (remote, url) = overleaf_remote(&host, &repo)?;
        let auth = token_for(&url, token.as_deref())?;
        git_ok(
            &host,
            &repo,
            &["pull", "--rebase", "--autostash", &remote, "master"],
            Some(&auth),
        )?;
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
        let (remote, url) = overleaf_remote(&host, &repo)?;
        let auth = token_for(&url, token.as_deref())?;
        git_ok(&host, &repo, &["add", "-A"], None)?;
        let staged = run_git(&host, &repo, &["diff", "--cached", "--quiet"], None)?;
        if staged.code == 1 {
            let name = git_ok(&host, &repo, &["config", "user.name"], None).unwrap_or_default();
            if name.trim().is_empty() {
                git_ok(&host, &repo, &["config", "user.name", "Linco Author"], None)?;
                git_ok(&host, &repo, &["config", "user.email", "linco@local"], None)?;
            }
            let commit_message = if message.trim().is_empty() {
                "Update manuscript from Linco"
            } else {
                message.trim()
            };
            git_ok(&host, &repo, &["commit", "-m", commit_message], None)?;
        } else if staged.code != 0 {
            return Err(staged.stderr);
        }
        git_ok(
            &host,
            &repo,
            &["pull", "--rebase", "--autostash", &remote, "master"],
            Some(&auth),
        )?;
        git_ok(&host, &repo, &["push", &remote, "HEAD:master"], Some(&auth))?;
        info(&host, &repo)
    })
    .await
}

fn compile_output_dir(repo: &str, host: &Option<String>) -> String {
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    repo.hash(&mut hasher);
    host.hash(&mut hasher);
    let key = format!("{:x}", hasher.finish());
    if host.as_deref().filter(|value| !value.is_empty()).is_some() {
        format!("/tmp/linco-latex-{key}")
    } else {
        std::env::temp_dir()
            .join("linco-latex")
            .join(key)
            .to_string_lossy()
            .to_string()
    }
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
const BUNDLED_TEX_SUPPLEMENT_VERSION: &str = "1";

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
        log = format!(
            "[Earlier compiler output omitted]\n{}",
            &log[log.len() - MAX_LOG..]
        );
    }
    log
}

#[tauri::command]
pub async fn latex_compile(
    app: AppHandle,
    repo: String,
    main_file: String,
    engine: String,
    host: Option<String>,
) -> Result<LatexCompileResult, String> {
    crate::blocking::run(move || {
        let started = Instant::now();
        let flag = compiler_flag(&engine)?;
        let relative = main_file
            .strip_prefix(repo.trim_end_matches(['/', '\\']))
            .unwrap_or(&main_file)
            .trim_start_matches(['/', '\\'])
            .to_string();
        if relative.is_empty() || relative.split(['/', '\\']).any(|part| part == "..") {
            return Err("The main TeX file must be inside the project".into());
        }
        let stem = Path::new(&relative)
            .file_stem()
            .and_then(|value| value.to_str())
            .ok_or("Invalid main TeX filename")?;
        let output_dir = compile_output_dir(&repo, &host);
        let pdf_path = if host.as_deref().filter(|value| !value.is_empty()).is_some() {
            format!("{output_dir}/{stem}.pdf")
        } else {
            Path::new(&output_dir)
                .join(format!("{stem}.pdf"))
                .to_string_lossy()
                .to_string()
        };

        let output = if let Some(remote_host) = host.as_deref().filter(|value| !value.is_empty()) {
            let command = format!(
                "mkdir -p -- {out} && cd -- {repo} && if command -v latexmk >/dev/null 2>&1; then latexmk {flag} -interaction=nonstopmode -file-line-error -synctex=1 -halt-on-error -outdir={out} {main}; else echo __LINCO_LATEX_MISSING__ >&2; exit 127; fi",
                out = crate::remote::shq(&output_dir),
                repo = crate::remote::shq(&repo),
                main = crate::remote::shq(&relative),
            );
            let value = crate::agent_rpc::call_background_timeout(
                remote_host,
                "shell",
                serde_json::json!({ "cmd": command, "timeout": 180 }),
                Duration::from_secs(190),
            )?;
            let stdout = value
                .get("stdout_b64")
                .and_then(|item| item.as_str())
                .and_then(|value| STANDARD.decode(value).ok())
                .map(|value| String::from_utf8_lossy(&value).to_string())
                .unwrap_or_default();
            GitOutput {
                code: value.get("code").and_then(|item| item.as_i64()).unwrap_or(-1) as i32,
                stdout,
                stderr: value
                    .get("stderr")
                    .and_then(|item| item.as_str())
                    .unwrap_or_default()
                    .to_string(),
            }
        } else {
            std::fs::create_dir_all(&output_dir).map_err(|error| error.to_string())?;
            match ensure_local_latexmk(&app) {
                Ok(latexmk) => {
                    let mut command = Command::new(&latexmk);
                    let out_arg = format!("-outdir={output_dir}");
                    command.current_dir(&repo).args([
                        flag,
                        "-interaction=nonstopmode",
                        "-file-line-error",
                        "-synctex=1",
                        "-halt-on-error",
                        &out_arg,
                        &relative,
                    ]);
                    prepend_executable_dir(&mut command, &latexmk);
                    crate::proc_ext::no_window(&mut command);
                    match command.output() {
                        Ok(output) => GitOutput {
                            code: output.status.code().unwrap_or(-1),
                            stdout: String::from_utf8_lossy(&output.stdout).to_string(),
                            stderr: String::from_utf8_lossy(&output.stderr).to_string(),
                        },
                        Err(error) => GitOutput {
                            code: 126,
                            stdout: String::new(),
                            stderr: format!("Unable to run bundled latexmk: {error}"),
                        },
                    }
                }
                Err(error) => GitOutput {
                    code: 127,
                    stdout: String::new(),
                    stderr: format!("__LINCO_LATEX_MISSING__\n{error}"),
                },
            }
        };
        let tool_missing = output.code == 127 || output.stderr.contains("__LINCO_LATEX_MISSING__");
        let log = trim_log(format!("{}{}", output.stdout, output.stderr));
        Ok(LatexCompileResult {
            success: output.code == 0,
            pdf_path,
            log,
            duration_ms: started.elapsed().as_millis() as u64,
            tool_missing,
        })
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

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
}
