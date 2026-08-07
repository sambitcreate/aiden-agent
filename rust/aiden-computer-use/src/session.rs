//! The cua-driver session client (port of
//! `main/services/computer-use/session.ts`).
//!
//! `CuaDriverSession` is the MCP client over an already-authenticated bridge:
//! newline-delimited JSON-RPC on the bridge's stdio (or, in tests, any async
//! byte stream). It replicates the TypeScript behavior exactly: the bounded
//! line decoder (64 MiB server limit), the 1 MiB client request limit with the
//! local request-too-large error, per-call timeouts, the serialized request
//! queue, and the `new → connecting → ready → broken/closed` lifecycle.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;

use serde_json::Value;
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};
use tokio::sync::{oneshot, Mutex};
use tokio::task::JoinHandle;
use tokio::time::{timeout, Duration, Instant};
use tokio_util::sync::CancellationToken;
use tracing::{debug, warn};

use crate::contract::{
    cua_driver_tool_declares_session, parse_cua_driver_tools, CuaDriverError, CuaDriverToolInfo,
};
use crate::jsonrpc::{JsonRpcId, JsonRpcMessage};
use crate::lines::decode_frame;

pub const CUA_DRIVER_MAX_CLIENT_MESSAGE_BYTES: usize = 1024 * 1024;
pub const CUA_DRIVER_MAX_SERVER_MESSAGE_BYTES: usize = 64 * 1024 * 1024;
const CUA_LOCAL_REQUEST_TOO_LARGE_ERROR_CODE: i64 = -32099;
const CUA_LOCAL_REQUEST_TOO_LARGE_MARKER: &str = "aiden.request_too_large.v1";
const CONNECT_TIMEOUT_MS: u64 = 10_000;
const CALL_TIMEOUT_MS: u64 = 30_000;
const CLOSE_GRACE_MS: u64 = 1_500;
const REQUEST_TIMEOUT_CODE: i64 = -32001;
const CANCELLED_CODE: i64 = -32002;
const TRANSPORT_CLOSED_CODE: i64 = -32000;

/// Options for a single tool call.
#[derive(Debug, Clone, Default)]
pub struct CuaDriverCallOptions {
    pub signal: Option<CancellationToken>,
    pub timeout_ms: Option<u64>,
}

/// What a session needs from its transport: the byte halves plus an optional
/// teardown handle (the bridge child process) used by `close`/`breakConnection`.
pub struct SessionTransportConfig {
    pub read_half: Box<dyn AsyncRead + Unpin + Send>,
    pub write_half: Box<dyn AsyncWrite + Unpin + Send>,
    /// Terminates the underlying bridge/child (SIGTERM → grace → SIGKILL).
    pub terminate: Option<Box<dyn FnOnce() + Send>>,
}

/// A byte-stream transport a `CuaDriverSession` can be built over.
pub trait SessionTransport: Send {
    fn into_parts(self) -> SessionTransportConfig;
}

impl SessionTransport for SessionTransportConfig {
    fn into_parts(self) -> SessionTransportConfig {
        self
    }
}

/// The driver result shape (`CallToolResult`): `{content, structuredContent,
/// isError}`.
#[derive(Debug, Clone)]
pub struct ToolCallResult {
    pub is_error: bool,
    pub content: Vec<Value>,
    pub structured_content: Option<serde_json::Map<String, Value>>,
    pub text: String,
    pub raw: Value,
}

impl ToolCallResult {
    pub fn from_value(value: Value) -> Result<ToolCallResult, CuaDriverError> {
        let object = value.as_object().ok_or_else(|| {
            CuaDriverError::new(
                "invalid_tools",
                "cua-driver returned an invalid tool result.",
            )
        })?;
        let is_error = object
            .get("isError")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        let mut text = String::new();
        let mut content = Vec::new();
        if let Some(items) = object.get("content").and_then(Value::as_array) {
            content = items.clone();
            for item in items {
                if let Some(part) = item.get("text").and_then(Value::as_str) {
                    text.push_str(part);
                }
            }
        }
        let structured_content = object
            .get("structuredContent")
            .and_then(Value::as_object)
            .cloned();
        Ok(ToolCallResult {
            is_error,
            content,
            structured_content,
            text,
            raw: value,
        })
    }
}

