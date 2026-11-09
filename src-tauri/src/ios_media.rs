//! AVFoundation loads media outside WKURLSchemeHandler. Give it real loopback HTTP,
//! while all upstream requests still use the existing checked Rust media proxy.
use std::{future::Future, sync::Arc, time::Duration};
use tauri::http::{HeaderMap, Response};
use tokio::{io::{AsyncReadExt, AsyncWriteExt}, net::{TcpListener, TcpStream}, sync::{OnceCell, Semaphore}};

struct Bridge { prefix: String }
static BRIDGE: OnceCell<Bridge> = OnceCell::const_new();

#[tauri::command]
pub async fn ios_media_origin() -> Result<String, String> {
    if !cfg!(target_os = "ios") { return Err("此播放通道仅用于 iOS".into()); }
    let bridge = BRIDGE.get_or_try_init(|| start(|path, query, prefix, range| async move {
        crate::media::handle_with_range(&path, &query, &prefix, range.as_deref()).await
    })).await?;
    Ok(bridge.prefix.clone())
}

async fn start<H, F>(handler: H) -> Result<Bridge, String>
where
    H: Fn(String, String, String, Option<String>) -> F + Send + Sync + 'static,
    F: Future<Output = Response<Vec<u8>>> + Send + 'static,
{
    let listener = TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0)).await.map_err(|e| e.to_string())?;
    let address = listener.local_addr().map_err(|e| e.to_string())?;
    let mut random = [0u8; 32];
    getrandom::getrandom(&mut random).map_err(|e| e.to_string())?;
    let token: String = random.iter().map(|b| format!("{b:02x}")).collect();
    let prefix = format!("http://{address}/{token}");
    let output = Bridge { prefix: prefix.clone() };
    let handler = Arc::new(handler);
    let permits = Arc::new(Semaphore::new(24));
    tauri::async_runtime::spawn(async move {
        while let Ok((stream, peer)) = listener.accept().await {
            if !peer.ip().is_loopback() { continue; }
            let Ok(permit) = permits.clone().try_acquire_owned() else { continue; };
            let (handler, prefix, token) = (handler.clone(), prefix.clone(), token.clone());
            tauri::async_runtime::spawn(async move {
                let _permit = permit;
                let _ = tokio::time::timeout(Duration::from_secs(90), serve(stream, address, &prefix, &token, handler)).await;
            });
        }
    });
    Ok(output)
}

fn error(status: u16) -> Response<Vec<u8>> {
    Response::builder().status(status).body(Vec::new()).unwrap()
}

async fn serve<H, F>(mut stream: TcpStream, address: std::net::SocketAddr, prefix: &str, token: &str, handler: Arc<H>) -> std::io::Result<()>
where
    H: Fn(String, String, String, Option<String>) -> F + Send + Sync + 'static,
    F: Future<Output = Response<Vec<u8>>> + Send + 'static,
{
    let mut raw = Vec::new();
    let header = tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            let mut chunk = [0u8; 2048];
            let count = stream.read(&mut chunk).await.ok()?;
            if count == 0 { return None; }
            raw.extend_from_slice(&chunk[..count]);
            if raw.len() > 16 * 1024 { return None; }
            if let Some(end) = raw.windows(4).position(|w| w == b"\r\n\r\n") {
                return String::from_utf8(raw[..end].to_vec()).ok();
            }
        }
    }).await.ok().flatten();
    let Some(header) = header else { return write_response(&mut stream, error(400), false, None).await; };
    let mut lines = header.split("\r\n");
    let fields: Vec<_> = lines.next().unwrap_or("").split_whitespace().collect();
    if fields.len() != 3 || !matches!(fields[2], "HTTP/1.0" | "HTTP/1.1") {
        return write_response(&mut stream, error(400), false, None).await;
    }
    let head = fields[0] == "HEAD";
    if !matches!(fields[0], "GET" | "HEAD") {
        return write_response(&mut stream, error(405), head, None).await;
    }
    let mut headers = HeaderMap::new();
    for line in lines {
        let parsed = line.split_once(':').and_then(|(k, v)| Some((
            tauri::http::HeaderName::from_bytes(k.as_bytes()).ok()?,
            tauri::http::HeaderValue::from_str(v.trim()).ok()?,
        )));
        let Some((name, value)) = parsed else { return write_response(&mut stream, error(400), head, None).await; };
        if headers.insert(name, value).is_some() {
            return write_response(&mut stream, error(400), head, None).await;
        }
    }
    let origin = headers.get("Origin").and_then(|v| v.to_str().ok());
    // The per-launch capability is required even for requests without an Origin (AVFoundation).
    if headers.get("Host").and_then(|v| v.to_str().ok()) != Some(address.to_string().as_str())
        || origin.is_some_and(|o| o != "null" && !crate::allowed_frontend_origin(o)) {
        return write_response(&mut stream, error(403), head, None).await;
    }
    let (path, query) = fields[1].split_once('?').unwrap_or((fields[1], ""));
    let route_prefix = format!("/{token}/");
    let route = match path.strip_prefix(&route_prefix) {
        Some("hls/list.m3u8") => "/hls",
        Some("seg") => "/seg",
        _ => return write_response(&mut stream, error(404), head, origin).await,
    };
    let range = headers.get("Range").and_then(|v| v.to_str().ok()).map(str::to_string);
    if range.as_ref().is_some_and(|v| v.len() > 100 || !v.starts_with("bytes=") || !v.bytes().all(|b| b.is_ascii_digit() || b"bytes=-".contains(&b))) {
        return write_response(&mut stream, error(416), head, origin).await;
    }
    crate::playback_log::record("ios.http.request", serde_json::json!({"route": route, "method": fields[0], "range": range}));
    let response = handler(route.to_string(), query.to_string(), prefix.to_string(), range).await;
    crate::playback_log::record("ios.http.response", serde_json::json!({"route": route, "status": response.status().as_u16(), "bytes": response.body().len()}));
    write_response(&mut stream, response, head, origin).await
}

