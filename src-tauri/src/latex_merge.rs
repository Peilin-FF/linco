//! Snapshot-based Overleaf merging. Git objects are prepared away from the
//! working tree; only a verified, conflict-free result is fast-forwarded into it.
use super::*;
use std::sync::{Arc, MutexGuard};

const MAX_TEXT: usize = 256_000;
const MAX_CONFLICTS: usize = 32;

struct Prepared {
    head: String,
    branch: String,
    remote_head: String,
    remote_ref: String,
    tree: String,
    pending_files: usize,
    #[cfg(test)]
    auto_combined: usize,
}

pub(super) fn repo_lock(host: &Option<String>, repo: &str) -> Arc<Mutex<()>> {
    static LOCKS: OnceLock<Mutex<HashMap<String, Arc<Mutex<()>>>>> = OnceLock::new();
    let mut locks = LOCKS.get_or_init(|| Mutex::new(HashMap::new())).lock().unwrap_or_else(|e| e.into_inner());
    locks.entry(collaboration_repo_key(host, repo)).or_insert_with(|| Arc::new(Mutex::new(()))).clone()
}

pub(super) fn lock(lock: &Mutex<()>) -> Result<MutexGuard<'_, ()>, String> {
    lock.lock().map_err(|_| "Another paper sync failed. Reopen the project before syncing.".into())
}

fn oid(text: &str) -> Result<String, String> {
    let value = text.trim();
    if ![40, 64].contains(&value.len()) || !value.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err("Git returned an invalid object identifier.".into());
    }
    Ok(value.to_string())
}

fn current_head(host: &Option<String>, repo: &str) -> Result<String, String> {
    oid(&git_ok(host, repo, &["rev-parse", "HEAD"], None)?)
}

fn ensure_no_operation(host: &Option<String>, repo: &str) -> Result<(), String> {
    if !git_ok(host, repo, &["ls-files", "--unmerged"], None)?.trim().is_empty() {
        return Err("OVERLEAF_GIT_STATE: This project already has unresolved Git files. Finish that operation before syncing; Linco has not aborted it.".into());
    }
    for reference in ["MERGE_HEAD", "REBASE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD"] {
        if run_git(host, repo, &["rev-parse", "--verify", "--quiet", reference], None)?.code == 0 {
            return Err("OVERLEAF_GIT_STATE: Another Git operation is in progress. Finish it before syncing; Linco has not aborted it.".into());
        }
    }
    Ok(())
}

fn clean(host: &Option<String>, repo: &str) -> Result<bool, String> {
    Ok(git_ok(host, repo, &["status", "--porcelain", "--untracked-files=all"], None)?.trim().is_empty())
}

fn ensure_author(host: &Option<String>, repo: &str) -> Result<(), String> {
    for (key, fallback) in [("user.name", "Linco Author"), ("user.email", "linco@local")] {
        if git_ok(host, repo, &["config", key], None).unwrap_or_default().trim().is_empty() {
            git_ok(host, repo, &["config", key, fallback], None)?;
        }
    }
    Ok(())
}

/// Pull/publish keep a real Git checkpoint of saved edits, not an autostash which
/// can conflict after a seemingly successful rebase. Nothing is published here.
pub(super) fn checkpoint(host: &Option<String>, repo: &str, message: &str) -> Result<(), String> {
    ensure_no_operation(host, repo)?;
    if clean(host, repo)? { return Ok(()); }
    ensure_author(host, repo)?;
    git_ok(host, repo, &["add", "-A"], None)?;
    let staged = run_git(host, repo, &["diff", "--cached", "--quiet"], None)?;
    if staged.code == 1 {
        git_ok(host, repo, &["commit", "-m", message], None)?;
    } else if staged.code != 0 { return Err(staged.stderr); }
    if !clean(host, repo)? { return Err("OVERLEAF_MERGE_STALE: Files changed while saving the checkpoint. Your edits remain on disk; retry when editing has paused.".into()); }
    Ok(())
}