type PendingSender = oneshot::Sender<Result<Value, RpcError>>;

/// A JSON-RPC error received from the driver (or synthesized locally).
#[derive(Debug, Clone)]
struct RpcError {
    code: i64,
    message: String,
    data: Option<Value>,
}

fn request_id_key(id: &JsonRpcId) -> String {
    serde_json::to_string(id).unwrap_or_else(|_| "null".to_string())
}

/// Accumulates newline-delimited frames with a hard byte cap per frame.
struct FrameAccumulator {
    buffer: Vec<u8>,
    maximum: usize,
}

impl FrameAccumulator {
    fn new(maximum: usize) -> Self {
        Self {
            buffer: Vec::new(),
            maximum,
        }
    }

    /// Feed bytes and return every complete frame (trailing `\r` stripped).
    fn push(&mut self, chunk: &[u8]) -> Result<Vec<Vec<u8>>, CuaDriverError> {
        self.buffer.extend_from_slice(chunk);
        let mut frames = Vec::new();
        while let Some((frame, rest)) = decode_frame(&self.buffer) {
            if frame.len() > self.maximum {
                self.buffer.clear();
                return Err(CuaDriverError::new(
                    "response_too_large",
                    "Computer Use returned an oversized MCP message.",
                ));
            }
            frames.push(frame.to_vec());
            self.buffer = rest.to_vec();
        }
        if self.buffer.len() > self.maximum {
            self.buffer.clear();
            return Err(CuaDriverError::new(
                "response_too_large",
                "Computer Use returned an oversized MCP message.",
            ));
        }
        Ok(frames)
    }
}

/// Low-level JSON-RPC client over a byte stream. Every method takes `&self`;
/// locks are held only for the brief read/write/registration steps, never
/// across a response await, so `close` can always proceed.
pub struct McpClient {
    read_half: std::sync::Mutex<Option<Box<dyn AsyncRead + Unpin + Send>>>,
    write_half: Mutex<Option<Box<dyn AsyncWrite + Unpin + Send>>>,
    pending: Arc<Mutex<HashMap<String, PendingSender>>>,
    next_id: AtomicU64,
    read_task: std::sync::Mutex<Option<JoinHandle<()>>>,
    closed: AtomicBool,
    on_close: std::sync::Mutex<Option<Box<dyn Fn() + Send>>>,
    terminate: std::sync::Mutex<Option<Box<dyn FnOnce() + Send>>>,
}

impl McpClient {
    pub fn new(config: SessionTransportConfig) -> Self {
        Self {
            read_half: std::sync::Mutex::new(Some(config.read_half)),
            write_half: Mutex::new(Some(config.write_half)),
            pending: Arc::new(Mutex::new(HashMap::new())),
            next_id: AtomicU64::new(1),
            read_task: std::sync::Mutex::new(None),
            closed: AtomicBool::new(false),
            on_close: std::sync::Mutex::new(None),
            terminate: std::sync::Mutex::new(config.terminate),
        }
    }

    pub fn on_close(&self, callback: Box<dyn Fn() + Send>) {
        *self.on_close.lock().unwrap() = Some(callback);
    }

    pub fn is_closed(&self) -> bool {
        self.closed.load(Ordering::SeqCst)
    }

