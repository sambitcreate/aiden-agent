//! MCP client (port of `main/services/mcp.ts`).
//!
//! [`McpClientManager`] owns one [`McpClient`] per server id. Connection
//! lifecycle maps to rmcp 3.1's `RunningService`:
//!
//! - stdio servers spawn via `tokio::process::Command` wrapped in
//!   `rmcp::transport::TokioChildProcess`; the parent environment is merged
//!   with the server's `env` override, exactly like the TS
//!   `StdioClientTransport`.
//! - remote servers connect through
//!   `rmcp::transport::StreamableHttpClientTransport` over reqwest with the
//!   server's headers (and the preset API-key header already injected by
//!   `resolve_mcp_server` + `with_preset_api_key`). API-key presets use a
//!   no-redirect HTTP client so a credential-bearing header can never be
//!   forwarded cross-origin.
//! - the `initialize` handshake happens inside `serve()`; a failed handshake
//!   surfaces as `McpError::Unavailable`.
//!
//! Tool calls are namespaced through [`mcp_agent_tool_name`] and their results
//! normalized exactly like `mcp-tool-result.ts` (text blocks joined by `\n`,
//! `isError: true` surfaces as a thrown [`McpError::ToolFailed`]).
//!
//! SSE transport: rmcp 3.x removed the SSE *client* transport (only SSE
//! *responses* for streamable HTTP remain), so `transport == "sse"` fails
//! with [`McpError::SseUnsupported`]. Porting the TS `SSEClientTransport`
//! would require `reqwest-eventsource` + a hand-rolled JSON-RPC request
//! channel — deferred.

use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

use aiden_data::portable_config::{McpServer, McpTransport};
use rmcp::model::{
    CallToolRequestParams, CallToolResult, ClientCapabilities, ClientInfo, ContentBlock,
    Implementation, ProtocolVersion, Tool,
};
use rmcp::service::{RoleClient, RunningService, ServiceExt};
use rmcp::transport::streamable_http_client::{
    StreamableHttpClientTransport, StreamableHttpClientTransportConfig,
};
use rmcp::transport::TokioChildProcess;
use rmcp::{ClientHandler, ServiceError};
use sha2::{Digest, Sha256};

use crate::config::{credential_connection_snapshot, McpServerSpec};
use crate::error::McpError;
use crate::inventory::McpToolInfo;

pub const CLIENT_NAME: &str = "aiden-agent";
pub const CLIENT_VERSION: &str = "1.0.0";
/// Callers may leave this to the per-call `timeout` parameter.
pub const DEFAULT_CALL_TIMEOUT_MS: u64 = 60_000;
pub const DEFAULT_LIST_TIMEOUT_MS: u64 = 30_000;
/// Upper bound for a normalized tool result. A pathological (or simply
/// verbose) MCP server must never be able to blow up the transcript that is
/// re-sent to the provider on the next request, so results are truncated here.
pub const MAX_MCP_TOOL_RESULT_CHARS: usize = 200_000;

/// Truncate `text` to at most `max` chars, keeping the tail marker and only
/// cutting on char boundaries.
fn truncate_chars(text: &str, max: usize) -> String {
    if text.len() <= max {
        return text.to_string();
    }
    let marker = "\n… [truncated]";
    let mut limit = max.saturating_sub(marker.len()).min(text.len());
    while !text.is_char_boundary(limit) {
        limit -= 1;
    }
    format!("{}{}", &text[..limit], marker)
}

/// The client handler identity announced during `initialize`
/// (`{name: "aiden-agent", version: "1.0.0"}`).
#[derive(Debug, Clone)]
pub struct AidenClientHandler {
    pub name: &'static str,
    pub version: &'static str,
}

impl Default for AidenClientHandler {
    fn default() -> Self {
        Self {
            name: CLIENT_NAME,
            version: CLIENT_VERSION,
        }
    }
}

impl ClientHandler for AidenClientHandler {
    fn get_info(&self) -> ClientInfo {
        ClientInfo::new(
            ClientCapabilities::default(),
            Implementation::new(self.name, self.version),
        )
        .with_protocol_version(ProtocolVersion::default())
    }
}

/// A connected MCP server. Dropping it cancels the running service; stdio
/// children are killed by the transport's `Drop` cleanup.
pub struct McpClient {
    pub server_id: String,
    pub server_name: String,
    pub transport: McpTransport,
    /// Canonical fingerprint of the spec this connection was built from (see
    /// [`spec_fingerprint`]). [`McpClientManager::ensure_connected`] compares
    /// it against the current spec and reconnects when the server record
    /// changed, so a stale process (and stale credentials) can never keep
    /// serving a reconfigured server.
    pub fingerprint: String,
    running: RunningService<RoleClient, AidenClientHandler>,
}

impl std::fmt::Debug for McpClient {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("McpClient")
            .field("server_id", &self.server_id)
            .field("server_name", &self.server_name)
            .field("transport", &self.transport)
            .field("fingerprint", &self.fingerprint)
            .finish_non_exhaustive()
    }
}

/// Canonical fingerprint of a connection spec: transport + the credential
/// connection snapshot (secret maps reduced to hashes), so it is deterministic
/// and never embeds secrets. Any change to the record's command, URL, env,
/// headers, or injected preset key changes the fingerprint and forces a
/// reconnect.
pub fn spec_fingerprint(spec: &McpServerSpec) -> String {
    let transport = match spec.transport {
        McpTransport::Stdio => "stdio",
        McpTransport::Http => "http",
        McpTransport::Sse => "sse",
    };
    let snapshot = credential_connection_snapshot(&spec.server);
    let mut hasher = Sha256::new();
    hasher.update(b"aiden-mcp-connection-v1\0");
    hasher.update(transport.as_bytes());
    hasher.update(b"\0");
    hasher.update(
        serde_json::to_string(&snapshot)
            .expect("snapshot is serializable")
            .as_bytes(),
    );
    format!("{:x}", hasher.finalize())
}

