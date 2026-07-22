use std::{
    fmt::Write as _,
    path::{Path as FsPath, PathBuf},
    sync::Arc,
    time::SystemTime,
};

use axum::{
    body::Body,
    extract::{Path, State},
    http::{header, HeaderMap, HeaderValue, Method, Request, Response, StatusCode},
    middleware::{self, Next},
    response::IntoResponse,
    routing::{get, put},
    Json, Router,
};
use http_body_util::BodyExt;
use percent_encoding::{utf8_percent_encode, NON_ALPHANUMERIC};
use serde_json::json;
use sha2::{Digest, Sha256};
use tokio::io::{AsyncReadExt, AsyncSeekExt, AsyncWriteExt, SeekFrom};
use tokio_util::io::ReaderStream;
use uuid::Uuid;

use crate::{
    state::AppState,
    tickets::HttpCapabilityKind,
    ws::{control_upgrade, interactive_upgrade},
};

pub fn router(state: Arc<AppState>) -> Router {
    Router::new()
        .route("/healthz", get(health))
        .route("/v1/ws/control", get(control_upgrade))
        .route("/v1/ws/interactive", get(interactive_upgrade))
        .route("/v1/bulk", get(bulk).head(bulk))
        .route("/v1/upload", put(upload))
        .route("/v1/preview/bootstrap", get(preview_bootstrap))
        .route(
            "/v1/preview/content",
            get(preview_content_root).head(preview_content_root),
        )
        .route(
            "/v1/preview/content/",
            get(preview_content_root).head(preview_content_root),
        )
        .route(
            "/v1/preview/content/{*path}",
            get(preview_content).head(preview_content),
        )
        .fallback(not_found)
        .layer(middleware::from_fn(security_headers))
        .with_state(state)
}

async fn health(State(state): State<Arc<AppState>>) -> impl IntoResponse {
    let uptime_ms = SystemTime::now()
        .duration_since(state.started_at)
        .unwrap_or_default()
        .as_millis()
        .min(u64::MAX as u128) as u64;
    Json(json!({
        "status": "ok",
        "version": env!("CARGO_PKG_VERSION"),
        "server_epoch": state.server_epoch,
        "uptime_ms": uptime_ms,
    }))
}

async fn bulk(
    State(state): State<Arc<AppState>>,
    method: Method,
    headers: HeaderMap,
) -> Response<Body> {
    let Some(ticket) = capability_header(&headers) else {
        return unauthorized();
    };
    let grant = match state
        .tickets
        .redeem_http(ticket, HttpCapabilityKind::BulkRead)
    {
        Ok(grant) => grant,
        Err(_) => return unauthorized(),
    };
    if !state.device_authorization_is_active(grant.device_id).await {
        return unauthorized();
    }
    let workspace = match state.workspaces.get(grant.workspace_id) {
        Ok(workspace) => workspace,
        Err(_) => return plain(StatusCode::NOT_FOUND, "workspace not found"),
    };
    let file = match workspace.root.resolve_existing(&grant.relative_path) {
        Ok(file) => file,
        Err(_) => return plain(StatusCode::NOT_FOUND, "file not found"),
    };
    serve_file(file, method == Method::HEAD, &headers).await
}

