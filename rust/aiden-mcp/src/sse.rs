//! Bounded legacy MCP SSE client transport.
//!
//! The legacy protocol opens a GET event stream, receives one `endpoint`
//! event naming the same-origin POST target, then exchanges JSON-RPC messages
//! by POSTing client messages and receiving `message` events.

use std::borrow::Cow;
use std::collections::BTreeMap;
use std::future::Future;
use std::net::IpAddr;
use std::sync::Arc;
use std::time::Duration;

use futures::StreamExt as _;
use reqwest::header::{HeaderMap, HeaderName, HeaderValue, ACCEPT, CONTENT_TYPE};
use rmcp::service::{RoleClient, RxJsonRpcMessage, TxJsonRpcMessage};
use rmcp::transport::Transport;
use tokio::sync::{mpsc, watch};
use tokio_util::sync::CancellationToken;

const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(15);
const POST_TIMEOUT: Duration = Duration::from_secs(30);
const IDLE_TIMEOUT: Duration = Duration::from_secs(45);
const MAX_RECONNECT_ATTEMPTS: usize = 3;
const MAX_LINE_BYTES: usize = 64 * 1024;
const MAX_EVENT_BYTES: usize = 256 * 1024;
const MAX_EVENT_ID_BYTES: usize = 1_024;
const MAX_TOTAL_BUFFERED_BYTES: usize = MAX_EVENT_BYTES + MAX_LINE_BYTES;
const MAX_POST_RESPONSE_BYTES: usize = 64 * 1024;
const MAX_OUTBOUND_MESSAGE_BYTES: usize = 256 * 1024;
const MAX_HEADERS: usize = 64;
const MAX_HEADER_NAME_BYTES: usize = 256;
const MAX_HEADER_VALUE_BYTES: usize = 4_096;
const LAST_EVENT_ID: HeaderName = HeaderName::from_static("last-event-id");

#[derive(Debug, Clone, thiserror::Error)]
pub enum SseTransportError {
    #[error("The MCP SSE address is not allowed.")]
    AddressDenied,
    #[error("The MCP SSE headers are invalid.")]
    InvalidHeaders,
    #[error("The MCP SSE server returned an invalid response.")]
    InvalidResponse,
    #[error("The MCP SSE stream exceeded its safety limit.")]
    TooLarge,
    #[error("The MCP SSE connection timed out.")]
    TimedOut,
    #[error("The MCP SSE connection was closed.")]
    Closed,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct SseEvent {
    event: String,
    data: String,
    id: Option<String>,
}

#[derive(Debug, Default)]
struct BoundedSseParser {
    buffered: Vec<u8>,
    event: String,
    data: String,
    id: Option<String>,
    event_bytes: usize,
}

impl BoundedSseParser {
    fn push(&mut self, chunk: &[u8]) -> Result<Vec<SseEvent>, SseTransportError> {
        if self.buffered.len().saturating_add(chunk.len()) > MAX_TOTAL_BUFFERED_BYTES {
            return Err(SseTransportError::TooLarge);
        }
        self.buffered.extend_from_slice(chunk);
        let mut events = Vec::new();
        while let Some(newline) = self.buffered.iter().position(|byte| *byte == b'\n') {
            let mut line = self.buffered.drain(..=newline).collect::<Vec<_>>();
            line.pop();
            if line.last() == Some(&b'\r') {
                line.pop();
            }
            let line =
                std::str::from_utf8(&line).map_err(|_| SseTransportError::InvalidResponse)?;
            if let Some(event) = self.push_line(line)? {
                events.push(event);
            }
        }
        if self.buffered.len() > MAX_LINE_BYTES {
            return Err(SseTransportError::TooLarge);
        }
        Ok(events)
    }

    fn push_line(&mut self, line: &str) -> Result<Option<SseEvent>, SseTransportError> {
        if line.is_empty() {
            if self.data.is_empty() {
                self.reset_event();
                return Ok(None);
            }
            let data = self
                .data
                .strip_suffix('\n')
                .unwrap_or(&self.data)
                .to_string();
            let event = SseEvent {
                event: if self.event.is_empty() {
                    "message".to_string()
                } else {
                    std::mem::take(&mut self.event)
                },
                data,
                id: self.id.take(),
            };
            self.data.clear();
            self.event_bytes = 0;
            return Ok(Some(event));
        }
        if line.starts_with(':') {
            return Ok(None);
        }
        let (field, value) = line.split_once(':').unwrap_or((line, ""));
        let value = value.strip_prefix(' ').unwrap_or(value);
        self.event_bytes = self.event_bytes.saturating_add(line.len());
        if self.event_bytes > MAX_EVENT_BYTES {
            return Err(SseTransportError::TooLarge);
        }
        match field {
            "event" => self.event = value.to_string(),
            "data" => {
                self.data.push_str(value);
                self.data.push('\n');
            }
            "id" => {
                if value.len() > MAX_EVENT_ID_BYTES || value.contains(['\r', '\n', '\0']) {
                    return Err(SseTransportError::InvalidResponse);
                }
                self.id = Some(value.to_string());
            }
            "retry" => {}
            _ => {}
        }
        Ok(None)
    }

