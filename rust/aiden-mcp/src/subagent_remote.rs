//! Isolated, raw remote MCP client for foreground subagent inspection/calls.
//!
//! Unlike the normal cached rmcp manager, this boundary retains the exact raw
//! `tools/list` records (including newer `execution` metadata), never admits
//! stdio, and closes its session after one bounded owner operation.

use std::collections::{BTreeMap, HashSet};
use std::net::IpAddr;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;

use futures::StreamExt as _;
use reqwest::header::{HeaderMap, HeaderName, HeaderValue, ACCEPT, CONTENT_TYPE};
use tokio_util::sync::CancellationToken;

use crate::{McpServerSpec, McpToolInfo, McpTransport};

const CONNECT_TIMEOUT: Duration = Duration::from_secs(5);
const INITIALIZE_TIMEOUT: Duration = Duration::from_secs(15);
const LIST_TIMEOUT: Duration = Duration::from_secs(3);
const CALL_TIMEOUT: Duration = Duration::from_secs(60);
const CLOSE_TIMEOUT: Duration = Duration::from_secs(3);
const MAX_RESPONSE_BYTES: usize = 256 * 1024;
const MAX_REQUEST_BYTES: usize = 64 * 1024;
const MAX_SESSION_ID_BYTES: usize = 1_024;
const MAX_HEADERS: usize = 64;
const MAX_HEADER_NAME_BYTES: usize = 256;
const MAX_HEADER_VALUE_BYTES: usize = 4_096;
const MAX_PAGES: usize = 16;
const MCP_SESSION_ID: HeaderName = HeaderName::from_static("mcp-session-id");
const MCP_PROTOCOL_VERSION: HeaderName = HeaderName::from_static("mcp-protocol-version");

