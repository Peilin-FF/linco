// 预览服务器:在 Mac 本机起一个仅 127.0.0.1 的 HTTP 服务器,iframe 只访问
// localhost(瞬时、不卡)。被预览的 HTML 在工作目录里:
// - 本地工作目录:直接读盘。
// - 远程工作目录(SSH):按需经持久 SSH 通道读字节并缓存(避免每次渲染卡 SSH)。
//
// 为什么用真 HTTP 服务器而非自定义 URI scheme:iframe 里 HTML 的相对子资源
// (./style.css、/img/x.png、<script src>)要正确加载;真服务器根在工作目录,
// 相对路径与任何网站一致。自定义 scheme 在 WKWebView iframe 里会被判 insecure。
//
// 热刷新:轮询目标文件 mtime(本地 metadata / 远端 stat),变化就 emit
// "preview-reload" 事件,前端把 iframe key+1 重载。远端 inotify 不可行,统一轮询。

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use base64::engine::general_purpose::STANDARD as B64;
use base64::Engine;
use serde::Serialize;
use tauri::{AppHandle, Emitter};

const MAX_PREVIEW_BYTES: u64 = 50 * 1024 * 1024;
const CACHE_TTL: Duration = Duration::from_secs(30);

struct PreviewInner {
    port: u16,            // 0 = 未启动
    host: Option<String>, // None = 本地
    root: String,         // 服务器根 = 工作目录绝对路径
    target_rel: String,   // 当前预览文件(相对 root),热刷新监听对象
    last_mtime: Option<i64>,
    // 远端字节缓存:key = 绝对路径,value = (取得时刻, 字节)
    cache: HashMap<String, (Instant, Vec<u8>)>,
    // html-vibe 插件 assets 目录(notebook.js/css/mathjax 所在),按 host 解析后缓存。
    // key = host("" 表本地);value 空串=解析过但没找到。
    assets_dir: HashMap<String, String>,
    // 渲染引擎资源的永久缓存(notebook.js/css、2MB mathjax 不变):key = "host|文件名"。
    // 一次读入常驻内存,后续 /__assets/ 请求零 IO/零 SSH,杜绝白屏重传。
    assets_cache: HashMap<String, Vec<u8>>,
}

impl Default for PreviewInner {
    fn default() -> Self {
        PreviewInner {
            port: 0,
            host: None,
            root: String::new(),
            target_rel: String::new(),
            last_mtime: None,
            cache: HashMap::new(),
            assets_dir: HashMap::new(),
            assets_cache: HashMap::new(),
        }
    }
}

// 状态是进程级单例(服务器线程/刷新线程需要 'static 访问);命令一律走 global()。
static STATE: OnceLock<&'static Mutex<PreviewInner>> = OnceLock::new();

#[derive(Clone, Serialize)]
struct ReloadEvent {
    token: u64,
}

/// 启动预览服务器(幂等)。返回监听端口。
#[tauri::command]
pub fn preview_start(app: AppHandle) -> Result<u16, String> {
    let cell = global();
    {
        let inner = cell.lock().map_err(|e| e.to_string())?;
        if inner.port != 0 {
            return Ok(inner.port);
        }
    }

    let server =
        tiny_http::Server::http("127.0.0.1:0").map_err(|e| format!("启动预览服务器失败: {e}"))?;
    let port = match server.server_addr().to_ip() {
        Some(a) => a.port(),
        None => return Err("无法获取预览端口".into()),
    };
    {
        let mut inner = cell.lock().map_err(|e| e.to_string())?;
        inner.port = port;
    }

    // 服务器线程:逐请求处理
    std::thread::spawn(move || {
        for mut req in server.incoming_requests() {
            let url = req.url().to_string();
            let path = url.split(['?', '#']).next().unwrap_or("").to_string();
            let is_post = matches!(req.method(), tiny_http::Method::Post);

            // POST /__save:WYSIWYG 保存(复刻插件的 /__save),把编辑后的
            // notebook 写回工作目录里的 .html。否则保存按钮报 "需经预览服务器打开"。
            let (bytes, ctype, code) = if is_post && path == "/__save" {
                let mut body = String::new();
                let _ = req.as_reader().read_to_string(&mut body);
                save_artifact(&body)
            } else {
                serve(&url)
            };

            let resp = tiny_http::Response::from_data(bytes)
                .with_status_code(code)
                .with_header(
                    tiny_http::Header::from_bytes(&b"Content-Type"[..], ctype.as_bytes()).unwrap(),
                )
                .with_header(
                    tiny_http::Header::from_bytes(
                        &b"Cache-Control"[..],
                        // 缓存策略分两类:
                        // - 会迭代的引擎(notebook.css/js)→ no-cache:每次回服务器校验,
                        //   改了组件样式立即生效,不被 WebView 永久缓存钉死(旧样式不更新的根因)。
                        // - 真正不变的大资源(mathjax/katex/字体)→ immutable 永久缓存,
                        //   避免 2MB 每次重传重解析(白屏主因)。
                        // - HTML 文档本身可变 → no-cache,保证热刷新拿到新内容。
                        if path.starts_with("/__assets/")
                            && !path.starts_with("/__assets/notebook.")
                        {
                            &b"public, max-age=31536000, immutable"[..]
                        } else {
                            &b"no-cache"[..]
                        },
                    )
                    .unwrap(),
                );
            let _ = req.respond(resp);
        }
    });

    // 热刷新线程:轮询目标 mtime
    let app2 = app.clone();
    std::thread::spawn(move || reload_loop(app2));

    Ok(port)
}

