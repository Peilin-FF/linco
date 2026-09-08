//! Local Notion tools through Codex's supported app-server interface. No model
//! turn, SSH connection, credential extraction, or remote-webview capabilities.
use serde_json::{json, Value};
use std::io::{BufRead, BufReader, Write};
use std::process::{Child, ChildStdin, Stdio};
use std::sync::mpsc::{self, Receiver};
use std::time::{Duration, Instant};

const ENDPOINT: &str = "https://mcp.notion.com/mcp";
const MAX_CONTENT: usize = 80_000;

struct Client {
    child: Child,
    input: Option<ChildStdin>,
    messages: Receiver<Value>,
    next_id: u64,
}

impl Client {
    fn start() -> Result<Self, String> {
        let mut command = crate::proc_ext::cli_command("codex", &["app-server"]);
        // Prefer the npm package's native executable on Windows, so the owned
        // process is Codex itself and cleanup never leaves a cmd/node wrapper.
        #[cfg(windows)]
        {
            let shim = std::path::PathBuf::from(crate::proc_ext::resolve_exe("codex"));
            let arch = if cfg!(target_arch = "aarch64") { "arm64" } else { "x64" };
            let triple = if cfg!(target_arch = "aarch64") { "aarch64" } else { "x86_64" };
            if let Some(parent) = shim.parent() {
                let binary = parent.join(format!("node_modules/@openai/codex/node_modules/@openai/codex-win32-{arch}/vendor/{triple}-pc-windows-msvc/bin/codex.exe"));
                if binary.is_file() {
                    command = std::process::Command::new(binary);
                    command.arg("app-server");
                    crate::proc_ext::no_window(&mut command);
                }
            }
        }
        // A remote project's cwd must never be used as a local executable path.
        let local_dir = crate::config::linco_home()?;
        std::fs::create_dir_all(&local_dir).map_err(|e| e.to_string())?;
        command.current_dir(local_dir);
        command.stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::null());
        let mut child = command.spawn().map_err(|_| "Local Codex is unavailable. Install Codex locally to connect this workbench.".to_string())?;
        let input = child.stdin.take();
        let output = child.stdout.take().ok_or("Cannot read the local Codex connection")?;
        let (sender, messages) = mpsc::sync_channel(16);
        std::thread::spawn(move || {
            for line in BufReader::new(output).lines() {
                let Ok(line) = line else { break };
                if line.len() > 4_000_000 { break; }
                if let Ok(value) = serde_json::from_str(&line) {
                    if sender.send(value).is_err() { break; }
                }
            }
        });
        let mut client = Self { child, input, messages, next_id: 0 };
        client.request("initialize", json!({
            "clientInfo": {"name":"linco_notion_workbench", "version":"1.0.0"},
            "capabilities":{"experimentalApi":true}
        }))?;
        client.send(json!({"method":"initialized", "params":{}}))?;
        let config = client.request("config/read", json!({"includeLayers":false}))?;
        if config.pointer("/config/mcp_servers/notion/url").and_then(Value::as_str) != Some(ENDPOINT) {
            return Err("Configure the official Notion server in local Codex first. Existing server settings were not changed.".into());
        }
        Ok(client)
    }

    fn send(&mut self, value: Value) -> Result<(), String> {
        let input = self.input.as_mut().ok_or("The Notion connection is closed")?;
        writeln!(input, "{value}").map_err(|e| e.to_string())?;
        input.flush().map_err(|e| e.to_string())
    }

    fn request(&mut self, method: &str, params: Value) -> Result<Value, String> {
        self.next_id += 1;
        let id = self.next_id;
        self.send(json!({"id":id,"method":method,"params":params}))?;
        let deadline = Instant::now() + Duration::from_secs(90);
        loop {
            let remaining = deadline.saturating_duration_since(Instant::now());
            let response = self.messages.recv_timeout(remaining).map_err(|_| {
                "Notion did not finish in time. Check the page before retrying a creation; it may have succeeded.".to_string()
            })?;
            if response.get("method").is_some() {
                if let Some(request_id) = response.get("id") {
                    self.send(json!({"id":request_id,"error":{"code":-32601,"message":"Interactive approval must be completed by the user."}}))?;
                    return Err("Notion needs your authorization or approval. Complete it in the connection settings.".into());
                }
                continue;
            }
            if response.get("id").and_then(Value::as_u64) != Some(id) { continue; }
            if let Some(error) = response.get("error") {
                return Err(error.get("message").and_then(Value::as_str).unwrap_or("Notion request failed").to_string());
            }
            return response.get("result").cloned().ok_or("Notion returned an empty result".into());
        }
    }

    fn status(&mut self, thread: Option<&str>) -> Result<Value, String> {
        let mut cursor = Value::Null;
        loop {
            let result = self.request("mcpServerStatus/list", json!({"threadId":thread,"cursor":cursor,"limit":100,"detail":"toolsAndAuthOnly"}))?;
            if let Some(server) = result.get("data").and_then(Value::as_array).and_then(|items| items.iter().find(|item| item["name"] == "notion")) {
                return Ok(server.clone());
            }
            cursor = result.get("nextCursor").cloned().unwrap_or(Value::Null);
            if cursor.is_null() { return Err("Notion is not configured in local Codex".into()); }
        }
    }
}