impl McpClient {
    /// `tools/list` with pagination, bounded by [`DEFAULT_LIST_TIMEOUT_MS`].
    pub async fn list_tools(&self) -> Result<Vec<McpToolInfo>, McpError> {
        let tools = timed(
            self.running.list_all_tools(),
            DEFAULT_LIST_TIMEOUT_MS,
            &self.server_id,
        )
        .await?;
        Ok(tools.into_iter().map(McpToolInfo::from).collect())
    }

    /// `resources/list` with pagination.
    pub async fn list_resources(&self) -> Result<Vec<rmcp::model::Resource>, McpError> {
        timed(
            self.running.list_all_resources(),
            DEFAULT_LIST_TIMEOUT_MS,
            &self.server_id,
        )
        .await
    }

    /// `prompts/list` with pagination.
    pub async fn list_prompts(&self) -> Result<Vec<rmcp::model::Prompt>, McpError> {
        timed(
            self.running.list_all_prompts(),
            DEFAULT_LIST_TIMEOUT_MS,
            &self.server_id,
        )
        .await
    }

    /// `tools/call` bounded by `timeout`, returning the raw protocol result.
    pub async fn call_tool_raw(
        &self,
        tool: &str,
        args: serde_json::Value,
        timeout: Duration,
    ) -> Result<CallToolResult, McpError> {
        let args = args.as_object().cloned().unwrap_or_default();
        let params = CallToolRequestParams::new(tool.to_string()).with_arguments(args);
        let ms = timeout.as_millis().min(u64::MAX as u128) as u64;
        tokio::time::timeout(timeout, self.running.call_tool(params))
            .await
            .map_err(|_| McpError::ToolTimeout {
                server: self.server_id.clone(),
                tool: tool.to_string(),
                ms,
            })?
            .map_err(|err| McpError::Protocol(err.to_string()))
    }

    /// `tools/call` with result normalization (`mcp-tool-result.ts`):
    /// `isError: true` becomes a thrown [`McpError::ToolFailed`].
    pub async fn call_tool(
        &self,
        tool: &str,
        args: serde_json::Value,
        timeout: Duration,
    ) -> Result<McpToolTextResult, McpError> {
        let result = self.call_tool_raw(tool, args, timeout).await?;
        mcp_agent_tool_result(&result, &self.server_id, tool)
    }
}

/// A text-only projection of a tool result (pi `AgentToolResult` content).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct McpToolTextResult {
    pub text: String,
}

/// Normalize a `CallToolResult` (TS `mcpAgentToolResult`).
pub fn mcp_agent_tool_result(
    result: &CallToolResult,
    server: &str,
    tool: &str,
) -> Result<McpToolTextResult, McpError> {
    let text = to_text(result);
    if result.is_error == Some(true) {
        return Err(McpError::ToolFailed {
            server: server.to_string(),
            tool: tool.to_string(),
            message: text,
        });
    }
    Ok(McpToolTextResult { text })
}

fn to_text(result: &CallToolResult) -> String {
    let mut parts = Vec::new();
    for block in &result.content {
        if let ContentBlock::Text(text) = block {
            parts.push(text.text.clone());
        }
    }
    let text = if parts.is_empty() {
        serde_json::to_string(result).unwrap_or_else(|_| "MCP tool returned no result.".to_string())
    } else {
        parts.join("\n")
    };
    truncate_chars(&text, MAX_MCP_TOOL_RESULT_CHARS)
}

async fn timed<T>(
    future: impl std::future::Future<Output = Result<T, ServiceError>>,
    ms: u64,
    server_id: &str,
) -> Result<T, McpError> {
    tokio::time::timeout(Duration::from_millis(ms), future)
        .await
        .map_err(|_| McpError::Timeout(format!("MCP server \"{server_id}\" request"), ms))?
        .map_err(|err| McpError::Protocol(err.to_string()))
}

// ===========================================================================
// Connection
// ===========================================================================

/// Connect to a stdio server: spawn the command with the parent environment
/// merged under the server's `env` overrides.
pub async fn connect_stdio(spec: &McpServerSpec) -> Result<McpClient, McpError> {
    let stdio = spec.stdio.as_ref().ok_or(McpError::MissingCommand)?;
    let mut command = tokio::process::Command::new(&stdio.command);
    command.args(&stdio.args);
    command.env_clear();
    command.envs(std::env::vars());
    command.envs(&stdio.env);
    let transport = TokioChildProcess::new(command)
        .map_err(|err| McpError::Transport(format!("spawn \"{}\": {err}", stdio.command)))?;
    let running = AidenClientHandler::default()
        .serve(transport)
        .await
        .map_err(|err| McpError::Unavailable {
            name: spec.server.name.clone(),
            cause: err.to_string(),
        })?;
    Ok(McpClient {
        server_id: spec.server.id.clone(),
        server_name: spec.server.name.clone(),
        transport: McpTransport::Stdio,
        fingerprint: spec_fingerprint(spec),
        running,
    })
}