#[derive(Debug, Clone, thiserror::Error, PartialEq, Eq)]
pub enum SubagentRemoteError {
    #[error("The remote MCP address is not allowed.")]
    AddressDenied,
    #[error("The remote MCP headers are invalid.")]
    InvalidHeaders,
    #[error("The remote MCP response was invalid.")]
    InvalidResponse,
    #[error("The remote MCP message exceeded its safety limit.")]
    TooLarge,
    #[error("The remote MCP operation timed out.")]
    TimedOut,
    #[error("The remote MCP operation was cancelled.")]
    Cancelled,
    #[error("The remote MCP transport is not supported for child use.")]
    UnsupportedTransport,
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
                    "remote MCP host is not public",
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

fn secure_url(value: &str) -> Result<reqwest::Url, SubagentRemoteError> {
    if value.is_empty() || value.len() > 4_096 {
        return Err(SubagentRemoteError::AddressDenied);
    }
    let url = reqwest::Url::parse(value).map_err(|_| SubagentRemoteError::AddressDenied)?;
    if !url.username().is_empty() || url.password().is_some() || url.fragment().is_some() {
        return Err(SubagentRemoteError::AddressDenied);
    }
    let loopback = url
        .host_str()
        .is_some_and(|host| matches!(host, "127.0.0.1" | "localhost" | "::1"));
    if url.scheme() != "https" && !(url.scheme() == "http" && loopback) {
        return Err(SubagentRemoteError::AddressDenied);
    }
    if url
        .host_str()
        .and_then(|host| host.parse::<IpAddr>().ok())
        .is_some_and(|address| !address.is_loopback() && !is_public_ip(address))
    {
        return Err(SubagentRemoteError::AddressDenied);
    }
    Ok(url)
}

fn exact_headers(values: &BTreeMap<String, String>) -> Result<HeaderMap, SubagentRemoteError> {
    if values.len() > MAX_HEADERS {
        return Err(SubagentRemoteError::InvalidHeaders);
    }
    let mut headers = HeaderMap::new();
    let mut names = HashSet::new();
    for (name, value) in values {
        if name.is_empty()
            || name.len() > MAX_HEADER_NAME_BYTES
            || value.len() > MAX_HEADER_VALUE_BYTES
        {
            return Err(SubagentRemoteError::InvalidHeaders);
        }
        let name = HeaderName::from_bytes(name.as_bytes())
            .map_err(|_| SubagentRemoteError::InvalidHeaders)?;
        if !names.insert(name.as_str().to_ascii_lowercase())
            || matches!(
                name.as_str(),
                "host"
                    | "content-length"
                    | "connection"
                    | "transfer-encoding"
                    | "accept"
                    | "content-type"
                    | "mcp-session-id"
                    | "mcp-protocol-version"
            )
        {
            return Err(SubagentRemoteError::InvalidHeaders);
        }
        let value =
            HeaderValue::from_str(value).map_err(|_| SubagentRemoteError::InvalidHeaders)?;
        headers.insert(name, value);
    }
    Ok(headers)
}

pub struct SubagentRemoteHttpClient {
    client: reqwest::Client,
    url: reqwest::Url,
    headers: HeaderMap,
    session_id: tokio::sync::Mutex<Option<HeaderValue>>,
    next_id: AtomicU64,
    cancelled: CancellationToken,
}

pub struct SubagentRemoteSseClient {
    transport: tokio::sync::Mutex<crate::sse::RawLegacySseTransport>,
    next_id: AtomicU64,
    cancelled: CancellationToken,
}

impl SubagentRemoteSseClient {
    pub async fn connect(
        spec: &McpServerSpec,
        cancelled: CancellationToken,
    ) -> Result<Self, SubagentRemoteError> {
        if spec.transport != McpTransport::Sse {
            return Err(SubagentRemoteError::UnsupportedTransport);
        }
        let remote = spec
            .remote
            .as_ref()
            .ok_or(SubagentRemoteError::AddressDenied)?;
        let transport = crate::sse::connect_raw(&remote.url, &remote.headers)
            .await
            .map_err(|_| SubagentRemoteError::InvalidResponse)?;
        let this = Self {
            transport: tokio::sync::Mutex::new(transport),
            next_id: AtomicU64::new(1),
            cancelled,
        };
        this.request(
            "initialize",
            serde_json::json!({
                "protocolVersion": "2025-11-25",
                "capabilities": {},
                "clientInfo": { "name": "aiden-agent-subagent", "version": "1.0.0" }
            }),
            INITIALIZE_TIMEOUT,
        )
        .await?;
        this.notify("notifications/initialized", serde_json::json!({}))
            .await?;
        Ok(this)
    }

    async fn request(
        &self,
        method: &str,
        params: serde_json::Value,
        timeout: Duration,
    ) -> Result<serde_json::Value, SubagentRemoteError> {
        let id = self.next_id.fetch_add(1, Ordering::AcqRel);
        let value = serde_json::json!({
            "jsonrpc": "2.0", "id": id, "method": method, "params": params
        });
        let mut transport = self.transport.lock().await;
        tokio::select! {
            _ = self.cancelled.cancelled() => return Err(SubagentRemoteError::Cancelled),
            sent = transport.send(value) => sent.map_err(|_| SubagentRemoteError::InvalidResponse)?,
        }
        let response = tokio::select! {
            _ = self.cancelled.cancelled() => return Err(SubagentRemoteError::Cancelled),
            response = tokio::time::timeout(timeout, async {
                loop {
                    let response = transport.receive().await.ok_or(SubagentRemoteError::InvalidResponse)?;
                    if response.get("id").and_then(serde_json::Value::as_u64) == Some(id) {
                        return Ok(response);
                    }
                }
            }) => response.map_err(|_| SubagentRemoteError::TimedOut)??,
        };
        let object = response
            .as_object()
            .ok_or(SubagentRemoteError::InvalidResponse)?;
        if object.get("jsonrpc").and_then(serde_json::Value::as_str) != Some("2.0")
            || object.contains_key("error")
        {
            return Err(SubagentRemoteError::InvalidResponse);
        }
        object
            .get("result")
            .cloned()
            .ok_or(SubagentRemoteError::InvalidResponse)
    }