async fn write_response(stream: &mut TcpStream, mut response: Response<Vec<u8>>, head: bool, origin: Option<&str>) -> std::io::Result<()> {
    let length = response.body().len();
    response.headers_mut().insert("Content-Length", length.into());
    response.headers_mut().insert("Connection", "close".parse().unwrap());
    response.headers_mut().insert("Cache-Control", "no-store".parse().unwrap());
    if let Some(origin) = origin.and_then(|o| o.parse().ok()) {
        response.headers_mut().insert("Access-Control-Allow-Origin", origin);
        response.headers_mut().insert("Vary", "Origin".parse().unwrap());
    }
    let mut header = format!("HTTP/1.1 {}\r\n", response.status());
    for (key, value) in response.headers() {
        if let Ok(value) = value.to_str() { header.push_str(&format!("{key}: {value}\r\n")); }
    }
    header.push_str("\r\n");
    stream.write_all(header.as_bytes()).await?;
    if !head { stream.write_all(response.body()).await?; }
    stream.shutdown().await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn native_http_chain_rewrites_playlists_and_serves_keys_ranges_and_head() {
        let bridge = start(|path, query, prefix, range| async move {
            let target = url::form_urlencoded::parse(query.as_bytes()).find(|(k, _)| k == "u").unwrap().1.into_owned();
            let (kind, bytes) = if path == "/hls" || target.ends_with("child.m3u8") {
                let text = if path == "/hls" { "#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=500000\nchild.m3u8\n" }
                    else { "#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI=\"key.bin\"\n#EXTINF:2,\nseg.ts\n" };
                ("application/vnd.apple.mpegurl", crate::media::rewrite_playlist(&target, text, &prefix).into_bytes())
            } else if target.ends_with("key.bin") { ("application/octet-stream", vec![1; 16]) }
            else { ("video/mp2t", (0..100u8).collect()) };
            let response = Response::builder().header("Content-Type", kind).body(bytes).unwrap();
            crate::media::apply_range(response, range.as_deref())
        }).await.unwrap();
        let client = reqwest::Client::builder().no_proxy().build().unwrap();
        let master_url = format!("{}/hls/list.m3u8?u=https%3A%2F%2Fcdn.example%2Fmaster.m3u8", bridge.prefix);
        let master = client.get(&master_url).send().await.unwrap().text().await.unwrap();
        let child_url = master.lines().find(|l| !l.starts_with('#')).unwrap();
        assert!(child_url.starts_with(&bridge.prefix));
        let child = client.get(child_url).send().await.unwrap().text().await.unwrap();
        let key_url = child.lines().find(|l| l.starts_with("#EXT-X-KEY")).unwrap().split('"').nth(1).unwrap();
        assert_eq!(client.get(key_url).send().await.unwrap().bytes().await.unwrap().len(), 16);
        let segment = child.lines().find(|l| !l.starts_with('#')).unwrap();
        for (range, expected, body) in [("bytes=0-1", "bytes 0-1/100", vec![0, 1]), ("bytes=90-", "bytes 90-99/100", (90..100u8).collect()), ("bytes=-2", "bytes 98-99/100", vec![98, 99])] {
            let r = client.get(segment).header("Range", range).send().await.unwrap();
            assert_eq!(r.status(), 206);
            assert_eq!(r.headers()["Content-Range"], expected);
            assert_eq!(r.bytes().await.unwrap().as_ref(), body);
        }
        let head = client.head(segment).header("Range", "bytes=0-1").send().await.unwrap();
        assert_eq!(head.status(), 206);
        assert_eq!(head.headers()["Content-Length"], "2");
        assert!(head.bytes().await.unwrap().is_empty());
        assert_eq!(client.get(segment).header("Range", "bytes=100-").send().await.unwrap().status(), 416);
        assert_eq!(client.get(segment).header("Range", "bytes=0-1,3-4").send().await.unwrap().status(), 416);
        assert_eq!(client.get(segment).header("Origin", "https://other.example").send().await.unwrap().status(), 403);
        assert_eq!(client.get(segment.replace(bridge.prefix.rsplit('/').next().unwrap(), "wrong-token")).send().await.unwrap().status(), 404);
        let r = client.get(&master_url).header("Origin", "tauri://localhost").send().await.unwrap();
        assert_eq!(r.headers()["Access-Control-Allow-Origin"], "tauri://localhost");
    }
}