/// Connect to a remote (streamable HTTP) server with its headers.
///
/// rmcp's reqwest-backed transport builds a no-redirect client by default
/// (`redirect(Policy::none())`), matching the TS `createNoRedirectFetch` for
/// API-key presets: a credential-bearing header can never be replayed to a
/// redirect target.
pub async fn connect_remote(spec: &McpServerSpec) -> Result<McpClient, McpError> {
    let remote = spec.remote.as_ref().ok_or(McpError::MissingUrl)?;
    let mut custom_headers = HashMap::new();
    for (name, value) in &remote.headers {
        let name = http::header::HeaderName::from_bytes(name.as_bytes())
            .map_err(|err| McpError::Transport(format!("invalid header name \"{name}\": {err}")))?;
        let value = http::header::HeaderValue::from_str(value).map_err(|err| {
            McpError::Transport(format!("invalid header value for \"{name}\": {err}"))
        })?;
        custom_headers.insert(name, value);
    }
    let config = StreamableHttpClientTransportConfig::with_uri(remote.url.as_str())
        .custom_headers(custom_headers);
    let transport = StreamableHttpClientTransport::from_config(config);
    let running = AidenClientHandler::default()
        .serve(transport)
        .await
        .map_err(|err| McpError::Unavailable {
            name: spec.server.name.clone(),
            cause: err.to_string(),
        })?;
    Ok(McpClient {
        server_id: spec.server.id.clone(),
        server_name: spec.server.name.clone(),
        transport: spec.transport,
        fingerprint: spec_fingerprint(spec),
        running,
    })
}

/// Connect a resolved server spec, dispatching on its transport.
pub async fn connect(spec: &McpServerSpec) -> Result<McpClient, McpError> {
    match spec.transport {
        McpTransport::Stdio => connect_stdio(spec).await,
        McpTransport::Http => connect_remote(spec).await,
        McpTransport::Sse => Err(McpError::SseUnsupported),
    }
}

// ===========================================================================
// Manager
// ===========================================================================

/// Result of the settings "test connection" action (TS `status`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct McpStatus {
    pub connected: bool,
    pub tool_count: usize,
    pub tools: Vec<String>,
    pub error: Option<String>,
}

/// One cached client per server id with connection generations. In the TS
/// main process the renderer is never trusted with the client; here the
/// manager's methods are the only handles.
///
/// Clients are held behind `Arc` so a call can clone the handle, release the
/// map lock, and then await the remote without blocking every other server's
/// operations. [`Self::ensure_connected`] never holds the lock across the
/// connect itself, and reconnects when the server record's fingerprint
/// changes.
#[derive(Default)]
pub struct McpClientManager {
    clients: tokio::sync::Mutex<HashMap<String, Arc<McpClient>>>,
    generations: tokio::sync::Mutex<HashMap<String, u64>>,
    #[cfg(test)]
    connect_override: tokio::sync::Mutex<Option<ConnectOverride>>,
}

impl std::fmt::Debug for McpClientManager {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("McpClientManager")
            .field("clients", &"..")
            .field("generations", &"..")
            .finish()
    }
}

#[cfg(test)]
type ConnectOverride = Box<
    dyn Fn(&McpServerSpec) -> futures::future::BoxFuture<'static, Result<McpClient, McpError>>
        + Send
        + Sync,
>;

impl McpClientManager {
    pub fn new() -> Self {
        Self::default()
    }

    /// Test-only constructor that substitutes the transport connector so tests
    /// can drive connects deterministically without spawning real servers.
    #[cfg(test)]
    pub fn with_connect(connect: ConnectOverride) -> Self {
        Self {
            clients: tokio::sync::Mutex::new(HashMap::new()),
            generations: tokio::sync::Mutex::new(HashMap::new()),
            connect_override: tokio::sync::Mutex::new(Some(connect)),
        }
    }

    async fn connect_spec(&self, spec: &McpServerSpec) -> Result<McpClient, McpError> {
        #[cfg(test)]
        {
            let override_fn = self.connect_override.lock().await;
            if let Some(connect) = override_fn.as_ref() {
                return connect(spec).await;
            }
        }
        connect(spec).await
    }

    /// Clone the cached client handle without holding the map lock across any
    /// await that follows.
    async fn client_for(&self, server_id: &str) -> Result<Arc<McpClient>, McpError> {
        self.clients
            .lock()
            .await
            .get(server_id)
            .cloned()
            .ok_or_else(not_connected(server_id))
    }

    /// Connect the server if it is not already connected (or its spec changed),
    /// and claim the next generation. A record whose fingerprint changed is
    /// reconnected: the old client is dropped (cancelling its service and
    /// killing the stdio child), so a reconfigured command, URL, env, header,
    /// or preset key always takes effect.
    pub async fn ensure_connected(&self, spec: &McpServerSpec) -> Result<(), McpError> {
        let fingerprint = spec_fingerprint(spec);
        {
            let clients = self.clients.lock().await;
            if let Some(existing) = clients.get(&spec.server.id) {
                if existing.fingerprint == fingerprint {
                    return Ok(());
                }
            }
        }
        // Connect outside the lock: a slow spawn/handshake must never
        // serialize unrelated servers or block a second chat generation.
        let client = Arc::new(self.connect_spec(spec).await?);
        let mut clients = self.clients.lock().await;
        if let Some(existing) = clients.get(&spec.server.id) {
            if existing.fingerprint == fingerprint {
                // A concurrent connect won; the loser's transport is dropped
                // (cancelling its service and killing the child).
                return Ok(());
            }
        }
        clients.insert(spec.server.id.clone(), client);
        drop(clients);
        self.bump_generation(&spec.server.id).await;
        tracing::info!(server = %spec.server.id, "MCP server connected");
        Ok(())
    }