    async fn notify(
        &self,
        method: &str,
        params: serde_json::Value,
    ) -> Result<(), SubagentRemoteError> {
        let value = serde_json::json!({ "jsonrpc": "2.0", "method": method, "params": params });
        let transport = self.transport.lock().await;
        tokio::select! {
            _ = self.cancelled.cancelled() => Err(SubagentRemoteError::Cancelled),
            sent = transport.send(value) => sent.map_err(|_| SubagentRemoteError::InvalidResponse),
        }
    }

    pub async fn list_tools(&self) -> Result<Vec<McpToolInfo>, SubagentRemoteError> {
        let result = self
            .request("tools/list", serde_json::json!({}), LIST_TIMEOUT)
            .await?;
        let page = result
            .get("tools")
            .and_then(serde_json::Value::as_array)
            .ok_or(SubagentRemoteError::InvalidResponse)?;
        if page.len() > crate::inventory::MAX_SUBAGENT_MCP_INVENTORY_TOOLS
            || result
                .get("nextCursor")
                .is_some_and(|cursor| !cursor.is_null())
        {
            // Legacy SSE pagination is intentionally denied for the first
            // bounded session rather than reconnecting or extending lifetime.
            return Err(SubagentRemoteError::TooLarge);
        }
        page.iter()
            .map(|tool| {
                McpToolInfo::from_raw_value(tool).map_err(|_| SubagentRemoteError::InvalidResponse)
            })
            .collect()
    }

    pub async fn call_tool(
        &self,
        tool_name: &str,
        arguments: serde_json::Value,
    ) -> Result<serde_json::Value, SubagentRemoteError> {
        if !crate::identity::is_safe_subagent_identifier(tool_name) || !arguments.is_object() {
            return Err(SubagentRemoteError::InvalidResponse);
        }
        self.request(
            "tools/call",
            serde_json::json!({ "name": tool_name, "arguments": arguments }),
            CALL_TIMEOUT,
        )
        .await
    }

    pub async fn close(&self) {
        self.transport.lock().await.close();
    }
}

pub enum SubagentRemoteClient {
    Http(SubagentRemoteHttpClient),
    Sse(SubagentRemoteSseClient),
}

impl SubagentRemoteClient {
    pub async fn connect(
        spec: &McpServerSpec,
        cancelled: CancellationToken,
    ) -> Result<Self, SubagentRemoteError> {
        match spec.transport {
            McpTransport::Http => Ok(Self::Http(
                SubagentRemoteHttpClient::connect(spec, cancelled).await?,
            )),
            McpTransport::Sse => Ok(Self::Sse(
                SubagentRemoteSseClient::connect(spec, cancelled).await?,
            )),
            McpTransport::Stdio => Err(SubagentRemoteError::UnsupportedTransport),
        }
    }

    pub async fn list_tools(&self) -> Result<Vec<McpToolInfo>, SubagentRemoteError> {
        match self {
            Self::Http(client) => client.list_tools().await,
            Self::Sse(client) => client.list_tools().await,
        }
    }

    pub async fn call_tool(
        &self,
        tool_name: &str,
        arguments: serde_json::Value,
    ) -> Result<serde_json::Value, SubagentRemoteError> {
        match self {
            Self::Http(client) => client.call_tool(tool_name, arguments).await,
            Self::Sse(client) => client.call_tool(tool_name, arguments).await,
        }
    }

    pub async fn close(&self) {
        match self {
            Self::Http(client) => client.close().await,
            Self::Sse(client) => client.close().await,
        }
    }
}

impl SubagentRemoteHttpClient {
    pub async fn connect(
        spec: &McpServerSpec,
        cancelled: CancellationToken,
    ) -> Result<Self, SubagentRemoteError> {
        if spec.transport != McpTransport::Http {
            return Err(SubagentRemoteError::UnsupportedTransport);
        }
        let remote = spec
            .remote
            .as_ref()
            .ok_or(SubagentRemoteError::AddressDenied)?;
        let client = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .no_proxy()
            .connect_timeout(CONNECT_TIMEOUT)
            .dns_resolver(Arc::new(PublicOnlyDnsResolver))
            .build()
            .map_err(|_| SubagentRemoteError::InvalidResponse)?;
        let this = Self {
            client,
            url: secure_url(&remote.url)?,
            headers: exact_headers(&remote.headers)?,
            session_id: tokio::sync::Mutex::new(None),
            next_id: AtomicU64::new(1),
            cancelled,
        };
        this.initialize().await?;
        Ok(this)
    }