/// 设置当前预览目标(切换文件/工作目录/连接时调用)。
#[tauri::command]
pub fn preview_set_target(
    host: Option<String>,
    root: String,
    target_rel: String,
) -> Result<(), String> {
    let host = host.filter(|s| !s.is_empty());
    let mut inner = global().lock().map_err(|e| e.to_string())?;
    let workspace_changed = inner.host != host || inner.root != root;
    inner.host = host;
    inner.root = root;
    inner.target_rel = target_rel;
    inner.last_mtime = None; // 重新基线,切换后不误刷
    if workspace_changed {
        inner.cache.clear();
    }
    Ok(())
}

/// 后台预取渲染引擎资源到永久缓存。预取 KaTeX(常见路径,~270KB)+ notebook 引擎,
/// **不**预取 2MB MathJax(它只在 KaTeX 渲染不了时才懒加载,绝大多数文档用不到)。
/// 在连接建立 / 打开预览前调用,真打开预览时引擎已在 Rust 内存,首屏不等传输。
#[tauri::command]
pub fn preview_prefetch_assets(host: Option<String>) {
    let host = host.filter(|s| !s.is_empty());
    std::thread::spawn(move || {
        for asset in [
            "notebook.css",
            "notebook.js",
            "katex.min.css",
            "katex.min.js",
        ] {
            let _ = serve_asset(&host, asset); // 命中即写入 assets_cache
        }
    });
}

#[tauri::command]
pub fn preview_prefetch_file(host: Option<String>, path: String) {
    let host = host.filter(|s| !s.is_empty());
    std::thread::spawn(move || {
        if let Some(h) = host.as_deref() {
            let _ = read_remote_cached(h, &path);
            return;
        }

        let key = format!("|{path}");
        if let Ok(g) = global().lock() {
            if g.cache.contains_key(&key) {
                return;
            }
        }
        if let Ok(data) = std::fs::read(&path) {
            if let Ok(mut g) = global().lock() {
                g.cache.insert(key, (Instant::now(), data));
            }
        }
    });
}

/// 解析默认预览目标:index.html → artifacts/index.html → 最新 *.html。
/// 返回相对 root 的路径;找不到返 Err。
#[tauri::command]
pub async fn preview_default_target(host: Option<String>, root: String) -> Result<String, String> {
    crate::blocking::run(move || preview_default_target_blocking(host, root)).await
}

fn preview_default_target_blocking(host: Option<String>, root: String) -> Result<String, String> {
    let host = host.filter(|s| !s.is_empty());
    let candidates = ["index.html", "artifacts/index.html"];
    if let Some(h) = host.as_deref() {
        for c in candidates {
            let abs = join_rel(&root, c);
            let out = crate::remote::preview_run_remote(
                h,
                &format!("test -f {} && echo Y", crate::remote::shq(&abs)),
            )
            .map(|b| String::from_utf8_lossy(&b).trim().to_string())
            .unwrap_or_default();
            if out == "Y" {
                return Ok(c.to_string());
            }
        }
        // 最新 *.html(GNU find,集群是 Linux)。-L 跟随软链(artifacts 常是软链目录)。
        let cmd = format!(
            "find -L {} -maxdepth 3 -name '*.html' -not -path '*/node_modules/*' -printf '%T@ %p\\n' 2>/dev/null | sort -rn | head -1",
            crate::remote::shq(&root)
        );
        let out = crate::remote::preview_run_remote(h, &cmd)
            .map(|b| String::from_utf8_lossy(&b).to_string())
            .unwrap_or_default();
        if let Some(p) = out.trim().split_whitespace().nth(1) {
            let rel = p.strip_prefix(&root).unwrap_or(p).trim_start_matches('/');
            if !rel.is_empty() {
                return Ok(rel.to_string());
            }
        }
        return Err("未找到 HTML".into());
    }

    // 本地
    for c in candidates {
        if Path::new(&root).join(c).is_file() {
            return Ok(c.to_string());
        }
    }
    if let Some(rel) = newest_local_html(&root) {
        return Ok(rel);
    }
    Err("未找到 HTML".into())
}

// —— 内部 ——

fn global() -> &'static Mutex<PreviewInner> {
    STATE.get_or_init(|| Box::leak(Box::new(Mutex::new(PreviewInner::default()))))
}

