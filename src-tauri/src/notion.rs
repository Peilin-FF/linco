//! The real Notion website in a native child webview, never an iframe or a local
//! copy of the note. Browser storage is persistent and separate from app storage.
use serde::{Deserialize, Serialize};
use std::sync::{
    atomic::{AtomicUsize, Ordering},
    Mutex,
};
use tauri::{
    webview::{NewWindowResponse, PageLoadEvent, WebviewBuilder},
    AppHandle, LogicalPosition, LogicalSize, Manager, Rect, State, Url, WebviewUrl,
};

const LABEL: &str = "notion-browser";
static POPUP_ID: AtomicUsize = AtomicUsize::new(1);

pub fn prepare(app: &AppHandle) -> Result<(), Box<dyn std::error::Error>> {
    // Tauri's asset protocol is independent of IPC capabilities and normally
    // inherits a broad local-file scope. Install these overrides AFTER the local
    // main webview exists: its original protocols stay intact, but every later
    // remote child/popup gets denial handlers, not local file or app resources.
    if app.get_webview("main").is_none() {
        return Err("Create the local main webview before browser isolation".into());
    }
    app.plugin(
        tauri::plugin::Builder::<tauri::Wry>::new("remote-browser-isolation")
            .register_uri_scheme_protocol("asset", |_, _| {
                tauri::http::Response::builder()
                    .status(403)
                    .body(Vec::<u8>::new())
                    .unwrap()
            })
            .register_uri_scheme_protocol("tauri", |_, _| {
                tauri::http::Response::builder()
                    .status(403)
                    .body(Vec::<u8>::new())
                    .unwrap()
            })
            .build(),
    )?;
    Ok(())
}

#[derive(Default)]
pub struct NotionState(Mutex<PageState>);

#[derive(Default)]
struct PageState {
    title: String,
    loading: bool,
}

#[derive(Serialize)]
pub struct NotionStatus {
    url: String,
    title: String,
    loading: bool,
}

#[derive(Deserialize)]
pub struct NotionBounds {
    x: f64,
    y: f64,
    width: f64,
    height: f64,
}

fn secure_web_url(url: &Url) -> bool {
    url.scheme() == "https"
        && url.host_str().is_some()
        && url.username().is_empty()
        && url.password().is_none()
        && url.port_or_known_default() == Some(443)
}

fn notion_url(value: &str) -> Result<Url, String> {
    let url = Url::parse(value).map_err(|_| "Enter a valid Notion HTTPS URL")?;
    let host = url.host_str().unwrap_or_default();
    let notion_host = ["notion.so", "notion.com", "notion.site"]
        .iter()
        .any(|domain| host == *domain || host.ends_with(&format!(".{domain}")));
    if !secure_web_url(&url) || !notion_host {
        return Err("Only Notion HTTPS URLs can be opened here".into());
    }
    Ok(url)
}

fn navigation_allowed(url: &Url) -> bool {
    // HTTPS redirects include identity providers. Never allow tauri:, file:,
    // javascript:, localhost HTTP, or external protocol handlers in this view.
    secure_web_url(url) || url.as_str() == "about:blank"
}