    fn reset_event(&mut self) {
        self.event.clear();
        self.data.clear();
        self.id = None;
        self.event_bytes = 0;
    }
}

#[derive(Debug, Clone, Copy)]
struct PublicOnlyDnsResolver;

impl reqwest::dns::Resolve for PublicOnlyDnsResolver {
    fn resolve(&self, name: reqwest::dns::Name) -> reqwest::dns::Resolving {
        let host = name.as_str().to_string();
        Box::pin(async move {
            let addresses = tokio::net::lookup_host((host.as_str(), 0))
                .await
                .map_err(|error| Box::new(error) as Box<dyn std::error::Error + Send + Sync>)?
                .collect::<Vec<_>>();
            let explicit_loopback = matches!(host.as_str(), "localhost" | "127.0.0.1" | "::1");
            let allowed = addresses.iter().all(|address| {
                if explicit_loopback {
                    address.ip().is_loopback()
                } else {
                    is_public_ip(address.ip())
                }
            });
            if addresses.is_empty() || !allowed {
                return Err(Box::new(std::io::Error::new(
                    std::io::ErrorKind::PermissionDenied,
                    "MCP SSE host is not public",
                ))
                    as Box<dyn std::error::Error + Send + Sync>);
            }
            Ok(Box::new(addresses.into_iter()) as reqwest::dns::Addrs)
        })
    }
}

fn is_public_ip(address: IpAddr) -> bool {
    match address {
        IpAddr::V4(address) => {
            let octets = address.octets();
            !(address.is_unspecified()
                || address.is_loopback()
                || address.is_private()
                || address.is_link_local()
                || address.is_multicast()
                || address.is_broadcast()
                || octets[0] == 0
                || (octets[0] == 100 && (64..=127).contains(&octets[1]))
                || (octets[0] == 192 && octets[1] == 0 && octets[2] == 0)
                || (octets[0] == 198 && matches!(octets[1], 18 | 19))
                || matches!(
                    octets,
                    [192, 0, 2, _] | [198, 51, 100, _] | [203, 0, 113, _]
                )
                || octets[0] >= 224)
        }
        IpAddr::V6(address) => {
            let segments = address.segments();
            !(address.is_unspecified()
                || address.is_loopback()
                || address.is_multicast()
                || (segments[0] & 0xfe00) == 0xfc00
                || (segments[0] & 0xffc0) == 0xfe80
                || (segments[0] == 0x2001 && segments[1] == 0x0db8))
        }
    }
}

fn secure_sse_url(value: &str) -> Result<reqwest::Url, SseTransportError> {
    if value.is_empty() || value.len() > 4_096 {
        return Err(SseTransportError::AddressDenied);
    }
    let url = reqwest::Url::parse(value).map_err(|_| SseTransportError::AddressDenied)?;
    if !url.username().is_empty() || url.password().is_some() || url.fragment().is_some() {
        return Err(SseTransportError::AddressDenied);
    }
    let loopback = url
        .host_str()
        .is_some_and(|host| matches!(host, "127.0.0.1" | "localhost" | "::1"));
    if url.scheme() != "https" && !(url.scheme() == "http" && loopback) {
        return Err(SseTransportError::AddressDenied);
    }
    if url
        .host_str()
        .and_then(|host| host.parse::<IpAddr>().ok())
        .is_some_and(|address| !address.is_loopback() && !is_public_ip(address))
    {
        return Err(SseTransportError::AddressDenied);
    }
    Ok(url)
}

fn headers(values: &BTreeMap<String, String>) -> Result<HeaderMap, SseTransportError> {
    if values.len() > MAX_HEADERS {
        return Err(SseTransportError::InvalidHeaders);
    }
    let mut headers = HeaderMap::new();
    let mut canonical_names = std::collections::HashSet::new();
    for (name, value) in values {
        if name.is_empty()
            || name.len() > MAX_HEADER_NAME_BYTES
            || value.len() > MAX_HEADER_VALUE_BYTES
        {
            return Err(SseTransportError::InvalidHeaders);
        }
        let name = HeaderName::from_bytes(name.as_bytes())
            .map_err(|_| SseTransportError::InvalidHeaders)?;
        if !canonical_names.insert(name.as_str().to_ascii_lowercase()) {
            return Err(SseTransportError::InvalidHeaders);
        }
        if matches!(
            name.as_str(),
            "host"
                | "content-length"
                | "connection"
                | "transfer-encoding"
                | "accept"
                | "content-type"
                | "last-event-id"
        ) {
            return Err(SseTransportError::InvalidHeaders);
        }
        let value = HeaderValue::from_str(value).map_err(|_| SseTransportError::InvalidHeaders)?;
        headers.insert(name, value);
    }
    Ok(headers)
}

fn endpoint_from_event(
    base: &reqwest::Url,
    value: &str,
) -> Result<reqwest::Url, SseTransportError> {
    let endpoint = base
        .join(value.trim())
        .map_err(|_| SseTransportError::AddressDenied)?;
    if endpoint.as_str().len() > 4_096
        || endpoint.scheme() != base.scheme()
        || endpoint.host_str() != base.host_str()
        || endpoint.port_or_known_default() != base.port_or_known_default()
        || !endpoint.username().is_empty()
        || endpoint.password().is_some()
        || endpoint.fragment().is_some()
    {
        return Err(SseTransportError::AddressDenied);
    }
    if endpoint.query_pairs().any(|(name, value)| {
        !matches!(name.as_ref(), "sessionId" | "session_id")
            || value.is_empty()
            || value.len() > MAX_EVENT_ID_BYTES
            || value.chars().any(char::is_control)
    }) {
        return Err(SseTransportError::AddressDenied);
    }
    Ok(endpoint)
}

#[derive(Clone)]
struct SseSender {
    client: reqwest::Client,
    headers: HeaderMap,
    endpoint: watch::Receiver<Option<reqwest::Url>>,
    cancelled: CancellationToken,
    post_gate: Arc<tokio::sync::Mutex<()>>,
}

impl SseSender {
    async fn send_body(&self, body: Vec<u8>) -> Result<(), SseTransportError> {
        if body.len() > MAX_OUTBOUND_MESSAGE_BYTES {
            return Err(SseTransportError::TooLarge);
        }
        let _post_guard = self.post_gate.lock().await;
        let mut endpoint = self.endpoint.clone();
        let url = tokio::time::timeout(HANDSHAKE_TIMEOUT, async {
            loop {
                if let Some(url) = endpoint.borrow().clone() {
                    return Ok(url);
                }
                tokio::select! {
                    _ = self.cancelled.cancelled() => return Err(SseTransportError::Closed),
                    changed = endpoint.changed() => changed.map_err(|_| SseTransportError::Closed)?,
                }
            }
        })
        .await
        .map_err(|_| SseTransportError::TimedOut)??;
        let response = tokio::select! {
            _ = self.cancelled.cancelled() => return Err(SseTransportError::Closed),
            response = tokio::time::timeout(POST_TIMEOUT, self.client.post(url).headers(self.headers.clone()).header(CONTENT_TYPE, "application/json").body(body).send()) => {
                response.map_err(|_| SseTransportError::TimedOut)?.map_err(|_| SseTransportError::InvalidResponse)?
            }
        };
        if !response.status().is_success() {
            return Err(SseTransportError::InvalidResponse);
        }
        let mut observed = 0usize;
        let mut stream = response.bytes_stream();
        while let Some(chunk) = stream.next().await {
            observed = observed
                .saturating_add(chunk.map_err(|_| SseTransportError::InvalidResponse)?.len());
            if observed > MAX_POST_RESPONSE_BYTES {
                return Err(SseTransportError::TooLarge);
            }
        }
        Ok(())
    }