/// 处理一个请求 URL,返回 (字节, content-type, 状态码)。
fn serve(url: &str) -> (Vec<u8>, String, u16) {
    // 去 query/fragment + 解码 + 去前导 /
    let path = url.split(['?', '#']).next().unwrap_or("");
    let decoded = percent_decode(path);
    let rel = decoded.trim_start_matches('/');

    let (host, root, target_rel) = {
        match global().lock() {
            Ok(g) => (g.host.clone(), g.root.clone(), g.target_rel.clone()),
            Err(_) => return (b"server busy".to_vec(), "text/plain".into(), 500),
        }
    };

    // html-vibe 渲染引擎资源:/__assets/notebook.js 等。复刻插件 Python 服务器的
    // /__assets/ 行为——从插件 assets 目录读(本地搜已知路径,远程 find+缓存),
    // 否则 notebook 产物拿不到渲染引擎、显示空白。
    if let Some(asset) = rel.strip_prefix("__assets/") {
        return serve_asset(&host, asset);
    }

    if root.is_empty() {
        return (b"no preview target".to_vec(), "text/plain".into(), 404);
    }

    if rel == "__debug__" {
        let body = format!(
            "host: {}\nroot: {}\ntarget_rel: {}\nrequest_rel: {}\n",
            host.as_deref().unwrap_or("(local)"),
            root,
            target_rel,
            rel
        );
        return (body.into_bytes(), "text/plain; charset=utf-8".into(), 200);
    }

    // 产物首页:显式 /__index__ 或目录请求(空/以 / 结尾)→ 列出所有 HTML 可点链接。
    if rel == "__index__" || rel.is_empty() || rel.ends_with('/') {
        let dir_rel = if rel == "__index__" {
            ""
        } else {
            rel.trim_end_matches('/')
        };
        return serve_index(&host, &root, dir_rel);
    }

    // 路径安全:归一化后必须仍在 root 内
    let abs = match safe_join(&root, rel) {
        Some(p) => p,
        None => return (b"forbidden".to_vec(), "text/plain".into(), 403),
    };
    let ctype = content_type(rel).to_string();

    let bytes = if let Some(h) = host.as_deref() {
        read_remote_cached(h, &abs)
    } else {
        std::fs::read(&abs).map_err(|e| e.to_string())
    };
    match bytes {
        Ok(b) => {
            // HTML 页面注入「上报自身路径」脚本:页面加载后把真实 location.pathname 经
            // postMessage 告诉父窗口(Linco)。这样无论是点链接、热刷新、还是直接导航,
            // React 的地址栏 / currentRel /「提交给 Agent」按钮都能跟上(跨源读 location
            // 会被浏览器拦,所以靠子页面主动上报)。
            if ctype.starts_with("text/html") {
                let mut out = b;
                out.extend_from_slice(PATH_REPORTER.as_bytes());
                (out, ctype, 200)
            } else {
                (b, ctype, 200)
            }
        }
        Err(e) => (
            format!("preview read failed\n\npath: {abs}\nerror: {e}").into_bytes(),
            "text/plain; charset=utf-8".into(),
            404,
        ),
    }
}

/// 注入到每个被预览 HTML 末尾:加载完成后把自身路径上报给父窗口。
const PATH_REPORTER: &str = "\n<script>try{parent.postMessage({__lincoPath:location.pathname+location.search},'*');}catch(e){}</script>\n";

/// 产物首页:列出 root(或其子目录 dir_rel)下所有 HTML 为可点链接。
/// 本地直接遍历;远程经 agent/find 列。链接是相对 URL,点击在 iframe 内导航。
fn serve_index(host: &Option<String>, root: &str, dir_rel: &str) -> (Vec<u8>, String, u16) {
    let base = if dir_rel.is_empty() {
        root.to_string()
    } else {
        format!("{}/{}", root.trim_end_matches('/'), dir_rel)
    };
    // 收集 HTML 相对路径(相对 root,供链接)
    let (htmls, list_error) = match list_html_rel(host, root, &base) {
        Ok(v) => (v, None),
        Err(e) => (Vec::new(), Some(e)),
    };
    let mut items = String::new();
    if let Some(e) = list_error {
        items.push_str(&format!(
            "<p class=empty>远端 HTML 列表读取失败。</p><pre>{}</pre>",
            html_escape(&e)
        ));
    } else if htmls.is_empty() {
        items.push_str("<p class=empty>工作目录里还没有 HTML 产物。</p>");
    } else {
        items.push_str("<ul>");
        for rel in &htmls {
            // 链接相对服务器根;名称展示去掉目录前缀更友好
            let name = rel.rsplit('/').next().unwrap_or(rel);
            let sub = if rel.contains('/') {
                let p = &rel[..rel.rfind('/').unwrap()];
                format!("<span class=dir>{}/</span>", html_escape(p))
            } else {
                String::new()
            };
            items.push_str(&format!(
                "<li><a href=\"/{href}\">{sub}<b>{name}</b></a></li>",
                href = html_escape(rel),
                sub = sub,
                name = html_escape(name),
            ));
        }
        items.push_str("</ul>");
    }
    let title = if dir_rel.is_empty() {
        "产物"
    } else {
        dir_rel
    };
    let page = format!(
        "<!doctype html><html lang=zh><head><meta charset=utf-8>\
<meta name=viewport content=\"width=device-width,initial-scale=1\">\
<title>{title}</title><style>\
body{{font-family:system-ui,-apple-system,'PingFang SC',sans-serif;background:#FAF9F5;\
color:#3D3D3A;max-width:820px;margin:0 auto;padding:48px 32px}}\
h1{{font-family:Georgia,serif;font-weight:500;color:#141413;font-size:26px;margin:0 0 4px}}\
.k{{font-family:ui-monospace,Menlo,monospace;font-size:11px;color:#87867F;\
text-transform:uppercase;letter-spacing:.08em;margin-bottom:20px}}\
ul{{list-style:none;padding:0;margin:0}}\
li{{border:1.5px solid #E3DACC;border-radius:10px;margin-bottom:8px;background:#fff}}\
li a{{display:block;padding:12px 16px;text-decoration:none;color:#141413;\
font-family:ui-monospace,Menlo,monospace;font-size:13.5px}}\
li a:hover{{border-color:#D97757;color:#B85C3E}}\
.dir{{color:#87867F}} b{{font-weight:600}}\
.empty{{color:#87867F;font-style:italic;font-family:Georgia,serif}}\
</style></head><body><div class=k>预览 · {title}</div><h1>HTML 产物</h1>{items}\
<script>\
// 点链接时通知父窗口(Linco),让工具条的前进/后退历史能记录这次跳转。\
document.addEventListener('click',function(e){{\
var a=e.target.closest&&e.target.closest('a[href]');\
if(a){{e.preventDefault();try{{parent.postMessage({{__lincoNav:a.getAttribute('href')}},'*');}}catch(_){{location.href=a.href;}}}}\
}});\
</script></body></html>",
        title = html_escape(title),
        items = items,
    );
    (page.into_bytes(), "text/html; charset=utf-8".into(), 200)
}