impl Drop for Client {
    fn drop(&mut self) {
        self.input.take();
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

fn valid_id(value: &str) -> bool {
    let compact = value.replace('-', "");
    compact.len() == 32 && compact.bytes().all(|b| b.is_ascii_hexdigit())
}

fn contains_moving_block(content: &str) -> bool {
    let lower = content.to_ascii_lowercase();
    ["<page ", "<database ", "<folder ", "<synced_block"].iter().any(|tag| {
        lower.match_indices(tag).any(|(index, _)| {
            // Odd backslashes escape the opening angle in Notion Markdown.
            lower[..index].bytes().rev().take_while(|byte| *byte == b'\\').count() % 2 == 0
        })
    })
}

fn validate_request(tool: &str, args: &Value) -> Result<(), String> {
    if !args.is_object() { return Err("Invalid Notion request".into()); }
    match tool {
        "notion-query-data-sources" => {
            // Structured, single-source reads only. No arbitrary SQL, joins,
            // publication, or mutation is exposed to the research interface.
            let data = &args["data"];
            let source = data["data_source_url"].as_str().unwrap_or_default();
            let limit = data["limit"].as_u64().unwrap_or(100);
            if data["mode"] != "rows" || !source.strip_prefix("collection://").is_some_and(valid_id)
                || !(1..=100).contains(&limit) || data.get("query").is_some()
                || args.to_string().len() > 8_000 {
                return Err("Research reads require one data source and at most 100 structured rows".into());
            }
        }
        "notion-fetch" => {
            let id = args["id"].as_str().unwrap_or_default();
            if valid_id(id) { return Ok(()); }
            let url = tauri::Url::parse(id).map_err(|_| "Open a Notion page first")?;
            let host = url.host_str().unwrap_or_default();
            if url.scheme() != "https" || !url.username().is_empty() || url.password().is_some() ||
                url.port().is_some() || !["notion.so","notion.com","notion.site"].iter().any(|domain| host == *domain || host.ends_with(&format!(".{domain}"))) {
                return Err("Only Notion HTTPS pages can be read".into());
            }
        }
        "notion-create-pages" => {
            let pages = args["pages"].as_array().ok_or("Missing Notion pages")?;
            if pages.is_empty() || pages.len() > 6 { return Err("Create one record or a small template set at a time".into()); }
            if let Some(parent) = args.get("parent") {
                let id = parent.get("page_id").or_else(|| parent.get("data_source_id")).and_then(Value::as_str).unwrap_or_default();
                if !valid_id(id) { return Err("Choose a valid notebook destination".into()); }
            } else if args["creation_mode"] != "draft" { return Err("New project homes must be private drafts".into()); }
            for page in pages {
                let content = page["content"].as_str().unwrap_or_default();
                if content.len() > MAX_CONTENT || page.get("is_skill").is_some() || page.get("template_id").is_some() {
                    return Err("Unsupported notebook content".into());
                }
                // These blocks can move existing content; templates only create
                // new notes and use native mentions for existing references.
                if contains_moving_block(content) {
                    return Err("Use a reference link instead of moving existing Notion content".into());
                }
            }
        }
        "notion-create-database" => {
            if !valid_id(args["parent"]["page_id"].as_str().unwrap_or_default()) || args["schema"].as_str().is_none_or(|s| s.len() > 4000 || !s.starts_with("CREATE TABLE")) {
                return Err("A project home and a valid notebook schema are required".into());
            }
        }
        "notion-create-view" => {
            let parent = args.get("database_id").or_else(|| args.get("parent_page_id")).and_then(Value::as_str).unwrap_or_default();
            if !valid_id(parent) || !valid_id(args["data_source_id"].as_str().unwrap_or_default()) || !["table", "board", "list"].contains(&args["type"].as_str().unwrap_or_default()) {
                return Err("Invalid notebook view".into());
            }
        }
        _ => return Err("This Notion action is not supported by the workbench".into()),
    }
    Ok(())
}

fn run_request(tool: Option<String>, arguments: Value) -> Result<Value, String> {
    if let Some(ref tool) = tool { validate_request(tool, &arguments)?; }
    let mut client = Client::start()?;
    let thread_id = if tool.is_some() {
        let result = client.request("thread/start", json!({"ephemeral":true}))?;
        Some(result["thread"]["id"].as_str().ok_or("Unable to initialize the Notion connection")?.to_string())
    } else { None };
    let status = client.status(thread_id.as_deref())?;
    let connected = status["authStatus"] == "oAuth";
    let count = status["tools"].as_object().map_or(0, |tools| tools.len());
    let Some(tool) = tool else { return Ok(json!({"connected":connected,"toolCount":count,"host":"local"})); };
    if !connected { return Err("Sign in to Notion through local Codex before using notebook actions".into()); }
    let available = status["tools"].as_object().is_some_and(|tools| tools.iter().any(|(name, spec)| name == &tool || spec["name"] == tool));
    if !available { return Err("This Notion tool is unavailable in the connected workspace".into()); }
    client.request("mcpServer/tool/call", json!({"threadId":thread_id,"server":"notion","tool":tool,"arguments":arguments}))
}

#[tauri::command]
pub async fn notion_connection() -> Result<Value, String> {
    crate::blocking::run(|| run_request(None, Value::Null)).await
}

#[tauri::command]
pub async fn notion_tool(tool: String, arguments: Value) -> Result<Value, String> {
    crate::blocking::run(move || run_request(Some(tool), arguments)).await
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    #[ignore = "uses the user's local Notion OAuth; read-only and explicitly invoked"]
    fn local_connection_round_trip() {
        let status = run_request(None, Value::Null).expect("Local connection");
        assert_eq!(status["connected"], true);
        assert!(status["toolCount"].as_u64().unwrap_or(0) > 0);
        let page = std::env::var("LINCO_NOTION_TEST_PAGE").expect("Pass an explicitly selected Notion page URL");
        let result = run_request(Some("notion-fetch".into()), json!({"id":page})).expect("Read selected page");
        assert_ne!(result["isError"], true);
        assert!(result["content"].as_array().is_some_and(|items| !items.is_empty()));
    }
    #[test]
    fn only_explicit_notebook_actions() {
        assert!(validate_request("notion-update-page", &json!({})).is_err());
        assert!(validate_request("notion-move-pages", &json!({})).is_err());
        assert!(validate_request("notion-fetch", &json!({"id":"file:///C:/secret"})).is_err());
        assert!(validate_request("notion-fetch", &json!({"id":"https://notion.so.evil.test/"})).is_err());
        assert!(validate_request("notion-fetch", &json!({"id":"https://www.notion.so/0123456789abcdef0123456789abcdef"})).is_ok());
    }
    #[test]
    fn research_queries_are_bounded_structured_reads() {
        let source = "collection://01234567-89ab-cdef-0123-456789abcdef";
        assert!(validate_request("notion-query-data-sources", &json!({"data":{"mode":"rows","data_source_url":source,"limit":100}})).is_ok());
        assert!(validate_request("notion-query-data-sources", &json!({"data":{"mode":"rows","data_source_url":source,"limit":101}})).is_err());
        assert!(validate_request("notion-query-data-sources", &json!({"data":{"mode":"sql","query":"SELECT * FROM anything"}})).is_err());
        assert!(validate_request("notion-query-data-sources", &json!({"data":{"mode":"rows","data_source_url":"https://evil.test"}})).is_err());
    }
    #[test]
    fn creations_preserve_existing_content_and_privacy() {
        assert!(validate_request("notion-create-pages", &json!({"pages":[{"content":"New note"}]})).is_err());
        assert!(validate_request("notion-create-pages", &json!({"creation_mode":"draft","pages":[{"content":"New note"}]})).is_ok());
        assert!(validate_request("notion-create-pages", &json!({"creation_mode":"draft","pages":[{"content":"<page url=\"https://notion.so/existing\">Move</page>"}]})).is_err());
        assert!(!contains_moving_block(r#"\<page url="example"\>literal\</page\>"#));
        assert!(contains_moving_block(r#"\\<page url="example">move</page>"#));
    }
}