    /// Spawn the reader task over the stored read half. Must be called once.
    pub fn start_reader(&self) -> Result<(), CuaDriverError> {
        if self.is_closed() {
            return Err(CuaDriverError::new(
                "session_unavailable",
                "The Computer Use session is closed.",
            ));
        }
        {
            let read_task = self.read_task.lock().unwrap();
            if read_task.is_some() {
                return Err(CuaDriverError::new(
                    "invalid_session_state",
                    "The Computer Use transport is already started.",
                ));
            }
        }
        let Some(read_half) = self.read_half.lock().unwrap().take() else {
            return Err(CuaDriverError::new(
                "session_unavailable",
                "The Computer Use transport is already started.",
            ));
        };
        let pending = Arc::clone(&self.pending);
        let notify = self.on_close.lock().unwrap().take();
        let handle = tokio::spawn(async move {
            run_reader(read_half, pending, notify).await;
        });
        *self.read_task.lock().unwrap() = Some(handle);
        Ok(())
    }

    fn next_id(&self) -> Value {
        Value::from(self.next_id.fetch_add(1, Ordering::SeqCst))
    }

    /// Dispatch one request and await its response. The pending entry is
    /// removed on every exit path.
    async fn request_raw(&self, method: &str, params: Option<Value>) -> Result<Value, RpcError> {
        let id = self.next_id();
        let id_key = request_id_key(&id);
        let (sender, receiver) = oneshot::channel();
        self.pending.lock().await.insert(id_key.clone(), sender);
        let message = JsonRpcMessage::Request {
            id,
            method: method.to_string(),
            params,
        };
        let line = message.to_line().map_err(|_| RpcError {
            code: CUA_LOCAL_REQUEST_TOO_LARGE_ERROR_CODE,
            message: "Computer Use request could not be serialized.".into(),
            data: None,
        })?;
        if line.len() > CUA_DRIVER_MAX_CLIENT_MESSAGE_BYTES {
            self.pending.lock().await.remove(&id_key);
            return Err(RpcError {
                code: CUA_LOCAL_REQUEST_TOO_LARGE_ERROR_CODE,
                message: "Computer Use request exceeds the local MCP message limit.".into(),
                data: Some(serde_json::json!({
                    "aidenLocalError": CUA_LOCAL_REQUEST_TOO_LARGE_MARKER,
                })),
            });
        }
        if let Err(error) = self.send_line(&line).await {
            self.pending.lock().await.remove(&id_key);
            return Err(RpcError {
                code: TRANSPORT_CLOSED_CODE,
                message: error.to_string(),
                data: None,
            });
        }
        match receiver.await {
            Ok(result) => result,
            Err(_) => Err(RpcError {
                code: TRANSPORT_CLOSED_CODE,
                message: "The cua-driver connection closed.".into(),
                data: None,
            }),
        }
    }

    async fn send_line(&self, line: &[u8]) -> Result<(), CuaDriverError> {
        let mut write_half = self.write_half.lock().await;
        let Some(write_half) = write_half.as_mut() else {
            return Err(CuaDriverError::new(
                "session_unavailable",
                "The Computer Use session is not connected.",
            ));
        };
        write_half.write_all(line).await.map_err(|error| {
            CuaDriverError::new(
                "transport_closed",
                format!("The cua-driver connection closed unexpectedly: {error}"),
            )
        })?;
        write_half.flush().await.map_err(|error| {
            CuaDriverError::new(
                "transport_closed",
                format!("The cua-driver connection closed unexpectedly: {error}"),
            )
        })
    }

    /// Terminate the child (if any) and mark the transport closed. Pending
    /// callers observe the closed channel on their next await.
    pub async fn close(&self) {
        if self.closed.swap(true, Ordering::SeqCst) {
            return;
        }
        if let Some(terminate) = self.terminate.lock().unwrap().take() {
            terminate();
        }
        *self.write_half.lock().await = None;
        let pending = std::mem::take(&mut *self.pending.lock().await);
        for (_, sender) in pending.into_iter() {
            let _ = sender.send(Err(RpcError {
                code: TRANSPORT_CLOSED_CODE,
                message: "The cua-driver connection closed.".into(),
                data: None,
            }));
        }
        if let Some(handle) = self.read_task.lock().unwrap().take() {
            handle.abort();
        }
        if let Some(callback) = self.on_close.lock().unwrap().take() {
            callback();
        }
    }
}