/// 列出 base 目录下(限深)所有 HTML,返回相对 root 的路径(/ 分隔)。
fn list_html_rel(host: &Option<String>, root: &str, base: &str) -> Result<Vec<String>, String> {
    let mut out: Vec<String> = Vec::new();
    if let Some(h) = host.as_deref() {
        // 远程:find(经持久会话);跳过噪声目录。
        // -L:跟随符号链接 —— 产物目录常是 `artifacts -> ../artifacts` 这类软链,
        // 不加 -L 的 find 不会进入软链目录,会导致产物列表为空。
        let base_q = crate::remote::shq(base);
        let cmd = format!(
            "if [ -d {base_q} ]; then find -L {base_q} -maxdepth 4 \\( -name node_modules -o -name .git -o -name target -o -name __pycache__ \\) -prune -o -type f \\( -iname '*.html' -o -iname '*.htm' \\) -print 2>/dev/null | head -500; else printf 'preview root not found: %s\\n' {base_q} >&2; exit 2; fi"
        );
        let b = crate::remote::preview_run_remote(h, &cmd)?;
        let root_pref = format!("{}/", root.trim_end_matches('/'));
        for line in String::from_utf8_lossy(&b).lines() {
            let line = line.trim();
            if line.is_empty() {
                continue;
            }
            let rel = line.strip_prefix(&root_pref).unwrap_or(line);
            out.push(rel.to_string());
        }
    } else {
        let root_path = std::path::Path::new(root);
        let mut stack = vec![(std::path::PathBuf::from(base), 0u32)];
        const SKIP: &[&str] = &[
            "node_modules",
            ".git",
            "target",
            "__pycache__",
            "dist",
            ".venv",
        ];
        while let Some((dir, depth)) = stack.pop() {
            if depth > 4 || out.len() >= 500 {
                continue;
            }
            let Ok(rd) = std::fs::read_dir(&dir) else {
                continue;
            };
            for e in rd.flatten() {
                let p = e.path();
                // 用 p.is_dir()(跟随软链)而非 file_type()(软链报 false),
                // 这样 `artifacts -> ../artifacts` 这类软链目录也会被进入扫描。
                if p.is_dir() {
                    let n = e.file_name().to_string_lossy().to_string();
                    if !SKIP.contains(&n.as_str()) {
                        stack.push((p, depth + 1));
                    }
                } else {
                    let lower = p
                        .extension()
                        .and_then(|x| x.to_str())
                        .unwrap_or("")
                        .to_lowercase();
                    if lower == "html" || lower == "htm" {
                        if let Ok(rel) = p.strip_prefix(root_path) {
                            out.push(rel.to_string_lossy().replace('\\', "/"));
                        }
                    }
                }
            }
        }
    }
    out.sort();
    Ok(out)
}

fn html_escape(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
}

/// 远端读字节,带 TTL 缓存。
fn read_remote_cached(host: &str, abs: &str) -> Result<Vec<u8>, String> {
    let key = format!("{host}|{abs}");
    {
        if let Ok(g) = global().lock() {
            if let Some((at, data)) = g.cache.get(&key) {
                if at.elapsed() < CACHE_TTL {
                    return Ok(data.clone());
                }
            }
        }
    }
    let b64 = crate::remote::preview_read_bytes_b64(host, abs, MAX_PREVIEW_BYTES)?;
    let data = B64.decode(b64.as_bytes()).map_err(|e| e.to_string())?;
    if let Ok(mut g) = global().lock() {
        g.cache.insert(key, (Instant::now(), data.clone()));
    }
    Ok(data)
}