    async fn send(&self, item: TxJsonRpcMessage<RoleClient>) -> Result<(), SseTransportError> {
        let body = serde_json::to_vec(&item).map_err(|_| SseTransportError::InvalidResponse)?;
        self.send_body(body).await
    }
}

pub struct LegacySseTransport {
    sender: SseSender,
    receiver: mpsc::Receiver<RxJsonRpcMessage<RoleClient>>,
    cancelled: CancellationToken,
}

impl Drop for LegacySseTransport {
    fn drop(&mut self) {
        self.cancelled.cancel();
    }
}

impl Transport<RoleClient> for LegacySseTransport {
    type Error = SseTransportError;

    fn name() -> Cow<'static, str> {
        "aiden-legacy-mcp-sse".into()
    }

    fn send(
        &mut self,
        item: TxJsonRpcMessage<RoleClient>,
    ) -> impl Future<Output = Result<(), Self::Error>> + Send + 'static {
        let sender = self.sender.clone();
        async move { sender.send(item).await }
    }

    async fn receive(&mut self) -> Option<RxJsonRpcMessage<RoleClient>> {
        self.receiver.recv().await
    }

    async fn close(&mut self) -> Result<(), Self::Error> {
        self.cancelled.cancel();
        Ok(())
    }
}

/// Raw legacy SSE session used only by the isolated subagent boundary. It
/// preserves exact JSON values before rmcp protocol structs can discard newer
/// tool fields.
pub struct RawLegacySseTransport {
    sender: SseSender,
    receiver: mpsc::Receiver<serde_json::Value>,
    cancelled: CancellationToken,
}

