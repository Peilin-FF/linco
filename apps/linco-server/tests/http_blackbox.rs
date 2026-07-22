use std::{
    collections::BTreeMap, fmt::Write as _, net::SocketAddr, path::PathBuf, sync::Arc,
    time::Duration,
};

use axum::{
    body::{Body, Bytes},
    http::{header, Method, Request, StatusCode},
    Router,
};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use ed25519_dalek::{Signature as Ed25519Signature, VerifyingKey as Ed25519VerifyingKey};
use hmac::{Hmac, Mac};
use http_body_util::BodyExt;
use linco_core::{TerminalSize, TerminalStart};
use linco_protocol::{
    authentication_transcript, pairing_transcript, server_hello_transcript, BinaryFrame,
    BinaryKind, ClientMessage, ConnectionPath, KeyAlgorithm, LogicalChannel, Permission,
    ResumeCursor, RpcMethod, ServerMessage, SessionKind, SessionResumeResponse,
    TerminalInputFaultCode, PROTOCOL_VERSION,
};
use linco_server::{
    auth::AuthStore,
    config::{ServerConfig, TerminalConfig},
    http,
    state::AppState,
    terminal_backend::CoreTerminalBackend,
    tickets::{HttpCapabilityKind, HttpGrant},
    workspace::{WorkspaceRegistry, WorkspaceSpec},
};
use p256::ecdsa::{signature::Signer as _, Signature as P256Signature, SigningKey};
use rand::{rngs::OsRng, RngCore};
use rusqlite::params;
use sha2::{Digest, Sha256};
use tempfile::TempDir;
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::{tcp::OwnedReadHalf, tcp::OwnedWriteHalf, TcpStream},
};
use tokio_util::sync::CancellationToken;
use tower::ServiceExt;
use uuid::Uuid;

struct Harness {
    _temp: TempDir,
    workspace_path: PathBuf,
    workspace_id: Uuid,
    device_id: Uuid,
    state: Arc<AppState>,
    app: Router,
}

impl Harness {
    async fn new() -> Self {
        let temp = tempfile::tempdir().expect("create integration-test root");
        let workspace_path = temp.path().join("workspace");
        let state_path = temp.path().join("state");
        tokio::fs::create_dir_all(&workspace_path)
            .await
            .expect("create test workspace");
        tokio::fs::create_dir_all(&state_path)
            .await
            .expect("create test state directory");

        let config = ServerConfig {
            listen: "127.0.0.1:0"
                .parse::<SocketAddr>()
                .expect("loopback socket"),
            public_url: "http://127.0.0.1:7337".into(),
            state_dir: state_path.clone(),
            workspaces: vec![WorkspaceSpec {
                name: "black-box".into(),
                path: workspace_path.clone(),
            }],
            terminal: TerminalConfig {
                replay_bytes: 64 * 1024,
                outbound_queue: 8,
            },
            control_queue: 8,
            max_inflight_calls: 8,
            http_ticket_ttl: Duration::from_secs(60),
            max_upload_bytes: 8 * 1024 * 1024,
        };
        let auth_path = state_path.join("auth.db");
        let auth = AuthStore::open(auth_path.clone())
            .await
            .expect("open auth store");
        let device_id = Uuid::new_v4();
        rusqlite::Connection::open(auth_path)
            .unwrap()
            .execute(
                "INSERT INTO devices(
                   id, name, key_algorithm, public_key, permissions, created_at_ms
                 ) VALUES(?1, 'HTTP fixture', 'p256', ?2, ?3, 1)",
                params![
                    device_id.to_string(),
                    [7_u8; 65].as_slice(),
                    serde_json::to_string(&vec!["read", "terminal", "write"]).unwrap(),
                ],
            )
            .unwrap();
        let workspaces = WorkspaceRegistry::new(&config.workspaces).expect("open workspace");
        let workspace_id = workspaces.list()[0].id;
        let terminal =
            CoreTerminalBackend::new(config.terminal.clone()).expect("initialize terminal backend");
        let state = Arc::new(AppState::new(config, auth, workspaces, terminal));
        let app = http::router(Arc::clone(&state));

        Self {
            _temp: temp,
            workspace_path,
            workspace_id,
            device_id,
            state,
            app,
        }
    }

    fn issue(
        &self,
        kind: HttpCapabilityKind,
        relative_path: &str,
        expected_etag: Option<String>,
        content_length: Option<u64>,
    ) -> String {
        self.state
            .tickets
            .issue_http(
                HttpGrant {
                    device_id: self.device_id,
                    workspace_id: self.workspace_id,
                    relative_path: relative_path.into(),
                    kind,
                    expected_etag,
                    max_bytes: self.state.config.max_upload_bytes,
                    content_length,
                },
                self.state.config.http_ticket_ttl,
            )
            .expect("issue HTTP capability")
    }

    async fn request(&self, request: Request<Body>) -> axum::response::Response {
        self.app
            .clone()
            .oneshot(request)
            .await
            .expect("infallible Axum router")
    }
}

fn authorization(token: &str) -> String {
    format!("LincoCapability {token}")
}

fn strong_etag(bytes: &[u8]) -> String {
    let digest = Sha256::digest(bytes);
    let mut hex = String::with_capacity(digest.len() * 2);
    for byte in digest {
        write!(&mut hex, "{byte:02x}").expect("writing to String cannot fail");
    }
    format!("\"sha256-{hex}\"")
}

async fn response_bytes(response: axum::response::Response) -> Bytes {
    response
        .into_body()
        .collect()
        .await
        .expect("collect response body")
        .to_bytes()
}

struct RawControlSocket {
    stream: TcpStream,
}

impl RawControlSocket {
    async fn connect(address: SocketAddr) -> Self {
        Self::connect_path(address, "/v1/ws/control").await
    }

