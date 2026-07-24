#[test]
fn retired_structured_agent_path_does_not_reappear() {
    let repo = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .expect("src-tauri should have a parent");
    let roots = [repo.join("src"), repo.join("src-tauri").join("src")];
    let forbidden = [
        concat!("stream", "-json"),
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

#[test]
fn retired_chat_completion_popup_does_not_reappear() {
    let repo = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .expect("src-tauri should have a parent");
    let roots = [repo.join("src"), repo.join("src-tauri").join("src")];
    let forbidden = [
        concat!("agent", "_completions"),
        concat!("load", "Completions"),
        concat!("Completion", "Item"),
        concat!("Completion", "Data"),
    ];

    let mut hits = Vec::new();
    for root in roots {
        scan_source_tree(&root, &forbidden, &mut hits);
    }

    assert!(
        hits.is_empty(),
        "retired chat completion popup is still referenced:\n{}",
        hits.join("\n")
    );
}

#[test]
fn release_updater_is_wired_for_signed_github_updates() {
    let repo = repo_root();
    let tauri_conf = read_json(&repo.join("src-tauri").join("tauri.conf.json"));
    assert_eq!(
        tauri_conf
            .pointer("/bundle/createUpdaterArtifacts")
            .and_then(serde_json::Value::as_bool),
        Some(true),
        "release builds must create signed updater artifacts"
    );

    let endpoint = tauri_conf
        .pointer("/plugins/updater/endpoints/0")
        .and_then(serde_json::Value::as_str)
        .unwrap_or_default();
    assert!(
        endpoint == "https://github.com/Peilin-FF/linco/releases/latest/download/latest.json",
        "updater endpoint should point at the GitHub latest.json release asset"
    );

    let pubkey = tauri_conf
        .pointer("/plugins/updater/pubkey")
        .and_then(serde_json::Value::as_str)
        .unwrap_or_default();
    assert!(
        pubkey.len() > 32 && !pubkey.contains("REPLACE"),
        "updater public key must be committed before release"
    );

    let permissions = read_json(
        &repo
            .join("src-tauri")
            .join("capabilities")
            .join("default.json"),
    );
    let permissions = permissions
        .pointer("/permissions")
        .and_then(serde_json::Value::as_array)
        .expect("default capability should declare permissions");
    assert!(
        permissions
            .iter()
            .any(|p| p.as_str() == Some("updater:default")),
        "frontend updater APIs must be granted"
    );
    assert!(
        permissions
            .iter()
            .any(|p| p.as_str() == Some("process:default")),
        "relaunch API must be granted after installing updates"
    );

    let lib = std::fs::read_to_string(repo.join("src-tauri").join("src").join("lib.rs"))
        .expect("read lib.rs");
    assert!(
        lib.contains("tauri_plugin_updater::Builder::new().build()"),
        "Rust side must register the updater plugin"
    );
    assert!(
        lib.contains("tauri_plugin_process::init()"),
        "Rust side must register the process plugin for relaunch"
    );
}

#[test]
fn update_notice_sits_immediately_left_of_connection_picker() {
    let repo = repo_root();
    let app = std::fs::read_to_string(repo.join("src").join("App.tsx")).expect("read App.tsx");
    assert!(
        app.contains("from '@tauri-apps/plugin-updater'")
            && app.contains("from '@tauri-apps/plugin-process'"),
        "update button must use Tauri updater and relaunch APIs"
    );

    let picker = app
        .find("<ConnectionPicker")
        .expect("ConnectionPicker should exist in header");
    let before_picker = &app[..picker];
    let spacer = before_picker
        .rfind("className=\"flex-1\"")
        .expect("header spacer should precede right-side controls");
    // 更新提示横幅:点击打开「新版更新内容」浮层(setShowUpdatePanel 切换),再决定安装。
    // 锚在切换 onClick(toggle),它在横幅文案 update.available 之前。
    let update_button = before_picker
        .rfind("setShowUpdatePanel((o)")
        .expect("update notice toggle should be rendered before ConnectionPicker");

    assert!(
        spacer < update_button && update_button < picker,
        "update notice should sit between the header spacer and ConnectionPicker"
    );
    assert!(
        before_picker[update_button..].contains("新版本")
            || before_picker[update_button..].contains("update.available"),
        "the update control should be a visible new-version notice"
    );
}

#[test]
fn settings_nav_only_shows_ready_sections() {
    let repo = repo_root();
    let settings =
        std::fs::read_to_string(repo.join("src").join("components").join("Settings.tsx"))
            .expect("read Settings.tsx");
    let hidden_until_ready = [
        "代码预览",
        "技能",
        "MCP 服务器",
        "插件管理",
        "命令",
        "索引库",
    ];
    let hits = hidden_until_ready
        .iter()
        .filter(|label| settings.contains(**label))
        .copied()
        .collect::<Vec<_>>();
    assert!(
        hits.is_empty(),
        "settings nav should hide unfinished sections: {}",
        hits.join(", ")
    );
}

fn repo_root() -> std::path::PathBuf {
    std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .expect("src-tauri should have a parent")
        .to_path_buf()
}

fn read_json(path: &std::path::Path) -> serde_json::Value {
    let text = std::fs::read_to_string(path).unwrap_or_else(|err| {
        panic!("read {}: {err}", path.display());
    });
    serde_json::from_str(&text).unwrap_or_else(|err| {
        panic!("parse {}: {err}", path.display());
    })
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