impl Drop for RawLegacySseTransport {
    fn drop(&mut self) {
        self.cancelled.cancel();
    }
}

impl RawLegacySseTransport {
    pub async fn send(&self, value: serde_json::Value) -> Result<(), SseTransportError> {
        let body = serde_json::to_vec(&value).map_err(|_| SseTransportError::InvalidResponse)?;
        self.sender.send_body(body).await
    }

    pub async fn receive(&mut self) -> Option<serde_json::Value> {
        self.receiver.recv().await
    }

    pub fn close(&self) {
        self.cancelled.cancel();
    }
}

pub async fn connect(
    url: &str,
    custom_headers: &BTreeMap<String, String>,
) -> Result<LegacySseTransport, SseTransportError> {
    let url = secure_sse_url(url)?;
    let headers = headers(custom_headers)?;
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .no_proxy()
        .connect_timeout(CONNECT_TIMEOUT)
        .dns_resolver(Arc::new(PublicOnlyDnsResolver))
        .build()
        .map_err(|_| SseTransportError::InvalidResponse)?;
    let cancelled = CancellationToken::new();
    let (endpoint_tx, endpoint_rx) = watch::channel(None);
    let (message_tx, message_rx) = mpsc::channel(32);
    tokio::spawn(read_loop(
        client.clone(),
        url,
        headers.clone(),
        endpoint_tx,
        message_tx,
        cancelled.clone(),
    ));
    Ok(LegacySseTransport {
        sender: SseSender {
            client,
            headers,
            endpoint: endpoint_rx,
            cancelled: cancelled.clone(),
            post_gate: Arc::new(tokio::sync::Mutex::new(())),
        },
        receiver: message_rx,
        cancelled,
    })
}

pub async fn connect_raw(
    url: &str,
    custom_headers: &BTreeMap<String, String>,
) -> Result<RawLegacySseTransport, SseTransportError> {
    let url = secure_sse_url(url)?;
    let headers = headers(custom_headers)?;
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .no_proxy()
        .connect_timeout(CONNECT_TIMEOUT)
        .dns_resolver(Arc::new(PublicOnlyDnsResolver))
        .build()
        .map_err(|_| SseTransportError::InvalidResponse)?;
    let cancelled = CancellationToken::new();
    let (endpoint_tx, endpoint_rx) = watch::channel(None);
    let (message_tx, message_rx) = mpsc::channel(32);
    tokio::spawn(read_loop_raw(
        client.clone(),
        url,
        headers.clone(),
        endpoint_tx,
        message_tx,
        cancelled.clone(),
    ));
    Ok(RawLegacySseTransport {
        sender: SseSender {
            client,
            headers,
            endpoint: endpoint_rx,
            cancelled: cancelled.clone(),
            post_gate: Arc::new(tokio::sync::Mutex::new(())),
        },
        receiver: message_rx,
        cancelled,
    })
}

