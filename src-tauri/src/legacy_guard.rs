#[test]
fn retired_structured_agent_path_does_not_reappear() {
    let repo = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .expect("src-tauri should have a parent");
    let roots = [repo.join("src"), repo.join("src-tauri").join("src")];
    let forbidden = [
        concat!("stream", "-json"),
        concat!("output", "-format"),
        concat!("agent", "_send"),
        concat!("agent", "-event"),
        concat!("agent", "-done"),
    ];

    let mut hits = Vec::new();
    for root in roots {
        scan_source_tree(&root, &forbidden, &mut hits);
    }

    assert!(
        hits.is_empty(),
        "retired structured agent path is still referenced:\n{}",
        hits.join("\n")
    );
}

fn scan_source_tree(root: &std::path::Path, forbidden: &[&str], hits: &mut Vec<String>) {
    let Ok(entries) = std::fs::read_dir(root) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            scan_source_tree(&path, forbidden, hits);
            continue;
        }
        let Some(name) = path.file_name().and_then(|n| n.to_str()) else {
            continue;
        };
        if name == "legacy_guard.rs" {
            continue;
        }
        let Some(ext) = path.extension().and_then(|e| e.to_str()) else {
            continue;
        };
        if !matches!(ext, "rs" | "ts" | "tsx") {
            continue;
        }
        let Ok(text) = std::fs::read_to_string(&path) else {
            continue;
        };
        for needle in forbidden {
            if text.contains(needle) {
                hits.push(format!("{} contains {needle}", path.display()));
            }
        }
    }
}
