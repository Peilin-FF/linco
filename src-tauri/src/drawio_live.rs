use std::collections::HashMap;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{sync_channel, SyncSender};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager};

const BRIDGE_EVENT: &str = "drawio-live-command";
const MCP_NAME: &str = "linco-drawio-live";
const MAX_COMMAND_BYTES: u64 = 2 * 1024 * 1024;
const RESPONSE_TIMEOUT: Duration = Duration::from_secs(45);

static BRIDGE: OnceLock<BridgeState> = OnceLock::new();
static COMMAND_SEQ: AtomicU64 = AtomicU64::new(1);

struct BridgeState {
    pending: Mutex<HashMap<u64, SyncSender<BridgeReply>>>,
    token: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct BridgeEvent {
    id: u64,
    command: Value,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct BridgeReply {
    result: Option<Value>,
    error: Option<String>,
}

#[derive(Serialize)]
struct BridgeDescriptor<'a> {
    version: u8,
    url: String,
    token: &'a str,
    pid: u32,
}

fn session_token() -> String {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    let seq = COMMAND_SEQ.fetch_add(1, Ordering::Relaxed);
    format!("{:032x}{:08x}{:016x}", nanos, std::process::id(), seq)
}

fn json_response(value: Value, status: u16) -> tiny_http::Response<std::io::Cursor<Vec<u8>>> {
    tiny_http::Response::from_data(value.to_string().into_bytes())
        .with_status_code(status)
        .with_header(
            tiny_http::Header::from_bytes(&b"Content-Type"[..], &b"application/json"[..])
                .expect("static JSON content type"),
        )
        .with_header(
            tiny_http::Header::from_bytes(&b"Cache-Control"[..], &b"no-store"[..])
                .expect("static cache header"),
        )
}

fn request_token(request: &tiny_http::Request) -> Option<&str> {
    request
        .headers()
        .iter()
        .find(|header| header.field.equiv("X-Linco-Drawio-Token"))
        .map(|header| header.value.as_str())
}

fn handle_request(mut request: tiny_http::Request, app: &AppHandle) {
    let state = match BRIDGE.get() {
        Some(state) => state,
        None => {
            let _ = request.respond(json_response(json!({ "error": "bridge not ready" }), 503));
            return;
        }
    };

    if request_token(&request) != Some(state.token.as_str()) {
        let _ = request.respond(json_response(json!({ "error": "unauthorized" }), 401));
        return;
    }

    let path = request.url().split(['?', '#']).next().unwrap_or_default();
    if request.method() == &tiny_http::Method::Get && path == "/status" {
        let _ = request.respond(json_response(json!({ "ready": true, "version": 1 }), 200));
        return;
    }
    if request.method() != &tiny_http::Method::Post || path != "/command" {
        let _ = request.respond(json_response(json!({ "error": "not found" }), 404));
        return;
    }

    let mut body = String::new();
    if request
        .as_reader()
        .take(MAX_COMMAND_BYTES + 1)
        .read_to_string(&mut body)
        .is_err()
        || body.len() as u64 > MAX_COMMAND_BYTES
    {
        let _ = request.respond(json_response(
            json!({ "error": "invalid command body" }),
            400,
        ));
        return;
    }
    let command = match serde_json::from_str::<Value>(&body) {
        Ok(Value::Object(command)) => Value::Object(command),
        _ => {
            let _ = request.respond(json_response(
                json!({ "error": "command must be a JSON object" }),
                400,
            ));
            return;
        }
    };

    let id = COMMAND_SEQ.fetch_add(1, Ordering::Relaxed);
    let (sender, receiver) = sync_channel(1);
    if let Ok(mut pending) = state.pending.lock() {
        pending.insert(id, sender);
    } else {
        let _ = request.respond(json_response(
            json!({ "error": "bridge state unavailable" }),
            503,
        ));
        return;
    }

    if app.emit(BRIDGE_EVENT, BridgeEvent { id, command }).is_err() {
        if let Ok(mut pending) = state.pending.lock() {
            pending.remove(&id);
        }
        let _ = request.respond(json_response(
            json!({ "error": "drawing view unavailable" }),
            503,
        ));
        return;
    }

    let response = match receiver.recv_timeout(RESPONSE_TIMEOUT) {
        Ok(reply) => {
            if let Some(error) = reply.error.filter(|error| !error.trim().is_empty()) {
                json_response(json!({ "ok": false, "error": error }), 422)
            } else {
                json_response(
                    json!({ "ok": true, "result": reply.result.unwrap_or(Value::Null) }),
                    200,
                )
            }
        }
        Err(_) => {
            if let Ok(mut pending) = state.pending.lock() {
                pending.remove(&id);
            }
            json_response(
                json!({
                    "ok": false,
                    "error": "Linco drawing view did not respond. Open the Drawing tab and keep it visible while the Agent draws."
                }),
                504,
            )
        }
    };
    let _ = request.respond(response);
}

fn descriptor_path() -> Result<PathBuf, String> {
    Ok(PathBuf::from(crate::config::home_dir()?)
        .join(".linco")
        .join("drawio-live.json"))
}

fn integration_source(app: &AppHandle) -> Result<PathBuf, String> {
    if let Ok(resource_dir) = app.path().resource_dir() {
        let source = resource_dir.join("codex").join("drawio-live");
        if source.join("scripts").join("server.mjs").exists() {
            return Ok(source);
        }
    }
    let source = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../vendor/HTML-VibeCoding/codex/drawio-live");
    if source.join("scripts").join("server.mjs").exists() {
        return Ok(source);
    }
    Err("draw.io Live integration resources are missing".into())
}

fn copy_dir(source: &Path, destination: &Path) -> Result<(), String> {
    if destination.exists() {
        std::fs::remove_dir_all(destination).map_err(|error| error.to_string())?;
    }
    std::fs::create_dir_all(destination).map_err(|error| error.to_string())?;
    for entry in std::fs::read_dir(source).map_err(|error| error.to_string())? {
        let entry = entry.map_err(|error| error.to_string())?;
        let source_path = entry.path();
        let destination_path = destination.join(entry.file_name());
        if entry
            .file_type()
            .map_err(|error| error.to_string())?
            .is_dir()
        {
            copy_dir(&source_path, &destination_path)?;
        } else {
            std::fs::copy(&source_path, &destination_path).map_err(|error| error.to_string())?;
        }
    }
    Ok(())
}

fn install_codex_integration(app: AppHandle) -> Result<(), String> {
    let source = integration_source(&app)?;
    let home = PathBuf::from(crate::config::home_dir()?);
    let skill_source = source.join("skills").join("drawio-live");
    if skill_source.exists() {
        copy_dir(
            &skill_source,
            &home.join(".codex").join("skills").join("drawio-live"),
        )?;
    }

    let server = source.join("scripts").join("server.mjs");
    let server_arg = server.to_string_lossy().to_string();
    let mut remove = crate::proc_ext::cli_command("codex", &["mcp", "remove", MCP_NAME]);
    let _ = remove.output();
    let mut add = crate::proc_ext::cli_command(
        "codex",
        &["mcp", "add", MCP_NAME, "--", "node", &server_arg],
    );
    let output = add.output().map_err(|error| error.to_string())?;
    if output.status.success() {
        Ok(())
    } else {
        let error = String::from_utf8_lossy(&output.stderr).trim().to_string();
        Err(if error.is_empty() {
            "failed to register the draw.io Live MCP server".into()
        } else {
            error
        })
    }
}

pub fn prepare(app: AppHandle) -> Result<(), String> {
    if BRIDGE.get().is_some() {
        return Ok(());
    }
    let server = tiny_http::Server::http("127.0.0.1:0")
        .map_err(|error| format!("failed to start draw.io Live bridge: {error}"))?;
    let port = server
        .server_addr()
        .to_ip()
        .map(|address| address.port())
        .ok_or_else(|| "failed to resolve draw.io Live bridge port".to_string())?;
    let token = session_token();
    BRIDGE
        .set(BridgeState {
            pending: Mutex::new(HashMap::new()),
            token: token.clone(),
        })
        .map_err(|_| "draw.io Live bridge already initialized".to_string())?;

    let descriptor = descriptor_path()?;
    if let Some(parent) = descriptor.parent() {
        std::fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    let payload = serde_json::to_vec_pretty(&BridgeDescriptor {
        version: 1,
        url: format!("http://127.0.0.1:{port}"),
        token: &token,
        pid: std::process::id(),
    })
    .map_err(|error| error.to_string())?;
    std::fs::write(&descriptor, payload).map_err(|error| error.to_string())?;

    let server_app = app.clone();
    std::thread::spawn(move || {
        for request in server.incoming_requests() {
            handle_request(request, &server_app);
        }
    });
    std::thread::spawn(move || {
        if let Err(error) = install_codex_integration(app) {
            eprintln!("draw.io Live integration install skipped: {error}");
        }
    });
    Ok(())
}

#[tauri::command]
pub fn drawio_live_respond(
    id: u64,
    result: Option<Value>,
    error: Option<String>,
) -> Result<(), String> {
    let state = BRIDGE
        .get()
        .ok_or_else(|| "draw.io Live bridge is not initialized".to_string())?;
    let sender = state
        .pending
        .lock()
        .map_err(|lock_error| lock_error.to_string())?
        .remove(&id)
        .ok_or_else(|| "draw.io Live command is no longer pending".to_string())?;
    sender
        .send(BridgeReply { result, error })
        .map_err(|send_error| send_error.to_string())
}