/// Read, frame, and dispatch driver messages until EOF or failure.
async fn run_reader(
    read_half: Box<dyn AsyncRead + Unpin + Send>,
    pending: Arc<Mutex<HashMap<String, PendingSender>>>,
    notify: Option<Box<dyn Fn() + Send>>,
) {
    let mut accumulator = FrameAccumulator::new(CUA_DRIVER_MAX_SERVER_MESSAGE_BYTES);
    let mut reader = read_half;
    let mut chunk = [0_u8; 64 * 1024];
    while let Ok(count) = reader.read(&mut chunk).await {
        if count == 0 {
            break;
        }
        match accumulator.push(&chunk[..count]) {
            Ok(frames) => {
                let mut malformed = false;
                for frame in frames {
                    let message = match JsonRpcMessage::from_line(&frame) {
                        Ok(message) => message,
                        Err(error) => {
                            debug!("malformed MCP frame from cua-driver: {error}");
                            malformed = true;
                            break;
                        }
                    };
                    if let JsonRpcMessage::Response { id, result, error } = message {
                        let key = request_id_key(&id);
                        let sender = pending.lock().await.remove(&key);
                        if let Some(sender) = sender {
                            let outcome = match error {
                                Some(error) => Err(RpcError {
                                    code: error.code,
                                    message: error.message,
                                    data: error.data,
                                }),
                                None => Ok(result.unwrap_or(Value::Null)),
                            };
                            let _ = sender.send(outcome);
                        }
                    }
                    // Requests/notifications from the driver are not part of the
                    // pinned contract; they are intentionally ignored.
                }
                if malformed {
                    break;
                }
            }
            Err(error) => {
                warn!("cua-driver framing failed: {}", error.message);
                break;
            }
        }
    }
    // Abort every pending request with a transport-closed error.
    let pending = std::mem::take(&mut *pending.lock().await);
    for (_, sender) in pending.into_iter() {
        let _ = sender.send(Err(RpcError {
            code: TRANSPORT_CLOSED_CODE,
            message: "The cua-driver connection closed.".into(),
            data: None,
        }));
    }
    if let Some(callback) = notify {
        callback();
    }
}

/// The connection lifecycle mirrors `CuaDriverSession` in session.ts.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum SessionState {
    New,
    Connecting,
    Ready,
    Broken,
    Closed,
}

/// Options for constructing a `CuaDriverSession`.
pub struct CuaDriverSessionOptions {
    pub transport: SessionTransportConfig,
    pub diagnostic: Option<Arc<dyn Fn() -> String + Send + Sync>>,
    /// Invoked (at most once) when the session transitions to a closed state.
    pub on_closed: Option<Box<dyn Fn() + Send>>,
}

/// Shared state a `CuaDriverSession` hands to its transport-close callback.
struct SessionShared {
    state: std::sync::Mutex<SessionState>,
    did_notify_closed: AtomicBool,
    on_closed: std::sync::Mutex<Option<Box<dyn Fn() + Send>>>,
}

impl SessionShared {
    fn notify_closed(&self) {
        if self.did_notify_closed.swap(true, Ordering::SeqCst) {
            return;
        }
        if let Some(callback) = self.on_closed.lock().unwrap().take() {
            callback();
        }
    }
}

/// The agent-facing session over the authenticated bridge.
pub struct CuaDriverSession {
    id: String,
    client: Arc<McpClient>,
    tools: std::sync::Mutex<HashMap<String, CuaDriverToolInfo>>,
    tool_schema_version: std::sync::Mutex<Option<String>>,
    tool_capability_version: std::sync::Mutex<Option<String>>,
    queue: Arc<Mutex<()>>,
    close_promise: Mutex<Option<JoinHandle<()>>>,
    shared: Arc<SessionShared>,
    diagnostic: Option<Arc<dyn Fn() -> String + Send + Sync>>,
}