    async fn connect_path(address: SocketAddr, path: &str) -> Self {
        let mut stream = TcpStream::connect(address)
            .await
            .expect("connect to Axum listener");
        let request = format!(
            "GET {path} HTTP/1.1\r\nHost: {address}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n"
        );
        stream
            .write_all(request.as_bytes())
            .await
            .expect("send WebSocket upgrade");
        let headers = tokio::time::timeout(Duration::from_secs(3), async {
            let mut headers = Vec::new();
            loop {
                let byte = stream.read_u8().await.expect("read upgrade response");
                headers.push(byte);
                assert!(headers.len() <= 8 * 1024, "upgrade headers were too large");
                if headers.ends_with(b"\r\n\r\n") {
                    return headers;
                }
            }
        })
        .await
        .expect("WebSocket upgrade timed out");
        let headers = String::from_utf8(headers).expect("ASCII upgrade response");
        let lowercase = headers.to_ascii_lowercase();
        assert!(headers.starts_with("HTTP/1.1 101 "), "{headers}");
        assert!(lowercase.contains("upgrade: websocket\r\n"), "{headers}");
        assert!(
            lowercase.contains("sec-websocket-accept: s3pplmbitxaq9kygzzhzrbk+xoo="),
            "{headers}"
        );
        Self { stream }
    }

    fn into_stream(self) -> TcpStream {
        self.stream
    }

    async fn send(&mut self, message: &ClientMessage) {
        let payload = serde_json::to_vec(message).expect("encode client control message");
        self.send_frame(0x1, &payload).await;
    }

    async fn send_binary(&mut self, payload: &[u8]) {
        self.send_frame(0x2, payload).await;
    }

    async fn receive(&mut self) -> ServerMessage {
        loop {
            let (opcode, payload) = tokio::time::timeout(Duration::from_secs(3), self.read_frame())
                .await
                .expect("server control message timed out");
            match opcode {
                0x1 => {
                    return serde_json::from_slice(&payload).expect("decode server control message")
                }
                0x9 => self.send_frame(0xa, &payload).await,
                0xa => {}
                0x2 => {}
                0x8 => panic!("server closed WebSocket during handshake"),
                other => panic!("unexpected WebSocket opcode {other:#x}"),
            }
        }
    }

    async fn send_frame(&mut self, opcode: u8, payload: &[u8]) {
        let mut frame = Vec::with_capacity(payload.len() + 14);
        frame.push(0x80 | opcode);
        match payload.len() {
            0..=125 => frame.push(0x80 | payload.len() as u8),
            126..=65_535 => {
                frame.push(0x80 | 126);
                frame.extend_from_slice(&(payload.len() as u16).to_be_bytes());
            }
            _ => {
                frame.push(0x80 | 127);
                frame.extend_from_slice(&(payload.len() as u64).to_be_bytes());
            }
        }
        let mut mask = [0_u8; 4];
        OsRng.fill_bytes(&mut mask);
        frame.extend_from_slice(&mask);
        frame.extend(
            payload
                .iter()
                .enumerate()
                .map(|(index, byte)| byte ^ mask[index % mask.len()]),
        );
        self.stream
            .write_all(&frame)
            .await
            .expect("send masked WebSocket frame");
    }

    async fn read_frame(&mut self) -> (u8, Vec<u8>) {
        let first = self.stream.read_u8().await.expect("read frame first byte");
        let second = self.stream.read_u8().await.expect("read frame length");
        assert_ne!(first & 0x80, 0, "fragmented server frame is unexpected");
        assert_eq!(second & 0x80, 0, "server frames must not be masked");
        let length = match second & 0x7f {
            126 => self.stream.read_u16().await.unwrap() as u64,
            127 => self.stream.read_u64().await.unwrap(),
            length => length as u64,
        };
        assert!(length <= 256 * 1024, "server frame exceeded test limit");
        let mut payload = vec![0_u8; length as usize];
        self.stream
            .read_exact(&mut payload)
            .await
            .expect("read frame payload");
        (first & 0x0f, payload)
    }
}

fn encoded_client_message(message: &ClientMessage) -> Vec<u8> {
    let payload = serde_json::to_vec(message).expect("encode client control message");
    let mut frame = Vec::with_capacity(payload.len() + 14);
    frame.push(0x81);
    match payload.len() {
        0..=125 => frame.push(0x80 | payload.len() as u8),
        126..=65_535 => {
            frame.push(0x80 | 126);
            frame.extend_from_slice(&(payload.len() as u16).to_be_bytes());
        }
        _ => {
            frame.push(0x80 | 127);
            frame.extend_from_slice(&(payload.len() as u64).to_be_bytes());
        }
    }
    let mask = [0x13, 0x37, 0x42, 0x99];
    frame.extend_from_slice(&mask);
    frame.extend(
        payload
            .iter()
            .enumerate()
            .map(|(index, byte)| byte ^ mask[index % mask.len()]),
    );
    frame
}

async fn flood_websocket(mut writer: OwnedWriteHalf, frame: Vec<u8>, stopped: CancellationToken) {
    loop {
        tokio::select! {
            biased;
            _ = stopped.cancelled() => return,
            written = writer.write_all(&frame) => {
                if written.is_err() {
                    return;
                }
            }
        }
    }
}

async fn expect_remote_disconnect(mut reader: OwnedReadHalf) {
    tokio::time::timeout(Duration::from_secs(2), async {
        let mut buffered = [0_u8; 16 * 1024];
        loop {
            match reader.read(&mut buffered).await {
                Ok(0) | Err(_) => return,
                Ok(_) => {}
            }
        }
    })
    .await
    .expect("server kept revoked WebSocket open during inbound flood");
}

fn decode_array<const N: usize>(value: &str) -> [u8; N] {
    URL_SAFE_NO_PAD
        .decode(value)
        .expect("valid base64url")
        .try_into()
        .unwrap_or_else(|bytes: Vec<u8>| panic!("expected {N} bytes, got {}", bytes.len()))
}

