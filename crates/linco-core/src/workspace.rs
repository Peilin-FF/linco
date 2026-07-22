use std::ffi::OsString;
use std::fs;
use std::path::{Component, Path, PathBuf};

use crate::CoreError;

/// A canonical, directory-only workspace boundary.
///
/// All untrusted paths accepted by this type must be relative. Existing targets (including
/// symlinks) are canonicalized and checked against the root. For a not-yet-created target, its
/// nearest existing ancestor is canonicalized first so a symlink cannot redirect creation outside
/// the workspace.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WorkspaceRoot {
    canonical: PathBuf,
}

impl WorkspaceRoot {
    pub fn open(path: impl AsRef<Path>) -> Result<Self, CoreError> {
        let original = path.as_ref().to_path_buf();
        let canonical =
            fs::canonicalize(&original).map_err(|source| CoreError::WorkspaceRootUnavailable {
                path: original.clone(),
                source,
            })?;
        if !canonical.is_dir() {
            return Err(CoreError::WorkspaceRootNotDirectory(canonical));
        }
        Ok(Self { canonical })
    }

    pub fn as_path(&self) -> &Path {
        &self.canonical
    }

    pub fn resolve_existing(&self, relative: impl AsRef<Path>) -> Result<PathBuf, CoreError> {
        let clean = clean_relative(relative.as_ref())?;
        let candidate = self.canonical.join(clean);
        let resolved =
            fs::canonicalize(&candidate).map_err(|source| CoreError::WorkspacePathUnavailable {
                path: candidate.clone(),
                source,
            })?;
        self.require_inside(resolved)
    }

    pub fn resolve_existing_dir(&self, relative: impl AsRef<Path>) -> Result<PathBuf, CoreError> {
        let resolved = self.resolve_existing(relative)?;
        if !resolved.is_dir() {
            return Err(CoreError::WorkspacePathNotDirectory(resolved));
        }
        Ok(resolved)
    }

    /// Resolves a path whose leaf may not exist yet.
    ///
    /// This performs boundary validation, not the eventual filesystem mutation. Callers handling
    /// hostile concurrent local writers should still use descriptor-relative open/create APIs to
    /// eliminate time-of-check/time-of-use races.
    pub fn resolve_for_create(&self, relative: impl AsRef<Path>) -> Result<PathBuf, CoreError> {
        let clean = clean_relative(relative.as_ref())?;
        let candidate = self.canonical.join(clean);

        let mut ancestor = candidate.as_path();
        let mut missing: Vec<OsString> = Vec::new();
        loop {
            match fs::symlink_metadata(ancestor) {
                Ok(_) => break,
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                    let name = ancestor.file_name().ok_or_else(|| {
                        CoreError::InvalidWorkspacePath(relative.as_ref().to_path_buf())
                    })?;
                    missing.push(name.to_os_string());
                    ancestor = ancestor.parent().ok_or_else(|| {
                        CoreError::InvalidWorkspacePath(relative.as_ref().to_path_buf())
                    })?;
                }
                Err(source) => {
                    return Err(CoreError::WorkspacePathUnavailable {
                        path: ancestor.to_path_buf(),
                        source,
                    });
                }
            }
        }

        let canonical_ancestor =
            fs::canonicalize(ancestor).map_err(|source| CoreError::WorkspacePathUnavailable {
                path: ancestor.to_path_buf(),
                source,
            })?;
        let mut resolved = self.require_inside(canonical_ancestor)?;
        for component in missing.iter().rev() {
            resolved.push(component);
        }
        Ok(resolved)
    }

    fn require_inside(&self, resolved: PathBuf) -> Result<PathBuf, CoreError> {
        if resolved == self.canonical || resolved.starts_with(&self.canonical) {
            Ok(resolved)
        } else {
            Err(CoreError::WorkspaceEscape(resolved))
        }
    }
}

fn clean_relative(path: &Path) -> Result<PathBuf, CoreError> {
    let mut clean = PathBuf::new();
    for component in path.components() {
        match component {
            Component::Normal(value) => clean.push(value),
            Component::CurDir => {}
            Component::ParentDir | Component::RootDir | Component::Prefix(_) => {
                return Err(CoreError::InvalidWorkspacePath(path.to_path_buf()));
            }
        }
    }
    Ok(clean)
}

#[cfg(test)]
mod tests {
    use std::fs;

    use tempfile::tempdir;

    use super::*;

    #[test]
    fn rejects_absolute_and_parent_traversal_paths() {
        let temp = tempdir().unwrap();
        let root = WorkspaceRoot::open(temp.path()).unwrap();

        assert!(matches!(
            root.resolve_for_create("../escape"),
            Err(CoreError::InvalidWorkspacePath(_))
        ));
        assert!(matches!(
            root.resolve_existing(temp.path()),
            Err(CoreError::InvalidWorkspacePath(_))
        ));
    }

    #[test]
    fn resolves_existing_and_future_paths_inside_root() {
        let temp = tempdir().unwrap();
        fs::create_dir(temp.path().join("src")).unwrap();
        fs::write(temp.path().join("src/lib.rs"), b"").unwrap();
        let root = WorkspaceRoot::open(temp.path()).unwrap();

        assert_eq!(
            root.resolve_existing("src/./lib.rs").unwrap(),
            fs::canonicalize(temp.path().join("src/lib.rs")).unwrap()
        );
        assert_eq!(
            root.resolve_for_create("src/new/nested.rs").unwrap(),
            fs::canonicalize(temp.path().join("src"))
                .unwrap()
                .join("new/nested.rs")
        );
    }

    #[cfg(unix)]
    #[test]
    fn rejects_symlinks_that_escape_the_workspace() {
        use std::os::unix::fs::symlink;

        let workspace = tempdir().unwrap();
        let outside = tempdir().unwrap();
        symlink(outside.path(), workspace.path().join("outside-link")).unwrap();
        let root = WorkspaceRoot::open(workspace.path()).unwrap();

        assert!(matches!(
            root.resolve_for_create("outside-link/new.txt"),
            Err(CoreError::WorkspaceEscape(_))
        ));
    }

    #[cfg(windows)]
    #[test]
    fn rejects_directory_links_that_escape_when_symlink_creation_is_available() {
        use std::os::windows::fs::symlink_dir;

        let workspace = tempdir().unwrap();
        let outside = tempdir().unwrap();
        if symlink_dir(outside.path(), workspace.path().join("outside-link")).is_err() {
            return;
        }
        let root = WorkspaceRoot::open(workspace.path()).unwrap();
        assert!(matches!(
            root.resolve_for_create("outside-link/new.txt"),
            Err(CoreError::WorkspaceEscape(_))
        ));
    }
}
