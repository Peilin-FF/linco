//! Reuse a successful, immutable PDF only after rechecking its source and inputs.
//! Cache failures are always a normal cache miss, never a compilation failure.
use crate::latex::LatexCompileResult;
use crate::latex_snapshot::fingerprint;
use serde::{Deserialize, Serialize};
use std::collections::BTreeSet;
use std::path::{Path, PathBuf};

#[derive(Serialize, Deserialize)]
struct Input {
    path: PathBuf,
    sha256: String,
}

fn file_hash(path: &Path, total: &mut u64) -> Option<String> {
    let before = std::fs::metadata(path).ok()?;
    if !before.is_file() || before.len() > 50 * 1024 * 1024 { return None; }
    *total += before.len();
    if *total > 256 * 1024 * 1024 { return None; }
    let bytes = std::fs::read(path).ok()?;
    let after = std::fs::metadata(path).ok()?;
    if before.len() != after.len() || before.modified().ok()? != after.modified().ok()? { return None; }
    Some(fingerprint(&bytes))
}

/// Includes new/deleted figures, bibliography and style files, not just the open editor buffer.
/// Large or non-regular trees opt out of caching; compilation itself remains available.
pub fn local_source_signature(root: &Path) -> Option<String> {
    fn visit(root: &Path, dir: &Path, paths: &mut BTreeSet<PathBuf>, visited: &mut usize, depth: usize) -> Option<()> {
        if depth > 12 { return None; }
        for entry in std::fs::read_dir(dir).ok()? {
            let entry = entry.ok()?;
            *visited += 1;
            if *visited > 10000 { return None; }
            let name = entry.file_name().to_string_lossy().into_owned();
            if name.starts_with('.') { continue; }
            let kind = entry.file_type().ok()?;
            if kind.is_symlink() { return None; }
            if kind.is_dir() {
                if ["node_modules", "target", "dist", "build", "__pycache__", "venv", "checkpoints", "wandb"].contains(&name.as_str()) { continue; }
                visit(root, &entry.path(), paths, visited, depth + 1)?;
            } else if kind.is_file() {
                let extension = entry.path().extension().map(|value| value.to_string_lossy().to_ascii_lowercase()).unwrap_or_default();
                if ["tex", "bib", "bst", "sty", "cls", "cfg", "def", "fd", "clo", "ldf", "bbx", "cbx", "lbx", "pdf", "eps", "png", "jpg", "jpeg", "svg", "webp", "csv", "tsv", "dat", "txt", "otf", "ttf", "map", "enc", "pfb", "tfm", "vf", "lua"].contains(&extension.as_str()) {
                    paths.insert(entry.path().strip_prefix(root).ok()?.to_path_buf());
                    if paths.len() > 2000 { return None; }
                }
            } else { return None; }
        }
        Some(())
    }
    let mut paths = BTreeSet::new();
    visit(root, root, &mut paths, &mut 0, 0)?;
    let mut total = 0;
    let mut files = Vec::new();
    for relative in paths {
        files.push((relative.clone(), file_hash(&root.join(&relative), &mut total)?));
    }
    Some(fingerprint(&serde_json::to_vec(&files).ok()?))
}

#[derive(Serialize, Deserialize)]
struct Entry {
    version: u8,
    source: String,
    inputs: Vec<Input>,
    pdf_sha256: String,
    result: LatexCompileResult,
}

pub fn load(file: &Path, source: &str, jobs: &Path) -> Option<LatexCompileResult> {
    if std::fs::metadata(file).ok()?.len() > 2_000_000 { return None; }
    let entry: Entry = serde_json::from_slice(&std::fs::read(file).ok()?).ok()?;
    if entry.version != 1 || entry.source != source || !entry.result.success || entry.inputs.is_empty() { return None; }
    let pdf = Path::new(&entry.result.pdf_path).canonicalize().ok()?;
    let provenance = Path::new(&entry.result.provenance_path).canonicalize().ok()?;
    let jobs = jobs.canonicalize().ok()?;
    if !pdf.starts_with(&jobs) || !provenance.starts_with(&jobs) || !provenance.is_file() { return None; }
    let mut total = 0;
    for input in entry.inputs {
        if file_hash(&input.path, &mut total)? != input.sha256 { return None; }
    }
    if file_hash(&pdf, &mut total)? != entry.pdf_sha256 { return None; }
    Some(entry.result)
}