/// 服务 html-vibe 渲染引擎资源(notebook.js/css、mathjax)。
/// asset 形如 "notebook.js"。引擎必须与产物同机(版本/seed 格式要匹配):
/// 远程产物 → 远程引擎。为避免 2MB 每次走 SSH:**永久缓存**(一 session 只读一次)
/// + 连接时**后台预取**(见 preview_prefetch_assets),打开预览前就备好。
fn serve_asset(host: &Option<String>, asset: &str) -> (Vec<u8>, String, u16) {
    // 允许:简单文件名 或 fonts/<名>(KaTeX CSS 用相对路径引字体)。
    // 拒:.. 穿越、绝对路径、其余多级子路径。
    let allowed = !asset.is_empty()
        && !asset.contains("..")
        && !asset.starts_with('/')
        && (!asset.contains('/') || {
            // 仅放行单层 fonts/ 子目录
            let rest = asset.strip_prefix("fonts/");
            matches!(rest, Some(r) if !r.is_empty() && !r.contains('/'))
        });
    if !allowed {
        return (b"forbidden".to_vec(), "text/plain".into(), 403);
    }
    let ctype = content_type(asset).to_string();
    // 永久缓存命中:零 IO/零 SSH(2MB mathjax 不再重读/重传)
    let ckey = format!("{}|{asset}", host.as_deref().unwrap_or(""));
    if let Ok(g) = global().lock() {
        if let Some(data) = g.assets_cache.get(&ckey) {
            return (data.clone(), ctype, 200);
        }
    }
    if let Some(b) = read_local_asset(asset) {
        if let Ok(mut g) = global().lock() {
            g.assets_cache.insert(ckey, b.clone());
        }
        return (b, ctype, 200);
    }
    let bytes = assets_dir(host)
        .filter(|d| !d.is_empty())
        .ok_or_else(|| "assets not found".to_string())
        .and_then(|dir| {
            let abs = format!("{}/{}", dir.trim_end_matches('/'), asset);
            if let Some(h) = host.as_deref() {
                read_remote_cached(h, &abs)
            } else {
                std::fs::read(&abs).map_err(|e| e.to_string())
            }
        })
        .or_else(|_| {
            find_assets_local()
                .ok_or_else(|| "local assets not found".to_string())
                .and_then(|dir| {
                    let abs = std::path::Path::new(&dir).join(asset);
                    std::fs::read(&abs).map_err(|e| e.to_string())
                })
        });
    match bytes {
        Ok(b) => {
            if let Ok(mut g) = global().lock() {
                g.assets_cache.insert(ckey, b.clone());
            }
            (b, ctype, 200)
        }
        Err(_) => (b"asset not found".to_vec(), "text/plain".into(), 404),
    }
}

fn read_local_asset(asset: &str) -> Option<Vec<u8>> {
    let dir = find_assets_local()?;
    let abs = std::path::Path::new(&dir).join(asset);
    std::fs::read(abs).ok()
}

/// WYSIWYG 保存(复刻插件 /__save)。body 是 JSON:
/// - {path, seed:[...]}:读盘上的文件,只替换 <script id="seed"> 的 JSON 体
///   (健壮:模板其余部分/脚本不被重新序列化);兼容旧版 /* SEED:BEGIN */ 区。
/// - {path, html:"..."}:整篇写入(通用兜底)。
/// path 必须是 .html 且限定在工作目录 root 内。本地写盘,远程经 SSH 写回。
fn save_artifact(body: &str) -> (Vec<u8>, String, u16) {
    let ok = |rel: &str| {
        (
            format!("{{\"ok\":true,\"path\":{}}}", json_str(rel)).into_bytes(),
            "application/json".to_string(),
            200u16,
        )
    };
    let err = |msg: &str| {
        (
            format!("{{\"ok\":false,\"error\":{}}}", json_str(msg)).into_bytes(),
            "application/json".to_string(),
            400u16,
        )
    };

    let payload: serde_json::Value = match serde_json::from_str(body) {
        Ok(v) => v,
        Err(e) => return err(&format!("bad json: {e}")),
    };
    // path 来自前端 location.pathname,文件名/目录含中文或空格时是 percent-encoded
    // (如 `/artifacts/%E6%88%91.html`)。必须先 percent-decode,否则 safe_join 拼出带
    // 字面 %XX 的路径 → 文件读不到 → "file not found" → 保存静默失败。
    // (GET 服务路径在 line 239 已经这样 decode 了;这里之前漏了,导致中文/空格名文件存不上。)
    let decoded = percent_decode(payload.get("path").and_then(|p| p.as_str()).unwrap_or(""));
    let rel = decoded.trim_start_matches('/');
    if !rel.ends_with(".html") {
        return err("bad request");
    }

    let (host, root) = match global().lock() {
        Ok(g) => (g.host.clone(), g.root.clone()),
        Err(_) => return err("server busy"),
    };
    // 路径限定在 root 内(防穿越)
    let abs = match safe_join(&root, rel) {
        Some(p) => p,
        None => return err("path escapes root"),
    };

    // 算出要写入的内容
    let out: String = if let Some(seed) = payload.get("seed") {
        // 读现有文件(本地/远程),替换 seed 区
        let src = match read_text(&host, &abs) {
            Ok(s) => s,
            Err(_) => return err("file not found for seed-save"),
        };
        let seed_json = match serde_json::to_string_pretty(seed) {
            Ok(s) => s,
            Err(e) => return err(&format!("seed serialize: {e}")),
        };
        match replace_seed(&src, &seed_json) {
            Ok(s) => s,
            Err(e) => return err(e),
        }
    } else if let Some(h) = payload.get("html").and_then(|h| h.as_str()) {
        h.to_string()
    } else {
        return err("bad request");
    };

    // 写回 + 失效缓存
    let write_res = if let Some(h) = host.as_deref() {
        crate::remote::preview_write_file(h, &abs, &out)
    } else {
        std::fs::write(&abs, out.as_bytes()).map_err(|e| e.to_string())
    };
    match write_res {
        Ok(_) => {
            // 我们自己保存的:把 last_mtime 推进到新值,避免热刷新线程把这次
            // 保存当成"外部改动"而触发整页重载(WYSIWYG 已就地更新,重载只会白屏)。
            let host_opt = host.clone();
            let new_mtime = mtime_of(&host_opt, &abs);
            if let Ok(mut g) = global().lock() {
                g.cache.clear();
                // 仅当保存的就是当前预览目标时才推进基线
                if join_rel(&g.root, &g.target_rel) == abs {
                    g.last_mtime = new_mtime;
                }
            }
            ok(rel)
        }
        Err(e) => err(&e),
    }
}