fn safe_path(path: &str) -> bool {
    !path.is_empty() && path.len() < 2048 && !path.contains(['\\', '\0', '\r', '\n'])
        && path.split('/').all(|p| !p.is_empty() && p != "." && p != ".." && !p.eq_ignore_ascii_case(".git"))
}

fn read_text(host: &Option<String>, repo: &str, revision: &str, path: &str) -> Result<Option<(String, String)>, String> {
    let listing = git_ok(host, repo, &["--literal-pathspecs", "ls-tree", "--full-tree", "-z", revision, "--", path], None)?;
    if listing.is_empty() { return Ok(None); }
    let record = listing.strip_suffix('\0').ok_or("Invalid Git tree entry")?;
    let (metadata, actual_path) = record.split_once('\t').ok_or("Invalid Git tree entry")?;
    let parts = metadata.split_whitespace().collect::<Vec<_>>();
    if actual_path != path || parts.len() != 3 || parts[1] != "blob" || !["100644", "100755"].contains(&parts[0]) {
        return Err("This file type or rename needs a Git merge tool; no file has been replaced.".into());
    }
    let size: usize = git_ok(host, repo, &["cat-file", "-s", parts[2]], None)?.trim().parse().map_err(|_| "Invalid Git blob size")?;
    if size > MAX_TEXT { return Err("This file exceeds the automatic text merge limit.".into()); }
    let text = git_ok(host, repo, &["cat-file", "blob", parts[2]], None)?;
    if text.contains(['\0', '\u{fffd}']) { return Err("Binary or non-UTF-8 content needs a Git merge tool.".into()); }
    Ok(Some((parts[0].to_string(), text)))
}

/// A conservative refinement of Git's line conflicts: combine two distinct
/// character spans (e.g. separate sentences on one LaTeX line). Overlapping
/// replacements/deletions and competing insertions are never guessed.
fn combine_spans(base: &str, ours: &str, theirs: &str) -> Option<String> {
    if ours == theirs || theirs == base { return Some(ours.into()); }
    if ours == base { return Some(theirs.into()); }
    let base = base.chars().collect::<Vec<_>>();
    fn edit(base: &[char], text: &str) -> (usize, usize, Vec<char>) {
        let next = text.chars().collect::<Vec<_>>();
        let start = base.iter().zip(&next).take_while(|(a, b)| a == b).count();
        let tail = base[start..].iter().rev().zip(next[start..].iter().rev()).take_while(|(a, b)| a == b).count();
        (start, base.len() - tail, next[start..next.len() - tail].to_vec())
    }
    let mut a = edit(&base, ours);
    let mut b = edit(&base, theirs);
    if b.0 < a.0 { std::mem::swap(&mut a, &mut b); }
    // Even disjoint letters may alter the same word, number or LaTeX command
    // (cat -> bat / car must not become bar). Require a whitespace boundary.
    if a.1 >= b.0 || !base[a.1..b.0].iter().any(|ch| ch.is_whitespace()) { return None; }
    Some(base[..a.0].iter().chain(a.2.iter()).chain(base[a.1..b.0].iter()).chain(b.2.iter()).chain(base[b.1..].iter()).collect())
}

fn input_git(host: &Option<String>, repo: &str, args: &[&str], input: &str) -> Result<String, String> {
    if input.len() > 2_000_000 { return Err("Merge data exceeds the safe transfer limit.".into()); }
    let result = if let Some(remote_host) = host.as_deref().filter(|host| !host.is_empty()) {
        let result = crate::agent_rpc::call_background_timeout(remote_host, "git_input", serde_json::json!({
            "repo": repo, "args": args, "input": input, "timeout": 30,
        }), Duration::from_secs(35)).map_err(|error| if error.contains("unknown op") {
            "OVERLEAF_MERGE_BACKEND_UPDATE: Reconnect this remote in the updated Linco app to enable safe merge transfers.".into()
        } else { error })?;
        GitOutput { code: result["code"].as_i64().unwrap_or(-1) as i32, stdout: result["stdout"].as_str().unwrap_or_default().into(), stderr: result["stderr"].as_str().unwrap_or_default().into() }
    } else {
        let mut command = Command::new("git");
        command.current_dir(repo).args(args).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped()).envs(auth_env(None));
        crate::proc_ext::no_window(&mut command);
        let mut child = command.spawn().map_err(|e| e.to_string())?;
        if let Err(error) = child.stdin.take().ok_or("Missing Git input")?.write_all(input.as_bytes()) {
            kill_child_tree(&mut child);
            return Err(error.to_string());
        }
        wait_child_output(child, Duration::from_secs(30))?
    };
    if result.code != 0 { return Err(format!("Git could not prepare the merge: {}", result.stderr.trim())); }
    Ok(result.stdout)
}