async fn upload(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    mut body: Body,
) -> Response<Body> {
    let Some(ticket) = capability_header(&headers) else {
        return unauthorized();
    };
    let grant = match state
        .tickets
        .consume_http(ticket, HttpCapabilityKind::BulkWrite)
    {
        Ok(grant) => grant,
        Err(_) => return unauthorized(),
    };
    if !state.device_authorization_is_active(grant.device_id).await {
        return unauthorized();
    }
    let supplied_length = headers
        .get(header::CONTENT_LENGTH)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.parse::<u64>().ok());
    if supplied_length.is_some_and(|length| length > grant.max_bytes) {
        return plain(StatusCode::PAYLOAD_TOO_LARGE, "upload is too large");
    }
    if supplied_length.is_none() || supplied_length != grant.content_length {
        return plain(
            StatusCode::BAD_REQUEST,
            "content-length did not match reservation",
        );
    }
    let Some(expected_etag) = grant.expected_etag.as_deref() else {
        return plain(
            StatusCode::PRECONDITION_REQUIRED,
            "upload revision is missing",
        );
    };
    if headers
        .get(header::IF_MATCH)
        .and_then(|value| value.to_str().ok())
        != Some(expected_etag)
    {
        return plain(
            StatusCode::PRECONDITION_FAILED,
            "file revision does not match",
        );
    }
    let workspace = match state.workspaces.get(grant.workspace_id) {
        Ok(workspace) => workspace,
        Err(_) => return plain(StatusCode::NOT_FOUND, "workspace not found"),
    };
    let target = match workspace.root.resolve_for_create(&grant.relative_path) {
        Ok(target) => target,
        Err(_) => return plain(StatusCode::BAD_REQUEST, "invalid upload path"),
    };
    if !revision_matches(&target, expected_etag).await {
        return plain(StatusCode::PRECONDITION_FAILED, "file revision changed");
    }
    let Some(parent) = target.parent() else {
        return plain(StatusCode::BAD_REQUEST, "invalid upload target");
    };
    if !parent.is_dir() {
        return plain(StatusCode::BAD_REQUEST, "upload parent does not exist");
    }
    let temp = parent.join(format!(".linco-upload-{}.tmp", Uuid::new_v4()));
    let mut file = match tokio::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&temp)
        .await
    {
        Ok(file) => file,
        Err(_) => return plain(StatusCode::INTERNAL_SERVER_ERROR, "upload staging failed"),
    };
    let mut written = 0_u64;
    while let Some(frame) = body.frame().await {
        let frame = match frame {
            Ok(frame) => frame,
            Err(_) => {
                drop(file);
                let _ = tokio::fs::remove_file(&temp).await;
                return plain(StatusCode::BAD_REQUEST, "upload body failed");
            }
        };
        let Ok(data) = frame.into_data() else {
            continue;
        };
        written = match written.checked_add(data.len() as u64) {
            Some(value) if value <= grant.max_bytes => value,
            _ => {
                drop(file);
                let _ = tokio::fs::remove_file(&temp).await;
                return plain(StatusCode::PAYLOAD_TOO_LARGE, "upload is too large");
            }
        };
        if file.write_all(&data).await.is_err() {
            drop(file);
            let _ = tokio::fs::remove_file(&temp).await;
            return plain(StatusCode::INTERNAL_SERVER_ERROR, "upload write failed");
        }
    }
    if Some(written) != grant.content_length {
        drop(file);
        let _ = tokio::fs::remove_file(&temp).await;
        return plain(
            StatusCode::BAD_REQUEST,
            "upload length did not match reservation",
        );
    }
    if file.flush().await.is_err() || file.sync_all().await.is_err() {
        drop(file);
        let _ = tokio::fs::remove_file(&temp).await;
        return plain(StatusCode::INTERNAL_SERVER_ERROR, "upload sync failed");
    }
    drop(file);
    // Linco writers serialize the commit section per canonical workspace target. Staging remains
    // concurrent, while the final authorization/CAS check and atomic replace form one unit.
    let _commit_guard = state.lock_upload_target(&target).await;
    if !state.refresh_device_authorization(grant.device_id).await {
        let _ = tokio::fs::remove_file(&temp).await;
        return unauthorized();
    }
    if !revision_matches(&target, expected_etag).await {
        let _ = tokio::fs::remove_file(&temp).await;
        return plain(
            StatusCode::PRECONDITION_FAILED,
            "file changed during upload",
        );
    }
    if let Ok(metadata) = tokio::fs::metadata(&target).await {
        let _ = tokio::fs::set_permissions(&temp, metadata.permissions()).await;
    }
    if tokio::fs::rename(&temp, &target).await.is_err() {
        let _ = tokio::fs::remove_file(&temp).await;
        return plain(
            StatusCode::INTERNAL_SERVER_ERROR,
            "atomic upload commit failed",
        );
    }
    sync_parent(parent.to_path_buf()).await;
    let new_etag = match strong_etag(&target).await {
        Ok(etag) => etag,
        Err(_) => {
            return plain(
                StatusCode::INTERNAL_SERVER_ERROR,
                "upload committed without metadata",
            )
        }
    };
    let mut response = Response::new(Body::empty());
    *response.status_mut() = StatusCode::NO_CONTENT;
    response.headers_mut().insert(
        header::ETAG,
        HeaderValue::from_str(&new_etag).expect("safe etag"),
    );
    response
}