/// 读文本(本地/远程),供 seed 保存用。
fn read_text(host: &Option<String>, abs: &str) -> Result<String, String> {
    if let Some(h) = host.as_deref() {
        crate::remote::preview_read_file(h, abs)
    } else {
        std::fs::read_to_string(abs).map_err(|e| e.to_string())
    }
}

/// 替换 notebook 的 seed 区:优先 <script id="seed"> JSON 体,兜底旧 SEED 注释区。
fn replace_seed(src: &str, seed_json: &str) -> Result<String, &'static str> {
    let tag = "<script id=\"seed\" type=\"application/json\">";
    if let Some(ti) = src.find(tag) {
        let cstart = ti + tag.len();
        let cend = match src[cstart..].find("</script>") {
            Some(off) => cstart + off,
            None => return Err("seed script not closed"),
        };
        return Ok(format!(
            "{}\n{}\n{}",
            &src[..cstart],
            seed_json,
            &src[cend..]
        ));
    }
    // 旧版:/* SEED:BEGIN */ ... /* SEED:END */
    let b = "/* SEED:BEGIN */";
    let e = "/* SEED:END */";
    if let (Some(i), Some(j)) = (src.find(b), src.find(e)) {
        if j >= i {
            return Ok(format!(
                "{}{}\nvar SEED={};\n{}",
                &src[..i],
                b,
                seed_json,
                &src[j..]
            ));
        }
    }
    Err("seed marker not found")
}

/// 最小 JSON 字符串转义(用于 ok/err 响应里的路径/消息)。
fn json_str(s: &str) -> String {
    serde_json::to_string(s).unwrap_or_else(|_| "\"\"".to_string())
}

/// 解析 html-vibe 插件 assets 目录(含 notebook.js)。解析一次后缓存到 state。
/// 本地:搜已知安装位置;远程:find 常见位置(经持久 SSH)。
fn assets_dir(host: &Option<String>) -> Option<String> {
    let hkey = host.as_deref().unwrap_or("").to_string();
    if let Ok(g) = global().lock() {
        if let Some(d) = g.assets_dir.get(&hkey) {
            return if d.is_empty() { None } else { Some(d.clone()) };
        }
    }
    let found = if let Some(h) = host.as_deref() {
        find_assets_remote(h)
    } else {
        find_assets_local()
    };
    if let Ok(mut g) = global().lock() {
        g.assets_dir.insert(hkey, found.clone().unwrap_or_default());
    }
    found
}

fn has_notebook_js(dir: &str) -> bool {
    std::path::Path::new(dir).join("notebook.js").is_file()
}

fn find_assets_local() -> Option<String> {
    let home = crate::config::home_dir()
        .ok()?
        .to_string_lossy()
        .to_string();
    // 已知安装位置(按优先级):新插件名 > 旧名(回退) > 开发副本 > 插件缓存搜索
    let mut cands = vec![
        format!("{home}/.codex/skills/html-kit/assets"),
        format!("{home}/.claude/plugins/linco-html/assets"), // 中文版插件(主)
        format!("{home}/.claude/plugins/linco-html-en/assets"), // 英文版插件
        format!("{home}/.claude/plugins/html-vibe/assets"),  // 旧插件名(兼容已部署)
        format!("{home}/HTML-VibeCoding/plugins/linco-html/assets"), // 开发副本(新名)
        format!("{home}/HTML-VibeCoding/plugins/html-vibe/assets"), // 开发副本(旧名)
    ];
    // 插件缓存/市场里搜(marketplaces / cache 下的 html-vibe)
    for base in [
        format!("{home}/.claude/plugins/marketplaces"),
        format!("{home}/.claude/plugins/cache"),
        format!("{home}/.claude/plugins"),
    ] {
        if let Some(d) = walk_find_assets(&base, 6) {
            cands.push(d);
        }
    }
    cands.into_iter().find(|d| has_notebook_js(d))
}

/// 本地有限深度搜 html-vibe/assets/notebook.js 的父目录。
fn walk_find_assets(base: &str, max_depth: u32) -> Option<String> {
    let mut stack = vec![(PathBuf::from(base), 0u32)];
    while let Some((dir, depth)) = stack.pop() {
        if depth > max_depth {
            continue;
        }
        let Ok(rd) = std::fs::read_dir(&dir) else {
            continue;
        };
        for e in rd.flatten() {
            let p = e.path();
            if e.file_type().map(|t| t.is_dir()).unwrap_or(false) {
                if e.file_name().to_string_lossy() == "assets" && p.join("notebook.js").is_file() {
                    return Some(p.to_string_lossy().to_string());
                }
                stack.push((p, depth + 1));
            }
        }
    }
    None
}

/// 远程:find 插件 assets 目录(经持久 SSH;集群是 Linux)。
fn find_assets_remote(host: &str) -> Option<String> {
    // 优先新插件名,再回退旧名/开发副本,最后在插件目录里 find(任意含 notebook.js 的 assets)。
    let cmd = "for d in \"$HOME/.claude/plugins/linco-html/assets\" \
\"$HOME/.claude/plugins/linco-html-en/assets\" \
\"$HOME/.claude/plugins/html-vibe/assets\" \
\"$HOME/HTML-VibeCoding/plugins/linco-html/assets\" \
\"$HOME/HTML-VibeCoding/plugins/html-vibe/assets\" \
$(find \"$HOME/.claude/plugins\" -maxdepth 6 -type d -name assets 2>/dev/null); do \
[ -f \"$d/notebook.js\" ] && echo \"$d\" && break; done";
    let out = crate::remote::preview_run_remote(host, cmd).ok()?;
    let s = String::from_utf8_lossy(&out).trim().to_string();
    if s.is_empty() {
        None
    } else {
        Some(s.lines().next()?.to_string())
    }
}