    async fn bump_generation(&self, server_id: &str) {
        let mut generations = self.generations.lock().await;
        let next = generations.get(server_id).copied().unwrap_or(0) + 1;
        generations.insert(server_id.to_string(), next);
    }

    pub async fn is_connected(&self, server_id: &str) -> bool {
        self.clients.lock().await.contains_key(server_id)
    }

    pub async fn list_tools(&self, server_id: &str) -> Result<Vec<McpToolInfo>, McpError> {
        let client = self.client_for(server_id).await?;
        client.list_tools().await
    }

    pub async fn list_resources(
        &self,
        server_id: &str,
    ) -> Result<Vec<rmcp::model::Resource>, McpError> {
        let client = self.client_for(server_id).await?;
        client.list_resources().await
    }

    pub async fn list_prompts(
        &self,
        server_id: &str,
    ) -> Result<Vec<rmcp::model::Prompt>, McpError> {
        let client = self.client_for(server_id).await?;
        client.list_prompts().await
    }

    /// Call a raw remote tool through its connected client, normalized by
    /// `mcp_agent_tool_result`. The map lock is released before the await, so
    /// a slow tool on one server never blocks another server's operations.
    pub async fn call_tool(
        &self,
        server_id: &str,
        tool: &str,
        args: serde_json::Value,
        timeout: Duration,
    ) -> Result<McpToolTextResult, McpError> {
        let client = self.client_for(server_id).await?;
        client.call_tool(tool, args, timeout).await
    }

    /// Namespaced agent tools for a connected server (TS
    /// `McpManager.agentToolsFor`): each remote tool becomes an
    /// [`crate::McpAgentTool`] with raw JSON Schema parameters.
    pub async fn agent_tools_for(
        &self,
        server: &McpServer,
    ) -> Result<Vec<crate::McpAgentTool>, McpError> {
        let tools = self.list_tools(&server.id).await?;
        Ok(tools
            .iter()
            .map(|tool| tool.to_tool_def(server, &tool.name))
            .collect())
    }

    /// The settings "test connection" action: connect and list tools; every
    /// failure collapses into a disconnected status (TS `status`).
    pub async fn status(&self, spec: &McpServerSpec) -> McpStatus {
        match self.ensure_connected(spec).await {
            Err(error) => McpStatus {
                connected: false,
                tool_count: 0,
                tools: Vec::new(),
                error: Some(error.to_string()),
            },
            Ok(()) => match self.list_tools(&spec.server.id).await {
                Ok(tools) => {
                    let names: Vec<String> = tools.iter().map(|tool| tool.name.clone()).collect();
                    McpStatus {
                        connected: true,
                        tool_count: tools.len(),
                        tools: names,
                        error: None,
                    }
                }
                Err(error) => McpStatus {
                    connected: false,
                    tool_count: 0,
                    tools: Vec::new(),
                    error: Some(error.to_string()),
                },
            },
        }
    }

    /// Drop the cached client (cancels the running service and kills stdio
    /// children) and advance its generation so stale callers fail closed.
    pub async fn disconnect(&self, server_id: &str) {
        self.clients.lock().await.remove(server_id);
        let mut generations = self.generations.lock().await;
        let next = generations.get(server_id).copied().unwrap_or(0) + 1;
        generations.insert(server_id.to_string(), next);
        tracing::info!(server = %server_id, "MCP server disconnected");
    }

    pub async fn close_all(&self) {
        let mut clients = self.clients.lock().await;
        clients.clear();
        self.generations.lock().await.clear();
    }

    pub async fn connected_ids(&self) -> Vec<String> {
        self.clients.lock().await.keys().cloned().collect()
    }

    /// The generation of the last connect attempt for this server.
    pub async fn connection_generation(&self, server_id: &str) -> u64 {
        self.generations
            .lock()
            .await
            .get(server_id)
            .copied()
            .unwrap_or(0)
    }
}

#[cfg(test)]
impl McpClientManager {
    /// Test-only: the fingerprint of the cached client for `server_id` (used
    /// to assert reconnects replace a stale connection).
    pub(crate) async fn cached_fingerprint(&self, server_id: &str) -> Option<String> {
        self.clients
            .lock()
            .await
            .get(server_id)
            .map(|client| client.fingerprint.clone())
    }
}

fn not_connected(server_id: &str) -> impl FnOnce() -> McpError + '_ {
    move || McpError::Unavailable {
        name: server_id.to_string(),
        cause: "not connected".to_string(),
    }
}

impl From<Tool> for McpToolInfo {
    fn from(tool: Tool) -> Self {
        let input_schema = serde_json::Value::Object((*tool.input_schema).clone());
        McpToolInfo {
            name: tool.name.into_owned(),
            description: tool.description.map(|description| description.into_owned()),
            input_schema,
            output_schema: tool
                .output_schema
                .map(|schema| serde_json::Value::Object((*schema).clone())),
            annotations: tool.annotations.map(|annotations| {
                serde_json::to_value(annotations).unwrap_or(serde_json::Value::Null)
            }),
        }
    }
}