// Rebuild only the affected path in immutable Git trees. No temporary index,
// worktree, checkout, or conflict markers are written into the user's files.
fn replace_blob(host: &Option<String>, repo: &str, tree: &str, path: &str, blob: &str) -> Result<String, String> {
    let (name, rest) = path.split_once('/').map_or((path, None), |(name, rest)| (name, Some(rest)));
    let listing = git_ok(host, repo, &["ls-tree", "-z", tree], None)?;
    if listing.contains('\u{fffd}') {
        return Err("A directory contains non-UTF-8 file names; automatic merging cannot safely rebuild it.".into());
    }
    let mut found = false;
    let mut next = String::new();
    for record in listing.split('\0').filter(|r| !r.is_empty()) {
        let (metadata, entry_name) = record.split_once('\t').ok_or("Invalid Git tree entry")?;
        if entry_name == name {
            found = true;
            let parts = metadata.split_whitespace().collect::<Vec<_>>();
            if parts.len() != 3 { return Err("Invalid Git tree entry".into()); }
            let replacement = if let Some(rest) = rest {
                if parts[1] != "tree" { return Err("Directory/file conflicts need a Git merge tool.".into()); }
                replace_blob(host, repo, parts[2], rest, blob)?
            } else {
                if parts[1] != "blob" || !["100644", "100755"].contains(&parts[0]) { return Err("Unsupported merge file mode.".into()); }
                blob.to_string()
            };
            next.push_str(&format!("{} {} {}\t{}\0", parts[0], parts[1], replacement, name));
        } else { next.push_str(record); next.push('\0'); }
    }
    if !found { return Err("The conflicting file moved or was deleted. Review it with a Git merge tool.".into()); }
    oid(&input_git(host, repo, &["mktree", "-z"], &next)?)
}

// Refine each Git diff3 hunk independently, keeping Git's compatible edits
// outside those hunks verbatim. Existing marker-looking content is never parsed.
fn combine_hunks(base: &str, ours: &str, theirs: &str, merged: &str) -> Option<String> {
    fn marker(line: &str) -> bool {
        line.starts_with("<<<<<<<") || line.starts_with("|||||||")
            || line.trim_end_matches(['\r', '\n']) == "=======" || line.starts_with(">>>>>>>")
    }
    if [base, ours, theirs].iter().any(|text| text.lines().any(marker)) { return None; }
    let mut output = String::new();
    let mut local = String::new();
    let mut ancestor = String::new();
    let mut remote = String::new();
    let mut phase = 0;
    let mut hunks = 0;
    for line in merged.split_inclusive('\n') {
        let bare = line.trim_end_matches(['\r', '\n']);
        if line.starts_with("<<<<<<< ") && phase == 0 {
            phase = 1; local.clear(); ancestor.clear(); remote.clear();
        } else if line.starts_with("||||||| ") && phase == 1 {
            phase = 2;
        } else if bare == "=======" && phase == 2 {
            phase = 3;
        } else if line.starts_with(">>>>>>> ") && phase == 3 {
            output.push_str(&combine_spans(&ancestor, &local, &remote)?);
            phase = 0; hunks += 1;
        } else if marker(line) {
            return None;
        } else {
            match phase {
                0 => output.push_str(line),
                1 => local.push_str(line),
                2 => ancestor.push_str(line),
                3 => remote.push_str(line),
                _ => return None,
            }
        }
    }
    if phase == 0 && hunks > 0 { Some(output) } else { None }
}