async fn preview_bootstrap(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
) -> Response<Body> {
    let Some(ticket) = capability_header(&headers) else {
        return unauthorized();
    };
    let bootstrap = match state
        .tickets
        .consume_http(ticket, HttpCapabilityKind::PreviewBootstrap)
    {
        Ok(grant) => grant,
        Err(_) => return unauthorized(),
    };
    if !state
        .device_authorization_is_active(bootstrap.device_id)
        .await
    {
        return unauthorized();
    }
    let workspace = match state.workspaces.get(bootstrap.workspace_id) {
        Ok(workspace) => workspace,
        Err(_) => return plain(StatusCode::NOT_FOUND, "workspace not found"),
    };
    let target = match workspace.root.resolve_existing(&bootstrap.relative_path) {
        Ok(target) => target,
        Err(_) => return plain(StatusCode::NOT_FOUND, "preview target not found"),
    };
    let relative_target = match target.strip_prefix(workspace.root.as_path()) {
        Ok(value) => value,
        Err(_) => return plain(StatusCode::NOT_FOUND, "preview target not found"),
    };
    let (base, suffix) = if target.is_dir() {
        (relative_target.to_path_buf(), String::new())
    } else {
        let base = relative_target
            .parent()
            .unwrap_or(FsPath::new(""))
            .to_path_buf();
        let Some(name) = relative_target.file_name().and_then(|value| value.to_str()) else {
            return plain(StatusCode::BAD_REQUEST, "preview path is not UTF-8");
        };
        (base, encode_path(name))
    };
    let session = match state.tickets.issue_http(
        crate::tickets::HttpGrant {
            device_id: bootstrap.device_id,
            workspace_id: bootstrap.workspace_id,
            relative_path: base.to_string_lossy().into_owned(),
            kind: HttpCapabilityKind::PreviewSession,
            expected_etag: None,
            max_bytes: 0,
            content_length: None,
        },
        state.config.http_ticket_ttl,
    ) {
        Ok(token) => token,
        Err(_) => return plain(StatusCode::INTERNAL_SERVER_ERROR, "preview session failed"),
    };
    let location = if suffix.is_empty() {
        "/v1/preview/content/".to_owned()
    } else {
        format!("/v1/preview/content/{suffix}")
    };
    let max_age = state.config.http_ticket_ttl.as_secs();
    let cookie = format!(
        "linco_preview={session}; Max-Age={max_age}; Path=/v1/preview/; Secure; HttpOnly; SameSite=Strict"
    );
    let mut response = Response::new(Body::empty());
    *response.status_mut() = StatusCode::SEE_OTHER;
    response.headers_mut().insert(
        header::LOCATION,
        HeaderValue::from_str(&location).expect("encoded relative redirect"),
    );
    response.headers_mut().insert(
        header::SET_COOKIE,
        HeaderValue::from_str(&cookie).expect("base64url cookie"),
    );
    response
        .headers_mut()
        .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    response
}

async fn preview_content_root(
    State(state): State<Arc<AppState>>,
    method: Method,
    headers: HeaderMap,
) -> Response<Body> {
    serve_preview(state, String::new(), method, headers).await
}

async fn preview_content(
    State(state): State<Arc<AppState>>,
    Path(path): Path<String>,
    method: Method,
    headers: HeaderMap,
) -> Response<Body> {
    serve_preview(state, path, method, headers).await
}