    async fn initialize(&self) -> Result<(), SubagentRemoteError> {
        self.request(
            "initialize",
            serde_json::json!({
                "protocolVersion": "2025-11-25",
                "capabilities": {},
                "clientInfo": { "name": "aiden-agent-subagent", "version": "1.0.0" }
            }),
            INITIALIZE_TIMEOUT,
        )
        .await?;
        self.notify("notifications/initialized", serde_json::json!({}))
            .await
    }

    pub async fn list_tools(&self) -> Result<Vec<McpToolInfo>, SubagentRemoteError> {
        let mut tools = Vec::new();
        let mut cursor: Option<String> = None;
        for _ in 0..MAX_PAGES {
            let params = cursor.as_ref().map_or_else(
                || serde_json::json!({}),
                |cursor| serde_json::json!({ "cursor": cursor }),
            );
            let result = self.request("tools/list", params, LIST_TIMEOUT).await?;
            let object = result
                .as_object()
                .ok_or(SubagentRemoteError::InvalidResponse)?;
            let page = object
                .get("tools")
                .and_then(serde_json::Value::as_array)
                .ok_or(SubagentRemoteError::InvalidResponse)?;
            if tools.len().saturating_add(page.len())
                > crate::inventory::MAX_SUBAGENT_MCP_INVENTORY_TOOLS
            {
                return Err(SubagentRemoteError::TooLarge);
            }
            for tool in page {
                tools.push(
                    McpToolInfo::from_raw_value(tool)
                        .map_err(|_| SubagentRemoteError::InvalidResponse)?,
                );
            }
            cursor = match object.get("nextCursor") {
                None | Some(serde_json::Value::Null) => return Ok(tools),
                Some(value) => {
                    let cursor = value
                        .as_str()
                        .filter(|cursor| !cursor.is_empty() && cursor.len() <= 1_024)
                        .ok_or(SubagentRemoteError::InvalidResponse)?;
                    Some(cursor.to_string())
                }
            };
        }
        Err(SubagentRemoteError::TooLarge)
    }

    pub async fn call_tool(
        &self,
        tool_name: &str,
        arguments: serde_json::Value,
    ) -> Result<serde_json::Value, SubagentRemoteError> {
        if !crate::identity::is_safe_subagent_identifier(tool_name) || !arguments.is_object() {
            return Err(SubagentRemoteError::InvalidResponse);
        }
        self.request(
            "tools/call",
            serde_json::json!({ "name": tool_name, "arguments": arguments }),
            CALL_TIMEOUT,
        )
        .await
    }

    async fn request(
        &self,
        method: &str,
        params: serde_json::Value,
        timeout: Duration,
    ) -> Result<serde_json::Value, SubagentRemoteError> {
        let id = self.next_id.fetch_add(1, Ordering::AcqRel);
        let body = serde_json::to_vec(&serde_json::json!({
            "jsonrpc": "2.0",
            "id": id,
            "method": method,
            "params": params
        }))
        .map_err(|_| SubagentRemoteError::InvalidResponse)?;
        if body.len() > MAX_REQUEST_BYTES {
            return Err(SubagentRemoteError::TooLarge);
        }
        let response = self.post(body, timeout).await?;
        let object = response
            .as_object()
            .ok_or(SubagentRemoteError::InvalidResponse)?;
        if object.get("id").and_then(serde_json::Value::as_u64) != Some(id)
            || object.get("jsonrpc").and_then(serde_json::Value::as_str) != Some("2.0")
        {
            return Err(SubagentRemoteError::InvalidResponse);
        }
        if object.contains_key("error") {
            return Err(SubagentRemoteError::InvalidResponse);
        }
        object
            .get("result")
            .cloned()
            .ok_or(SubagentRemoteError::InvalidResponse)
    }