async fn read_loop(
    client: reqwest::Client,
    url: reqwest::Url,
    headers: HeaderMap,
    endpoint: watch::Sender<Option<reqwest::Url>>,
    messages: mpsc::Sender<RxJsonRpcMessage<RoleClient>>,
    cancelled: CancellationToken,
) {
    let mut last_event_id: Option<String> = None;
    for attempt in 0..MAX_RECONNECT_ATTEMPTS {
        if cancelled.is_cancelled() {
            break;
        }
        let _ = endpoint.send(None);
        let mut request = client
            .get(url.clone())
            .headers(headers.clone())
            .header(ACCEPT, "text/event-stream");
        if let Some(id) = &last_event_id {
            request = request.header(LAST_EVENT_ID, id);
        }
        let response = tokio::select! {
            _ = cancelled.cancelled() => break,
            response = tokio::time::timeout(HANDSHAKE_TIMEOUT, request.send()) => match response {
                Ok(Ok(response)) => response,
                _ => {
                    reconnect_delay(attempt, &cancelled).await;
                    continue;
                }
            }
        };
        if !response.status().is_success()
            || !response
                .headers()
                .get(CONTENT_TYPE)
                .is_some_and(|value| value.as_bytes().starts_with(b"text/event-stream"))
        {
            break;
        }
        let mut parser = BoundedSseParser::default();
        let mut body = response.bytes_stream();
        let mut retry = false;
        let mut has_endpoint = false;
        loop {
            let chunk = tokio::select! {
                _ = cancelled.cancelled() => return,
                chunk = tokio::time::timeout(IDLE_TIMEOUT, body.next()) => match chunk {
                    Ok(Some(Ok(chunk))) => chunk,
                    Ok(None) => { retry = true; break; }
                    _ => break,
                }
            };
            let events = match parser.push(&chunk) {
                Ok(events) => events,
                Err(_) => return,
            };
            for event in events {
                match event.event.as_str() {
                    "endpoint" => {
                        let Ok(value) = endpoint_from_event(&url, &event.data) else {
                            return;
                        };
                        if endpoint.send(Some(value)).is_err() {
                            return;
                        }
                        has_endpoint = true;
                    }
                    "message" => {
                        if !has_endpoint {
                            return;
                        }
                        let Ok(message) =
                            serde_json::from_str::<RxJsonRpcMessage<RoleClient>>(&event.data)
                        else {
                            return;
                        };
                        if messages.send(message).await.is_err() {
                            return;
                        }
                        if let Some(id) = event.id {
                            last_event_id = Some(id);
                        }
                    }
                    _ => return,
                }
            }
        }
        if !retry {
            break;
        }
        let _ = endpoint.send(None);
        reconnect_delay(attempt, &cancelled).await;
    }
}

async fn read_loop_raw(
    client: reqwest::Client,
    url: reqwest::Url,
    headers: HeaderMap,
    endpoint: watch::Sender<Option<reqwest::Url>>,
    messages: mpsc::Sender<serde_json::Value>,
    cancelled: CancellationToken,
) {
    let mut last_event_id: Option<String> = None;
    for attempt in 0..MAX_RECONNECT_ATTEMPTS {
        if cancelled.is_cancelled() {
            break;
        }
        let _ = endpoint.send(None);
        let mut request = client
            .get(url.clone())
            .headers(headers.clone())
            .header(ACCEPT, "text/event-stream");
        if let Some(id) = &last_event_id {
            request = request.header(LAST_EVENT_ID, id);
        }
        let response = tokio::select! {
            _ = cancelled.cancelled() => break,
            response = tokio::time::timeout(HANDSHAKE_TIMEOUT, request.send()) => match response {
                Ok(Ok(response)) => response,
                _ => {
                    reconnect_delay(attempt, &cancelled).await;
                    continue;
                }
            }
        };
        if !response.status().is_success()
            || !response
                .headers()
                .get(CONTENT_TYPE)
                .is_some_and(|value| value.as_bytes().starts_with(b"text/event-stream"))
        {
            break;
        }
        let mut parser = BoundedSseParser::default();
        let mut body = response.bytes_stream();
        let mut retry = false;
        let mut has_endpoint = false;
        loop {
            let chunk = tokio::select! {
                _ = cancelled.cancelled() => return,
                chunk = tokio::time::timeout(IDLE_TIMEOUT, body.next()) => match chunk {
                    Ok(Some(Ok(chunk))) => chunk,
                    Ok(None) => { retry = true; break; }
                    _ => break,
                }
            };
            let events = match parser.push(&chunk) {
                Ok(events) => events,
                Err(_) => return,
            };
            for event in events {
                match event.event.as_str() {
                    "endpoint" => {
                        let Ok(value) = endpoint_from_event(&url, &event.data) else {
                            return;
                        };
                        if endpoint.send(Some(value)).is_err() {
                            return;
                        }
                        has_endpoint = true;
                    }
                    "message" => {
                        if !has_endpoint {
                            return;
                        }
                        let Ok(message) = serde_json::from_str::<serde_json::Value>(&event.data)
                        else {
                            return;
                        };
                        if messages.send(message).await.is_err() {
                            return;
                        }
                        if let Some(id) = event.id {
                            last_event_id = Some(id);
                        }
                    }
                    _ => return,
                }
            }
        }
        if !retry {
            break;
        }
        let _ = endpoint.send(None);
        reconnect_delay(attempt, &cancelled).await;
    }
}