/// Merge agent tools from the enabled subset of `servers`. Non-strict callers
/// skip failing servers with a warning (TS `collectMcpAgentTools`).
pub async fn collect_mcp_agent_tools(
    manager: &McpClientManager,
    servers: &[McpServer],
    strict: bool,
) -> Result<Vec<crate::McpAgentTool>, McpError> {
    let mut all: Vec<crate::McpAgentTool> = Vec::new();
    for server in servers {
        if !server.enabled {
            continue;
        }
        let spec = match crate::config::resolve_mcp_server(server) {
            Ok(spec) => spec,
            Err(error) => {
                if strict {
                    return Err(McpError::Unavailable {
                        name: server.name.clone(),
                        cause: error.to_string(),
                    });
                }
                tracing::warn!(server = %server.id, %error, "Skipping MCP server");
                continue;
            }
        };
        let server_tools = match manager.ensure_connected(&spec).await {
            Ok(()) => match manager.agent_tools_for(server).await {
                Ok(tools) => tools,
                Err(error) => {
                    if strict {
                        return Err(McpError::Unavailable {
                            name: server.name.clone(),
                            cause: error.to_string(),
                        });
                    }
                    tracing::warn!(server = %server.id, %error, "Skipping MCP server");
                    continue;
                }
            },
            Err(error) => {
                if strict {
                    return Err(McpError::Unavailable {
                        name: server.name.clone(),
                        cause: error.to_string(),
                    });
                }
                tracing::warn!(server = %server.id, %error, "Skipping MCP server");
                continue;
            }
        };
        let names: Vec<String> = all
            .iter()
            .map(|tool| tool.name.clone())
            .chain(server_tools.iter().map(|tool| tool.name.clone()))
            .collect();
        crate::identity::assert_unique_mcp_agent_tool_names(&names)?;
        all.extend(server_tools);
    }
    if strict && !servers.is_empty() && all.is_empty() {
        return Err(McpError::NoTools);
    }
    Ok(all)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::identity::mcp_agent_tool_name;
    use futures::FutureExt;
    use rmcp::model::TextContent;

    fn result(content: Vec<ContentBlock>, is_error: bool) -> CallToolResult {
        if is_error {
            CallToolResult::error(content)
        } else {
            CallToolResult::success(content)
        }
    }

    #[test]
    fn tool_result_normalization_joins_text_blocks() {
        let result = result(
            vec![ContentBlock::text("first"), ContentBlock::text("second")],
            false,
        );
        let normalized = mcp_agent_tool_result(&result, "docs", "lookup").unwrap();
        assert_eq!(normalized.text, "first\nsecond");
    }

    #[test]
    fn tool_result_normalization_falls_back_to_json() {
        let result = result(vec![], false);
        let normalized = mcp_agent_tool_result(&result, "docs", "lookup").unwrap();
        assert!(normalized.text.contains("isError"));
    }

    #[test]
    fn tool_result_is_error_surfaces_as_failure() {
        let result = result(vec![ContentBlock::text("boom")], true);
        let err = mcp_agent_tool_result(&result, "docs", "write").unwrap_err();
        assert!(matches!(
            err,
            McpError::ToolFailed { ref server, ref tool, .. } if server == "docs" && tool == "write"
        ));
        assert_eq!(
            err.to_string(),
            "MCP tool \"write\" on server \"docs\" failed: boom"
        );
    }

    #[test]
    fn text_content_is_extracted() {
        let result = result(
            vec![
                ContentBlock::Text(TextContent::new("hello")),
                ContentBlock::text("world"),
            ],
            false,
        );
        assert_eq!(
            mcp_agent_tool_result(&result, "s", "t").unwrap().text,
            "hello\nworld"
        );
    }

    #[test]
    fn agent_tool_names_are_namespaced() {
        let name = mcp_agent_tool_name("linear", "Linear", "search_issues");
        assert_eq!(name, "Linear__search_issues_fb4b3e0873c6");
    }

    // ---------------------------------------------------------------------
    // In-process transport fixture: a real rmcp client connected over a
    // tokio duplex to a real rmcp `ServerHandler`, exercising the initialize
    // handshake, `tools/list`, and `tools/call` end to end — no network.
    // ---------------------------------------------------------------------

    struct FixtureServer;

    impl rmcp::ServerHandler for FixtureServer {
        fn get_info(&self) -> rmcp::model::ServerInfo {
            rmcp::model::ServerInfo::new(
                rmcp::model::ServerCapabilities::builder()
                    .enable_tools()
                    .build(),
            )
        }

        fn list_tools(
            &self,
            _request: Option<rmcp::model::PaginatedRequestParams>,
            _context: rmcp::service::RequestContext<rmcp::RoleServer>,
        ) -> impl std::future::Future<Output = Result<rmcp::model::ListToolsResult, RmcpError>>
               + rmcp::service::MaybeSendFuture
               + '_ {
            let tools = vec![Tool::new(
                "echo",
                "Echoes the arguments back",
                serde_json::from_value::<rmcp::model::JsonObject>(serde_json::json!({
                    "type": "object",
                    "properties": { "text": { "type": "string" } }
                }))
                .expect("schema map"),
            )];
            std::future::ready(Ok(rmcp::model::ListToolsResult::with_all_items(tools)))
        }

        fn call_tool(
            &self,
            request: CallToolRequestParams,
            _context: rmcp::service::RequestContext<rmcp::RoleServer>,
        ) -> impl std::future::Future<Output = Result<rmcp::model::CallToolResponse, RmcpError>>
               + rmcp::service::MaybeSendFuture
               + '_ {
            if request.name != "echo" {
                return std::future::ready(Err(RmcpError::invalid_params(
                    format!("unknown tool \"{}\"", request.name),
                    None,
                )));
            }
            let args = request.arguments.unwrap_or_default();
            let text = serde_json::to_string(&args).unwrap_or_else(|_| "{}".into());
            std::future::ready(Ok(rmcp::model::CallToolResponse::Complete(
                CallToolResult::success(vec![ContentBlock::text(text)]),
            )))
        }
    }

    type RmcpError = rmcp::ErrorData;

    #[tokio::test]
    async fn in_process_client_connects_lists_tools_and_calls_tools() {
        let (server_half, client_half) = tokio::io::duplex(1024);
        let server_task = tokio::spawn(async move {
            let running = rmcp::serve_server(FixtureServer, server_half)
                .await
                .expect("in-process server must initialize");
            // Keep the server alive while the client works, then close.
            tokio::time::sleep(std::time::Duration::from_secs(5)).await;
            drop(running);
        });

        let running = AidenClientHandler::default()
            .serve(client_half)
            .await
            .expect("client must complete the initialize handshake");
        let client = McpClient {
            server_id: "fixture".into(),
            server_name: "Fixture".into(),
            transport: McpTransport::Http,
            fingerprint: "0".repeat(64),
            running,
        };

        // tools/list reaches the in-process server through the full protocol.
        let tools = client.list_tools().await.expect("list tools");
        assert_eq!(tools.len(), 1);
        assert_eq!(tools[0].name, "echo");
        assert_eq!(
            tools[0].description.as_deref(),
            Some("Echoes the arguments back")
        );
        assert_eq!(
            tools[0].input_schema,
            serde_json::json!({ "type": "object", "properties": { "text": { "type": "string" } } })
        );

        // tools/call round-trips arguments and normalizes the result.
        let call = client
            .call_tool(
                "echo",
                serde_json::json!({ "text": "hello" }),
                Duration::from_secs(5),
            )
            .await
            .expect("call tool");
        assert!(call.text.contains("hello"));

        // An unknown tool surfaces the server's method-not-found error.
        let err = client
            .call_tool("missing", serde_json::json!({}), Duration::from_secs(5))
            .await
            .unwrap_err();
        assert!(matches!(err, McpError::Protocol(_)));

        server_task.abort();
    }

    // ---------------------------------------------------------------------
    // Spec fingerprints (reconnect detection)
    // ---------------------------------------------------------------------

    fn stdio_spec(id: &str, command: &str) -> McpServerSpec {
        McpServerSpec {
            server: aiden_data::portable_config::McpServer {
                id: id.into(),
                name: id.into(),
                transport: McpTransport::Stdio,
                command: Some(command.into()),
                args: Some(vec!["--serve".into()]),
                env: Some(
                    [("TOKEN".to_string(), "secret".to_string())]
                        .into_iter()
                        .collect(),
                ),
                url: None,
                headers: None,
                oauth: None,
                preset_id: None,
                enabled: true,
            },
            transport: McpTransport::Stdio,
            stdio: Some(crate::config::StdioSpec {
                command: command.into(),
                args: vec!["--serve".into()],
                env: [("TOKEN".to_string(), "secret".to_string())]
                    .into_iter()
                    .collect(),
            }),
            remote: None,
            preset: None,
        }
    }

    #[test]
    fn spec_fingerprints_are_deterministic_and_change_with_the_config() {
        let spec = stdio_spec("docs", "mcp-docs");
        let again = stdio_spec("docs", "mcp-docs");
        assert_eq!(spec_fingerprint(&spec), spec_fingerprint(&again));

        // A different command (or URL, env, header) changes the fingerprint.
        let changed_command = stdio_spec("docs", "mcp-docs-v2");
        assert_ne!(spec_fingerprint(&spec), spec_fingerprint(&changed_command));

        let changed_env = {
            let mut spec = spec.clone();
            let stdio = spec.stdio.as_mut().expect("stdio");
            stdio.env.insert("TOKEN".into(), "new-secret".into());
            spec.server.env = Some(stdio.env.clone());
            spec
        };
        assert_ne!(spec_fingerprint(&spec), spec_fingerprint(&changed_env));

        // The fingerprint never embeds secret values (env is hashed).
        let fingerprint = spec_fingerprint(&spec);
        assert!(!fingerprint.contains("secret"));
        assert_eq!(fingerprint.len(), 64);

        // Transport is part of the identity.
        let remote = McpServerSpec {
            transport: McpTransport::Http,
            remote: Some(crate::config::RemoteSpec {
                url: "https://docs.test/mcp".into(),
                headers: Default::default(),
            }),
            ..spec.clone()
        };
        assert_ne!(spec_fingerprint(&spec), spec_fingerprint(&remote));
    }

    // ---------------------------------------------------------------------
    // Manager lifecycle (in-process duplex fixtures through with_connect)
    // ---------------------------------------------------------------------

    fn remote_spec(id: &str) -> McpServerSpec {
        McpServerSpec {
            server: aiden_data::portable_config::McpServer {
                id: id.into(),
                name: id.into(),
                transport: McpTransport::Http,
                command: None,
                args: None,
                env: None,
                url: Some(format!("https://{id}.test/mcp")),
                headers: None,
                oauth: None,
                preset_id: None,
                enabled: true,
            },
            transport: McpTransport::Http,
            stdio: None,
            remote: Some(crate::config::RemoteSpec {
                url: format!("https://{id}.test/mcp"),
                headers: Default::default(),
            }),
            preset: None,
        }
    }

    /// A fixture server that can delay its `tools/call` response and signal
    /// when a call has started (so tests can deterministically observe the
    /// manager's lock behavior).
    struct DelayedFixtureServer {
        started: std::sync::Mutex<Option<tokio::sync::oneshot::Sender<()>>>,
        delay_ms: u64,
    }

    impl rmcp::ServerHandler for DelayedFixtureServer {
        fn get_info(&self) -> rmcp::model::ServerInfo {
            rmcp::model::ServerInfo::new(
                rmcp::model::ServerCapabilities::builder()
                    .enable_tools()
                    .build(),
            )
        }

        fn list_tools(
            &self,
            _request: Option<rmcp::model::PaginatedRequestParams>,
            _context: rmcp::service::RequestContext<rmcp::RoleServer>,
        ) -> impl std::future::Future<Output = Result<rmcp::model::ListToolsResult, RmcpError>>
               + rmcp::service::MaybeSendFuture
               + '_ {
            let tools = vec![Tool::new(
                "echo",
                "Echoes the arguments back",
                serde_json::from_value::<rmcp::model::JsonObject>(serde_json::json!({
                    "type": "object",
                    "properties": { "text": { "type": "string" } }
                }))
                .expect("schema map"),
            )];
            std::future::ready(Ok(rmcp::model::ListToolsResult::with_all_items(tools)))
        }

        fn call_tool(
            &self,
            request: CallToolRequestParams,
            _context: rmcp::service::RequestContext<rmcp::RoleServer>,
        ) -> impl std::future::Future<Output = Result<rmcp::model::CallToolResponse, RmcpError>>
               + rmcp::service::MaybeSendFuture
               + '_ {
            let started = self.started.lock().unwrap().take();
            if let Some(tx) = started {
                let _ = tx.send(());
            }
            let delay_ms = self.delay_ms;
            async move {
                if delay_ms > 0 {
                    tokio::time::sleep(std::time::Duration::from_millis(delay_ms)).await;
                }
                let args = request.arguments.unwrap_or_default();
                let text = serde_json::to_string(&args).unwrap_or_else(|_| "{}".into());
                Ok(rmcp::model::CallToolResponse::Complete(
                    CallToolResult::success(vec![ContentBlock::text(text)]),
                ))
            }
        }
    }

    /// Build a real rmcp client over a duplex connected to a
    /// [`DelayedFixtureServer`]. The returned client's fingerprint matches
    /// `spec_fingerprint(spec)` so the manager's reconnect decision sees an
    /// up-to-date (or stale, if the spec later changes) connection.
    async fn fixture_client(
        spec: &McpServerSpec,
        delay_ms: u64,
        started: Option<tokio::sync::oneshot::Sender<()>>,
    ) -> McpClient {
        let (server_half, client_half) = tokio::io::duplex(16 * 1024);
        tokio::spawn(async move {
            let running = rmcp::serve_server(
                DelayedFixtureServer {
                    started: std::sync::Mutex::new(started),
                    delay_ms,
                },
                server_half,
            )
            .await
            .expect("fixture server handshake");
            tokio::time::sleep(std::time::Duration::from_secs(60)).await;
            drop(running);
        });
        let running = AidenClientHandler::default()
            .serve(client_half)
            .await
            .expect("fixture client handshake");
        McpClient {
            server_id: spec.server.id.clone(),
            server_name: spec.server.name.clone(),
            transport: spec.transport,
            fingerprint: spec_fingerprint(spec),
            running,
        }
    }

    fn counting_connect(
        connects: Arc<std::sync::atomic::AtomicUsize>,
        delay_ms: u64,
    ) -> ConnectOverride {
        Box::new(move |spec: &McpServerSpec| {
            let connects = connects.clone();
            let spec = spec.clone();
            async move {
                connects.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                Ok(fixture_client(&spec, delay_ms, None).await)
            }
            .boxed()
        })
    }

    #[tokio::test]
    async fn a_slow_tool_call_does_not_hold_the_manager_lock() {
        let connects = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        // The fixture's call_tool sleeps 300ms, so the call below is still in
        // flight while we probe the manager.
        let manager = Arc::new(McpClientManager::with_connect(counting_connect(
            connects.clone(),
            300,
        )));
        let spec = remote_spec("slow");
        manager.ensure_connected(&spec).await.unwrap();
        assert_eq!(connects.load(std::sync::atomic::Ordering::SeqCst), 1);

        let call = {
            let manager = manager.clone();
            tokio::spawn(async move {
                manager
                    .call_tool(
                        "slow",
                        "echo",
                        serde_json::json!({ "text": "x" }),
                        Duration::from_secs(5),
                    )
                    .await
            })
        };
        // Let the call enter the manager and park on the slow remote.
        tokio::task::yield_now().await;
        tokio::task::yield_now().await;
        // Even while the call is in flight, other manager operations return
        // immediately instead of waiting for the call to finish.
        let observed =
            tokio::time::timeout(Duration::from_millis(100), manager.is_connected("slow"))
                .await
                .expect("is_connected must not block behind an in-flight call");
        assert!(observed);
        let result = tokio::time::timeout(Duration::from_secs(5), call)
            .await
            .expect("call completes")
            .unwrap()
            .unwrap();
        assert!(result.text.contains("text"));
    }

    #[tokio::test]
    async fn a_slow_call_on_one_server_does_not_block_another_servers_connect() {
        let connects = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let manager = Arc::new(McpClientManager::with_connect(counting_connect(
            connects.clone(),
            0,
        )));
        manager
            .ensure_connected(&remote_spec("server-a"))
            .await
            .unwrap();

        // Fire a call to server-a that blocks on the (instant) fixture; the
        // real regression is connect-time: ensure_connected must not hold the
        // map lock while a connect is in flight. Drive that with a delayed
        // connect override for server-b.
        let (release_tx, release_rx) = tokio::sync::oneshot::channel::<()>();
        let slow_connect: ConnectOverride = {
            let release_rx = std::sync::Mutex::new(Some(release_rx));
            Box::new(move |spec: &McpServerSpec| {
                let release_rx = release_rx.lock().unwrap().take();
                let spec = spec.clone();
                async move {
                    if let Some(rx) = release_rx {
                        let _ = rx.await;
                    }
                    Ok(fixture_client(&spec, 0, None).await)
                }
                .boxed()
            })
        };
        let manager_b = Arc::new(McpClientManager::with_connect(slow_connect));
        let spec_b = remote_spec("server-b");
        let connect_task = {
            let manager_b = manager_b.clone();
            let spec_b = spec_b.clone();
            tokio::spawn(async move { manager_b.ensure_connected(&spec_b).await })
        };
        // Give the connect a chance to start and park on the release channel.
        for _ in 0..50 {
            tokio::task::yield_now().await;
        }
        // While server-b's connect is in flight, an unrelated manager operation
        // (server-a's is_connected) must not block on the connect.
        let observed = tokio::time::timeout(
            Duration::from_millis(100),
            manager_b.is_connected("server-a"),
        )
        .await
        .expect("is_connected must not block behind an in-flight connect");
        assert!(!observed);
        let _ = release_tx.send(());
        connect_task
            .await
            .expect("connect task")
            .expect("ensure_connected succeeds");
    }

    #[tokio::test]
    async fn a_changed_spec_reconnects_and_advances_the_generation() {
        let connects = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let manager = Arc::new(McpClientManager::with_connect(counting_connect(
            connects.clone(),
            0,
        )));

        let spec_a = remote_spec("docs");
        manager.ensure_connected(&spec_a).await.unwrap();
        assert_eq!(connects.load(std::sync::atomic::Ordering::SeqCst), 1);
        assert_eq!(manager.connection_generation("docs").await, 1);

        // An unchanged spec reuses the cached connection.
        manager.ensure_connected(&spec_a).await.unwrap();
        assert_eq!(connects.load(std::sync::atomic::Ordering::SeqCst), 1);
        assert_eq!(manager.connection_generation("docs").await, 1);

        // A changed record (different URL) forces a fresh connection and the
        // old one is dropped (its transport is cancelled).
        let spec_b = {
            let mut spec = spec_a.clone();
            spec.server.url = Some("https://docs.test/mcp/v2".into());
            spec.remote = Some(crate::config::RemoteSpec {
                url: "https://docs.test/mcp/v2".into(),
                headers: Default::default(),
            });
            spec
        };
        manager.ensure_connected(&spec_b).await.unwrap();
        assert_eq!(connects.load(std::sync::atomic::Ordering::SeqCst), 2);
        assert_eq!(manager.connection_generation("docs").await, 2);
        assert_eq!(
            manager.cached_fingerprint("docs").await.as_deref(),
            Some(spec_fingerprint(&spec_b).as_str())
        );

        // Back to the original record → reconnect again (double-checked).
        manager.ensure_connected(&spec_a).await.unwrap();
        assert_eq!(connects.load(std::sync::atomic::Ordering::SeqCst), 3);
        assert_eq!(
            manager.cached_fingerprint("docs").await.as_deref(),
            Some(spec_fingerprint(&spec_a).as_str())
        );
    }

    #[tokio::test]
    async fn concurrent_connects_to_the_same_server_both_succeed_with_one_cached() {
        let connects = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let manager = Arc::new(McpClientManager::with_connect(counting_connect(
            connects.clone(),
            0,
        )));
        let spec = remote_spec("docs");
        let first = {
            let manager = manager.clone();
            let spec = spec.clone();
            tokio::spawn(async move { manager.ensure_connected(&spec).await })
        };
        let second = {
            let manager = manager.clone();
            let spec = spec.clone();
            tokio::spawn(async move { manager.ensure_connected(&spec).await })
        };
        first.await.expect("first").expect("connected");
        second.await.expect("second").expect("connected");
        assert_eq!(connects.load(std::sync::atomic::Ordering::SeqCst), 2);
        assert_eq!(manager.connected_ids().await, vec!["docs"]);
        // The cached client is current for the requested spec.
        assert_eq!(
            manager.cached_fingerprint("docs").await.as_deref(),
            Some(spec_fingerprint(&spec).as_str())
        );
        // The generation advanced exactly once for the winning connection.
        assert_eq!(manager.connection_generation("docs").await, 1);
        // A subsequent ensure_connected finds the cached client (no new spawn).
        manager.ensure_connected(&spec).await.unwrap();
        assert_eq!(connects.load(std::sync::atomic::Ordering::SeqCst), 2);
    }

    #[tokio::test]
    async fn oversized_tool_results_are_truncated_to_the_bound() {
        let big = "x".repeat(MAX_MCP_TOOL_RESULT_CHARS * 2);
        let result = CallToolResult::success(vec![ContentBlock::text(big)]);
        let normalized = mcp_agent_tool_result(&result, "docs", "read").unwrap();
        assert!(normalized.text.len() <= MAX_MCP_TOOL_RESULT_CHARS);
        assert!(normalized.text.ends_with("… [truncated]"));

        // A single under-limit result is untouched.
        let small = CallToolResult::success(vec![ContentBlock::text("hello")]);
        let normalized = mcp_agent_tool_result(&small, "docs", "read").unwrap();
        assert_eq!(normalized.text, "hello");
    }
}
