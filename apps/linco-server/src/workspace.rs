use std::{collections::HashMap, path::PathBuf};

use anyhow::{bail, Context};
use linco_core::WorkspaceRoot;
use linco_protocol::WorkspaceSummary;
use uuid::Uuid;

const WORKSPACE_NAMESPACE: Uuid = Uuid::from_u128(0x4df3b57e_37df_4fa4_a38b_f5a7f236b8d1);

#[derive(Debug, Clone)]
pub struct WorkspaceSpec {
    pub name: String,
    pub path: PathBuf,
}

impl WorkspaceSpec {
    pub fn parse(value: &str) -> anyhow::Result<Self> {
        let (name, path) = value
            .split_once('=')
            .context("workspace must use NAME=/absolute/path")?;
        let name = name.trim();
        let path = PathBuf::from(path.trim());
        if name.is_empty() || name.chars().count() > 80 {
            bail!("workspace name must contain 1 to 80 characters");
        }
        if !path.is_absolute() {
            bail!("workspace path must be absolute: {}", path.display());
        }
        Ok(Self {
            name: name.to_owned(),
            path,
        })
    }
}

#[derive(Debug, Clone)]
pub struct Workspace {
    pub id: Uuid,
    pub name: String,
    pub root: WorkspaceRoot,
}

#[derive(Debug, Clone)]
pub struct WorkspaceRegistry {
    entries: HashMap<Uuid, Workspace>,
}

impl WorkspaceRegistry {
    pub fn new(specs: &[WorkspaceSpec]) -> anyhow::Result<Self> {
        let mut entries = HashMap::new();
        for spec in specs {
            let root = WorkspaceRoot::open(&spec.path)
                .with_context(|| format!("open workspace {}={}", spec.name, spec.path.display()))?;
            let id = Uuid::new_v5(
                &WORKSPACE_NAMESPACE,
                root.as_path().to_string_lossy().as_bytes(),
            );
            if entries.contains_key(&id) {
                bail!("duplicate workspace root: {}", root.as_path().display());
            }
            entries.insert(
                id,
                Workspace {
                    id,
                    name: spec.name.clone(),
                    root,
                },
            );
        }
        Ok(Self { entries })
    }

    pub fn get(&self, id: Uuid) -> anyhow::Result<&Workspace> {
        self.entries
            .get(&id)
            .with_context(|| format!("workspace not found: {id}"))
    }

    pub fn list(&self) -> Vec<WorkspaceSummary> {
        let mut out = self
            .entries
            .values()
            .map(|workspace| WorkspaceSummary {
                id: workspace.id,
                name: workspace.name.clone(),
            })
            .collect::<Vec<_>>();
        out.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
        out
    }

    pub fn name_for_path(&self, path: &std::path::Path) -> Option<&str> {
        self.entries
            .values()
            .filter(|workspace| path.starts_with(workspace.root.as_path()))
            .max_by_key(|workspace| workspace.root.as_path().components().count())
            .map(|workspace| workspace.name.as_str())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_relative_workspace_paths() {
        assert!(WorkspaceSpec::parse("bad=relative/path").is_err());
    }

    #[test]
    fn ids_are_stable_for_the_same_canonical_root() {
        let temp = tempfile::tempdir().unwrap();
        let spec = WorkspaceSpec {
            name: "one".into(),
            path: temp.path().to_owned(),
        };
        let a = WorkspaceRegistry::new(std::slice::from_ref(&spec)).unwrap();
        let b = WorkspaceRegistry::new(&[WorkspaceSpec {
            name: "two".into(),
            path: temp.path().join("."),
        }])
        .unwrap();
        assert_eq!(a.list()[0].id, b.list()[0].id);
    }
}
