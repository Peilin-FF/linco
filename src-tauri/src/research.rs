//! Explicit evidence capture for remote-context / local-production workflows.
use crate::latex_snapshot::{fingerprint, portable_relative, Snapshot, SnapshotFile};
use base64::{engine::general_purpose::STANDARD, Engine};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResearchSource {
    pub path: String,
    pub sha256: String,
    pub bytes: usize,
    pub text: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EvidenceReference {
    pub path: String,
    pub sha256: String,
    pub bytes: usize,
    pub excerpt: String,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResearchPacket {
    pub version: u32,
    pub directory: String,
    pub repo: String,
    pub host: Option<String>,
    pub captured_at: u64,
    pub sources: Vec<ResearchSource>,
}

pub fn evidence_path(path: &str) -> Result<PathBuf, String> {
    let relative = portable_relative(path)?;
    if path.split('/').any(|part| part.starts_with('.')) {
        return Err("Hidden files cannot be included in a research packet".into());
    }
    let extension = relative
        .extension()
        .and_then(|s| s.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    if ![
        "py", "rs", "js", "ts", "tsx", "jsx", "c", "h", "cpp", "cu", "r", "jl", "m", "sh", "md",
        "txt", "tex", "bib", "csv", "tsv", "json", "jsonl", "yaml", "yml", "toml",
    ]
    .contains(&extension.as_str())
    {
        return Err("Select text code, notes, configuration, bibliography, or tabular results (not executables or credentials)".into());
    }
    Ok(relative)
}

pub fn read_sources(
    repo: &str,
    paths: &[String],
    host: Option<&str>,
) -> Result<Vec<ResearchSource>, String> {
    if paths.is_empty() || paths.len() > 16 {
        return Err("Select between 1 and 16 evidence files".into());
    }
    let unique: std::collections::HashSet<_> = paths.iter().collect();
    if unique.len() != paths.len() {
        return Err("Remove duplicate evidence paths".into());
    }
    for path in paths {
        evidence_path(path)?;
    }
    let snapshot: Snapshot = if let Some(remote) = host.filter(|h| !h.is_empty()) {
        serde_json::from_value(crate::agent_rpc::call_background_timeout(
            remote,
            "research_snapshot",
            serde_json::json!({"repo": repo, "paths": paths}),
            Duration::from_secs(45),
        )?)
        .map_err(|e| e.to_string())?
    } else {
        use std::io::Read;
        let root = Path::new(repo).canonicalize().map_err(|e| e.to_string())?;
        if root.parent().is_none() {
            return Err("Select a research directory, not a filesystem root".into());
        }
        let mut files = Vec::new();
        for path in paths {
            let mut absolute = root.clone();
            for part in path.split('/') {
                absolute.push(part);
                if std::fs::symlink_metadata(&absolute)
                    .map_err(|e| e.to_string())?
                    .file_type()
                    .is_symlink()
                {
                    return Err(format!("Evidence cannot follow symlinks: {path}"));
                }
            }
            let mut file = std::fs::File::open(&absolute).map_err(|e| e.to_string())?;
            let before = file.metadata().map_err(|e| e.to_string())?;
            if !before.is_file() || before.len() > 1_048_576 {
                return Err("Evidence files must be regular text files of at most 1 MiB".into());
            }
            let mut data = Vec::new();
            (&mut file)
                .take(1_048_577)
                .read_to_end(&mut data)
                .map_err(|e| e.to_string())?;
            let after = file.metadata().map_err(|e| e.to_string())?;
            if before.len() != data.len() as u64 || before.modified().ok() != after.modified().ok()
            {
                return Err("Evidence changed during capture; retry".into());
            }
            files.push(SnapshotFile {
                path: path.clone(),
                data: STANDARD.encode(data),
            });
        }
        Snapshot { files }
    };
    if snapshot.files.len() != paths.len() {
        return Err("Evidence snapshot is incomplete".into());
    }
    let mut seen = std::collections::HashSet::new();
    let mut total = 0;
    snapshot
        .files
        .into_iter()
        .map(|file| {
            if !unique.contains(&file.path) || !seen.insert(file.path.clone()) {
                return Err("Unexpected file in research snapshot".into());
            }
            let data = STANDARD.decode(&file.data).map_err(|e| e.to_string())?;
            total += data.len();
            if data.len() > 1_048_576 || total > 8 * 1_048_576 || data.contains(&0) {
                return Err("Research packet exceeds text transfer limits".into());
            }
            Ok(ResearchSource {
                path: file.path,
                sha256: fingerprint(&data),
                bytes: data.len(),
                text: String::from_utf8(data).map_err(|_| "Evidence must be UTF-8 text")?,
            })
        })
        .collect()
}

#[tauri::command]
pub async fn research_capture(
    app: tauri::AppHandle,
    repo: String,
    paths: Vec<String>,
    host: Option<String>,
) -> Result<ResearchPacket, String> {
    crate::blocking::run(move || {
        let sources = read_sources(&repo, &paths, host.as_deref())?;
        let directory = crate::latex_snapshot::new_job(&app, "research")?;
        let packet = ResearchPacket {
            version: 1,
            directory: directory.to_string_lossy().into_owned(),
            repo,
            host,
            captured_at: SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map_err(|e| e.to_string())?
                .as_secs(),
            sources,
        };
        // Preserve exact source bytes and their hashes, not just an AI summary.
        for source in &packet.sources {
            let destination = directory.join("sources").join(evidence_path(&source.path)?);
            std::fs::create_dir_all(destination.parent().ok_or("Invalid evidence destination")?)
                .map_err(|e| e.to_string())?;
            std::fs::write(destination, &source.text).map_err(|e| e.to_string())?;
        }
        std::fs::write(
            directory.join("research-packet.json"),
            serde_json::to_vec_pretty(&packet).map_err(|e| e.to_string())?,
        )
        .map_err(|e| e.to_string())?;
        Ok(packet)
    })
    .await
}

fn owned_job(app: &tauri::AppHandle, directory: &str) -> Result<PathBuf, String> {
    use tauri::Manager;
    let root = app
        .path()
        .app_local_data_dir()
        .map_err(|e| e.to_string())?
        .join("production-jobs")
        .canonicalize()
        .map_err(|e| e.to_string())?;
    let path = Path::new(directory)
        .canonicalize()
        .map_err(|e| e.to_string())?;
    if path.parent() != Some(root.as_path()) {
        return Err("Select a Linco production job".into());
    }
    Ok(path)
}

fn load_packet(app: &tauri::AppHandle, directory: &str) -> Result<ResearchPacket, String> {
    use std::io::Read;
    let job = owned_job(app, directory)?;
    let file = std::fs::File::open(job.join("research-packet.json")).map_err(|e| e.to_string())?;
    let mut data = Vec::new();
    file.take(16_777_217)
        .read_to_end(&mut data)
        .map_err(|e| e.to_string())?;
    if data.len() > 16_777_216 {
        return Err("Saved research packet exceeds its size limit".into());
    }
    let mut packet: ResearchPacket = serde_json::from_slice(&data).map_err(|e| e.to_string())?;
    if packet.version != 1 || packet.sources.is_empty() || packet.sources.len() > 16 {
        return Err("Unsupported research packet".into());
    }
    let mut total = 0;
    let mut seen = std::collections::HashSet::new();
    for source in &packet.sources {
        evidence_path(&source.path)?;
        total += source.text.len();
        if !seen.insert(&source.path)
            || source.bytes != source.text.len()
            || source.bytes > 1_048_576
            || total > 8_388_608
            || source.sha256 != fingerprint(source.text.as_bytes())
        {
            return Err(
                "Saved research packet failed its integrity check; capture the source again".into(),
            );
        }
    }
    packet.directory = job.to_string_lossy().into_owned();
    Ok(packet)
}

#[tauri::command]
pub async fn research_load(
    app: tauri::AppHandle,
    directory: String,
) -> Result<ResearchPacket, String> {
    crate::blocking::run(move || load_packet(&app, &directory)).await
}

#[tauri::command]
pub async fn research_save_figure(
    app: tauri::AppHandle,
    packet_directory: String,
    recipe: serde_json::Value,
    svg: String,
    marks: serde_json::Value,
) -> Result<String, String> {
    crate::blocking::run(move || {
        let packet = load_packet(&app, &packet_directory)?;
        let path = recipe["sourcePath"].as_str().ok_or("Figure source is missing")?;
        let source = packet.sources.iter().find(|s| s.path == path).ok_or("Figure source is not in the captured packet")?;
        if recipe["sourceSha256"].as_str() != Some(source.sha256.as_str()) || fingerprint(source.text.as_bytes()) != source.sha256 {
            return Err("Figure source fingerprint does not match the captured bytes".into());
        }
        if svg.len() > 1_000_000 || !svg.starts_with("<svg ") { return Err("Invalid vector figure".into()); }
        let items = marks.as_array().ok_or("Invalid figure layout")?;
        if items.len() > 200 { return Err("Figure has too many objects".into()); }
        for item in items {
            for field in ["x", "y", "width", "height"] {
                let value = item[field].as_f64().ok_or("Invalid figure geometry")?;
                if !value.is_finite() || value < 0.0 || value > 516.0 { return Err("Figure geometry is outside the academic canvas".into()); }
            }
            if item["x"].as_f64().unwrap() + item["width"].as_f64().unwrap() > 516.1 || item["y"].as_f64().unwrap() + item["height"].as_f64().unwrap() > 326.1 { return Err("Figure object extends outside the canvas".into()); }
        }
        let job = crate::latex_snapshot::new_job(&app, "figure")?;
        std::fs::write(job.join("figure.svg"), svg).map_err(|e| e.to_string())?;
        std::fs::write(job.join("source-data.txt"), &source.text).map_err(|e| e.to_string())?;
        std::fs::write(job.join("figure-recipe.json"), serde_json::to_vec_pretty(&serde_json::json!({
            "version": 1, "renderer": "linco-result-figure-v1", "lincoVersion": env!("CARGO_PKG_VERSION"),
            "recipe": recipe, "marks": marks, "packetDirectory": packet_directory,
            "sourceHost": packet.host, "sourceRepo": packet.repo, "capturedAt": packet.captured_at,
            "note": "Exact captured values; no aggregation, interpolation, statistical tests or inferred error bars."
        })).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
        Ok(job.to_string_lossy().into_owned())
    }).await
}

#[tauri::command]
pub async fn research_powerpoint(
    app: tauri::AppHandle,
    directory: String,
    save: bool,
) -> Result<serde_json::Value, String> {
    #[cfg(not(windows))]
    {
        let _ = (app, directory, save);
        Err("Editable PowerPoint production currently requires local Windows PowerPoint. SVG export works on all supported desktop platforms.".into())
    }
    #[cfg(windows)]
    crate::blocking::run(move || {
        use std::io::Read;
        use tauri::Manager;
        let job = owned_job(&app, &directory)?;
        let resources = app.path().resource_dir().map_err(|e| e.to_string())?;
        let mut script = resources.join("research/render-research-powerpoint.mjs");
        if !script.exists() { script = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../scripts/render-research-powerpoint.mjs"); }
        let mut server = resources.join("codex/powerpoint-live/scripts/server.mjs");
        if !server.exists() { server = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../vendor/HTML-VibeCoding/codex/powerpoint-live/scripts/server.mjs"); }
        let mut command = crate::proc_ext::cli_command("node", &[]);
        let output = std::fs::File::create(job.join("powerpoint.log")).map_err(|e| e.to_string())?;
        command.arg(script).arg(server).arg(&job).arg(if save { "save" } else { "prepare" })
            .current_dir(&job).stdin(std::process::Stdio::null()).stdout(output.try_clone().map_err(|e| e.to_string())?).stderr(output);
        let mut child = command.spawn().map_err(|e| format!("Unable to start the local PowerPoint bridge (Node.js required): {e}"))?;
        let deadline = std::time::Instant::now() + Duration::from_secs(120);
        let status = loop {
            if let Some(status) = child.try_wait().map_err(|e| e.to_string())? { break status; }
            if std::time::Instant::now() > deadline {
                let _ = crate::proc_ext::background_command("taskkill").args(["/PID", &child.id().to_string(), "/T", "/F"]).output();
                let _ = child.wait();
                return Err("PowerPoint preparation timed out. Your remote repository is unchanged.".into());
            }
            std::thread::sleep(Duration::from_millis(100));
        };
        if !status.success() {
            let mut message = String::new();
            std::fs::File::open(job.join("powerpoint.log")).map_err(|e| e.to_string())?.take(6000).read_to_string(&mut message).map_err(|e| e.to_string())?;
            return Err(message);
        }
        Ok(serde_json::json!({"presentationPath": job.join("figure.pptx"), "previewPath": job.join("figure-preview.png"), "saved": save}))
    }).await
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn accepts_only_explicit_non_hidden_text_evidence() {
        for path in [
            "../a.py",
            "/a.py",
            ".env",
            "a/.ssh/key.txt",
            "a/key.pem",
            "a/run.exe",
            "x/CON.csv",
        ] {
            assert!(evidence_path(path).is_err(), "{path}");
        }
        for path in [
            "training/model.py",
            "outputs/eval.json",
            "results.csv",
            "notes/conclusions.md",
        ] {
            assert!(evidence_path(path).is_ok(), "{path}");
        }
    }
}