fn uuid4() -> String {
    let mut bytes = [0_u8; 16];
    if getrandom::getrandom(&mut bytes).is_err() {
        bytes = [0_u8; 16];
    }
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    format!(
        "{:02x}{:02x}{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}{:02x}{:02x}{:02x}{:02x}",
        bytes[0], bytes[1], bytes[2], bytes[3],
        bytes[4], bytes[5],
        bytes[6], bytes[7],
        bytes[8], bytes[9],
        bytes[10], bytes[11], bytes[12], bytes[13], bytes[14], bytes[15],
    )
}

fn startup_timeout_error() -> CuaDriverError {
    CuaDriverError::retryable(
        "startup_timeout",
        "Aiden Computer Use did not finish starting in time.",
    )
}

fn is_request_timeout(error: &RpcError) -> bool {
    error.code == REQUEST_TIMEOUT_CODE
}

fn is_cancelled(error: &RpcError) -> bool {
    error.code == CANCELLED_CODE
}

fn is_local_request_too_large(error: &RpcError) -> bool {
    error.code == CUA_LOCAL_REQUEST_TOO_LARGE_ERROR_CODE
        && error.data.as_ref().is_some_and(|data| {
            data.get("aidenLocalError").and_then(Value::as_str)
                == Some(CUA_LOCAL_REQUEST_TOO_LARGE_MARKER)
        })
}

fn is_transport_closed(error: &RpcError) -> bool {
    error.code == TRANSPORT_CLOSED_CODE
}

impl CuaDriverSession {
    pub fn new(mut options: CuaDriverSessionOptions) -> Self {
        let id = format!("aiden-{}", uuid4());
        let shared = Arc::new(SessionShared {
            state: std::sync::Mutex::new(SessionState::New),
            did_notify_closed: AtomicBool::new(false),
            on_closed: std::sync::Mutex::new(options.on_closed.take()),
        });
        let client = McpClient::new(options.transport);
        let client = Arc::new(client);
        let shared_for_client = Arc::clone(&shared);
        client.on_close(Box::new(move || {
            let state = *shared_for_client.state.lock().unwrap();
            if matches!(state, SessionState::Connecting | SessionState::Ready) {
                *shared_for_client.state.lock().unwrap() = SessionState::Broken;
            }
            shared_for_client.notify_closed();
        }));
        Self {
            id,
            client,
            tools: std::sync::Mutex::new(HashMap::new()),
            tool_schema_version: std::sync::Mutex::new(None),
            tool_capability_version: std::sync::Mutex::new(None),
            queue: Arc::new(Mutex::new(())),
            close_promise: Mutex::new(None),
            shared,
            diagnostic: options.diagnostic,
        }
    }

    pub fn id(&self) -> &str {
        &self.id
    }

    pub fn ready(&self) -> bool {
        *self.shared.state.lock().unwrap() == SessionState::Ready
    }

    pub fn tool_catalog(&self) -> HashMap<String, CuaDriverToolInfo> {
        self.tools.lock().unwrap().clone()
    }

    pub fn schema_version(&self) -> Option<String> {
        self.tool_schema_version.lock().unwrap().clone()
    }

    pub fn capability_version(&self) -> Option<String> {
        self.tool_capability_version.lock().unwrap().clone()
    }

    pub fn supports(&self, tool: &str, capability: &str) -> bool {
        self.tools
            .lock()
            .unwrap()
            .get(tool)
            .map(|info| info.capabilities.contains(capability))
            .unwrap_or(false)
    }

    fn state(&self) -> SessionState {
        *self.shared.state.lock().unwrap()
    }

    fn set_state(&self, state: SessionState) {
        *self.shared.state.lock().unwrap() = state;
    }

    fn notify_closed(&self) {
        self.shared.notify_closed();
    }