async fn reconnect_delay(attempt: usize, cancelled: &CancellationToken) {
    let millis = 100u64.saturating_mul(1u64 << attempt.min(4));
    tokio::select! {
        _ = cancelled.cancelled() => {}
        _ = tokio::time::sleep(Duration::from_millis(millis)) => {}
    }
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Mutex as StdMutex;

    use rmcp::service::ServiceExt as _;
    use tokio::io::{AsyncReadExt as _, AsyncWriteExt as _};

    use super::*;

    async fn read_http_request(socket: &mut tokio::net::TcpStream) -> Option<(String, Vec<u8>)> {
        let mut bytes = Vec::new();
        let header_end = loop {
            if let Some(position) = bytes.windows(4).position(|window| window == b"\r\n\r\n") {
                break position + 4;
            }
            let mut chunk = [0u8; 2_048];
            let read = socket.read(&mut chunk).await.ok()?;
            if read == 0 || bytes.len().saturating_add(read) > MAX_OUTBOUND_MESSAGE_BYTES {
                return None;
            }
            bytes.extend_from_slice(&chunk[..read]);
        };
        let head = std::str::from_utf8(&bytes[..header_end]).ok()?.to_string();
        let content_length = head
            .lines()
            .find_map(|line| {
                let (name, value) = line.split_once(':')?;
                name.eq_ignore_ascii_case("content-length")
                    .then(|| value.trim().parse::<usize>().ok())
                    .flatten()
            })
            .unwrap_or(0);
        while bytes.len().saturating_sub(header_end) < content_length {
            let mut chunk = [0u8; 2_048];
            let read = socket.read(&mut chunk).await.ok()?;
            if read == 0 || bytes.len().saturating_add(read) > MAX_OUTBOUND_MESSAGE_BYTES {
                return None;
            }
            bytes.extend_from_slice(&chunk[..read]);
        }
        Some((
            head,
            bytes[header_end..header_end + content_length].to_vec(),
        ))
    }

    fn response_event(value: serde_json::Value, id: u64) -> String {
        let data = serde_json::to_string(&value).unwrap();
        format!("event: message\r\nid: {id}\r\ndata: {data}\r\n\r\n")
    }

    async fn spawn_mcp_sse_fixture() -> (
        String,
        Arc<StdMutex<Vec<String>>>,
        tokio::task::JoinHandle<()>,
    ) {
        spawn_mcp_sse_fixture_with_reconnect(false).await
    }

    async fn spawn_mcp_sse_fixture_with_reconnect(
        close_first_stream: bool,
    ) -> (
        String,
        Arc<StdMutex<Vec<String>>>,
        tokio::task::JoinHandle<()>,
    ) {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let requests = Arc::new(StdMutex::new(Vec::new()));
        let captured = requests.clone();
        let (events, _) = tokio::sync::broadcast::channel::<String>(16);
        let stream_count = Arc::new(AtomicUsize::new(0));
        let task = tokio::spawn(async move {
            loop {
                let Ok((mut socket, _)) = listener.accept().await else {
                    break;
                };
                let requests = captured.clone();
                let events = events.clone();
                let stream_count = stream_count.clone();
                tokio::spawn(async move {
                    let Some((head, body)) = read_http_request(&mut socket).await else {
                        return;
                    };
                    requests.lock().unwrap().push(head.clone());
                    if head.starts_with("GET /sse ") {
                        let stream_number = stream_count.fetch_add(1, Ordering::SeqCst) + 1;
                        let mut receiver = events.subscribe();
                        if socket
                            .write_all(b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nConnection: close\r\n\r\nevent: end")
                            .await
                            .is_err()
                        {
                            return;
                        }
                        if socket
                            .write_all(b"point\r\ndata: /message?session_id=fixture\r\n\r\n")
                            .await
                            .is_err()
                        {
                            return;
                        }
                        while let Ok(event) = receiver.recv().await {
                            if socket.write_all(event.as_bytes()).await.is_err() {
                                break;
                            }
                            if close_first_stream && stream_number == 1 {
                                break;
                            }
                        }
                        return;
                    }
                    if !head.starts_with("POST /message?session_id=fixture ") {
                        let _ = socket
                            .write_all(b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\n\r\n")
                            .await;
                        return;
                    }
                    let Ok(request) = serde_json::from_slice::<serde_json::Value>(&body) else {
                        return;
                    };
                    let method = request.get("method").and_then(serde_json::Value::as_str);
                    if let Some(id) = request.get("id") {
                        let result = match method {
                            Some("initialize") => serde_json::json!({
                                "protocolVersion": "2024-11-05",
                                "capabilities": { "tools": {} },
                                "serverInfo": { "name": "fixture", "version": "1.0.0" }
                            }),
                            Some("tools/list") => serde_json::json!({
                                "tools": [
                                    {
                                        "name": "echo",
                                        "description": "Echo fixture",
                                        "inputSchema": { "type": "object" },
                                        "annotations": { "readOnlyHint": true },
                                        "execution": { "taskSupport": "forbidden" }
                                    },
                                    {
                                        "name": "long_task",
                                        "inputSchema": { "type": "object" },
                                        "annotations": { "readOnlyHint": true },
                                        "execution": { "taskSupport": "required" }
                                    }
                                ]
                            }),
                            Some("tools/call") => serde_json::json!({
                                "content": [{ "type": "text", "text": "sse evidence" }]
                            }),
                            _ => serde_json::json!({}),
                        };
                        let _ = events.send(response_event(
                            serde_json::json!({ "jsonrpc": "2.0", "id": id, "result": result }),
                            if method == Some("initialize") { 1 } else { 2 },
                        ));
                    }
                    let _ = socket
                        .write_all(b"HTTP/1.1 202 Accepted\r\nContent-Length: 0\r\nConnection: close\r\n\r\n")
                        .await;
                });
            }
        });
        (format!("http://{address}/sse"), requests, task)
    }

    #[test]
    fn parser_accepts_chunked_utf8_crlf_and_multiline_data() {
        let mut parser = BoundedSseParser::default();
        assert!(parser
            .push(b"event: message\r\ndata: {\"jsonrpc\":\"2.0\",\r\n")
            .unwrap()
            .is_empty());
        let events = parser
            .push("data: \"result\":\"héllo\"}\r\n\r\n".as_bytes())
            .unwrap();
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].event, "message");
        assert!(events[0].data.contains("héllo"));
    }

    #[test]
    fn parser_rejects_oversized_lines_and_event_ids() {
        let mut parser = BoundedSseParser::default();
        assert!(matches!(
            parser.push(&vec![b'a'; MAX_LINE_BYTES + 1]),
            Err(SseTransportError::TooLarge)
        ));
        let mut parser = BoundedSseParser::default();
        let input = format!("id: {}\n", "a".repeat(MAX_EVENT_ID_BYTES + 1));
        assert!(matches!(
            parser.push(input.as_bytes()),
            Err(SseTransportError::InvalidResponse)
        ));
    }

    #[test]
    fn endpoint_is_same_origin_and_rejects_query_credentials() {
        let base = secure_sse_url("https://mcp.example/sse").unwrap();
        assert!(endpoint_from_event(&base, "/message?session_id=ok").is_ok());
        assert!(endpoint_from_event(&base, "https://other.example/message").is_err());
        assert!(endpoint_from_event(&base, "/message?access_token=secret").is_err());
    }

    #[test]
    fn url_policy_allows_https_and_explicit_loopback_only() {
        assert!(secure_sse_url("https://mcp.example/sse").is_ok());
        assert!(secure_sse_url("http://127.0.0.1:3000/sse").is_ok());
        assert!(secure_sse_url("http://10.0.0.1/sse").is_err());
        assert!(secure_sse_url("https://user:secret@mcp.example/sse").is_err());
    }

    #[tokio::test]
    async fn production_transport_handshakes_lists_tools_and_sends_exact_headers() {
        let (url, requests, server) = spawn_mcp_sse_fixture().await;
        let custom_headers = BTreeMap::from([
            (
                "Authorization".to_string(),
                "Bearer exact-secret".to_string(),
            ),
            ("X-Aiden-Test".to_string(), "bound".to_string()),
        ]);
        let transport = connect(&url, &custom_headers).await.unwrap();
        let running = crate::client::AidenClientHandler::default()
            .serve(transport)
            .await
            .unwrap();
        let tools = running.list_all_tools().await.unwrap();
        assert_eq!(tools[0].name, "echo");
        let captured = requests.lock().unwrap().clone();
        assert!(captured
            .iter()
            .any(|request| request.starts_with("GET /sse ")));
        assert!(captured
            .iter()
            .filter(|request| request.starts_with("POST /message"))
            .all(|request| request
                .to_ascii_lowercase()
                .contains("authorization: bearer exact-secret")));
        drop(running);
        server.abort();
    }

    #[tokio::test]
    async fn reconnect_is_bounded_and_resumes_only_from_an_accepted_event_id() {
        let (url, requests, server) = spawn_mcp_sse_fixture_with_reconnect(true).await;
        let transport = connect(&url, &BTreeMap::new()).await.unwrap();
        let running = crate::client::AidenClientHandler::default()
            .serve(transport)
            .await
            .unwrap();
        tokio::time::sleep(Duration::from_millis(350)).await;
        let tools = running.list_all_tools().await.unwrap();
        assert_eq!(tools[0].name, "echo");
        let get_requests = requests
            .lock()
            .unwrap()
            .iter()
            .filter(|request| request.starts_with("GET /sse "))
            .cloned()
            .collect::<Vec<_>>();
        assert!(get_requests.len() >= 2);
        assert!(get_requests[1]
            .to_ascii_lowercase()
            .contains("last-event-id: 1"));
        drop(running);
        server.abort();
    }

    #[tokio::test]
    async fn raw_subagent_sse_preserves_execution_calls_and_closes() {
        let (url, requests, server) = spawn_mcp_sse_fixture().await;
        let spec = crate::config::McpServerSpec {
            server: aiden_data::portable_config::McpServer {
                id: "legacy-sse".into(),
                name: "Legacy SSE".into(),
                transport: aiden_data::portable_config::McpTransport::Sse,
                command: None,
                args: None,
                env: None,
                url: Some(url.clone()),
                headers: None,
                oauth: None,
                preset_id: None,
                enabled: true,
            },
            transport: aiden_data::portable_config::McpTransport::Sse,
            stdio: None,
            remote: Some(crate::config::RemoteSpec {
                url,
                headers: BTreeMap::from([(
                    "Authorization".to_string(),
                    "Bearer exact-sse-secret".to_string(),
                )]),
            }),
            preset: None,
        };
        let client = crate::subagent_remote::SubagentRemoteSseClient::connect(
            &spec,
            CancellationToken::new(),
        )
        .await
        .unwrap();
        let tools = client.list_tools().await.unwrap();
        assert_eq!(tools.len(), 2);
        assert_eq!(
            tools[1].execution,
            Some(serde_json::json!({ "taskSupport": "required" }))
        );
        let normalized = crate::inventory::normalize_subagent_mcp_inventory(&tools, &|text| {
            text.replace("exact-sse-secret", "[redacted]")
        })
        .unwrap();
        assert_eq!(normalized.len(), 1);
        let result = client
            .call_tool("echo", serde_json::json!({ "value": "bounded" }))
            .await
            .unwrap();
        assert_eq!(result["content"][0]["text"], "sse evidence");
        client.close().await;
        let captured = requests.lock().unwrap().join("\n").to_ascii_lowercase();
        assert!(captured.contains("authorization: bearer exact-sse-secret"));
        server.abort();
    }

    #[tokio::test]
    async fn manager_replaces_sse_credentials_and_reset_advances_the_global_fence() {
        let (url, requests, server) = spawn_mcp_sse_fixture().await;
        let make_spec = |credential: &str| crate::config::McpServerSpec {
            server: aiden_data::portable_config::McpServer {
                id: "legacy-sse".into(),
                name: "Legacy SSE".into(),
                transport: aiden_data::portable_config::McpTransport::Sse,
                command: None,
                args: None,
                env: None,
                url: Some(url.clone()),
                headers: None,
                oauth: None,
                preset_id: None,
                enabled: true,
            },
            transport: aiden_data::portable_config::McpTransport::Sse,
            stdio: None,
            remote: Some(crate::config::RemoteSpec {
                url: url.clone(),
                headers: BTreeMap::from([(
                    "Authorization".to_string(),
                    format!("Bearer {credential}"),
                )]),
            }),
            preset: None,
        };
        let manager = crate::client::McpClientManager::new();
        let first = make_spec("credential-a");
        manager.ensure_connected(&first).await.unwrap();
        let first_fingerprint = manager.cached_fingerprint("legacy-sse").await.unwrap();
        let second = make_spec("credential-b");
        manager.ensure_connected(&second).await.unwrap();
        assert_ne!(
            first_fingerprint,
            manager.cached_fingerprint("legacy-sse").await.unwrap()
        );
        let before_reset = manager.config_generation();
        manager.close_all().await;
        assert!(manager.config_generation() > before_reset);
        assert!(!manager.is_connected("legacy-sse").await);
        let captured = requests.lock().unwrap().join("\n").to_ascii_lowercase();
        assert!(captured.contains("authorization: bearer credential-a"));
        assert!(captured.contains("authorization: bearer credential-b"));
        server.abort();
    }

    #[tokio::test]
    async fn redirects_and_error_bodies_never_echo_credentials() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let _ = read_http_request(&mut socket).await;
            socket
                .write_all(b"HTTP/1.1 302 Found\r\nLocation: http://127.0.0.1:1/stolen\r\nContent-Length: 24\r\n\r\naccess_token=server-body")
                .await
                .unwrap();
        });
        let headers = BTreeMap::from([(
            "Authorization".to_string(),
            "Bearer caller-secret".to_string(),
        )]);
        let transport = connect(&format!("http://{address}/sse"), &headers)
            .await
            .unwrap();
        let error = crate::client::AidenClientHandler::default()
            .serve(transport)
            .await
            .unwrap_err()
            .to_string();
        assert!(!error.contains("caller-secret"));
        assert!(!error.contains("server-body"));
        server.await.unwrap();
    }
}