async fn serve_preview(
    state: Arc<AppState>,
    requested: String,
    method: Method,
    headers: HeaderMap,
) -> Response<Body> {
    let Some(ticket) = cookie_value(&headers, "linco_preview") else {
        return unauthorized();
    };
    let grant = match state
        .tickets
        .redeem_http(ticket, HttpCapabilityKind::PreviewSession)
    {
        Ok(grant) => grant,
        Err(_) => return unauthorized(),
    };
    if !state.device_authorization_is_active(grant.device_id).await {
        return unauthorized();
    }
    let workspace = match state.workspaces.get(grant.workspace_id) {
        Ok(workspace) => workspace,
        Err(_) => return plain(StatusCode::NOT_FOUND, "workspace not found"),
    };

    let relative = if requested.is_empty() {
        PathBuf::from(&grant.relative_path)
    } else {
        PathBuf::from(&grant.relative_path).join(requested)
    };
    let mut file = match workspace.root.resolve_existing(&relative) {
        Ok(path) => path,
        Err(_) => return plain(StatusCode::NOT_FOUND, "preview asset not found"),
    };
    if file.is_dir() {
        file.push("index.html");
        file = match workspace.root.resolve_existing(
            file.strip_prefix(workspace.root.as_path())
                .unwrap_or(FsPath::new("")),
        ) {
            Ok(path) => path,
            Err(_) => return plain(StatusCode::NOT_FOUND, "preview index not found"),
        };
    }
    let mut response = serve_file(file, method == Method::HEAD, &headers).await;
    insert_preview_security_headers(response.headers_mut());
    response
}

async fn serve_file(path: PathBuf, head_only: bool, request_headers: &HeaderMap) -> Response<Body> {
    let mut file = match tokio::fs::File::open(&path).await {
        Ok(file) => file,
        Err(_) => return plain(StatusCode::NOT_FOUND, "file not found"),
    };
    let metadata = match file.metadata().await {
        Ok(metadata) if metadata.is_file() => metadata,
        _ => return plain(StatusCode::NOT_FOUND, "file not found"),
    };
    let len = metadata.len();
    let etag = match strong_etag_file(&mut file).await {
        Ok(etag) => etag,
        Err(_) => return plain(StatusCode::INTERNAL_SERVER_ERROR, "file revision failed"),
    };

    if request_headers
        .get(header::IF_NONE_MATCH)
        .and_then(|value| value.to_str().ok())
        .is_some_and(|value| etag_matches(value, &etag))
    {
        let mut response = Response::new(Body::empty());
        *response.status_mut() = StatusCode::NOT_MODIFIED;
        insert_common_file_headers(response.headers_mut(), &path, &etag);
        return response;
    }

    let honor_range = request_headers
        .get(header::IF_RANGE)
        .and_then(|value| value.to_str().ok())
        .is_none_or(|value| value.trim() == etag);
    let range = if honor_range {
        match request_headers.get(header::RANGE) {
            Some(value) => match value
                .to_str()
                .ok()
                .and_then(|value| parse_range(value, len))
            {
                Some(range) => Some(range),
                None => return range_not_satisfiable(len),
            },
            None => None,
        }
    } else {
        None
    };
    let (start, end, status) = range
        .map(|(start, end)| (start, end, StatusCode::PARTIAL_CONTENT))
        .unwrap_or_else(|| (0, len.saturating_sub(1), StatusCode::OK));
    let body_len = if len == 0 { 0 } else { end - start + 1 };

    let body = if head_only || body_len == 0 {
        Body::empty()
    } else {
        if file.seek(SeekFrom::Start(start)).await.is_err() {
            return plain(StatusCode::INTERNAL_SERVER_ERROR, "file seek failed");
        }
        Body::from_stream(ReaderStream::new(file.take(body_len)))
    };

    let mut response = Response::new(body);
    *response.status_mut() = status;
    let headers = response.headers_mut();
    insert_common_file_headers(headers, &path, &etag);
    headers.insert(
        header::CONTENT_LENGTH,
        HeaderValue::from_str(&body_len.to_string()).expect("integer header"),
    );
    if status == StatusCode::PARTIAL_CONTENT {
        headers.insert(
            header::CONTENT_RANGE,
            HeaderValue::from_str(&format!("bytes {start}-{end}/{len}")).expect("range header"),
        );
    }
    response
}