    fn diagnostic_detail(&self) -> String {
        self.diagnostic
            .as_ref()
            .map(|detail| detail().trim().chars().take(600).collect())
            .unwrap_or_default()
    }

    /// Run one JSON-RPC request with a timeout and optional cancellation.
    async fn request_with_timeout(
        &self,
        method: &str,
        params: Option<Value>,
        timeout_ms: u64,
        signal: Option<&CancellationToken>,
    ) -> Result<Value, CuaDriverError> {
        let request = self.client.request_raw(method, params);
        tokio::pin!(request);
        let outcome = tokio::select! {
            result = &mut request => result,
            _ = tokio::time::sleep(Duration::from_millis(timeout_ms)) => {
                Err(RpcError { code: REQUEST_TIMEOUT_CODE, message: "request timed out".into(), data: None })
            }
            _ = async {
                match signal {
                    Some(token) => token.cancelled().await,
                    None => std::future::pending::<()>().await,
                }
            } => {
                Err(RpcError { code: CANCELLED_CODE, message: "cancelled".into(), data: None })
            }
        };
        match outcome {
            Ok(value) => Ok(value),
            Err(error) if is_request_timeout(&error) => Err(CuaDriverError::retryable(
                "timeout",
                "cua-driver did not finish the Computer Use action in time.",
            )),
            Err(error) if is_cancelled(&error) => {
                Err(CuaDriverError::cancelled("Computer Use was cancelled."))
            }
            Err(error) if is_transport_closed(&error) => Err(CuaDriverError::retryable(
                "transport_closed",
                "The cua-driver connection closed unexpectedly.",
            )),
            Err(error) if is_local_request_too_large(&error) => Err(CuaDriverError::new(
                "request_too_large",
                "Computer Use request exceeds the 1 MiB MCP message limit.",
            )),
            Err(error) => Err(CuaDriverError::new(
                "connection_failed",
                format!("cua-driver returned a JSON-RPC error: {}", error.message),
            )),
        }
    }