#[tauri::command]
pub async fn notion_open(app: AppHandle, url: String, navigate: bool) -> Result<(), String> {
    let url = notion_url(&url)?;
    if let Some(view) = app.get_webview(LABEL) {
        if navigate {
            view.navigate(url).map_err(|e| e.to_string())?;
        }
        return Ok(());
    }
    let directory = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("notion-browser");
    std::fs::create_dir_all(&directory).map_err(|e| e.to_string())?;
    let popup_app = app.clone();
    let popup_directory = directory.clone();
    let builder = WebviewBuilder::new(LABEL, WebviewUrl::External(url))
        .data_directory(directory)
        .disable_drag_drop_handler()
        .focused(false)
        .on_navigation(navigation_allowed)
        .on_page_load(|view, payload| {
            let state = view.state::<NotionState>();
            if let Ok(mut page) = state.0.lock() {
                page.loading = matches!(payload.event(), PageLoadEvent::Started);
            };
        })
        .on_document_title_changed(|view, title| {
            let state = view.state::<NotionState>();
            if let Ok(mut page) = state.0.lock() {
                page.title = title;
            };
        })
        .on_new_window(move |url, features| {
            if !navigation_allowed(&url) {
                return NewWindowResponse::Deny;
            }
            // Preserve window.opener for OAuth instead of silently redirecting a
            // popup into the note. These windows have no Linco capabilities.
            let label = format!("notion-popup-{}", POPUP_ID.fetch_add(1, Ordering::Relaxed));
            let popup = tauri::WebviewWindowBuilder::new(
                &popup_app,
                label,
                WebviewUrl::External("about:blank".parse().expect("static URL")),
            )
            .window_features(features)
            .data_directory(popup_directory.clone())
            .on_navigation(navigation_allowed)
            .on_document_title_changed(|window, title| {
                let _ = window.set_title(&title);
            })
            .title("Notion — sign in or follow link")
            .build();
            match popup {
                Ok(window) => NewWindowResponse::Create { window },
                Err(_) => NewWindowResponse::Deny,
            }
        });
    #[cfg(debug_assertions)]
    let builder = if std::env::var("LINCO_NOTION_DEVTOOLS").as_deref() == Ok("1") {
        builder.additional_browser_args("--remote-debugging-port=9226")
    } else {
        builder
    };
    let window = app.get_window("main").ok_or("Main window is unavailable")?;
    // Create offscreen and hidden. Only the measured, active Notes pane can show
    // it; this also prevents web content painting over the agent during startup.
    let view = window
        .add_child(
            builder,
            LogicalPosition::new(-10000.0, -10000.0),
            LogicalSize::new(1.0, 1.0),
        )
        .map_err(|e| e.to_string())?;
    view.hide().map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn notion_layout(
    app: AppHandle,
    visible: bool,
    bounds: Option<NotionBounds>,
) -> Result<(), String> {
    let Some(view) = app.get_webview(LABEL) else {
        return Ok(());
    };
    if !visible {
        return view.hide().map_err(|e| e.to_string());
    }
    let b = bounds.ok_or("Missing browser bounds")?;
    if ![b.x, b.y, b.width, b.height].iter().all(|n| n.is_finite())
        || b.x < 0.0
        || b.y < 0.0
        || b.width < 1.0
        || b.height < 1.0
    {
        return Err("Invalid browser bounds".into());
    }
    let window = app.get_window("main").ok_or("Main window is unavailable")?;
    let size = window
        .inner_size()
        .map_err(|e| e.to_string())?
        .to_logical::<f64>(window.scale_factor().map_err(|e| e.to_string())?);
    if b.x + b.width > size.width + 1.0 || b.y + b.height > size.height + 1.0 {
        view.hide().map_err(|e| e.to_string())?;
        return Err("Browser bounds exceed the window".into());
    }
    view.set_bounds(Rect {
        position: LogicalPosition::new(b.x, b.y).into(),
        size: LogicalSize::new(b.width, b.height).into(),
    })
    .map_err(|e| e.to_string())?;
    view.show().map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn notion_status(
    app: AppHandle,
    state: State<'_, NotionState>,
) -> Result<Option<NotionStatus>, String> {
    let Some(view) = app.get_webview(LABEL) else {
        return Ok(None);
    };
    let url = view.url().map_err(|e| e.to_string())?.to_string();
    let page = state.0.lock().map_err(|e| e.to_string())?;
    Ok(Some(NotionStatus {
        url,
        title: page.title.clone(),
        loading: page.loading,
    }))
}

#[tauri::command]
pub async fn notion_action(app: AppHandle, action: String) -> Result<(), String> {
    let view = app.get_webview(LABEL).ok_or("Open Notes first")?;
    match action.as_str() {
        "reload" => view.reload(),
        "back" => view.eval("history.back()"),
        "forward" => view.eval("history.forward()"),
        _ => return Err("Unknown browser action".into()),
    }
    .map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn accepts_only_real_notion_hosts() {
        for url in [
            "https://app.notion.com/login",
            "https://www.notion.so/notes",
            "https://team.notion.site/page",
        ] {
            assert!(notion_url(url).is_ok(), "{url}");
        }
        for url in [
            "https://notion.so.evil.test",
            "https://evilnotion.so",
            "http://notion.so",
            "https://user@notion.so",
            "https://notion.so:444",
            "file:///C:/secret",
            "javascript:alert(1)",
        ] {
            assert!(notion_url(url).is_err(), "{url}");
        }
    }
    #[test]
    fn redirects_cannot_reach_native_protocols() {
        assert!(navigation_allowed(
            &Url::parse("https://accounts.google.com/login").unwrap()
        ));
        for url in [
            "tauri://localhost",
            "http://localhost:1420",
            "file:///tmp/file",
            "javascript:alert(1)",
            "notion://open",
        ] {
            assert!(!navigation_allowed(&Url::parse(url).unwrap()), "{url}");
        }
    }
}