fn insert_common_file_headers(headers: &mut HeaderMap, path: &FsPath, etag: &str) {
    headers.insert(header::ACCEPT_RANGES, HeaderValue::from_static("bytes"));
    headers.insert(
        header::ETAG,
        HeaderValue::from_str(etag).expect("safe etag"),
    );
    headers.insert(
        header::CONTENT_TYPE,
        HeaderValue::from_str(mime_guess::from_path(path).first_or_octet_stream().as_ref())
            .expect("valid MIME type"),
    );
    headers.insert(
        header::CACHE_CONTROL,
        HeaderValue::from_static("private, no-cache"),
    );
}

fn insert_preview_security_headers(headers: &mut HeaderMap) {
    headers.insert(
        header::HeaderName::from_static("content-security-policy"),
        HeaderValue::from_static(
            "default-src 'self' data: blob:; connect-src 'self'; img-src 'self' data: blob:; font-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'",
        ),
    );
}

pub(crate) async fn strong_etag(path: &FsPath) -> std::io::Result<String> {
    let mut file = tokio::fs::File::open(path).await?;
    strong_etag_file(&mut file).await
}

async fn strong_etag_file(file: &mut tokio::fs::File) -> std::io::Result<String> {
    file.seek(SeekFrom::Start(0)).await?;
    let mut digest = Sha256::new();
    let mut buffer = vec![0_u8; 64 * 1024];
    loop {
        let read = file.read(&mut buffer).await?;
        if read == 0 {
            break;
        }
        digest.update(&buffer[..read]);
    }
    file.seek(SeekFrom::Start(0)).await?;
    let digest = digest.finalize();
    let mut hex = String::with_capacity(digest.len() * 2);
    for byte in digest {
        write!(&mut hex, "{byte:02x}").expect("writing to String cannot fail");
    }
    Ok(format!("\"sha256-{hex}\""))
}

async fn revision_matches(target: &FsPath, expected: &str) -> bool {
    match (expected, tokio::fs::metadata(target).await) {
        ("*", Err(error)) if error.kind() == std::io::ErrorKind::NotFound => true,
        ("*", _) => false,
        (_, Ok(metadata)) if metadata.is_file() => strong_etag(target)
            .await
            .is_ok_and(|revision| revision == expected),
        _ => false,
    }
}

async fn sync_parent(parent: PathBuf) {
    #[cfg(unix)]
    {
        let _ = tokio::task::spawn_blocking(move || {
            std::fs::File::open(parent).and_then(|file| file.sync_all())
        })
        .await;
    }
    #[cfg(not(unix))]
    let _ = parent;
}

fn etag_matches(header_value: &str, etag: &str) -> bool {
    header_value
        .split(',')
        .map(str::trim)
        .any(|candidate| candidate == "*" || candidate.trim_start_matches("W/") == etag)
}

fn parse_range(value: &str, len: u64) -> Option<(u64, u64)> {
    if len == 0 {
        return None;
    }
    let value = value.strip_prefix("bytes=")?;
    if value.contains(',') {
        return None;
    }
    let (start, end) = value.split_once('-')?;
    if start.is_empty() {
        let suffix = end.parse::<u64>().ok()?;
        if suffix == 0 {
            return None;
        }
        return Some((len.saturating_sub(suffix.min(len)), len - 1));
    }
    let start = start.parse::<u64>().ok()?;
    if start >= len {
        return None;
    }
    let end = if end.is_empty() {
        len - 1
    } else {
        end.parse::<u64>().ok()?.min(len - 1)
    };
    (end >= start).then_some((start, end))
}

fn range_not_satisfiable(len: u64) -> Response<Body> {
    let mut response = plain(StatusCode::RANGE_NOT_SATISFIABLE, "range not satisfiable");
    response.headers_mut().insert(
        header::CONTENT_RANGE,
        HeaderValue::from_str(&format!("bytes */{len}")).expect("range header"),
    );
    response
}