#[tokio::test]
async fn sensitive_routes_reject_requests_without_their_bearer() {
    let harness = Harness::new().await;
    let requests = [
        Request::builder()
            .uri("/v1/bulk")
            .body(Body::empty())
            .unwrap(),
        Request::builder()
            .method(Method::PUT)
            .uri("/v1/upload")
            .body(Body::empty())
            .unwrap(),
        Request::builder()
            .uri("/v1/preview/bootstrap")
            .body(Body::empty())
            .unwrap(),
        Request::builder()
            .uri("/v1/preview/content/")
            .body(Body::empty())
            .unwrap(),
    ];

    for request in requests {
        let response = harness.request(request).await;
        assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
        assert_eq!(
            response.headers().get(header::WWW_AUTHENTICATE).unwrap(),
            "LincoCapability"
        );
        assert_eq!(
            response.headers().get(header::CACHE_CONTROL).unwrap(),
            "no-store"
        );
        assert_eq!(
            response
                .headers()
                .get(header::X_CONTENT_TYPE_OPTIONS)
                .unwrap(),
            "nosniff"
        );
    }

    harness.state.shutdown().await;
}

#[tokio::test]
async fn revocation_invalidates_preissued_read_write_and_preview_capabilities() {
    let harness = Harness::new().await;
    tokio::fs::write(harness.workspace_path.join("guarded.txt"), b"before")
        .await
        .unwrap();
    let revision = strong_etag(b"before");
    let read = harness.issue(HttpCapabilityKind::BulkRead, "guarded.txt", None, None);
    let write = harness.issue(
        HttpCapabilityKind::BulkWrite,
        "guarded.txt",
        Some(revision.clone()),
        Some(5),
    );
    let bootstrap = harness.issue(
        HttpCapabilityKind::PreviewBootstrap,
        "guarded.txt",
        None,
        None,
    );
    let preview_session = harness.issue(HttpCapabilityKind::PreviewSession, "", None, None);

    harness
        .state
        .auth
        .revoke_device(harness.device_id)
        .await
        .unwrap();

    let download = harness
        .request(
            Request::builder()
                .uri("/v1/bulk")
                .header(header::AUTHORIZATION, authorization(&read))
                .body(Body::empty())
                .unwrap(),
        )
        .await;
    assert_eq!(download.status(), StatusCode::UNAUTHORIZED);

    let upload = harness
        .request(
            Request::builder()
                .method(Method::PUT)
                .uri("/v1/upload")
                .header(header::AUTHORIZATION, authorization(&write))
                .header(header::CONTENT_LENGTH, "5")
                .header(header::IF_MATCH, revision)
                .body(Body::from("after"))
                .unwrap(),
        )
        .await;
    assert_eq!(upload.status(), StatusCode::UNAUTHORIZED);

    let bootstrap = harness
        .request(
            Request::builder()
                .uri("/v1/preview/bootstrap")
                .header(header::AUTHORIZATION, authorization(&bootstrap))
                .body(Body::empty())
                .unwrap(),
        )
        .await;
    assert_eq!(bootstrap.status(), StatusCode::UNAUTHORIZED);

    let preview = harness
        .request(
            Request::builder()
                .uri("/v1/preview/content/guarded.txt")
                .header(header::COOKIE, format!("linco_preview={preview_session}"))
                .body(Body::empty())
                .unwrap(),
        )
        .await;
    assert_eq!(preview.status(), StatusCode::UNAUTHORIZED);
    assert_eq!(
        tokio::fs::read(harness.workspace_path.join("guarded.txt"))
            .await
            .unwrap(),
        b"before"
    );

    harness.state.shutdown().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn revocation_during_a_slow_upload_prevents_the_final_commit() {
    use futures_util::stream;

    let harness = Harness::new().await;
    let relative = "slow.txt";
    let path = harness.workspace_path.join(relative);
    tokio::fs::write(&path, b"before").await.unwrap();
    let revision = strong_etag(b"before");
    let token = harness.issue(
        HttpCapabilityKind::BulkWrite,
        relative,
        Some(revision.clone()),
        Some(6),
    );
    let first_chunk_sent = Arc::new(tokio::sync::Notify::new());
    let continue_upload = Arc::new(tokio::sync::Notify::new());
    let body = Body::from_stream(stream::unfold(0_u8, {
        let first_chunk_sent = Arc::clone(&first_chunk_sent);
        let continue_upload = Arc::clone(&continue_upload);
        move |step| {
            let first_chunk_sent = Arc::clone(&first_chunk_sent);
            let continue_upload = Arc::clone(&continue_upload);
            async move {
                match step {
                    0 => {
                        first_chunk_sent.notify_one();
                        Some((Ok::<_, std::io::Error>(Bytes::from_static(b"aft")), 1))
                    }
                    1 => {
                        continue_upload.notified().await;
                        Some((Ok(Bytes::from_static(b"er!")), 2))
                    }
                    _ => None,
                }
            }
        }
    }));
    let request = Request::builder()
        .method(Method::PUT)
        .uri("/v1/upload")
        .header(header::AUTHORIZATION, authorization(&token))
        .header(header::CONTENT_LENGTH, "6")
        .header(header::IF_MATCH, revision)
        .body(body)
        .unwrap();
    let app = harness.app.clone();
    let upload =
        tokio::spawn(async move { app.oneshot(request).await.expect("infallible Axum router") });

    first_chunk_sent.notified().await;
    harness
        .state
        .auth
        .revoke_device(harness.device_id)
        .await
        .unwrap();
    continue_upload.notify_one();
    let response = upload.await.unwrap();
    assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
    assert_eq!(tokio::fs::read(&path).await.unwrap(), b"before");
    assert!(!std::fs::read_dir(path.parent().unwrap())
        .unwrap()
        .filter_map(Result::ok)
        .any(|entry| entry
            .file_name()
            .to_string_lossy()
            .starts_with(".linco-upload-")));

    harness.state.shutdown().await;
}

#[tokio::test]
async fn download_capability_serves_strong_etag_ranges_and_conditional_requests() {
    let harness = Harness::new().await;
    let relative = "reports/result.txt";
    let path = harness.workspace_path.join(relative);
    tokio::fs::create_dir_all(path.parent().unwrap())
        .await
        .unwrap();
    let content = b"latency=7ms\nrenderer=metal\n";
    tokio::fs::write(&path, content).await.unwrap();
    let token = harness.issue(HttpCapabilityKind::BulkRead, relative, None, None);
    let expected_etag = strong_etag(content);

    let response = harness
        .request(
            Request::builder()
                .uri("/v1/bulk")
                .header(header::AUTHORIZATION, authorization(&token))
                .body(Body::empty())
                .unwrap(),
        )
        .await;
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(
        response.headers().get(header::ETAG).unwrap(),
        &expected_etag
    );
    assert_eq!(
        response.headers().get(header::ACCEPT_RANGES).unwrap(),
        "bytes"
    );
    assert!(response.headers().get("content-security-policy").is_none());
    assert_eq!(response_bytes(response).await.as_ref(), content);

    // Read capabilities stay usable for a short TTL so an interrupted iPhone transfer can
    // issue Range and conditional requests without another control-lane round trip.
    let response = harness
        .request(
            Request::builder()
                .uri("/v1/bulk")
                .header(header::AUTHORIZATION, authorization(&token))
                .header(header::RANGE, "bytes=8-10")
                .header(header::IF_RANGE, &expected_etag)
                .body(Body::empty())
                .unwrap(),
        )
        .await;
    assert_eq!(response.status(), StatusCode::PARTIAL_CONTENT);
    assert_eq!(
        response.headers().get(header::CONTENT_RANGE).unwrap(),
        "bytes 8-10/27"
    );
    assert_eq!(response_bytes(response).await.as_ref(), b"7ms");

    let response = harness
        .request(
            Request::builder()
                .uri("/v1/bulk")
                .header(header::AUTHORIZATION, authorization(&token))
                .header(header::IF_NONE_MATCH, &expected_etag)
                .body(Body::empty())
                .unwrap(),
        )
        .await;
    assert_eq!(response.status(), StatusCode::NOT_MODIFIED);
    assert!(response_bytes(response).await.is_empty());

    harness.state.shutdown().await;
}

#[tokio::test]
async fn atomic_put_commits_once_rejects_replay_and_detects_both_conflict_forms() {
    let harness = Harness::new().await;
    let relative = "notes/today.md";
    let path = harness.workspace_path.join(relative);
    tokio::fs::create_dir_all(path.parent().unwrap())
        .await
        .unwrap();
    let original = b"old value\n";
    let replacement = b"final value\n";
    tokio::fs::write(&path, original).await.unwrap();
    let original_etag = strong_etag(original);
    let token = harness.issue(
        HttpCapabilityKind::BulkWrite,
        relative,
        Some(original_etag.clone()),
        Some(replacement.len() as u64),
    );

    let put = || {
        Request::builder()
            .method(Method::PUT)
            .uri("/v1/upload")
            .header(header::AUTHORIZATION, authorization(&token))
            .header(header::CONTENT_LENGTH, replacement.len())
            .header(header::IF_MATCH, &original_etag)
            .body(Body::from(replacement.as_slice()))
            .unwrap()
    };
    let response = harness.request(put()).await;
    assert_eq!(response.status(), StatusCode::NO_CONTENT);
    assert_eq!(
        response.headers().get(header::ETAG).unwrap(),
        &strong_etag(replacement)
    );
    assert_eq!(tokio::fs::read(&path).await.unwrap(), replacement);
    assert!(!std::fs::read_dir(path.parent().unwrap())
        .unwrap()
        .filter_map(Result::ok)
        .any(|entry| entry
            .file_name()
            .to_string_lossy()
            .starts_with(".linco-upload-")));

    let replay = harness.request(put()).await;
    assert_eq!(replay.status(), StatusCode::UNAUTHORIZED);
    assert_eq!(tokio::fs::read(&path).await.unwrap(), replacement);

    let current_etag = strong_etag(replacement);
    let wrong_header_token = harness.issue(
        HttpCapabilityKind::BulkWrite,
        relative,
        Some(current_etag.clone()),
        Some(4),
    );
    let response = harness
        .request(
            Request::builder()
                .method(Method::PUT)
                .uri("/v1/upload")
                .header(header::AUTHORIZATION, authorization(&wrong_header_token))
                .header(header::CONTENT_LENGTH, 4)
                .header(header::IF_MATCH, "\"sha256-stale-client\"")
                .body(Body::from("edit"))
                .unwrap(),
        )
        .await;
    assert_eq!(response.status(), StatusCode::PRECONDITION_FAILED);
    assert_eq!(tokio::fs::read(&path).await.unwrap(), replacement);

    let raced_token = harness.issue(
        HttpCapabilityKind::BulkWrite,
        relative,
        Some(current_etag.clone()),
        Some(4),
    );
    tokio::fs::write(&path, b"external\n").await.unwrap();
    let response = harness
        .request(
            Request::builder()
                .method(Method::PUT)
                .uri("/v1/upload")
                .header(header::AUTHORIZATION, authorization(&raced_token))
                .header(header::CONTENT_LENGTH, 4)
                .header(header::IF_MATCH, &current_etag)
                .body(Body::from("edit"))
                .unwrap(),
        )
        .await;
    assert_eq!(response.status(), StatusCode::PRECONDITION_FAILED);
    assert_eq!(tokio::fs::read(&path).await.unwrap(), b"external\n");

    harness.state.shutdown().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn concurrent_compare_and_swap_uploads_allow_exactly_one_commit() {
    let harness = Harness::new().await;
    let relative = "notes/concurrent.md";
    let path = harness.workspace_path.join(relative);
    tokio::fs::create_dir_all(path.parent().unwrap())
        .await
        .unwrap();
    let original = b"old!!";
    tokio::fs::write(&path, original).await.unwrap();
    let revision = strong_etag(original);
    let first_token = harness.issue(
        HttpCapabilityKind::BulkWrite,
        relative,
        Some(revision.clone()),
        Some(5),
    );
    let second_token = harness.issue(
        HttpCapabilityKind::BulkWrite,
        relative,
        Some(revision.clone()),
        Some(5),
    );
    let barrier = Arc::new(tokio::sync::Barrier::new(3));

    let launch = |token: String, body: &'static str| {
        let app = harness.app.clone();
        let revision = revision.clone();
        let barrier = Arc::clone(&barrier);
        tokio::spawn(async move {
            barrier.wait().await;
            app.oneshot(
                Request::builder()
                    .method(Method::PUT)
                    .uri("/v1/upload")
                    .header(header::AUTHORIZATION, authorization(&token))
                    .header(header::CONTENT_LENGTH, "5")
                    .header(header::IF_MATCH, revision)
                    .body(Body::from(body))
                    .unwrap(),
            )
            .await
            .expect("infallible Axum router")
            .status()
        })
    };
    let first = launch(first_token, "first");
    let second = launch(second_token, "other");
    barrier.wait().await;
    let (first, second) = tokio::join!(first, second);
    let mut statuses = [first.unwrap(), second.unwrap()];
    statuses.sort();
    assert_eq!(
        statuses,
        [StatusCode::NO_CONTENT, StatusCode::PRECONDITION_FAILED]
    );
    let committed = tokio::fs::read(&path).await.unwrap();
    assert!(committed == b"first" || committed == b"other");

    harness.state.shutdown().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn readers_never_observe_a_partially_written_put() {
    use std::collections::VecDeque;

    use futures_util::stream;

    let harness = Harness::new().await;
    let relative = "atomic.bin";
    let path = harness.workspace_path.join(relative);
    let original = vec![b'a'; 128 * 1024];
    let replacement = vec![b'b'; 128 * 1024];
    tokio::fs::write(&path, &original).await.unwrap();
    let original_etag = strong_etag(&original);
    let token = harness.issue(
        HttpCapabilityKind::BulkWrite,
        relative,
        Some(original_etag.clone()),
        Some(replacement.len() as u64),
    );
    let chunks = replacement
        .chunks(4 * 1024)
        .map(Bytes::copy_from_slice)
        .collect::<VecDeque<_>>();
    let body = Body::from_stream(stream::unfold(chunks, |mut chunks| async move {
        let chunk = chunks.pop_front()?;
        tokio::time::sleep(Duration::from_millis(2)).await;
        Some((Ok::<_, std::io::Error>(chunk), chunks))
    }));
    let request = Request::builder()
        .method(Method::PUT)
        .uri("/v1/upload")
        .header(header::AUTHORIZATION, authorization(&token))
        .header(header::CONTENT_LENGTH, replacement.len())
        .header(header::IF_MATCH, original_etag)
        .body(body)
        .unwrap();
    let app = harness.app.clone();
    let upload =
        tokio::spawn(async move { app.oneshot(request).await.expect("infallible Axum router") });

    while !upload.is_finished() {
        let visible = tokio::fs::read(&path).await.unwrap();
        assert!(visible == original || visible == replacement);
        tokio::task::yield_now().await;
    }
    let response = upload.await.unwrap();
    assert_eq!(response.status(), StatusCode::NO_CONTENT);
    assert_eq!(tokio::fs::read(&path).await.unwrap(), replacement);

    harness.state.shutdown().await;
}

#[tokio::test]
async fn preview_bootstrap_is_single_use_then_cookie_serves_isolated_content() {
    let harness = Harness::new().await;
    let site = harness.workspace_path.join("site");
    tokio::fs::create_dir_all(&site).await.unwrap();
    let html = b"<!doctype html><script src=\"app.js\"></script><h1>Linco</h1>";
    tokio::fs::write(site.join("index.html"), html)
        .await
        .unwrap();
    tokio::fs::write(site.join("app.js"), b"document.body.dataset.ready='1'")
        .await
        .unwrap();
    tokio::fs::write(harness.workspace_path.join("secret.txt"), b"outside")
        .await
        .unwrap();
    let token = harness.issue(HttpCapabilityKind::PreviewBootstrap, "site", None, None);

    let bootstrap_request = || {
        Request::builder()
            .uri("/v1/preview/bootstrap")
            .header(header::AUTHORIZATION, authorization(&token))
            .body(Body::empty())
            .unwrap()
    };
    let response = harness.request(bootstrap_request()).await;
    assert_eq!(response.status(), StatusCode::SEE_OTHER);
    assert_eq!(
        response.headers().get(header::LOCATION).unwrap(),
        "/v1/preview/content/"
    );
    assert_eq!(
        response.headers().get(header::CACHE_CONTROL).unwrap(),
        "no-store"
    );
    let set_cookie = response
        .headers()
        .get(header::SET_COOKIE)
        .unwrap()
        .to_str()
        .unwrap()
        .to_owned();
    for attribute in [
        "linco_preview=",
        "Path=/v1/preview/",
        "Secure",
        "HttpOnly",
        "SameSite=Strict",
    ] {
        assert!(set_cookie.contains(attribute), "missing cookie {attribute}");
    }
    let cookie = set_cookie.split(';').next().unwrap().to_owned();

    let replay = harness.request(bootstrap_request()).await;
    assert_eq!(replay.status(), StatusCode::UNAUTHORIZED);

    let response = harness
        .request(
            Request::builder()
                .uri("/v1/preview/content/")
                .header(header::COOKIE, &cookie)
                .body(Body::empty())
                .unwrap(),
        )
        .await;
    assert_eq!(response.status(), StatusCode::OK);
    let csp = response
        .headers()
        .get("content-security-policy")
        .unwrap()
        .to_str()
        .unwrap();
    for directive in [
        "connect-src 'self'",
        "object-src 'none'",
        "base-uri 'self'",
        "form-action 'self'",
        "frame-ancestors 'none'",
    ] {
        assert!(csp.contains(directive), "missing CSP {directive}");
    }
    assert_eq!(
        response.headers().get(header::REFERRER_POLICY).unwrap(),
        "no-referrer"
    );
    assert_eq!(response_bytes(response).await.as_ref(), html);

    let response = harness
        .request(
            Request::builder()
                .uri("/v1/preview/content/app.js")
                .header(header::COOKIE, &cookie)
                .body(Body::empty())
                .unwrap(),
        )
        .await;
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(
        response_bytes(response).await.as_ref(),
        b"document.body.dataset.ready='1'"
    );

    let escaped = harness
        .request(
            Request::builder()
                .uri("/v1/preview/content/%2e%2e/secret.txt")
                .header(header::COOKIE, &cookie)
                .body(Body::empty())
                .unwrap(),
        )
        .await;
    assert!(!escaped.status().is_success());

    harness.state.shutdown().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn real_websocket_routes_pair_authenticate_and_revoke_blocked_lanes() {
    type HmacSha256 = Hmac<Sha256>;

    let harness = Harness::new().await;
    let pairing = harness
        .state
        .auth
        .create_pairing("http://127.0.0.1:7337", 120)
        .await
        .expect("create pairing ticket");
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind real Axum listener");
    let address = listener.local_addr().unwrap();
    let app = harness.app.clone();
    let server = tokio::spawn(async move {
        axum::serve(listener, app)
            .await
            .expect("serve black-box router")
    });

    let device_signing = SigningKey::random(&mut OsRng);
    let device_public_key = device_signing
        .verifying_key()
        .to_encoded_point(false)
        .as_bytes()
        .to_vec();
    let client_nonce = [0x31_u8; 32];
    let mut socket = RawControlSocket::connect(address).await;
    socket
        .send(&ClientMessage::Hello {
            protocol_version: PROTOCOL_VERSION,
            lane: LogicalChannel::Control,
            connection_id: None,
            device_id: None,
            client_nonce_b64: URL_SAFE_NO_PAD.encode(client_nonce),
            resume: ResumeCursor::default(),
        })
        .await;
    let (pairing_connection, pairing_epoch, server_identity, pairing_challenge, server_signature) =
        match socket.receive().await {
            ServerMessage::Hello {
                protocol_version,
                lane,
                connection_id,
                server_epoch,
                server_identity_b64,
                auth_challenge_b64,
                server_signature_b64,
                heartbeat_ms,
            } => {
                assert_eq!(protocol_version, PROTOCOL_VERSION);
                assert_eq!(lane, LogicalChannel::Control);
                assert_eq!(heartbeat_ms, 15_000);
                (
                    connection_id,
                    server_epoch,
                    decode_array::<32>(&server_identity_b64),
                    decode_array::<32>(&auth_challenge_b64),
                    decode_array::<64>(&server_signature_b64),
                )
            }
            other => panic!("expected server hello, got {other:?}"),
        };
    assert_eq!(
        URL_SAFE_NO_PAD.encode(server_identity),
        pairing.server_identity_b64
    );
    let hello_transcript = server_hello_transcript(
        PROTOCOL_VERSION,
        LogicalChannel::Control,
        pairing_connection,
        pairing_epoch,
        &client_nonce,
        &pairing_challenge,
        &server_identity,
    )
    .unwrap();
    Ed25519VerifyingKey::from_bytes(&server_identity)
        .unwrap()
        .verify_strict(
            &hello_transcript,
            &Ed25519Signature::from_bytes(&server_signature),
        )
        .expect("server hello proves the QR-pinned identity");

    socket
        .send(&ClientMessage::PairStart {
            pairing_id: pairing.pairing_id,
            device_name: "Black-box iPhone".into(),
            device_key_algorithm: KeyAlgorithm::P256,
            device_public_key_b64: URL_SAFE_NO_PAD.encode(&device_public_key),
            client_nonce_b64: URL_SAFE_NO_PAD.encode(client_nonce),
        })
        .await;
    match socket.receive().await {
        ServerMessage::PairChallenge {
            pairing_id,
            challenge_b64,
            expires_at_ms,
        } => {
            assert_eq!(pairing_id, pairing.pairing_id);
            assert_eq!(decode_array::<32>(&challenge_b64), pairing_challenge);
            assert!(expires_at_ms > 0);
        }
        other => panic!("expected pairing challenge, got {other:?}"),
    }
    let pairing_transcript = pairing_transcript(
        pairing.pairing_id,
        &client_nonce,
        &pairing_challenge,
        &device_public_key,
        &server_identity,
    )
    .unwrap();
    let secret = decode_array::<32>(&pairing.pairing_secret_b64);
    let mut mac = <HmacSha256 as Mac>::new_from_slice(&secret).unwrap();
    mac.update(&pairing_transcript);
    let pairing_proof = mac.finalize().into_bytes();
    let device_signature: P256Signature = device_signing.sign(&pairing_transcript);
    socket
        .send(&ClientMessage::PairFinish {
            pairing_id: pairing.pairing_id,
            proof_b64: URL_SAFE_NO_PAD.encode(pairing_proof),
            device_signature_b64: URL_SAFE_NO_PAD.encode(device_signature.to_der().as_bytes()),
        })
        .await;
    let device_id = match socket.receive().await {
        ServerMessage::PairAccepted {
            device_id,
            permissions,
        } => {
            assert_eq!(
                permissions,
                vec![Permission::Read, Permission::Terminal, Permission::Write]
            );
            device_id
        }
        other => panic!("expected pairing acceptance, got {other:?}"),
    };
    match socket.receive().await {
        ServerMessage::Ready {
            connection_id,
            server_epoch,
            lane,
            connection_path,
            attach_tickets,
        } => {
            assert_eq!(connection_id, pairing_connection);
            assert_eq!(server_epoch, pairing_epoch);
            assert_eq!(lane, LogicalChannel::Control);
            assert_eq!(connection_path, ConnectionPath::Direct);
            assert_eq!(attach_tickets.len(), 1);
            assert_eq!(attach_tickets[0].lane, LogicalChannel::Interactive);
        }
        other => panic!("expected ready after pairing, got {other:?}"),
    }
    drop(socket);

    let auth_nonce = [0x72_u8; 32];
    let mut socket = RawControlSocket::connect(address).await;
    socket
        .send(&ClientMessage::Hello {
            protocol_version: PROTOCOL_VERSION,
            lane: LogicalChannel::Control,
            connection_id: None,
            device_id: Some(device_id),
            client_nonce_b64: URL_SAFE_NO_PAD.encode(auth_nonce),
            resume: ResumeCursor::default(),
        })
        .await;
    let (auth_connection, auth_challenge) = match socket.receive().await {
        ServerMessage::Hello {
            protocol_version,
            lane,
            connection_id,
            server_epoch,
            server_identity_b64,
            auth_challenge_b64,
            ..
        } => {
            assert_eq!(protocol_version, PROTOCOL_VERSION);
            assert_eq!(lane, LogicalChannel::Control);
            assert_eq!(server_epoch, pairing_epoch);
            assert_eq!(decode_array::<32>(&server_identity_b64), server_identity);
            (connection_id, decode_array::<32>(&auth_challenge_b64))
        }
        other => panic!("expected authentication hello, got {other:?}"),
    };
    let authentication_transcript = authentication_transcript(
        auth_connection,
        device_id,
        pairing_epoch,
        &auth_nonce,
        &auth_challenge,
        &server_identity,
    )
    .unwrap();
    let auth_signature: P256Signature = device_signing.sign(&authentication_transcript);
    socket
        .send(&ClientMessage::Authenticate {
            connection_id: auth_connection,
            device_id,
            challenge_signature_b64: URL_SAFE_NO_PAD.encode(auth_signature.to_der().as_bytes()),
        })
        .await;
    let interactive_ticket = match socket.receive().await {
        ServerMessage::Ready {
            connection_id,
            server_epoch,
            lane,
            connection_path,
            attach_tickets,
        } => {
            assert_eq!(connection_id, auth_connection);
            assert_eq!(server_epoch, pairing_epoch);
            assert_eq!(lane, LogicalChannel::Control);
            assert_eq!(connection_path, ConnectionPath::Direct);
            assert_eq!(attach_tickets.len(), 1);
            attach_tickets.into_iter().next().unwrap()
        }
        other => panic!("expected ready after authentication, got {other:?}"),
    };
    socket
        .send(&ClientMessage::Ping {
            nonce: 99,
            sent_at_ms: 1234,
        })
        .await;
    match socket.receive().await {
        ServerMessage::Pong {
            nonce,
            client_sent_at_ms,
            server_at_ms,
        } => {
            assert_eq!(nonce, 99);
            assert_eq!(client_sent_at_ms, 1234);
            assert!(server_at_ms > 1234);
        }
        other => panic!("expected authenticated pong, got {other:?}"),
    }

    let mut interactive = RawControlSocket::connect_path(address, "/v1/ws/interactive").await;
    interactive
        .send(&ClientMessage::AttachLane {
            connection_id: auth_connection,
            lane: LogicalChannel::Interactive,
            ticket_b64: interactive_ticket.ticket_b64,
            client_nonce_b64: URL_SAFE_NO_PAD.encode([0x53_u8; 32]),
        })
        .await;
    match interactive.receive().await {
        ServerMessage::Ready {
            connection_id,
            server_epoch,
            lane,
            connection_path,
            attach_tickets,
        } => {
            assert_eq!(connection_id, auth_connection);
            assert_eq!(server_epoch, pairing_epoch);
            assert_eq!(lane, LogicalChannel::Interactive);
            assert_eq!(connection_path, ConnectionPath::Direct);
            assert!(attach_tickets.is_empty());
        }
        other => panic!("expected interactive ready, got {other:?}"),
    }

    // A same-epoch reconnect can still hold input for a terminal stream the server has retired.
    // Reject only that stream; keeping the lane alive prevents a permanent reconnect/replay loop.
    let retired_stream_id = u32::MAX;
    let retired_input = BinaryFrame::new(
        BinaryKind::TerminalInput,
        retired_stream_id,
        0,
        0,
        b"stale pending input".to_vec(),
    )
    .unwrap()
    .encode();
    interactive.send_binary(&retired_input).await;
    match interactive.receive().await {
        ServerMessage::TerminalInputFault {
            stream_id,
            generation,
            code,
            authoritative_through,
            discard_pending,
        } => {
            assert_eq!(stream_id, retired_stream_id);
            assert_eq!(generation, None);
            assert_eq!(code, TerminalInputFaultCode::NotFound);
            assert_eq!(authoritative_through, None);
            assert!(discard_pending);
        }
        other => panic!("expected stream-scoped terminal input fault, got {other:?}"),
    }
    interactive
        .send(&ClientMessage::Ping {
            nonce: 100,
            sent_at_ms: 1_235,
        })
        .await;
    match interactive.receive().await {
        ServerMessage::Pong {
            nonce,
            client_sent_at_ms,
            ..
        } => {
            assert_eq!(nonce, 100);
            assert_eq!(client_sent_at_ms, 1_235);
        }
        other => panic!("expected interactive lane to survive stale input, got {other:?}"),
    }

    let retired_resume_id = Uuid::new_v4();
    interactive
        .send(&ClientMessage::Call {
            id: retired_resume_id,
            method: RpcMethod::SessionResume,
            params: serde_json::json!({
                "stream_id": retired_stream_id,
                "generation": 1,
                "offset": 0,
            }),
            idempotency_key: None,
            deadline_ms: 5_000,
        })
        .await;
    match interactive.receive().await {
        ServerMessage::ResumeReset {
            stream_id, reason, ..
        } => {
            assert_eq!(stream_id, Some(retired_stream_id));
            assert!(reason.contains("not found"));
        }
        other => panic!("expected retired-stream resume reset, got {other:?}"),
    }
    match interactive.receive().await {
        ServerMessage::Error { id, code, .. } => {
            assert_eq!(id, Some(retired_resume_id));
            assert_eq!(code, linco_protocol::ErrorCode::NotFound);
        }
        other => panic!("expected retired-stream resume error, got {other:?}"),
    }
    interactive
        .send(&ClientMessage::Ping {
            nonce: 101,
            sent_at_ms: 1_236,
        })
        .await;
    match interactive.receive().await {
        ServerMessage::Pong { nonce, .. } => assert_eq!(nonce, 101),
        other => panic!("expected lane to survive retired-stream resume, got {other:?}"),
    }

    let terminal_session_id = Uuid::new_v4();
    let workspace = harness
        .state
        .workspaces
        .get(harness.workspace_id)
        .unwrap()
        .root
        .clone();
    let (terminal_info, stream_id) = harness
        .state
        .terminal
        .start(TerminalStart {
            session_id: terminal_session_id,
            kind: SessionKind::Shell,
            workspace,
            relative_cwd: PathBuf::new(),
            size: TerminalSize::default(),
            environment: BTreeMap::new(),
            agent_arguments: Vec::new(),
        })
        .await
        .expect("start real PTY for blocked-input revocation test");
    let resume_id = Uuid::new_v4();
    interactive
        .send(&ClientMessage::Call {
            id: resume_id,
            method: RpcMethod::SessionResume,
            params: serde_json::json!({
                "stream_id": stream_id,
                "generation": terminal_info.generation,
                "offset": 0,
            }),
            idempotency_key: None,
            deadline_ms: 5_000,
        })
        .await;
    match interactive.receive().await {
        ServerMessage::StreamOpened {
            stream_id: opened,
            generation,
            starting_offset,
            input_through,
        } => {
            assert_eq!(opened, stream_id);
            assert_eq!(generation, terminal_info.generation);
            assert_eq!(starting_offset, 0);
            assert_eq!(input_through, 0);
        }
        other => panic!("expected terminal stream open, got {other:?}"),
    }
    match interactive.receive().await {
        ServerMessage::Result { id, value } => {
            assert_eq!(id, resume_id);
            let resumed: SessionResumeResponse = serde_json::from_value(value).unwrap();
            assert_eq!(resumed.input_through, 0);
        }
        other => panic!("expected terminal resume result, got {other:?}"),
    }

    #[cfg(windows)]
    let nonreading_command = b"ping -n 30 127.0.0.1 >NUL\r\n".as_slice();
    #[cfg(target_os = "linux")]
    let nonreading_command =
        b"trap '' HUP; sleep 300 & (printf 'LINCO-WATCHDOG-%s\\n' READY; exec sleep 300)\n"
            .as_slice();
    #[cfg(all(not(windows), not(target_os = "linux")))]
    let nonreading_command = b"sleep 30\n".as_slice();
    let command_frame = BinaryFrame::new(
        BinaryKind::TerminalInput,
        stream_id,
        0,
        0,
        nonreading_command.to_vec(),
    )
    .unwrap()
    .encode();
    interactive.send_binary(&command_frame).await;
    match interactive.receive().await {
        ServerMessage::StreamAck {
            stream_id: acknowledged,
            through_offset,
        } => {
            assert_eq!(acknowledged, stream_id);
            assert_eq!(through_offset, nonreading_command.len() as u64);
        }
        other => panic!("expected command input acknowledgement, got {other:?}"),
    }

    // Model a fresh iPhone process: the output cursor may restart independently, but input must
    // begin at the server-authoritative offset. StreamOpened precedes Result on the same lane.
    let cold_resume_id = Uuid::new_v4();
    interactive
        .send(&ClientMessage::Call {
            id: cold_resume_id,
            method: RpcMethod::SessionResume,
            params: serde_json::json!({
                "stream_id": stream_id,
                "generation": terminal_info.generation,
                "offset": 0,
            }),
            idempotency_key: None,
            deadline_ms: 5_000,
        })
        .await;
    match interactive.receive().await {
        ServerMessage::StreamOpened {
            stream_id: opened,
            generation,
            starting_offset,
            input_through,
        } => {
            assert_eq!(opened, stream_id);
            assert_eq!(generation, terminal_info.generation);
            assert_eq!(starting_offset, 0);
            assert_eq!(input_through, nonreading_command.len() as u64);
        }
        other => panic!("expected authoritative cold-resume stream open, got {other:?}"),
    }
    match interactive.receive().await {
        ServerMessage::Result { id, value } => {
            assert_eq!(id, cold_resume_id);
            let resumed: SessionResumeResponse = serde_json::from_value(value).unwrap();
            assert_eq!(resumed.input_through, nonreading_command.len() as u64);
        }
        other => panic!("expected authoritative cold-resume result, got {other:?}"),
    }
    tokio::time::sleep(Duration::from_millis(150)).await;

    let input_chunk = vec![b'x'; BinaryKind::TerminalInput.max_payload_bytes()];
    let mut input_offset = nonreading_command.len() as u64;
    for _ in 0..6 {
        let frame = BinaryFrame::new(
            BinaryKind::TerminalInput,
            stream_id,
            input_offset,
            0,
            input_chunk.clone(),
        )
        .unwrap()
        .encode();
        interactive.send_binary(&frame).await;
        input_offset += input_chunk.len() as u64;
    }

    let flood_frame = encoded_client_message(&ClientMessage::Ping {
        nonce: 7,
        sent_at_ms: 7,
    });
    let flood_stopped = CancellationToken::new();
    let (control_reader, control_writer) = socket.into_stream().into_split();
    let (interactive_reader, interactive_writer) = interactive.into_stream().into_split();
    let control_flood = tokio::spawn(flood_websocket(
        control_writer,
        flood_frame.clone(),
        flood_stopped.clone(),
    ));
    let interactive_flood = tokio::spawn(flood_websocket(
        interactive_writer,
        flood_frame,
        flood_stopped.clone(),
    ));

    harness.state.auth.revoke_device(device_id).await.unwrap();
    tokio::time::sleep(Duration::from_secs(3)).await;
    tokio::join!(
        expect_remote_disconnect(control_reader),
        expect_remote_disconnect(interactive_reader)
    );
    flood_stopped.cancel();
    let _ = tokio::join!(control_flood, interactive_flood);

    let devices = harness.state.auth.list_devices().await.unwrap();
    let paired = devices
        .iter()
        .find(|device| device.id == device_id)
        .expect("paired device remains auditable after revocation");
    assert!(paired.revoked);
    assert!(harness
        .state
        .auth
        .check_pairing(pairing.pairing_id)
        .await
        .is_err());

    server.abort();
    let _ = server.await;
    harness.state.shutdown().await;
}