    async fn notify(
        &self,
        method: &str,
        params: serde_json::Value,
    ) -> Result<(), SubagentRemoteError> {
        let body = serde_json::to_vec(&serde_json::json!({
            "jsonrpc": "2.0",
            "method": method,
            "params": params
        }))
        .map_err(|_| SubagentRemoteError::InvalidResponse)?;
        if body.len() > MAX_REQUEST_BYTES {
            return Err(SubagentRemoteError::TooLarge);
        }
        let request = self.request_builder(reqwest::Method::POST).body(body);
        let response = tokio::select! {
            _ = self.cancelled.cancelled() => return Err(SubagentRemoteError::Cancelled),
            response = tokio::time::timeout(INITIALIZE_TIMEOUT, request.send()) => {
                response.map_err(|_| SubagentRemoteError::TimedOut)?
                    .map_err(|_| SubagentRemoteError::InvalidResponse)?
            }
        };
        self.capture_session(&response).await?;
        if !response.status().is_success() {
            return Err(SubagentRemoteError::InvalidResponse);
        }
        Ok(())
    }

    async fn post(
        &self,
        body: Vec<u8>,
        timeout: Duration,
    ) -> Result<serde_json::Value, SubagentRemoteError> {
        let request = self.request_builder(reqwest::Method::POST).body(body);
        let response = tokio::select! {
            _ = self.cancelled.cancelled() => return Err(SubagentRemoteError::Cancelled),
            response = tokio::time::timeout(timeout, request.send()) => {
                response.map_err(|_| SubagentRemoteError::TimedOut)?
                    .map_err(|_| SubagentRemoteError::InvalidResponse)?
            }
        };
        self.capture_session(&response).await?;
        if !response.status().is_success() {
            return Err(SubagentRemoteError::InvalidResponse);
        }
        let event_stream = response
            .headers()
            .get(CONTENT_TYPE)
            .and_then(|value| value.to_str().ok())
            .is_some_and(|value| value.starts_with("text/event-stream"));
        let bytes = bounded_body(response).await?;
        if event_stream {
            parse_sse_response(&bytes)
        } else {
            serde_json::from_slice(&bytes).map_err(|_| SubagentRemoteError::InvalidResponse)
        }
    }

    fn request_builder(&self, method: reqwest::Method) -> reqwest::RequestBuilder {
        let mut request = self
            .client
            .request(method, self.url.clone())
            .headers(self.headers.clone())
            .header(CONTENT_TYPE, "application/json")
            .header(ACCEPT, "application/json, text/event-stream")
            .header(MCP_PROTOCOL_VERSION, "2025-11-25");
        if let Some(session) = self
            .session_id
            .try_lock()
            .ok()
            .and_then(|value| value.clone())
        {
            request = request.header(MCP_SESSION_ID, session);
        }
        request
    }

    async fn capture_session(
        &self,
        response: &reqwest::Response,
    ) -> Result<(), SubagentRemoteError> {
        let Some(value) = response.headers().get(&MCP_SESSION_ID) else {
            return Ok(());
        };
        if value.as_bytes().is_empty()
            || value.as_bytes().len() > MAX_SESSION_ID_BYTES
            || value.as_bytes().iter().any(|byte| byte.is_ascii_control())
        {
            return Err(SubagentRemoteError::InvalidResponse);
        }
        let mut session = self.session_id.lock().await;
        if session.as_ref().is_some_and(|current| current != value) {
            return Err(SubagentRemoteError::InvalidResponse);
        }
        *session = Some(value.clone());
        Ok(())
    }

    pub async fn close(&self) {
        if self.session_id.lock().await.is_none() {
            return;
        }
        let request = self.request_builder(reqwest::Method::DELETE);
        let _ = tokio::select! {
            _ = self.cancelled.cancelled() => None,
            response = tokio::time::timeout(CLOSE_TIMEOUT, request.send()) => response.ok(),
        };
    }
}

async fn bounded_body(response: reqwest::Response) -> Result<Vec<u8>, SubagentRemoteError> {
    let mut bytes = Vec::new();
    let mut stream = response.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|_| SubagentRemoteError::InvalidResponse)?;
        if bytes.len().saturating_add(chunk.len()) > MAX_RESPONSE_BYTES {
            return Err(SubagentRemoteError::TooLarge);
        }
        bytes.extend_from_slice(&chunk);
    }
    Ok(bytes)
}