/// 热刷新轮询:目标 mtime 变化 → 清缓存 + emit。
fn reload_loop(app: AppHandle) {
    let mut token: u64 = 0;
    loop {
        std::thread::sleep(Duration::from_millis(2000));
        let (host, root, target_rel, last) = {
            match global().lock() {
                Ok(g) => (
                    g.host.clone(),
                    g.root.clone(),
                    g.target_rel.clone(),
                    g.last_mtime,
                ),
                Err(_) => continue,
            }
        };
        if root.is_empty() || target_rel.is_empty() {
            continue;
        }
        let abs = join_rel(&root, &target_rel);
        let cur = mtime_of(&host, &abs);
        let Some(cur) = cur else { continue };
        match last {
            None => {
                if let Ok(mut g) = global().lock() {
                    g.last_mtime = Some(cur);
                }
            }
            Some(prev) if prev != cur => {
                if let Ok(mut g) = global().lock() {
                    g.last_mtime = Some(cur);
                    g.cache.clear();
                }
                token += 1;
                let _ = app.emit("preview-reload", ReloadEvent { token });
            }
            _ => {}
        }
    }
}

fn mtime_of(host: &Option<String>, abs: &str) -> Option<i64> {
    if let Some(h) = host.as_deref() {
        // GNU 然后 BSD 兜底
        let cmd = format!(
            "stat -c %Y {p} 2>/dev/null || stat -f %m {p} 2>/dev/null",
            p = crate::remote::shq(abs)
        );
        let out = crate::remote::preview_run_remote(h, &cmd).ok()?;
        String::from_utf8_lossy(&out).trim().parse::<i64>().ok()
    } else {
        let meta = std::fs::metadata(abs).ok()?;
        let modified = meta.modified().ok()?;
        let dur = modified.duration_since(std::time::UNIX_EPOCH).ok()?;
        Some(dur.as_secs() as i64)
    }
}

/// 本地找最新 *.html(限深遍历,跳过常见噪声目录)。
fn newest_local_html(root: &str) -> Option<String> {
    let root_path = PathBuf::from(root);
    let mut best: Option<(std::time::SystemTime, PathBuf)> = None;
    let mut stack = vec![(root_path.clone(), 0u32)];
    const SKIP: &[&str] = &["node_modules", ".git", "target", "__pycache__", "dist"];
    while let Some((dir, depth)) = stack.pop() {
        if depth > 3 {
            continue;
        }
        let Ok(rd) = std::fs::read_dir(&dir) else {
            continue;
        };
        for e in rd.flatten() {
            let p = e.path();
            // p.is_dir() 跟随软链,使 `artifacts -> ../artifacts` 这类软链目录也被遍历。
            if p.is_dir() {
                let name = e.file_name().to_string_lossy().to_string();
                if !SKIP.contains(&name.as_str()) {
                    stack.push((p, depth + 1));
                }
            } else if p.extension().and_then(|x| x.to_str()) == Some("html") {
                if let Ok(m) = std::fs::metadata(&p).and_then(|md| md.modified()) {
                    if best.as_ref().map(|(t, _)| m > *t).unwrap_or(true) {
                        best = Some((m, p));
                    }
                }
            }
        }
    }
    let (_, p) = best?;
    let rel = p.strip_prefix(&root_path).ok()?;
    Some(rel.to_string_lossy().replace('\\', "/"))
}

fn join_rel(root: &str, rel: &str) -> String {
    format!(
        "{}/{}",
        root.trim_end_matches(['/', '\\']),
        rel.trim_start_matches(['/', '\\'])
    )
}

/// 安全拼接:归一化 rel,拒绝 `..` 逃逸;结果绝对路径必须在 root 内。
fn safe_join(root: &str, rel: &str) -> Option<String> {
    if rel.starts_with(['/', '\\']) || rel.contains(':') {
        return None;
    }
    let mut parts: Vec<&str> = Vec::new();
    for comp in rel.split(['/', '\\']) {
        match comp {
            "" | "." => {}
            ".." => return None,
            c => {
                if c.contains('\0') {
                    return None;
                }
                parts.push(c);
            }
        }
    }
    let root_clean = root.trim_end_matches(['/', '\\']);
    let abs = if parts.is_empty() {
        root_clean.to_string()
    } else {
        format!("{}/{}", root_clean, parts.join("/"))
    };
    if abs == root_clean || abs.starts_with(&format!("{root_clean}/")) {
        Some(abs)
    } else {
        None
    }
}

fn content_type(name: &str) -> &'static str {
    let ext = name.rsplit('.').next().unwrap_or("").to_lowercase();
    match ext.as_str() {
        "html" | "htm" => "text/html; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "js" | "mjs" => "text/javascript; charset=utf-8",
        "json" => "application/json; charset=utf-8",
        "svg" => "image/svg+xml",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "ico" => "image/x-icon",
        "woff" => "font/woff",
        "woff2" => "font/woff2",
        "ttf" => "font/ttf",
        "wasm" => "application/wasm",
        "map" => "application/json",
        "mp4" => "video/mp4",
        "webm" => "video/webm",
        "mp3" => "audio/mpeg",
        "wav" => "audio/wav",
        "pdf" => "application/pdf",
        "txt" => "text/plain; charset=utf-8",
        _ => "application/octet-stream",
    }
}