fn prepare(host: &Option<String>, repo: &str, remote_ref: &str) -> Result<Prepared, String> {
    ensure_no_operation(host, repo)?;
    let head = current_head(host, repo)?;
    let branch = git_ok(host, repo, &["symbolic-ref", "--quiet", "HEAD"], None)?.trim().to_string();
    let remote_head = oid(&git_ok(host, repo, &["rev-parse", remote_ref], None)?)?;
    let bases = git_ok(host, repo, &["merge-base", "--all", &head, &remote_head], None)?;
    let bases = bases.lines().collect::<Vec<_>>();
    if bases.len() != 1 { return Err("This history has no unique shared base. Your draft is unchanged; use Git to join the histories.".into()); }
    let result = run_git(host, repo, &["-c", "merge.conflictStyle=diff3", "merge-tree", "--write-tree", "--name-only", "--no-messages", "-z", &head, &remote_head], None)?;
    if ![0, 1].contains(&result.code) {
        return Err(format!("OVERLEAF_SYNC_FAILED: Git could not prepare a safe merge (Git 2.38+ is required). {}", result.stderr.trim()));
    }
    let mut records = result.stdout.split('\0');
    let mut tree = oid(records.next().unwrap_or_default())?;
    let paths = records.take_while(|r| !r.is_empty()).collect::<Vec<_>>();
    if result.code == 1 && paths.is_empty() { return Err("Git could not identify the incompatible files. The draft is unchanged.".into()); }
    let mut pending_files = 0;
    #[cfg(test)]
    let mut auto_combined = 0;
    for path in &paths {
        // Unusual/large/binary/delete-modify cases stay in the saved histories.
        // We never write Git markers into the manuscript or select a winner.
        if paths.len() > MAX_CONFLICTS || !safe_path(path) { pending_files += 1; continue; }
        let content = (|| -> Result<_, String> {
            let base = read_text(host, repo, bases[0], path)?.ok_or("No shared file")?;
            let ours = read_text(host, repo, &head, path)?.ok_or("File deleted locally")?;
            let theirs = read_text(host, repo, &remote_head, path)?.ok_or("File deleted remotely")?;
            let merged = read_text(host, repo, &tree, path)?.ok_or("No merged file")?;
            if ours.0 != theirs.0 || ours.0 != base.0 { return Err("File-mode change".into()); }
            Ok((base.1, ours.1, theirs.1, merged.1))
        })();
        if let Ok((base, ours, theirs, merged)) = content {
            if let Some(combined) = combine_hunks(&base, &ours, &theirs, &merged) {
                let blob = oid(&input_git(host, repo, &["hash-object", "-w", "--stdin"], &combined)?)?;
                tree = replace_blob(host, repo, &tree, path, &blob)?;
                #[cfg(test)]
                { auto_combined += 1; }
                continue;
            }
        }
        pending_files += 1;
    }
    Ok(Prepared { head, branch, remote_head, remote_ref: remote_ref.into(), tree, pending_files, #[cfg(test)] auto_combined })
}

fn ensure_current(host: &Option<String>, repo: &str, prepared: &Prepared) -> Result<(), String> {
    ensure_no_operation(host, repo)?;
    if current_head(host, repo)? != prepared.head
        || git_ok(host, repo, &["symbolic-ref", "--quiet", "HEAD"], None)?.trim() != prepared.branch
        || git_ok(host, repo, &["rev-parse", &prepared.remote_ref], None)?.trim() != prepared.remote_head
        || !clean(host, repo)? {
        return Err("OVERLEAF_MERGE_STALE: The draft or fetched revision changed during sync. Your newer edits are preserved; sync will retry.".into());
    }
    Ok(())
}

fn commit_prepared(host: &Option<String>, repo: &str, prepared: &Prepared) -> Result<(), String> {
    ensure_current(host, repo, prepared)?;
    if prepared.pending_files > 0 { return Err(pending_message(prepared)); }
    if run_git(host, repo, &["merge-base", "--is-ancestor", &prepared.remote_head, &prepared.head], None)?.code == 0 { return Ok(()); }
    if run_git(host, repo, &["merge-base", "--is-ancestor", &prepared.head, &prepared.remote_head], None)?.code == 0 {
        git_ok(host, repo, &["merge", "--ff-only", "--no-edit", &prepared.remote_head], None)?;
        return Ok(());
    }
    ensure_author(host, repo)?;
    let commit = oid(&git_ok(host, repo, &["commit-tree", &prepared.tree, "-p", &prepared.head, "-p", &prepared.remote_head, "-m", "Merge Overleaf changes in Linco (both histories preserved)"], None)?)?;
    ensure_current(host, repo, prepared)?;
    // Git's fast-forward checkout refuses to overwrite concurrent working edits.
    // Both previous heads are parents; no rebase, reset, or forced push is used.
    git_ok(host, repo, &["merge", "--ff-only", "--no-edit", &commit], None)?;
    Ok(())
}

fn pending_message(prepared: &Prepared) -> String {
    format!("OVERLEAF_SYNC_PENDING: {} {}. Both versions are saved in Git; {} file(s) cannot yet be combined automatically. Nothing was overwritten or published.", prepared.head, prepared.remote_head, prepared.pending_files)
}

pub(super) fn integrate(host: &Option<String>, repo: &str, remote_ref: &str) -> Result<(), String> {
    let prepared = prepare(host, repo, remote_ref)?;
    commit_prepared(host, repo, &prepared)
}

#[cfg(test)]
mod tests {
    use super::*;

    const REMOTE: &str = "refs/remotes/overleaf/main";
    struct Fixture { root: PathBuf, repo: String }
    impl Fixture {
        fn git(&self, args: &[&str]) -> String { git_ok(&None, &self.repo, args, None).unwrap() }
        fn new(base: &str, ours: &str, theirs: &str) -> Self {
            let nonce = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos();
            let root = env::temp_dir().join(format!("linco-safe-paper-merge-{}-{nonce}", std::process::id()));
            std::fs::create_dir(&root).unwrap();
            let fixture = Self { repo: root.to_string_lossy().into(), root };
            fixture.git(&["init", "-b", "main"]);
            fixture.git(&["config", "user.name", "Linco test"]);
            fixture.git(&["config", "user.email", "test@example.invalid"]);
            fixture.git(&["config", "core.autocrlf", "false"]);
            std::fs::create_dir(fixture.root.join("section")).unwrap();
            std::fs::write(fixture.root.join("section/intro.tex"), base).unwrap();
            std::fs::write(fixture.root.join("untouched.tex"), "untouched\n").unwrap();
            fixture.git(&["add", "-A"]); fixture.git(&["commit", "-m", "base"]);
            let base_head = fixture.git(&["rev-parse", "HEAD"]);
            std::fs::write(fixture.root.join("section/intro.tex"), ours).unwrap();
            fixture.git(&["add", "-A"]); fixture.git(&["commit", "--allow-empty", "-m", "local edit"]);
            fixture.git(&["switch", "-c", "other", base_head.trim()]);
            std::fs::write(fixture.root.join("section/intro.tex"), theirs).unwrap();
            fixture.git(&["add", "-A"]); fixture.git(&["commit", "--allow-empty", "-m", "collaborator edit"]);
            let remote = fixture.git(&["rev-parse", "HEAD"]);
            fixture.git(&["update-ref", REMOTE, remote.trim()]);
            fixture.git(&["switch", "main"]);
            fixture.git(&["remote", "add", "overleaf", "https://overleaf.example.invalid/paper"]);
            fixture.git(&["branch", "--set-upstream-to=overleaf/main", "main"]);
            fixture
        }
        fn text(&self) -> String { std::fs::read_to_string(self.root.join("section/intro.tex")).unwrap() }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            if self.root.parent() == Some(env::temp_dir().as_path())
                && self.root.file_name().unwrap_or_default().to_string_lossy().starts_with("linco-safe-paper-merge-") {
                let _ = std::fs::remove_dir_all(&self.root);
            }
        }
    }

    #[test]
    fn distinct_sentence_edits_combine_but_competing_meaning_does_not() {
        assert_eq!(combine_spans("Batch 4; seed 1.", "Batch 8; seed 1.", "Batch 4; seed 2."), Some("Batch 8; seed 2.".into()));
        assert_eq!(combine_spans("α x; β y", "α z; β y", "α x; β 🧪"), Some("α z; β 🧪".into()));
        assert_eq!(combine_spans("result 4", "result 8", "result 2"), None);
        assert_eq!(combine_spans("/section{}\n", "\\section{Introduction}\n", "\n"), None);
        assert_eq!(combine_spans("a", "ab", "ac"), None);
        assert_eq!(combine_spans("abc", "aXbc", "aYbc"), None);
        assert_eq!(combine_spans("cat", "bat", "car"), None);
        assert_eq!(combine_spans("1.23", "2.23", "1.24"), None);
        assert_eq!(combine_spans("same", "same", "same"), Some("same".into()));
    }

    #[test]
    fn true_overlap_is_pending_without_markers_or_rewriting_either_history() {
        let f = Fixture::new("/section{}\n\n$x^2$\n", "\\section{Introduction}\n\n$x^2$\n", "\n\n$x^2$\n");
        let before = f.git(&["rev-parse", "HEAD"]);
        let remote = f.git(&["rev-parse", REMOTE]);
        let error = integrate(&None, &f.repo, REMOTE).unwrap_err();
        assert!(error.contains("OVERLEAF_SYNC_PENDING"));
        assert!(error.contains(remote.trim()));
        assert_eq!(before, f.git(&["rev-parse", "HEAD"]));
        assert_eq!(remote, f.git(&["rev-parse", REMOTE]));
        assert!(f.git(&["status", "--porcelain"]).is_empty());
        assert!(f.git(&["ls-files", "--unmerged"]).is_empty());
        assert_eq!(f.text(), "\\section{Introduction}\n\n$x^2$\n");
    }

    #[test]
    fn independent_edits_on_one_line_merge_and_preserve_both_histories() {
        let f = Fixture::new("Batch 4; seed 1.\n", "Batch 8; seed 1.\n", "Batch 4; seed 2.\n");
        let prepared = prepare(&None, &f.repo, REMOTE).unwrap();
        assert_eq!(prepared.pending_files, 0);
        assert_eq!(prepared.auto_combined, 1);
        commit_prepared(&None, &f.repo, &prepared).unwrap();
        assert_eq!(f.text(), "Batch 8; seed 2.\n");
        let parents = f.git(&["rev-list", "--parents", "-n", "1", "HEAD"]);
        assert!(parents.contains(&prepared.head) && parents.contains(&prepared.remote_head));
        assert_eq!(f.git(&["rev-parse", REMOTE]).trim(), prepared.remote_head);
        assert_eq!(std::fs::read_to_string(f.root.join("untouched.tex")).unwrap(), "untouched\n");
        let head = f.git(&["rev-parse", "HEAD"]);
        integrate(&None, &f.repo, REMOTE).unwrap();
        assert_eq!(head, f.git(&["rev-parse", "HEAD"]));
    }

    #[test]
    fn separate_hunks_preserve_all_edits_outside_the_hunks() {
        let spacer = "\n\nunchanged a\nunchanged b\nunchanged c\nunchanged d\n\n\n";
        let base = format!("Batch 4; seed 1.\n{spacer}Rate 3; epoch 4.\n{spacer}Conclusion.\n");
        let ours = base.replace("Batch 4", "Batch 8").replace("Rate 3", "Rate 6");
        let theirs = base.replace("seed 1", "seed 2").replace("epoch 4", "epoch 9").replace("Conclusion.", "Collaborator conclusion.");
        let f = Fixture::new(&base, &ours, &theirs);
        integrate(&None, &f.repo, REMOTE).unwrap();
        assert_eq!(f.text(), ours.replace("seed 1", "seed 2").replace("epoch 4", "epoch 9").replace("Conclusion.", "Collaborator conclusion."));
    }

    #[test]
    fn stale_worktree_remote_head_and_branch_are_never_overwritten() {
        let f = Fixture::new("Batch 4; seed 1.\n", "Batch 8; seed 1.\n", "Batch 4; seed 2.\n");
        let prepared = prepare(&None, &f.repo, REMOTE).unwrap();
        std::fs::write(f.root.join("section/intro.tex"), "New author text\n").unwrap();
        assert!(commit_prepared(&None, &f.repo, &prepared).unwrap_err().contains("OVERLEAF_MERGE_STALE"));
        assert_eq!(f.text(), "New author text\n");
        std::fs::write(f.root.join("section/intro.tex"), "Batch 8; seed 1.\n").unwrap();
        f.git(&["update-ref", REMOTE, &prepared.head]);
        assert!(commit_prepared(&None, &f.repo, &prepared).unwrap_err().contains("OVERLEAF_MERGE_STALE"));
        f.git(&["update-ref", REMOTE, &prepared.remote_head]);
        f.git(&["switch", "-c", "another-local-branch"]);
        assert!(commit_prepared(&None, &f.repo, &prepared).unwrap_err().contains("OVERLEAF_MERGE_STALE"));
        assert_eq!(f.git(&["rev-parse", "HEAD"]).trim(), prepared.head);
    }

    #[test]
    fn checkpoint_keeps_dirty_notes_and_does_not_abort_existing_git_operations() {
        let f = Fixture::new("Base\n", "Ours\n", "Theirs\n");
        std::fs::write(f.root.join("notes.tex"), "Local research notes\n").unwrap();
        let before = f.git(&["rev-parse", "HEAD"]);
        checkpoint(&None, &f.repo, "Save test checkpoint").unwrap();
        assert_ne!(before, f.git(&["rev-parse", "HEAD"]));
        assert_eq!(f.git(&["show", "HEAD:notes.tex"]), "Local research notes\n");
        let merge = run_git(&None, &f.repo, &["merge", "--no-edit", REMOTE], None).unwrap();
        assert_eq!(merge.code, 1);
        let unfinished = f.git(&["ls-files", "--unmerged"]);
        assert!(!unfinished.is_empty());
        assert!(checkpoint(&None, &f.repo, "must not abort").unwrap_err().contains("OVERLEAF_GIT_STATE"));
        assert_eq!(unfinished, f.git(&["ls-files", "--unmerged"]));
        assert_eq!(run_git(&None, &f.repo, &["rev-parse", "--verify", "MERGE_HEAD"], None).unwrap().code, 0);
    }

    #[test]
    fn binary_and_delete_modify_cases_remain_saved_and_pending() {
        let f = Fixture::new("base\0\n", "ours\0\n", "theirs\0\n");
        assert!(integrate(&None, &f.repo, REMOTE).unwrap_err().contains("OVERLEAF_SYNC_PENDING"));
        assert_eq!(f.text(), "ours\0\n");
        f.git(&["rm", "section/intro.tex"]); f.git(&["commit", "-m", "delete local file"]);
        assert!(integrate(&None, &f.repo, REMOTE).unwrap_err().contains("OVERLEAF_SYNC_PENDING"));
        assert!(!f.root.join("section/intro.tex").exists());
        assert!(!safe_path("../paper.tex"));
        assert!(!safe_path("section/../paper.tex"));
        assert!(!safe_path(".git/config"));
        assert!(safe_path("section/研究.tex"));
    }

    #[test]
    fn malformed_or_existing_markers_are_not_guessed_and_crlf_is_preserved() {
        let good = "before\r\n<<<<<<< ours\r\nBatch 8; seed 1.\r\n||||||| base\r\nBatch 4; seed 1.\r\n=======\r\nBatch 4; seed 2.\r\n>>>>>>> theirs\r\nafter\r\n";
        assert_eq!(combine_hunks("", "", "", good), Some("before\r\nBatch 8; seed 2.\r\nafter\r\n".into()));
        assert_eq!(combine_hunks("<<<<<<< literal", "", "", good), None);
        assert_eq!(combine_hunks("", "", "", &good.replace("||||||| base\r\n", "")), None);
        assert_eq!(combine_hunks("", "", "", &good.replace(">>>>>>> theirs\r\n", "")), None);
    }
}
