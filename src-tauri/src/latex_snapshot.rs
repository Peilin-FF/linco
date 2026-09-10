use base64::engine::general_purpose::STANDARD;
use base64::Engine;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::HashSet;
use std::path::{Path, PathBuf};

#[derive(Deserialize, Serialize)]
pub struct SnapshotFile {
    pub path: String,
    pub data: String,
}

#[derive(Deserialize, Serialize)]
pub struct Snapshot {
    pub files: Vec<SnapshotFile>,
}

pub fn fingerprint(data: &[u8]) -> String {
    format!("{:x}", Sha256::digest(data))
}

pub fn new_job(app: &tauri::AppHandle, kind: &str) -> Result<PathBuf, String> {
    use tauri::Manager;
    let root = app
        .path()
        .app_local_data_dir()
        .map_err(|e| e.to_string())?
        .join("production-jobs");
    std::fs::create_dir_all(&root).map_err(|e| e.to_string())?;
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|e| e.to_string())?
        .as_nanos();
    let directory = root.join(format!("{kind}-{}-{stamp}", std::process::id()));
    std::fs::create_dir(&directory).map_err(|e| e.to_string())?;
    Ok(directory)
}

pub fn portable_relative(path: &str) -> Result<PathBuf, String> {
    if path.is_empty() || path.len() > 200 {
        return Err("Paper path is empty or too long for the local compiler".into());
    }
    for part in path.split('/') {
        let stem = part.split('.').next().unwrap_or("").to_ascii_uppercase();
        if part.is_empty()
            || part == "."
            || part == ".."
            || part.ends_with(['.', ' '])
            || part
                .chars()
                .any(|c| c.is_control() || "\\:<>\"|?*".contains(c))
            || matches!(stem.as_str(), "CON" | "PRN" | "AUX" | "NUL")
            || (stem.len() == 4
                && (stem.starts_with("COM") || stem.starts_with("LPT"))
                && matches!(stem.as_bytes()[3], b'1'..=b'9'))
        {
            return Err(format!(
                "Paper path cannot be safely copied to this computer: {path}"
            ));
        }
    }
    Ok(path.split('/').collect())
}

pub fn materialize(snapshot: Snapshot, destination: &Path) -> Result<usize, String> {
    if snapshot.files.len() > 2000 {
        return Err("Paper snapshot exceeds 2000 files".into());
    }
    // Validate the entire manifest before writing any files; reject collisions
    // even on case-sensitive clients so the same paper behaves on Windows/Mac.
    let mut paths = HashSet::new();
    let mut prepared = Vec::new();
    let mut total = 0usize;
    for file in snapshot.files {
        let path = portable_relative(&file.path)?;
        if !paths.insert(file.path.to_lowercase()) {
            return Err(format!("Case-colliding paper filename: {}", file.path));
        }
        if file.data.len() > 70 * 1024 * 1024 {
            return Err("Paper file exceeds the transfer limit".into());
        }
        let data = STANDARD
            .decode(&file.data)
            .map_err(|_| "Invalid paper snapshot data")?;
        total += data.len();
        if data.len() > 50 * 1024 * 1024 || total > 100 * 1024 * 1024 {
            return Err("Paper snapshot exceeds 100 MiB total or 50 MiB per file".into());
        }
        prepared.push((path, data));
    }
    for path in &paths {
        let mut parent = path.as_str();
        while let Some((prefix, _)) = parent.rsplit_once('/') {
            if paths.contains(prefix) {
                return Err(format!("File/directory-colliding paper path: {path}"));
            }
            parent = prefix;
        }
    }
    let count = prepared.len();
    // The caller owns a newly created directory. Never merge into a source repo.
    for (path, data) in prepared {
        let target = destination.join(path);
        std::fs::create_dir_all(target.parent().ok_or("Invalid paper path")?)
            .map_err(|e| e.to_string())?;
        std::fs::write(target, data).map_err(|e| e.to_string())?;
    }
    Ok(count)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn rejects_escaping_and_nonportable_paths() {
        for path in [
            "../paper.tex",
            "/paper.tex",
            "C:/paper.tex",
            "a\\b.tex",
            "a/../b",
            "a//b",
            "CON.tex",
            "aux.txt",
            "x/COM1.log",
            "a.",
            "a ",
            "",
        ] {
            assert!(portable_relative(path).is_err(), "{path}");
        }
        assert!(portable_relative("section/相关工作.tex").is_ok());
    }
    #[test]
    fn rejects_collisions_before_writing() {
        let snapshot = Snapshot {
            files: vec![
                SnapshotFile {
                    path: "Paper.tex".into(),
                    data: "YQ==".into(),
                },
                SnapshotFile {
                    path: "paper.tex".into(),
                    data: "Yg==".into(),
                },
            ],
        };
        assert!(materialize(snapshot, Path::new("unused"))
            .unwrap_err()
            .contains("colliding"));
        let snapshot = Snapshot {
            files: vec![
                SnapshotFile {
                    path: "Figures".into(),
                    data: "YQ==".into(),
                },
                SnapshotFile {
                    path: "figures/plot.pdf".into(),
                    data: "Yg==".into(),
                },
            ],
        };
        assert!(materialize(snapshot, Path::new("unused"))
            .unwrap_err()
            .contains("colliding"));
    }
}