    /// Connect: initialize → initialized → tools/list → start_session.
    pub async fn connect(
        &self,
        signal: Option<&CancellationToken>,
        deadline: Option<Instant>,
    ) -> Result<(), CuaDriverError> {
        {
            let mut state = self.shared.state.lock().unwrap();
            match *state {
                SessionState::New => *state = SessionState::Connecting,
                SessionState::Ready => return Ok(()),
                _ => {
                    return Err(CuaDriverError::new(
                        "invalid_session_state",
                        "The cua-driver session cannot be connected again.",
                    ))
                }
            }
        }
        if signal.is_some_and(|token| token.is_cancelled()) {
            self.break_connection().await;
            return Err(CuaDriverError::cancelled(
                "Computer Use startup was cancelled.",
            ));
        }

        let remaining = |deadline: Option<Instant>| -> u64 {
            match deadline {
                Some(deadline) => deadline
                    .saturating_duration_since(Instant::now())
                    .as_millis()
                    .max(1) as u64,
                None => CONNECT_TIMEOUT_MS,
            }
        };

        // Bootstrap: reader + initialize + initialized notification. These use
        // the client directly (not the queue) because no tool call can be in
        // flight before the session is ready.
        let bootstrap = async {
            self.client.start_reader()?;
            self.client
                .request_raw(
                    "initialize",
                    Some(serde_json::json!({
                        "protocolVersion": "2024-11-05",
                        "capabilities": {},
                        "clientInfo": { "name": "aiden-agent-computer-use", "version": "1.0.0" },
                    })),
                )
                .await
                .map_err(|error| self.map_bootstrap_error(error))?;
            let notification = JsonRpcMessage::Notification {
                method: "notifications/initialized".into(),
                params: Some(serde_json::json!({})),
            }
            .to_line()
            .map_err(|_| {
                CuaDriverError::new(
                    "connection_failed",
                    "Aiden could not connect to cua-driver.",
                )
            })?;
            self.client.send_line(&notification).await.map_err(|error| {
                CuaDriverError::retryable(
                    "transport_closed",
                    format!(
                        "The cua-driver connection closed unexpectedly: {}",
                        error.message
                    ),
                )
            })
        }
        .await;
        if let Err(error) = bootstrap {
            self.break_connection().await;
            let detail = self.diagnostic_detail();
            return Err(if detail.is_empty() {
                error
            } else {
                CuaDriverError {
                    code: error.code,
                    message: format!("{}: {}", error.message, detail),
                    retryable: error.retryable,
                }
            });
        }

        let listing = self
            .request_with_timeout(
                "tools/list",
                Some(serde_json::json!({})),
                remaining(deadline),
                signal,
            )
            .await
            .map_err(|error| {
                if matches!(
                    error.code,
                    "timeout" | "transport_closed" | "cancelled" | "request_too_large"
                ) {
                    error
                } else {
                    CuaDriverError::new(
                        "incompatible_driver",
                        "cua-driver returned an incompatible tool catalog.",
                    )
                }
            })?;
        let catalog = parse_cua_driver_tools(&listing).map_err(|error| {
            if error.code == "incompatible_driver" || error.code == "invalid_tools" {
                error
            } else {
                CuaDriverError::new(
                    "incompatible_driver",
                    "cua-driver returned an incompatible tool catalog.",
                )
            }
        })?;
        *self.tools.lock().unwrap() = catalog.tools;
        *self.tool_schema_version.lock().unwrap() = Some(catalog.schema_version);
        *self.tool_capability_version.lock().unwrap() = Some(catalog.capability_version);

        let start_result = self
            .request_with_timeout(
                "tools/call",
                Some(serde_json::json!({
                    "name": "start_session",
                    "arguments": { "session": self.id },
                })),
                remaining(deadline),
                signal,
            )
            .await
            .map_err(|error| {
                if error.code == "timeout" {
                    startup_timeout_error()
                } else {
                    error
                }
            })?;
        if start_result
            .get("isError")
            .and_then(Value::as_bool)
            .unwrap_or(false)
        {
            self.break_connection().await;
            return Err(CuaDriverError::new(
                "session_start_failed",
                "cua-driver rejected Aiden's Computer Use session.",
            ));
        }
        if self.state() != SessionState::Connecting {
            self.break_connection().await;
            return Err(CuaDriverError::new(
                "session_closed",
                "The Computer Use session closed during startup.",
            ));
        }
        self.set_state(SessionState::Ready);
        Ok(())
    }

    fn map_bootstrap_error(&self, error: RpcError) -> CuaDriverError {
        if is_request_timeout(&error) {
            startup_timeout_error()
        } else if is_transport_closed(&error) {
            CuaDriverError::retryable(
                "transport_closed",
                "The cua-driver connection closed unexpectedly.",
            )
        } else {
            CuaDriverError::new(
                "connection_failed",
                format!("Aiden could not connect to cua-driver: {}", error.message),
            )
        }
    }

