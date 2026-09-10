//! Mutable, app-owned incremental build state. Published jobs remain immutable.
use std::collections::BTreeSet;
use std::fs::{self, File, OpenOptions, TryLockError};
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

/// The OS releases this lock even if Linco crashes. Different desktop windows
/// must never synchronize sources or run latexmk in the same directory at once.
pub fn lock(directory: &Path) -> Result<File, String> {
    fs::create_dir_all(directory).map_err(|e| e.to_string())?;
    let file = OpenOptions::new().read(true).write(true).create(true).truncate(false)
        .open(directory.join("build.lock")).map_err(|e| e.to_string())?;
    let deadline = Instant::now() + Duration::from_secs(30);
    loop {
        match file.try_lock() {
            Ok(()) => return Ok(file),
            Err(TryLockError::WouldBlock) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(50)),
            Err(TryLockError::WouldBlock) => return Err("This paper is still compiling in another window. Wait for that build, then retry.".into()),
            Err(error) => return Err(format!("Unable to lock the local paper build: {error}")),
        }
    }
}

fn inventory(root: &Path) -> Result<(BTreeSet<PathBuf>, Vec<PathBuf>), String> {
    fn visit(root: &Path, dir: &Path, files: &mut BTreeSet<PathBuf>, dirs: &mut Vec<PathBuf>, depth: usize) -> Result<(), String> {
        if depth > 32 || files.len() + dirs.len() > 5000 { return Err("Build source tree is too large".into()); }
        for entry in fs::read_dir(dir).map_err(|e| e.to_string())? {
            let entry = entry.map_err(|e| e.to_string())?;
            let kind = entry.file_type().map_err(|e| e.to_string())?;
            let path = entry.path();
            let relative = path.strip_prefix(root).map_err(|e| e.to_string())?.to_path_buf();
            if kind.is_dir() {
                dirs.push(relative);
                visit(root, &path, files, dirs, depth + 1)?;
            } else if kind.is_file() { files.insert(relative); }
            else { return Err("Non-regular files are not allowed in the local build mirror".into()); }
        }
        Ok(())
    }
    if fs::symlink_metadata(root).map_err(|e| e.to_string())?.file_type().is_symlink() {
        return Err("A build mirror cannot be a symbolic link".into());
    }
    let mut files = BTreeSet::new();
    let mut dirs = Vec::new();
    visit(root, root, &mut files, &mut dirs, 0)?;
    Ok((files, dirs))
}

/// Both directories belong to Linco, never to the user's repository. The capture
/// has already passed snapshot validation. Preserve unchanged source mtimes so
/// latexmk can reuse .aux/.bbl/.fdb_latexmk state after a small edit.
pub fn sync_sources(capture: &Path, mirror: &Path) -> Result<usize, String> {
    fs::create_dir_all(mirror).map_err(|e| e.to_string())?;
    let (next, _) = inventory(capture)?;
    let (old, mut dirs) = inventory(mirror)?;
    let mut changed = 0;
    for relative in old.difference(&next) {
        // Only ordinary files discovered inside this private mirror are removed.
        fs::remove_file(mirror.join(relative)).map_err(|e| e.to_string())?;
        changed += 1;
    }
    dirs.sort_by_key(|path| std::cmp::Reverse(path.components().count()));
    for relative in dirs {
        // Remove empty directories to support file/directory renames, never recursively.
        let path = mirror.join(relative);
        if fs::read_dir(&path).map_err(|e| e.to_string())?.next().is_none() {
            fs::remove_dir(path).map_err(|e| e.to_string())?;
        }
    }
    for relative in next {
        let target = mirror.join(&relative);
        let bytes = fs::read(capture.join(relative)).map_err(|e| e.to_string())?;
        if fs::read(&target).is_ok_and(|previous| previous == bytes) { continue; }
        fs::create_dir_all(target.parent().ok_or("Invalid build source path")?).map_err(|e| e.to_string())?;
        fs::write(target, bytes).map_err(|e| e.to_string())?;
        changed += 1;
    }
    Ok(changed)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn mirror_preserves_unchanged_inputs_and_handles_deleted_and_renamed_files() {
        let root = std::env::temp_dir().join(format!("linco-incremental-test-{}-{}", std::process::id(), std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()));
        let capture = root.join("capture");
        let mirror = root.join("mirror");
        fs::create_dir_all(capture.join("section")).unwrap();
        fs::write(capture.join("main.tex"), "main v1").unwrap();
        fs::write(capture.join("section/intro.tex"), "intro").unwrap();
        assert_eq!(sync_sources(&capture, &mirror).unwrap(), 2);
        let before = fs::metadata(mirror.join("section/intro.tex")).unwrap().modified().unwrap();
        assert_eq!(sync_sources(&capture, &mirror).unwrap(), 0);
        fs::write(capture.join("main.tex"), "main v2").unwrap();
        assert_eq!(sync_sources(&capture, &mirror).unwrap(), 1);
        assert_eq!(fs::metadata(mirror.join("section/intro.tex")).unwrap().modified().unwrap(), before);
        fs::remove_file(capture.join("section/intro.tex")).unwrap();
        fs::remove_dir(capture.join("section")).unwrap();
        fs::write(capture.join("section"), "changed to a file").unwrap();
        assert_eq!(sync_sources(&capture, &mirror).unwrap(), 2);
        assert!(!mirror.join("section/intro.tex").exists());
        assert_eq!(fs::read_to_string(mirror.join("main.tex")).unwrap(), "main v2");
        let first = lock(&root).unwrap();
        let second = OpenOptions::new().read(true).write(true).open(root.join("build.lock")).unwrap();
        assert!(matches!(second.try_lock(), Err(TryLockError::WouldBlock)));
        drop(first);
        second.try_lock().unwrap();
        drop(second);
        fs::remove_dir_all(root).unwrap();
    }
}