fn parse_sse_response(bytes: &[u8]) -> Result<serde_json::Value, SubagentRemoteError> {
    let text = std::str::from_utf8(bytes).map_err(|_| SubagentRemoteError::InvalidResponse)?;
    let mut data = String::new();
    let mut accepted: Option<serde_json::Value> = None;
    for line in text.lines().chain(std::iter::once("")) {
        let line = line.strip_suffix('\r').unwrap_or(line);
        if line.is_empty() {
            if !data.is_empty() {
                let payload = data.strip_suffix('\n').unwrap_or(&data);
                accepted = Some(
                    serde_json::from_str(payload)
                        .map_err(|_| SubagentRemoteError::InvalidResponse)?,
                );
                data.clear();
            }
            continue;
        }
        if let Some(value) = line.strip_prefix("data:") {
            data.push_str(value.strip_prefix(' ').unwrap_or(value));
            data.push('\n');
        }
    }
    accepted.ok_or(SubagentRemoteError::InvalidResponse)
}

#[cfg(test)]
mod tests {
    use std::sync::Mutex as StdMutex;

    use aiden_data::portable_config::McpServer;
    use tokio::io::{AsyncReadExt as _, AsyncWriteExt as _};

    use super::*;

    async fn read_request(socket: &mut tokio::net::TcpStream) -> Option<(String, Vec<u8>)> {
        let mut bytes = Vec::new();
        let header_end = loop {
            if let Some(position) = bytes.windows(4).position(|window| window == b"\r\n\r\n") {
                break position + 4;
            }
            let mut chunk = [0u8; 2_048];
            let read = socket.read(&mut chunk).await.ok()?;
            if read == 0 || bytes.len().saturating_add(read) > MAX_REQUEST_BYTES {
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
            if read == 0 || bytes.len().saturating_add(read) > MAX_REQUEST_BYTES {
                return None;
            }
            bytes.extend_from_slice(&chunk[..read]);
        }
        Some((
            head,
            bytes[header_end..header_end + content_length].to_vec(),
        ))
    }

    async fn spawn_remote_fixture() -> (
        String,
        Arc<StdMutex<Vec<String>>>,
        tokio::task::JoinHandle<()>,
    ) {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let observed = Arc::new(StdMutex::new(Vec::new()));
        let task_observed = observed.clone();
        let task = tokio::spawn(async move {
            for _ in 0..5 {
                let (mut socket, _) = listener.accept().await.unwrap();
                let Some((head, body)) = read_request(&mut socket).await else {
                    return;
                };
                task_observed.lock().unwrap().push(head.clone());
                let method = head.split_whitespace().next().unwrap_or_default();
                let value: serde_json::Value = serde_json::from_slice(&body).unwrap_or_default();
                let rpc_method = value.get("method").and_then(serde_json::Value::as_str);
                let id = value.get("id").and_then(serde_json::Value::as_u64);
                let (status, session, response) = match (method, rpc_method) {
                    ("POST", Some("initialize")) => (
                        "200 OK",
                        true,
                        serde_json::json!({
                            "jsonrpc": "2.0", "id": id,
                            "result": {
                                "protocolVersion": "2025-11-25",
                                "capabilities": { "tools": {} },
                                "serverInfo": { "name": "fixture", "version": "1" }
                            }
                        })
                        .to_string(),
                    ),
                    ("POST", Some("notifications/initialized")) => {
                        ("202 Accepted", false, String::new())
                    }
                    ("POST", Some("tools/list")) => (
                        "200 OK",
                        false,
                        serde_json::json!({
                            "jsonrpc": "2.0", "id": id,
                            "result": { "tools": [
                                {
                                    "name": "lookup",
                                    "inputSchema": { "type": "object", "properties": { "query": { "type": "string" } } },
                                    "annotations": { "readOnlyHint": true },
                                    "execution": { "taskSupport": "forbidden" }
                                },
                                {
                                    "name": "long_task",
                                    "inputSchema": { "type": "object" },
                                    "annotations": { "readOnlyHint": true },
                                    "execution": { "taskSupport": "required" }
                                }
                            ] }
                        })
                        .to_string(),
                    ),
                    ("POST", Some("tools/call")) => (
                        "200 OK",
                        false,
                        serde_json::json!({
                            "jsonrpc": "2.0", "id": id,
                            "result": { "content": [{ "type": "text", "text": "evidence" }] }
                        })
                        .to_string(),
                    ),
                    ("DELETE", _) => ("200 OK", false, String::new()),
                    _ => ("400 Bad Request", false, String::new()),
                };
                let session = if session {
                    "Mcp-Session-Id: exact-session\r\n"
                } else {
                    ""
                };
                let response = format!(
                    "HTTP/1.1 {status}\r\n{session}Content-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{response}",
                    response.len()
                );
                socket.write_all(response.as_bytes()).await.unwrap();
            }
        });
        (format!("http://{address}/mcp"), observed, task)
    }

    #[test]
    fn remote_policy_denies_private_and_credentialled_addresses() {
        assert!(secure_url("https://mcp.example.test/mcp").is_ok());
        assert!(secure_url("http://127.0.0.1:3000/mcp").is_ok());
        assert_eq!(
            secure_url("https://10.0.0.1/mcp"),
            Err(SubagentRemoteError::AddressDenied)
        );
        assert_eq!(
            secure_url("https://user:secret@mcp.example.test/mcp"),
            Err(SubagentRemoteError::AddressDenied)
        );
    }

    #[test]
    fn streamable_sse_response_parser_is_bounded_upstream_and_exact() {
        let value = parse_sse_response(
            b"event: message\r\ndata: {\"jsonrpc\":\"2.0\",\r\ndata: \"id\":1,\"result\":{}}\r\n\r\n",
        )
        .unwrap();
        assert_eq!(value["id"], 1);
        assert!(parse_sse_response(b"event: message\n\ndata: not-json\n\n").is_err());
    }

    #[tokio::test]
    async fn isolated_http_client_preserves_execution_calls_once_and_closes() {
        let (url, observed, server) = spawn_remote_fixture().await;
        let spec = crate::resolve_mcp_server(&McpServer {
            id: "docs".into(),
            name: "Docs".into(),
            transport: McpTransport::Http,
            command: None,
            args: None,
            env: None,
            url: Some(url),
            headers: Some(BTreeMap::from([(
                "authorization".into(),
                "Bearer exact-secret".into(),
            )])),
            oauth: None,
            preset_id: None,
            enabled: true,
        })
        .unwrap();
        let client = SubagentRemoteHttpClient::connect(&spec, CancellationToken::new())
            .await
            .unwrap();
        let tools = client.list_tools().await.unwrap();
        assert_eq!(tools.len(), 2);
        assert_eq!(
            tools[1].execution,
            Some(serde_json::json!({ "taskSupport": "required" }))
        );
        let normalized = crate::inventory::normalize_subagent_mcp_inventory(&tools, &|text| {
            text.replace("exact-secret", "[redacted]")
        })
        .unwrap();
        assert_eq!(normalized.len(), 1);
        assert_eq!(normalized[0].tool_name, "lookup");
        let result = client
            .call_tool("lookup", serde_json::json!({ "query": "bounded" }))
            .await
            .unwrap();
        assert_eq!(result["content"][0]["text"], "evidence");
        client.close().await;
        server.await.unwrap();

        let heads = observed.lock().unwrap();
        assert_eq!(heads.len(), 5);
        assert!(heads.iter().all(|head| {
            head.to_ascii_lowercase()
                .contains("authorization: bearer exact-secret")
        }));
        assert!(heads.iter().skip(1).all(|head| {
            head.to_ascii_lowercase()
                .contains("mcp-session-id: exact-session")
        }));
    }
}