    /// Serialize a tool call through the request queue and return the raw
    /// `CallToolResult` value.
    pub async fn call_tool(
        &self,
        name: &str,
        args: Value,
        options: &CuaDriverCallOptions,
    ) -> Result<Value, CuaDriverError> {
        if options
            .signal
            .as_ref()
            .is_some_and(|token| token.is_cancelled())
        {
            self.break_connection().await;
            return Err(CuaDriverError::cancelled("Computer Use was cancelled."));
        }
        let _queue_guard = self.queue.lock().await;
        if options
            .signal
            .as_ref()
            .is_some_and(|token| token.is_cancelled())
        {
            self.break_connection().await;
            return Err(CuaDriverError::cancelled("Computer Use was cancelled."));
        }
        if self.state() != SessionState::Ready {
            return Err(CuaDriverError::retryable(
                "session_unavailable",
                "The Computer Use session is not ready.",
            ));
        }
        let args_object = args.as_object().cloned().ok_or_else(|| {
            CuaDriverError::new("invalid_arguments", "Tool arguments must be an object.")
        })?;
        let tool = {
            let tools = self.tools.lock().unwrap();
            tools.get(name).cloned().ok_or_else(|| {
                CuaDriverError::new(
                    "unsupported_tool",
                    format!("The pinned cua-driver does not expose {name}."),
                )
            })?
        };
        if name == "start_session" || name == "end_session" {
            return Err(CuaDriverError::new(
                "reserved_tool",
                format!("{name} is owned by Aiden's session lifecycle."),
            ));
        }
        if args_object.keys().any(|key| key.starts_with("_aiden_")) {
            return Err(CuaDriverError::new(
                "reserved_argument",
                "Private Computer Use authentication arguments are owned by Aiden's broker.",
            ));
        }
        let declares_session = cua_driver_tool_declares_session(&tool)?;
        if !declares_session && args_object.contains_key("session") {
            return Err(CuaDriverError::new(
                "unsupported_argument",
                format!("{name} does not accept a Computer Use session argument."),
            ));
        }
        let mut arguments = args_object;
        if declares_session {
            arguments.insert("session".into(), Value::String(self.id.clone()));
        }
        let timeout_ms = options.timeout_ms.unwrap_or(CALL_TIMEOUT_MS);
        self.request_with_timeout(
            "tools/call",
            Some(serde_json::json!({ "name": name, "arguments": arguments })),
            timeout_ms,
            options.signal.as_ref(),
        )
        .await
    }

    async fn break_connection(&self) {
        if matches!(self.state(), SessionState::Closed | SessionState::Broken) {
            return;
        }
        self.set_state(SessionState::Broken);
        self.notify_closed();
        self.client.close().await;
    }

    /// Hook used by the host when the broker launcher exits. Retained for
    /// parity with `CuaDriverSession.invalidate()` in session.ts; the host
    /// currently relies on transport EOF to reach the same state.
    #[allow(dead_code)]
    fn invalidate(&self) {
        if matches!(self.state(), SessionState::Closed | SessionState::Broken) {
            return;
        }
        self.set_state(SessionState::Broken);
        self.notify_closed();
        let client = Arc::clone(&self.client);
        tokio::spawn(async move {
            client.close().await;
        });
    }

    pub async fn close(&self) {
        let mut guard = self.close_promise.lock().await;
        if guard.is_none() {
            let shared = Arc::clone(&self.shared);
            let client = Arc::clone(&self.client);
            let queue = Arc::clone(&self.queue);
            let id = self.id.clone();
            *guard = Some(tokio::spawn(async move {
                close_internal(shared, client, queue, id).await;
            }));
        }
        if let Some(handle) = guard.take() {
            let _ = handle.await;
        }
    }
}

async fn close_internal(
    shared: Arc<SessionShared>,
    client: Arc<McpClient>,
    queue: Arc<Mutex<()>>,
    id: String,
) {
    let was_ready = {
        let mut state = shared.state.lock().unwrap();
        if *state == SessionState::Closed {
            return;
        }
        let was_ready = *state == SessionState::Ready;
        *state = SessionState::Closed;
        was_ready
    };
    let queue_settled = timeout(Duration::from_millis(CLOSE_GRACE_MS), queue.lock())
        .await
        .is_ok();
    if was_ready && queue_settled {
        // The queue is idle (no queued call holds the client), so this
        // cannot deadlock. Process teardown below is the hard boundary.
        let _ = timeout(
            Duration::from_millis(CLOSE_GRACE_MS),
            client.request_raw(
                "tools/call",
                Some(serde_json::json!({
                    "name": "end_session",
                    "arguments": { "session": id },
                })),
            ),
        )
        .await;
    }
    client.close().await;
    shared.notify_closed();
}