fn capability_header(headers: &HeaderMap) -> Option<&str> {
    headers
        .get(header::AUTHORIZATION)?
        .to_str()
        .ok()?
        .strip_prefix("LincoCapability ")
        .filter(|value| !value.is_empty())
}

fn cookie_value<'a>(headers: &'a HeaderMap, name: &str) -> Option<&'a str> {
    headers
        .get(header::COOKIE)?
        .to_str()
        .ok()?
        .split(';')
        .map(str::trim)
        .find_map(|part| {
            part.split_once('=')
                .filter(|(key, _)| *key == name)
                .map(|(_, value)| value)
        })
}

fn encode_path(path: &str) -> String {
    path.split('/')
        .map(|segment| utf8_percent_encode(segment, NON_ALPHANUMERIC).to_string())
        .collect::<Vec<_>>()
        .join("/")
}

fn unauthorized() -> Response<Body> {
    let mut response = plain(StatusCode::UNAUTHORIZED, "invalid or expired capability");
    response.headers_mut().insert(
        header::WWW_AUTHENTICATE,
        HeaderValue::from_static("LincoCapability"),
    );
    response
        .headers_mut()
        .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    response
}

async fn security_headers(request: Request<Body>, next: Next) -> Response<Body> {
    let mut response = next.run(request).await;
    let headers = response.headers_mut();
    headers.insert(
        header::X_CONTENT_TYPE_OPTIONS,
        HeaderValue::from_static("nosniff"),
    );
    headers.insert(
        header::REFERRER_POLICY,
        HeaderValue::from_static("no-referrer"),
    );
    headers.insert(
        header::HeaderName::from_static("permissions-policy"),
        HeaderValue::from_static("camera=(), microphone=(), geolocation=()"),
    );
    response
}

async fn not_found() -> Response<Body> {
    plain(StatusCode::NOT_FOUND, "not found")
}

fn plain(status: StatusCode, message: &'static str) -> Response<Body> {
    let mut response = Response::new(Body::from(message));
    *response.status_mut() = status;
    response.headers_mut().insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("text/plain; charset=utf-8"),
    );
    response
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_standard_open_and_suffix_ranges() {
        assert_eq!(parse_range("bytes=2-5", 10), Some((2, 5)));
        assert_eq!(parse_range("bytes=7-", 10), Some((7, 9)));
        assert_eq!(parse_range("bytes=-3", 10), Some((7, 9)));
        assert_eq!(parse_range("bytes=99-100", 10), None);
        assert_eq!(parse_range("bytes=1-2,4-5", 10), None);
    }

    #[test]
    fn weak_and_list_etags_match() {
        assert!(etag_matches("W/\"a\", \"b\"", "\"a\""));
        assert!(etag_matches("*", "\"a\""));
        assert!(!etag_matches("\"b\"", "\"a\""));
    }

    #[test]
    fn preview_csp_blocks_exfiltration_without_changing_bulk_downloads() {
        let name = header::HeaderName::from_static("content-security-policy");
        let mut preview = HeaderMap::new();
        insert_preview_security_headers(&mut preview);
        let csp = preview.get(&name).unwrap().to_str().unwrap();
        for directive in [
            "connect-src 'self'",
            "object-src 'none'",
            "base-uri 'self'",
            "form-action 'self'",
            "frame-ancestors 'none'",
        ] {
            assert!(csp.contains(directive), "missing {directive}");
        }

        let mut bulk = HeaderMap::new();
        insert_common_file_headers(&mut bulk, FsPath::new("artifact.html"), "\"sha256-a\"");
        assert!(!bulk.contains_key(name));
    }

    #[tokio::test]
    async fn strong_etag_changes_for_same_length_content() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("value.bin");
        tokio::fs::write(&path, b"aaaa").await.unwrap();
        let first = strong_etag(&path).await.unwrap();
        tokio::fs::write(&path, b"bbbb").await.unwrap();
        let second = strong_etag(&path).await.unwrap();
        assert_ne!(first, second);
        assert!(first.starts_with("\"sha256-"));
        assert!(!first.starts_with("W/"));
    }
}