/// 最小 percent-decode(只处理 %XX 与 +→空格不处理,路径里 + 是字面量)。
fn percent_decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            let hi = (bytes[i + 1] as char).to_digit(16);
            let lo = (bytes[i + 2] as char).to_digit(16);
            if let (Some(h), Some(l)) = (hi, lo) {
                out.push((h * 16 + l) as u8);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn content_type_by_ext() {
        assert_eq!(content_type("a.html"), "text/html; charset=utf-8");
        assert_eq!(content_type("dir/x.CSS"), "text/css; charset=utf-8");
        assert_eq!(content_type("img.png"), "image/png");
        assert_eq!(content_type("noext"), "application/octet-stream");
    }

    #[test]
    fn safe_join_blocks_traversal() {
        assert!(safe_join("/work", "../etc/passwd").is_none());
        assert!(safe_join("/work", "/abs").is_none());
        assert_eq!(
            safe_join("/work", "sub/page.html").as_deref(),
            Some("/work/sub/page.html")
        );
        assert_eq!(
            safe_join("/work", "./a/./b.css").as_deref(),
            Some("/work/a/b.css")
        );
        assert_eq!(
            safe_join("/work", r"artifacts\index.html").as_deref(),
            Some("/work/artifacts/index.html")
        );
    }

    #[test]
    fn percent_decode_basic() {
        assert_eq!(percent_decode("/a%20b/c.html"), "/a b/c.html");
        assert_eq!(percent_decode("/plain.css"), "/plain.css");
    }
}

#[cfg(test)]
mod save_tests {
    use super::*;

    #[test]
    fn notebook_delete_cell_removes_insert_rail() {
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../vendor/HTML-VibeCoding/plugins/linco-html/assets/notebook.js");
        let js = std::fs::read_to_string(path).expect("read notebook.js");

        assert!(
            js.contains("function removeCell(c)"),
            "delete buttons must use the shared cell removal path"
        );
        assert_eq!(
            js.matches("addEventListener('click',function(){removeCell(c);});")
                .count(),
            2,
            "text and table cell delete buttons should both remove their paired insert rail"
        );
        assert!(
            !js.contains("addEventListener('click',function(){c.remove();});"),
            "bare cell removal leaves orphan insert rails behind"
        );
    }

    #[test]
    fn remote_preview_io_uses_dedicated_rpc_helpers() {
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src/preview.rs");
        let src = std::fs::read_to_string(path).expect("read preview.rs");

        assert!(
            src.contains("crate::remote::preview_run_remote"),
            "preview shell-style probes should use the preview RPC lane"
        );
        assert!(
            src.contains("crate::remote::preview_read_bytes_b64"),
            "preview file bytes should use the preview RPC lane"
        );
        assert!(
            src.contains("crate::remote::preview_read_file"),
            "preview seed-save reads should use the preview RPC lane"
        );
        assert!(
            src.contains("crate::remote::preview_write_file"),
            "preview seed-save writes should use the preview RPC lane"
        );

        let forbidden = [
            ["crate::remote::read_bytes_", "b64(host, abs"].concat(),
            ["crate::remote::read_", "file(h, abs"].concat(),
            ["crate::remote::write_", "file(h, &abs"].concat(),
        ];
        for pat in forbidden {
            assert!(
                !src.contains(&pat),
                "preview.rs should not call shared remote helper: {pat}"
            );
        }
    }

    #[test]
    fn replace_seed_script_body() {
        let src =
            "<html><script id=\"seed\" type=\"application/json\">OLD</script><body></body></html>";
        let out = replace_seed(src, "{\"a\":1}").unwrap();
        assert!(out.contains("{\"a\":1}"), "new seed in: {out}");
        assert!(!out.contains("OLD"), "old seed gone");
        assert!(out.contains("<body></body>"), "rest preserved");
    }
    #[test]
    fn replace_seed_legacy_region() {
        let src = "x/* SEED:BEGIN */var SEED=1;/* SEED:END */y";
        let out = replace_seed(src, "[2]").unwrap();
        assert!(out.contains("var SEED=[2];"));
        assert!(out.starts_with("x") && out.ends_with("y"));
    }
    #[test]
    fn replace_seed_missing() {
        assert!(replace_seed("<html></html>", "{}").is_err());
    }

    // 回归:保存路径的 percent-decode。前端 location.pathname 对中文/空格名是编码过的,
    // 保存时必须先 decode 再 safe_join,否则拼出带字面 %XX 的路径、文件读不到 → 保存失败。
    #[test]
    fn save_path_percent_decoded_for_cjk_and_space() {
        // 中文名:%E6%88%91.html → 我.html
        assert_eq!(percent_decode("/artifacts/%E6%88%91.html"), "/artifacts/我.html");
        // 空格名
        assert_eq!(percent_decode("/my%20notes/a.html"), "/my notes/a.html");
        // decode 后再 safe_join 应能拼回真实路径(在 root 内)
        let rel = percent_decode("/sub/%E6%88%91.html");
        let rel = rel.trim_start_matches('/');
        let abs = safe_join("/work/proj", rel).expect("应在 root 内");
        assert!(abs.ends_with("/sub/我.html"), "拼出真实中文路径: {abs}");
        assert!(!abs.contains('%'), "不应残留 percent 编码: {abs}");
    }
}