pub fn save(file: &Path, source: &str, working: &Path, build_output: &Path, latexmk: &Path, result: &LatexCompileResult) -> Option<()> {
    if !result.success { return None; }
    let pdf = Path::new(&result.pdf_path);
    let output = build_output.canonicalize().ok()?;
    let recorder = pdf.with_extension("fls");
    if std::fs::metadata(&recorder).ok()?.len() > 2_000_000 { return None; }
    let text = std::fs::read_to_string(recorder).ok()?;
    let mut paths = BTreeSet::new();
    for line in text.lines().filter_map(|line| line.strip_prefix("INPUT ")) {
        let input = Path::new(line.trim().trim_matches('"'));
        let absolute = if input.is_absolute() { input.to_path_buf() } else { working.join(input) };
        let absolute = absolute.canonicalize().ok()?;
        if !absolute.starts_with(&output) { paths.insert(absolute); }
    }
    if paths.is_empty() || paths.len() > 2000 { return None; }
    paths.insert(latexmk.canonicalize().ok()?);
    // Package-manager changes can change TeX lookup precedence even for old names.
    if let Some(runtime) = latexmk.parent().and_then(Path::parent).and_then(Path::parent) {
        let inventory = runtime.join("tlpkg/texlive.tlpdb");
        if inventory.is_file() { paths.insert(inventory); }
    }
    let mut total = 0;
    let mut inputs = Vec::new();
    for path in paths { inputs.push(Input { sha256: file_hash(&path, &mut total)?, path }); }
    let entry = Entry { version: 1, source: source.into(), inputs, pdf_sha256: file_hash(pdf, &mut total)?, result: result.clone() };
    std::fs::create_dir_all(file.parent()?).ok()?;
    let temporary = file.with_extension(format!("{}-{}.tmp", std::process::id(), std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).ok()?.as_nanos()));
    std::fs::write(&temporary, serde_json::to_vec(&entry).ok()?).ok()?;
    if std::fs::rename(&temporary, file).is_err() {
        let _ = std::fs::remove_file(&temporary);
        return None;
    }
    Some(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn cached_pdf_is_reused_only_while_recorded_inputs_and_output_match() {
        let root = std::env::temp_dir().join(format!("linco-latex-cache-roundtrip-{}-{}", std::process::id(), std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()));
        let source = root.join("source");
        let jobs = root.join("jobs");
        let output = jobs.join("job/output");
        std::fs::create_dir_all(&source).unwrap();
        std::fs::create_dir_all(&output).unwrap();
        let main = source.join("main.tex");
        let compiler = root.join("latexmk-test-only");
        let pdf = output.join("main.pdf");
        let provenance = jobs.join("job/provenance.json");
        std::fs::write(&main, "source version one").unwrap();
        std::fs::write(&compiler, "not executable; cache unit-test fixture").unwrap();
        std::fs::write(&pdf, "%PDF-1.4\nsynthetic fixture").unwrap();
        std::fs::write(&provenance, "{}").unwrap();
        std::fs::write(pdf.with_extension("fls"), format!("INPUT {}\n", main.display())).unwrap();
        let result = LatexCompileResult {
            success: true, pdf_path: pdf.to_string_lossy().into_owned(), log: "fixture".into(), duration_ms: 1,
            tool_missing: false, pdf_is_local: true, provenance_path: provenance.to_string_lossy().into_owned(), cached: false,
        };
        let file = root.join("cache/entry.json");
        save(&file, "version-one", &source, &output, &compiler, &result).unwrap();
        assert!(load(&file, "version-one", &jobs).is_some());
        assert!(load(&file, "different-source", &jobs).is_none());
        // Also exercises atomic replacement of an existing cache entry on Windows.
        save(&file, "version-one", &source, &output, &compiler, &result).unwrap();
        std::fs::write(&pdf, "%PDF-1.4\nmodified output").unwrap();
        assert!(load(&file, "version-one", &jobs).is_none());
        std::fs::write(&pdf, "%PDF-1.4\nsynthetic fixture").unwrap();
        std::fs::write(&main, "source version two").unwrap();
        assert!(load(&file, "version-one", &jobs).is_none());
        std::fs::write(&main, "source version one").unwrap();
        std::fs::remove_file(&provenance).unwrap();
        assert!(load(&file, "version-one", &jobs).is_none());
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn all_paper_inputs_invalidate_the_signature() {
        let root = std::env::temp_dir().join(format!("linco-latex-cache-test-{}-{}", std::process::id(), std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()));
        std::fs::create_dir(&root).unwrap();
        std::fs::write(root.join("main.tex"), b"test").unwrap();
        let initial = local_source_signature(&root).unwrap();
        assert_eq!(local_source_signature(&root).unwrap(), initial);
        for name in ["chapter.tex", "refs.bib", "plot.png", "style.sty"] {
            std::fs::write(root.join(name), b"one").unwrap();
            let added = local_source_signature(&root).unwrap();
            assert_ne!(initial, added);
            std::fs::write(root.join(name), b"two").unwrap();
            assert_ne!(local_source_signature(&root).unwrap(), added);
            std::fs::remove_file(root.join(name)).unwrap();
            assert_eq!(local_source_signature(&root).unwrap(), initial);
        }
        std::fs::remove_dir_all(root).unwrap();
    }
}
