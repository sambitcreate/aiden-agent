//! MCP OAuth (port of `main/services/mcp-oauth-session.ts`,
//! `mcp-oauth-operation.ts`, and the store-facing state machine of
//! `mcp-oauth.ts`).
//!
//! Scope delivered:
//!
//! - `McpOAuthSession` persisted shape + tolerant parser/validators
//!   (`mcp-oauth-session.ts`) and the `McpOAuthSessionTransaction` buffer.
//! - `McpOAuthOperationGate` (`mcp-oauth-operation.ts`) — generations,
//!   interactive exclusivity, invalidation, suspension, mutation fencing.
//! - PKCE S256 generation (`PkcePair`) matching the public-client policy:
//!   never retain a dynamic client secret.
//! - RFC 8252 loopback redirect listener on the fixed port 41390 with the
//!   Aiden callback HTML (`start_loopback_server`).
//! - `McpOAuthStore` trait plus the production implementation backed by
//!   [`aiden_data::mcp_oauth::EncryptedMcpOAuthStore`].
//! - `McpOAuthProvider` — the `OAuthClientProvider` contract rmcp's
//!   transports consume, backed by the store + gate.
//! - `authorize_mcp_server` — the interactive flow driver with the same
//!   transactional commit/rollback semantics as TS. The network I/O
//!   (authorization-server discovery, dynamic client registration, token
//!   exchange/refresh) is behind the `McpOAuthHttp` trait so tests never touch
//!   the network; `ReqwestMcpOAuthHttp` is the production implementation.
//!
//! Browser opening remains injected (`open_browser`) so background runtime
//! resolution can never trigger consent UI.

use std::collections::HashMap;
use std::net::{Ipv4Addr, SocketAddr};
use std::sync::Mutex;

use futures::{future::BoxFuture, StreamExt as _};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;
use tokio::sync::watch;

#[cfg(test)]
use crate::config::resolve_mcp_server;
use crate::error::McpError;
use crate::util::{base64url_encode, random_bytes};
use crate::McpTransport;

/// Fixed loopback redirect so the registered redirect_uri stays stable across
/// sessions (dynamic client registration records it once).
pub const OAUTH_PORT: u16 = 41390;
pub const OAUTH_REDIRECT_URI: &str = "http://127.0.0.1:41390/callback";
/// 5-minute authorization timeout (TS `AUTH_TIMEOUT_MS`).
pub const AUTH_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(5 * 60);
const OAUTH_REQUEST_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(15);
const OAUTH_CONNECT_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(5);
const MAX_OAUTH_RESPONSE_BYTES: usize = 256 * 1024;
const MAX_OAUTH_URL_LEN: usize = 4_096;
const MAX_OAUTH_METADATA_ITEMS: usize = 64;
const MAX_OAUTH_METADATA_VALUE_LEN: usize = 4_096;
const MAX_OAUTH_SCOPE_LEN: usize = 256;
const MAX_OAUTH_SECRET_LEN: usize = 128 * 1024;
const TOKEN_EXPIRY_SKEW_SECONDS: u64 = 60;
const TOKEN_OBTAINED_AT_KEY: &str = "_aiden_obtained_at_ms";
const SESSION_VERIFIED_KEY: &str = "_aiden_connection_verified";

const CALLBACK_HTML: &str = "<!doctype html><html><head><meta charset=\"utf-8\"><title>Aiden Agent</title>\
<style>body{font-family:-apple-system,system-ui,sans-serif;background:#1c1c1e;color:#fff;display:flex;\
align-items:center;justify-content:center;height:100vh;margin:0}div{text-align:center}\
h1{font-size:17px;font-weight:600;margin:0 0 6px}p{font-size:13px;color:#98989d;margin:0}</style></head>\
<body><div><h1>Connected</h1><p>You can return to Aiden Agent and close this tab.</p></div></body></html>";

// ===========================================================================
// Session shape (mcp-oauth-session.ts)
// ===========================================================================

/// Dynamic client registration information (public fields only).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct McpOAuthClientInformation {
    pub client_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub client_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub redirect_uris: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub token_endpoint_auth_method: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub grant_types: Option<Vec<String>>,
    #[serde(flatten)]
    pub extra: serde_json::Map<String, serde_json::Value>,
}

/// OAuth 2.0 token response (RFC 6749 §5.1 subset used by MCP).
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct McpOAuthTokens {
    pub access_token: String,
    pub token_type: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub refresh_token: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub scope: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub expires_in: Option<u64>,
    #[serde(flatten)]
    pub extra: serde_json::Map<String, serde_json::Value>,
}

/// Encrypted-store payload for one server (TS `McpOAuthSession`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpOAuthSession {
    /// Normalized protected-resource URL this registration and tokens belong
    /// to.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub authorization_binding: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub client_information: Option<McpOAuthClientInformation>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tokens: Option<McpOAuthTokens>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub code_verifier: Option<String>,
    /// Compatible future fields survive round-trips untouched.
    #[serde(flatten)]
    pub extra: serde_json::Map<String, serde_json::Value>,
}

impl Default for McpOAuthSession {
    fn default() -> Self {
        Self {
            authorization_binding: None,
            client_information: None,
            tokens: None,
            code_verifier: None,
            extra: serde_json::Map::new(),
        }
    }
}

impl McpOAuthSession {
    pub fn bound(binding: impl Into<String>) -> Self {
        Self {
            authorization_binding: Some(binding.into()),
            ..Self::default()
        }
    }
}

/// Validate a decrypted session structure while retaining compatible future
/// fields (TS `parseMcpOAuthSession`). Field types are checked strictly —
/// explicit `null` or a wrong-typed value for a known key is malformed, never
/// silently dropped into `extra`.
pub fn parse_mcp_oauth_session(value: serde_json::Value) -> Result<McpOAuthSession, McpError> {
    let serde_json::Value::Object(record) = value else {
        return Err(McpError::OAuthSessionMalformed(
            "MCP OAuth session must be a JSON object.".into(),
        ));
    };
    let malformed = |detail: &str| McpError::OAuthSessionMalformed(detail.to_string());
    let mut session = McpOAuthSession::default();

    if let Some(binding) = record.get("authorizationBinding") {
        let Some(text) = binding.as_str() else {
            return Err(malformed("MCP OAuth authorization binding is malformed."));
        };
        if text.is_empty() {
            return Err(malformed("MCP OAuth authorization binding is malformed."));
        }
        session.authorization_binding = Some(text.to_string());
    }
    if let Some(information) = record.get("clientInformation") {
        if !information.is_object() {
            return Err(malformed("MCP OAuth client information is malformed."));
        }
        let information: McpOAuthClientInformation = serde_json::from_value(information.clone())
            .map_err(|err| {
                malformed(&format!("MCP OAuth client information is malformed: {err}"))
            })?;
        if !valid_client_information(&information) {
            return Err(malformed("MCP OAuth client information is malformed."));
        }
        if let Some(uris) = &information.redirect_uris {
            if uris.is_empty() || uris.iter().any(|uri| uri.is_empty()) {
                return Err(malformed("MCP OAuth client information is malformed."));
            }
        }
        session.client_information = Some(information);
    }
    if let Some(tokens) = record.get("tokens") {
        if !tokens.is_object() {
            return Err(malformed("MCP OAuth tokens are malformed."));
        }
        let tokens: McpOAuthTokens = serde_json::from_value(tokens.clone())
            .map_err(|err| malformed(&format!("MCP OAuth tokens are malformed: {err}")))?;
        if !valid_tokens(&tokens) {
            return Err(malformed("MCP OAuth tokens are malformed."));
        }
        session.tokens = Some(tokens);
    }
    if let Some(verifier) = record.get("codeVerifier") {
        let Some(text) = verifier.as_str() else {
            return Err(malformed("MCP OAuth PKCE verifier is malformed."));
        };
        session.code_verifier = Some(text.to_string());
    }

    for (key, value) in record {
        if matches!(
            key.as_str(),
            "authorizationBinding" | "clientInformation" | "tokens" | "codeVerifier"
        ) {
            continue;
        }
        session.extra.insert(key, value);
    }
    Ok(session)
}

/// Normalize a protected-resource URL into its authorization binding: strip
/// the fragment, collapse trailing slashes on the path (TS
/// `mcpAuthorizationBinding`).
pub fn mcp_authorization_binding(url: &str) -> String {
    // Strip the fragment (RFC 8252 §7.3: the binding never carries one).
    let binding = url.split('#').next().unwrap_or(url).to_string();
    if let Some((base, query)) = binding.split_once('?') {
        let base = base.trim_end_matches('/');
        let base = if base.is_empty() { "/" } else { base };
        format!("{base}?{query}")
    } else {
        let base = binding.trim_end_matches('/');
        if base.is_empty() {
            "/".to_string()
        } else {
            base.to_string()
        }
    }
}

/// `sessionMatchesMcpBinding` — a session is only usable for the exact
/// normalized resource it was authorized against.
pub fn session_matches_mcp_binding(session: &McpOAuthSession, binding: &str) -> bool {
    session.authorization_binding.as_deref() == Some(binding)
}

/// Native PKCE clients are public clients; never retain a DCR client secret.
pub fn public_mcp_client_information(
    information: &McpOAuthClientInformation,
) -> McpOAuthClientInformation {
    let mut public = information.clone();
    public.extra.remove("client_secret");
    public.extra.remove("client_secret_expires_at");
    public
}

fn valid_client_information(information: &McpOAuthClientInformation) -> bool {
    let bounded_values = information
        .redirect_uris
        .iter()
        .flatten()
        .chain(information.grant_types.iter().flatten())
        .all(|value| !value.is_empty() && value.len() <= MAX_OAUTH_METADATA_VALUE_LEN);
    !information.client_id.is_empty()
        && information.client_id.len() <= MAX_OAUTH_METADATA_VALUE_LEN
        && information
            .client_name
            .as_ref()
            .is_none_or(|value| value.len() <= MAX_OAUTH_METADATA_VALUE_LEN)
        && information
            .token_endpoint_auth_method
            .as_ref()
            .is_none_or(|value| !value.is_empty() && value.len() <= 128)
        && information
            .redirect_uris
            .as_ref()
            .is_none_or(|values| !values.is_empty() && values.len() <= MAX_OAUTH_METADATA_ITEMS)
        && information
            .grant_types
            .as_ref()
            .is_none_or(|values| !values.is_empty() && values.len() <= MAX_OAUTH_METADATA_ITEMS)
        && bounded_values
}

fn valid_tokens(tokens: &McpOAuthTokens) -> bool {
    !tokens.access_token.is_empty()
        && tokens.access_token.len() <= MAX_OAUTH_SECRET_LEN
        && !tokens.token_type.is_empty()
        && tokens.token_type.len() <= 64
        && tokens
            .refresh_token
            .as_ref()
            .is_none_or(|value| !value.is_empty() && value.len() <= MAX_OAUTH_SECRET_LEN)
        && tokens
            .scope
            .as_ref()
            .is_none_or(|value| value.len() <= MAX_OAUTH_METADATA_VALUE_LEN)
}

/// Start an explicit Settings re-authorization without discarding the dynamic
/// client registration (TS `sessionForFreshMcpAuthorization`).
pub fn session_for_fresh_mcp_authorization(
    session: &McpOAuthSession,
    binding: &str,
) -> McpOAuthSession {
    if session_matches_mcp_binding(session, binding) {
        if let Some(information) = &session.client_information {
            return McpOAuthSession {
                authorization_binding: Some(binding.to_string()),
                client_information: Some(public_mcp_client_information(information)),
                tokens: None,
                code_verifier: None,
                extra: serde_json::Map::new(),
            };
        }
    }
    McpOAuthSession::bound(binding)
}

pub fn has_mcp_oauth_session_data(session: &McpOAuthSession) -> bool {
    session.authorization_binding.is_some()
        || session.client_information.is_some()
        || session.tokens.is_some()
        || session.code_verifier.is_some()
}

/// Keep an interactive replacement session private until verification
/// succeeds (TS `McpOAuthSessionTransaction`).
#[derive(Debug, Clone)]
pub struct McpOAuthSessionTransaction {
    session: McpOAuthSession,
}

impl McpOAuthSessionTransaction {
    pub fn new(initial: McpOAuthSession) -> Self {
        Self { session: initial }
    }

    pub fn read(&self) -> McpOAuthSession {
        self.session.clone()
    }

    pub fn replace(&mut self, session: McpOAuthSession) {
        self.session = session;
    }
}

// ===========================================================================
// Operation gate (mcp-oauth-operation.ts)
// ===========================================================================

/// `McpOAuthGeneration` — a snapshot that identifies a point in the server's
/// OAuth lifetime.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct McpOAuthGeneration {
    pub server_id: String,
    pub generation: u64,
}

/// `McpOAuthOperation` — a generation plus a live cancellation signal.
#[derive(Debug, Clone)]
pub struct McpOAuthOperation {
    pub server_id: String,
    pub generation: u64,
    pub signal: watch::Receiver<bool>,
}

impl McpOAuthOperation {
    pub fn aborted(&self) -> bool {
        *self.signal.borrow()
    }

    pub fn generation(&self) -> McpOAuthGeneration {
        McpOAuthGeneration {
            server_id: self.server_id.clone(),
            generation: self.generation,
        }
    }
}

/// `AbortSignal`-equivalent: a watch channel where `true` means cancelled.
#[derive(Debug, Clone, Default)]
pub struct AbortToken {
    tx: watch::Sender<bool>,
}

impl AbortToken {
    pub fn new() -> Self {
        let (tx, _) = watch::channel(false);
        Self { tx }
    }

    pub fn is_aborted(&self) -> bool {
        *self.tx.borrow()
    }

    pub fn abort(&self) {
        let _ = self.tx.send(true);
    }

    pub fn subscribe(&self) -> watch::Receiver<bool> {
        self.tx.subscribe()
    }
}

#[derive(Debug)]
struct ActiveOperation {
    generation: u64,
    token: AbortToken,
}

/// Owns OAuth generations so cleanup can permanently supersede stale writers
/// (TS `McpOAuthOperationGate`).
#[derive(Debug, Default)]
struct McpOAuthGateState {
    interactive: HashMap<String, ActiveOperation>,
    generations: HashMap<String, u64>,
    suspended: HashMap<String, u64>,
}

#[derive(Debug, Default)]
pub struct McpOAuthOperationGate {
    state: Mutex<McpOAuthGateState>,
}

impl McpOAuthOperationGate {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn snapshot(&self, server_id: &str) -> McpOAuthGeneration {
        let state = self.state.lock().unwrap();
        McpOAuthGeneration {
            server_id: server_id.to_string(),
            generation: state.generations.get(server_id).copied().unwrap_or(0),
        }
    }

    pub fn begin(&self, server_id: &str) -> Result<McpOAuthOperation, McpError> {
        let mut state = self.state.lock().unwrap();
        if state.suspended.get(server_id).copied().unwrap_or(0) > 0 {
            return Err(McpError::OAuthUpdating);
        }
        if state.interactive.contains_key(server_id) {
            return Err(McpError::OAuthInProgress);
        }
        let generation = state.generations.get(server_id).copied().unwrap_or(0) + 1;
        let token = AbortToken::new();
        state.generations.insert(server_id.to_string(), generation);
        state.interactive.insert(
            server_id.to_string(),
            ActiveOperation {
                generation,
                token: token.clone(),
            },
        );
        Ok(McpOAuthOperation {
            server_id: server_id.to_string(),
            generation,
            signal: token.subscribe(),
        })
    }

    /// Invalidate the active generation and abort its signal (TS
    /// `invalidate`).
    pub fn invalidate(&self, server_id: &str) {
        let mut state = self.state.lock().unwrap();
        if let Some(active) = state.interactive.remove(server_id) {
            active.token.abort();
        }
        let next = state.generations.get(server_id).copied().unwrap_or(0) + 1;
        state.generations.insert(server_id.to_string(), next);
    }

    /// Suspend the server: invalidates the current generation and blocks new
    /// operations until the returned guard is released (TS `suspend`).
    pub fn suspend(&self, server_id: &str) -> SuspendGuard<'_> {
        let mut state = self.state.lock().unwrap();
        if let Some(active) = state.interactive.remove(server_id) {
            active.token.abort();
        }
        let next = state.generations.get(server_id).copied().unwrap_or(0) + 1;
        state.generations.insert(server_id.to_string(), next);
        *state.suspended.entry(server_id.to_string()).or_insert(0) += 1;
        SuspendGuard {
            gate: self,
            server_id: server_id.to_string(),
            active: true,
        }
    }

    pub fn end(&self, operation: &McpOAuthOperation) {
        let mut state = self.state.lock().unwrap();
        if let Some(active) = state.interactive.get(&operation.server_id) {
            if active.generation == operation.generation {
                state.interactive.remove(&operation.server_id);
            }
        }
    }

    pub fn is_current(&self, generation: &McpOAuthGeneration) -> bool {
        let state = self.state.lock().unwrap();
        // Background semantics (TS `isCurrent` for a plain generation): current
        // only while no interactive flow owns the server.
        if state
            .suspended
            .get(&generation.server_id)
            .copied()
            .unwrap_or(0)
            > 0
        {
            return false;
        }
        if state
            .generations
            .get(&generation.server_id)
            .copied()
            .unwrap_or(0)
            != generation.generation
        {
            return false;
        }
        !state.interactive.contains_key(&generation.server_id)
    }

    pub fn is_current_operation(&self, operation: &McpOAuthOperation) -> bool {
        let state = self.state.lock().unwrap();
        // Interactive semantics (TS `isCurrent` for an operation with a
        // signal): current only while it is the live, un-aborted owner.
        if state
            .suspended
            .get(&operation.server_id)
            .copied()
            .unwrap_or(0)
            > 0
        {
            return false;
        }
        if state
            .generations
            .get(&operation.server_id)
            .copied()
            .unwrap_or(0)
            != operation.generation
        {
            return false;
        }
        if operation.aborted() {
            return false;
        }
        matches!(
            state.interactive.get(&operation.server_id),
            Some(active) if active.generation == operation.generation
        )
    }

    /// Background (non-interactive) snapshots may only mutate while no
    /// interactive flow owns the server (TS `canMutate` for a plain
    /// generation). Interactive operations use [`Self::is_current_operation`]
    /// instead, which the provider enforces via its `operation` field.
    pub fn can_mutate(&self, server_id: &str, generation: &McpOAuthGeneration) -> bool {
        if generation.server_id != server_id {
            return false;
        }
        let state = self.state.lock().unwrap();
        if state.suspended.get(server_id).copied().unwrap_or(0) > 0 {
            return false;
        }
        if state.generations.get(server_id).copied().unwrap_or(0) != generation.generation {
            return false;
        }
        !state.interactive.contains_key(server_id)
    }

    pub fn assert_mutation_allowed(
        &self,
        server_id: &str,
        generation: &McpOAuthGeneration,
    ) -> Result<(), McpError> {
        if !self.can_mutate(server_id, generation) {
            return Err(McpError::OAuthStale);
        }
        Ok(())
    }
}

struct OAuthOperationEndGuard<'a> {
    gate: &'a McpOAuthOperationGate,
    operation: McpOAuthOperation,
}

impl Drop for OAuthOperationEndGuard<'_> {
    fn drop(&mut self) {
        self.gate.end(&self.operation);
    }
}

/// Releases a suspension exactly once (TS closure from `suspend`).
pub struct SuspendGuard<'a> {
    gate: &'a McpOAuthOperationGate,
    server_id: String,
    active: bool,
}

impl Drop for SuspendGuard<'_> {
    fn drop(&mut self) {
        if !self.active {
            return;
        }
        self.active = false;
        let mut state = self.gate.state.lock().unwrap();
        if let Some(active) = state.interactive.remove(&self.server_id) {
            active.token.abort();
        }
        let next = state.generations.get(&self.server_id).copied().unwrap_or(0) + 1;
        state.generations.insert(self.server_id.clone(), next);
        let remaining = state.suspended.get(&self.server_id).copied().unwrap_or(1) - 1;
        if remaining > 0 {
            state.suspended.insert(self.server_id.clone(), remaining);
        } else {
            state.suspended.remove(&self.server_id);
        }
    }
}

// ===========================================================================
// PKCE (RFC 7636, S256)
// ===========================================================================

/// A freshly generated PKCE verifier + S256 challenge pair.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PkcePair {
    pub verifier: String,
    pub challenge: String,
}

impl PkcePair {
    /// 32 random bytes → 43-char base64url verifier; challenge is
    /// base64url(sha256(verifier)), both unpadded.
    pub fn new() -> Result<Self, McpError> {
        let random = random_bytes(32)?;
        let verifier = base64url_encode(&random);
        let challenge = pkce_s256_challenge(&verifier);
        Ok(Self {
            verifier,
            challenge,
        })
    }
}

impl Default for PkcePair {
    fn default() -> Self {
        // Deterministic test helper; never used in production paths.
        let verifier = base64url_encode(&[0u8; 32]);
        let challenge = pkce_s256_challenge(&verifier);
        Self {
            verifier,
            challenge,
        }
    }
}

pub fn pkce_s256_challenge(verifier: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(verifier.as_bytes());
    base64url_encode(&hasher.finalize())
}

// ===========================================================================
// Loopback redirect (RFC 8252)
// ===========================================================================

/// One-shot loopback HTTP listener that captures the authorization code from
/// `GET /callback?code=...` and renders the Aiden "Connected" page. The
/// listener lives in a spawned task that finishes after the first callback.
pub struct LoopbackServer {
    result: watch::Receiver<Option<Result<OAuthCallback, McpError>>>,
    port: u16,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct OAuthCallback {
    code: String,
    state: Option<String>,
}

impl LoopbackServer {
    /// Bind on `127.0.0.1:<port>` (fixed `OAUTH_PORT` in production; tests may
    /// pass 0 to pick a free port and read it from [`LoopbackServer::port`]).
    pub async fn bind(port: u16) -> Result<Self, McpError> {
        let address = SocketAddr::new(Ipv4Addr::LOCALHOST.into(), port);
        let listener = TcpListener::bind(address).await.map_err(|err| {
            if err.kind() == std::io::ErrorKind::AddrInUse {
                McpError::OAuthPortBusy(port)
            } else {
                McpError::Transport(format!("failed to bind the OAuth loopback: {err}"))
            }
        })?;
        let local = listener
            .local_addr()
            .map_err(|err| McpError::Transport(err.to_string()))?;
        let bound_port = local.port();
        let (result_tx, result_rx) = watch::channel(None);
        tokio::spawn(async move {
            let (mut stream, _peer) = match listener.accept().await {
                Ok(accepted) => accepted,
                Err(_) => return,
            };
            let mut buffer = [0u8; 4096];
            let read = stream.read(&mut buffer).await.unwrap_or(0);
            let request = String::from_utf8_lossy(&buffer[..read]).into_owned();
            let outcome = handle_callback_request(&request);
            let (status, body) = match &outcome {
                Ok(_) => ("200 OK", CALLBACK_HTML),
                Err(McpError::OAuthDenied(_)) | Err(McpError::OAuthNoCode) => {
                    ("400 Bad Request", "")
                }
                Err(_) => ("404 Not Found", ""),
            };
            let response = format!(
                "HTTP/1.1 {status}\r\ncontent-type: text/html; charset=utf-8\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}",
                body.len()
            );
            let _ = stream.write_all(response.as_bytes()).await;
            let _ = stream.flush().await;
            let _ = result_tx.send(Some(outcome));
        });
        Ok(Self {
            result: result_rx,
            port: bound_port,
        })
    }

    pub fn port(&self) -> u16 {
        self.port
    }

    /// Wait for the browser's callback with the caller's abort token and a
    /// timeout (defaults to `AUTH_TIMEOUT`).
    pub async fn wait_for_code(
        &self,
        abort: Option<&watch::Receiver<bool>>,
        timeout: Option<std::time::Duration>,
    ) -> Result<String, McpError> {
        let timeout = timeout.unwrap_or(AUTH_TIMEOUT);
        let mut result = self.result.clone();
        let abort = abort.cloned();
        tokio::select! {
            _ = result.changed() => match result.borrow().clone() {
                Some(outcome) => outcome.map(|callback| callback.code),
                None => Err(McpError::OAuthTimeout),
            },
            _ = wait_for_abort(abort.as_ref()) => Err(cancellation_error()),
            _ = tokio::time::sleep(timeout) => Err(McpError::OAuthTimeout),
        }
    }

    async fn wait_for_code_with_state(
        &self,
        expected_state: &str,
        abort: Option<&watch::Receiver<bool>>,
        timeout: Option<std::time::Duration>,
    ) -> Result<String, McpError> {
        let timeout = timeout.unwrap_or(AUTH_TIMEOUT);
        let mut result = self.result.clone();
        let abort = abort.cloned();
        let callback = tokio::select! {
            _ = result.changed() => match result.borrow().clone() {
                Some(outcome) => outcome,
                None => Err(McpError::OAuthTimeout),
            },
            _ = wait_for_abort(abort.as_ref()) => Err(cancellation_error()),
            _ = tokio::time::sleep(timeout) => Err(McpError::OAuthTimeout),
        }?;
        if callback.state.as_deref() != Some(expected_state) {
            return Err(McpError::OAuthRequest(
                "authorization callback state did not match".into(),
            ));
        }
        Ok(callback.code)
    }
}

impl std::fmt::Debug for LoopbackServer {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("LoopbackServer")
            .field("port", &self.port)
            .finish_non_exhaustive()
    }
}

/// Parse `GET /callback?...` and extract `code` / `error`.
fn handle_callback_request(request: &str) -> Result<OAuthCallback, McpError> {
    let first_line = request.lines().next().unwrap_or("");
    let target = first_line.split_whitespace().nth(1).unwrap_or("/");
    if !target.starts_with("/callback") {
        return Err(McpError::OAuthSessionMalformed(
            "unexpected callback path".into(),
        ));
    }
    let callback_url = reqwest::Url::parse(&format!("http://127.0.0.1{target}"))
        .map_err(|_| McpError::OAuthSessionMalformed("invalid callback URL".into()))?;
    let params: HashMap<String, String> = callback_url.query_pairs().into_owned().collect();
    if let Some(error) = params.get("error") {
        let safe_error = error
            .chars()
            .take(64)
            .filter(|character| character.is_ascii_alphanumeric() || *character == '_')
            .collect::<String>();
        return Err(McpError::OAuthDenied(if safe_error.is_empty() {
            "authorization_denied".into()
        } else {
            safe_error
        }));
    }
    match params.get("code") {
        Some(code) if !code.is_empty() && code.len() <= 4096 => Ok(OAuthCallback {
            code: code.to_string(),
            state: params.get("state").cloned(),
        }),
        _ => Err(McpError::OAuthNoCode),
    }
}

fn cancellation_error() -> McpError {
    McpError::OAuthSuperseded
}

async fn wait_for_abort(abort: Option<&watch::Receiver<bool>>) {
    match abort {
        Some(receiver) => {
            let mut receiver = receiver.clone();
            if *receiver.borrow() {
                return;
            }
            let _ = receiver.changed().await;
        }
        None => std::future::pending::<()>().await,
    }
}

// ===========================================================================
// Store trait
// ===========================================================================

/// The encrypted `<userData>/mcp-oauth.json` store surface the OAuth state
/// machine persists through. The disk-backed implementation is a later
/// aiden-data phase; `MemoryMcpOAuthStore` is provided for tests.
pub trait McpOAuthStore: Send + Sync {
    fn get(&self, server_id: &str) -> Result<McpOAuthSession, McpError>;
    fn set(&self, server_id: &str, session: &McpOAuthSession) -> Result<(), McpError>;
    fn clear(&self, server_id: &str) -> Result<(), McpError>;

    fn get_owned(
        &self,
        server_id: &str,
        is_current: &(dyn Fn() -> bool + Send + Sync),
    ) -> Result<McpOAuthSession, McpError> {
        if !is_current() {
            return Err(McpError::OAuthSuperseded);
        }
        let session = self.get(server_id)?;
        if !is_current() {
            return Err(McpError::OAuthSuperseded);
        }
        Ok(session)
    }

    fn set_owned(
        &self,
        server_id: &str,
        session: &McpOAuthSession,
        is_current: &(dyn Fn() -> bool + Send + Sync),
    ) -> Result<(), McpError> {
        if !is_current() {
            return Err(McpError::OAuthSuperseded);
        }
        self.set(server_id, session)
    }

    fn clear_owned(
        &self,
        server_id: &str,
        is_current: &(dyn Fn() -> bool + Send + Sync),
    ) -> Result<(), McpError> {
        if !is_current() {
            return Err(McpError::OAuthSuperseded);
        }
        self.clear(server_id)
    }
}

impl McpOAuthStore for aiden_data::mcp_oauth::EncryptedMcpOAuthStore {
    fn get(&self, server_id: &str) -> Result<McpOAuthSession, McpError> {
        self.get(server_id, None, &|| true)
            .map_err(|error| McpError::OAuthStore(error.to_string()))?
            .map(parse_mcp_oauth_session)
            .transpose()
            .map(Option::unwrap_or_default)
    }

    fn set(&self, server_id: &str, session: &McpOAuthSession) -> Result<(), McpError> {
        let binding = session.authorization_binding.as_deref().ok_or_else(|| {
            McpError::OAuthSessionMalformed("missing authorization binding".into())
        })?;
        let value = serde_json::to_value(session)
            .map_err(|error| McpError::OAuthStore(error.to_string()))?;
        self.set(server_id, binding, &value, &|| true)
            .map_err(|error| McpError::OAuthStore(error.to_string()))
    }

    fn clear(&self, server_id: &str) -> Result<(), McpError> {
        self.clear(server_id, &|| true)
            .map_err(|error| McpError::OAuthStore(error.to_string()))
    }

    fn get_owned(
        &self,
        server_id: &str,
        is_current: &(dyn Fn() -> bool + Send + Sync),
    ) -> Result<McpOAuthSession, McpError> {
        self.get(server_id, None, is_current)
            .map_err(|error| McpError::OAuthStore(error.to_string()))?
            .map(parse_mcp_oauth_session)
            .transpose()
            .map(Option::unwrap_or_default)
    }

    fn set_owned(
        &self,
        server_id: &str,
        session: &McpOAuthSession,
        is_current: &(dyn Fn() -> bool + Send + Sync),
    ) -> Result<(), McpError> {
        let binding = session.authorization_binding.as_deref().ok_or_else(|| {
            McpError::OAuthSessionMalformed("missing authorization binding".into())
        })?;
        let value = serde_json::to_value(session)
            .map_err(|error| McpError::OAuthStore(error.to_string()))?;
        self.set(server_id, binding, &value, is_current)
            .map_err(|error| McpError::OAuthStore(error.to_string()))
    }

    fn clear_owned(
        &self,
        server_id: &str,
        is_current: &(dyn Fn() -> bool + Send + Sync),
    ) -> Result<(), McpError> {
        self.clear(server_id, is_current)
            .map_err(|error| McpError::OAuthStore(error.to_string()))
    }
}

/// In-memory store (tests + early prototypes).
#[derive(Debug, Default, Clone)]
pub struct MemoryMcpOAuthStore {
    sessions: std::sync::Arc<Mutex<HashMap<String, McpOAuthSession>>>,
}

impl MemoryMcpOAuthStore {
    pub fn new() -> Self {
        Self::default()
    }
}

impl McpOAuthStore for MemoryMcpOAuthStore {
    fn get(&self, server_id: &str) -> Result<McpOAuthSession, McpError> {
        Ok(self
            .sessions
            .lock()
            .unwrap()
            .get(server_id)
            .cloned()
            .unwrap_or_default())
    }

    fn set(&self, server_id: &str, session: &McpOAuthSession) -> Result<(), McpError> {
        self.sessions
            .lock()
            .unwrap()
            .insert(server_id.to_string(), session.clone());
        Ok(())
    }

    fn clear(&self, server_id: &str) -> Result<(), McpError> {
        self.sessions.lock().unwrap().remove(server_id);
        Ok(())
    }
}

// ===========================================================================
// HTTP seam (dynamic client registration + token endpoints)
// ===========================================================================

/// Authorization server metadata discovered from the MCP endpoint.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct McpAuthorizationServerMetadata {
    pub issuer: Option<String>,
    pub authorization_endpoint: String,
    pub token_endpoint: String,
    pub registration_endpoint: Option<String>,
    pub code_challenge_methods_supported: Vec<String>,
    pub scopes_supported: Vec<String>,
}

/// Parameters for an authorization-code exchange.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CodeExchangeParams<'a> {
    pub token_endpoint: &'a str,
    pub client_id: &'a str,
    pub code: &'a str,
    pub redirect_uri: &'a str,
    pub code_verifier: &'a str,
    pub resource: &'a str,
}

/// Parameters for a refresh-token grant.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RefreshParams<'a> {
    pub token_endpoint: &'a str,
    pub client_id: &'a str,
    pub refresh_token: &'a str,
    pub resource: &'a str,
}

/// The network I/O of the MCP OAuth flow. Production uses
/// [`ReqwestMcpOAuthHttp`]; tests inject a fake so no network is ever touched.
pub trait McpOAuthHttp: Send + Sync {
    /// Fetch `/.well-known/oauth-authorization-server` (or the MCP metadata
    /// endpoint) and return the endpoints.
    fn fetch_authorization_metadata(
        &self,
        _mcp_endpoint: &str,
    ) -> BoxFuture<'_, Result<McpAuthorizationServerMetadata, McpError>>;
    /// Dynamic client registration (RFC 7591). Returns `None` when the server
    /// does not expose a registration endpoint (public clients then proceed
    /// without registration).
    fn register_client(
        &self,
        metadata: &McpAuthorizationServerMetadata,
        client_metadata: &serde_json::Value,
    ) -> BoxFuture<'_, Result<Option<McpOAuthClientInformation>, McpError>>;
    fn exchange_authorization_code(
        &self,
        params: CodeExchangeParams<'_>,
    ) -> BoxFuture<'_, Result<McpOAuthTokens, McpError>>;
    fn refresh_tokens(
        &self,
        params: RefreshParams<'_>,
    ) -> BoxFuture<'_, Result<McpOAuthTokens, McpError>>;
}

/// reqwest-backed implementation. All requests use a no-redirect client so
/// credential-bearing headers can never be forwarded cross-origin (TS
/// `createNoRedirectFetch`).
#[derive(Debug, Clone)]
pub struct ReqwestMcpOAuthHttp {
    client: reqwest::Client,
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
                    "OAuth endpoint did not resolve exclusively to public addresses",
                ))
                    as Box<dyn std::error::Error + Send + Sync>);
            }
            Ok(Box::new(addresses.into_iter()) as reqwest::dns::Addrs)
        })
    }
}

impl Default for ReqwestMcpOAuthHttp {
    fn default() -> Self {
        Self {
            client: reqwest::Client::builder()
                .redirect(reqwest::redirect::Policy::none())
                .connect_timeout(OAUTH_CONNECT_TIMEOUT)
                .timeout(OAUTH_REQUEST_TIMEOUT)
                .dns_resolver(std::sync::Arc::new(PublicOnlyDnsResolver))
                .build()
                .expect("building the MCP OAuth HTTP client must not fail"),
        }
    }
}

impl McpOAuthHttp for ReqwestMcpOAuthHttp {
    fn fetch_authorization_metadata(
        &self,
        mcp_endpoint: &str,
    ) -> BoxFuture<'_, Result<McpAuthorizationServerMetadata, McpError>> {
        let client = self.client.clone();
        let endpoint = mcp_endpoint.to_string();
        Box::pin(async move {
            let endpoint = secure_url(&endpoint, "MCP endpoint")?;
            let protected = discover_protected_resource_metadata(&client, &endpoint).await?;
            let resource_scopes = protected.scopes_supported;
            let authorization_server = protected
                .authorization_servers
                .into_iter()
                .next()
                .unwrap_or_else(|| endpoint.origin().ascii_serialization());
            let authorization_server = secure_url(&authorization_server, "authorization server")?;
            let metadata =
                discover_authorization_server_metadata(&client, &authorization_server).await?;
            validate_exact_issuer(&authorization_server, metadata.issuer.as_deref())?;
            validate_authorization_server_metadata(&metadata)?;
            validate_discovered_endpoint(
                metadata.issuer.as_deref(),
                metadata.authorization_endpoint.as_str(),
                "authorization endpoint",
            )?;
            validate_discovered_endpoint(
                metadata.issuer.as_deref(),
                metadata.token_endpoint.as_str(),
                "token endpoint",
            )?;
            if let Some(registration) = metadata.registration_endpoint.as_deref() {
                validate_discovered_endpoint(
                    metadata.issuer.as_deref(),
                    registration,
                    "registration endpoint",
                )?;
            }
            if !metadata
                .code_challenge_methods_supported
                .iter()
                .any(|method| method == "S256")
            {
                return Err(McpError::OAuthRequest(
                    "authorization server does not support PKCE S256".into(),
                ));
            }
            Ok(McpAuthorizationServerMetadata {
                issuer: metadata.issuer,
                authorization_endpoint: metadata.authorization_endpoint,
                token_endpoint: metadata.token_endpoint,
                registration_endpoint: metadata.registration_endpoint,
                code_challenge_methods_supported: metadata.code_challenge_methods_supported,
                scopes_supported: resource_scopes,
            })
        })
    }

    fn register_client(
        &self,
        metadata: &McpAuthorizationServerMetadata,
        client_metadata: &serde_json::Value,
    ) -> BoxFuture<'_, Result<Option<McpOAuthClientInformation>, McpError>> {
        let client = self.client.clone();
        let endpoint = metadata.registration_endpoint.clone();
        let body = client_metadata.clone();
        Box::pin(async move {
            let Some(endpoint) = endpoint else {
                return Ok(None);
            };
            let endpoint = secure_url(&endpoint, "registration endpoint")?;
            let response = client
                .post(endpoint)
                .json(&body)
                .send()
                .await
                .map_err(|_| sanitized_request_error("client registration"))?;
            let response: McpOAuthClientInformation =
                parse_json_response(response, "client registration").await?;
            if !valid_client_information(&response) {
                return Err(McpError::OAuthRequest(
                    "client registration returned an invalid client identifier".into(),
                ));
            }
            Ok(Some(public_mcp_client_information(&response)))
        })
    }

    fn exchange_authorization_code(
        &self,
        params: CodeExchangeParams<'_>,
    ) -> BoxFuture<'_, Result<McpOAuthTokens, McpError>> {
        let client = self.client.clone();
        let params = params.to_owned_refs();
        Box::pin(async move {
            let token_endpoint = secure_url(&params.token_endpoint, "token endpoint")?;
            let body = form_encode(&[
                ("grant_type", "authorization_code"),
                ("code", &params.code),
                ("redirect_uri", &params.redirect_uri),
                ("client_id", &params.client_id),
                ("code_verifier", &params.code_verifier),
                ("resource", &params.resource),
            ]);
            let response = client
                .post(token_endpoint)
                .header("content-type", "application/x-www-form-urlencoded")
                .body(body)
                .send()
                .await
                .map_err(|_| sanitized_request_error("token exchange"))?;
            parse_tokens_response(response, "token exchange").await
        })
    }

    fn refresh_tokens(
        &self,
        params: RefreshParams<'_>,
    ) -> BoxFuture<'_, Result<McpOAuthTokens, McpError>> {
        let client = self.client.clone();
        let params = OwnedRefreshParams {
            token_endpoint: params.token_endpoint.to_string(),
            client_id: params.client_id.to_string(),
            refresh_token: params.refresh_token.to_string(),
            resource: params.resource.to_string(),
        };
        Box::pin(async move {
            let token_endpoint = secure_url(&params.token_endpoint, "token endpoint")?;
            let body = form_encode(&[
                ("grant_type", "refresh_token"),
                ("refresh_token", &params.refresh_token),
                ("client_id", &params.client_id),
                ("resource", &params.resource),
            ]);
            let response = client
                .post(token_endpoint)
                .header("content-type", "application/x-www-form-urlencoded")
                .body(body)
                .send()
                .await
                .map_err(|_| sanitized_request_error("token refresh"))?;
            parse_tokens_response(response, "token refresh").await
        })
    }
}

#[derive(Debug, Default, Deserialize)]
struct ProtectedResourceMetadata {
    resource: String,
    #[serde(default)]
    authorization_servers: Vec<String>,
    #[serde(default)]
    scopes_supported: Vec<String>,
}

#[derive(Debug, Deserialize)]
struct AuthorizationServerMetadataResponse {
    issuer: Option<String>,
    authorization_endpoint: String,
    token_endpoint: String,
    registration_endpoint: Option<String>,
    #[serde(default)]
    code_challenge_methods_supported: Vec<String>,
}

fn validate_authorization_server_metadata(
    metadata: &AuthorizationServerMetadataResponse,
) -> Result<(), McpError> {
    let values = [
        metadata.issuer.as_deref(),
        Some(metadata.authorization_endpoint.as_str()),
        Some(metadata.token_endpoint.as_str()),
        metadata.registration_endpoint.as_deref(),
    ];
    if values
        .into_iter()
        .flatten()
        .any(|value| value.is_empty() || value.len() > MAX_OAUTH_METADATA_VALUE_LEN)
        || metadata.code_challenge_methods_supported.len() > MAX_OAUTH_METADATA_ITEMS
        || metadata
            .code_challenge_methods_supported
            .iter()
            .any(|method| method.is_empty() || method.len() > 64)
    {
        return Err(McpError::OAuthRequest(
            "authorization-server metadata exceeded supported bounds".into(),
        ));
    }
    Ok(())
}

fn secure_url(value: &str, label: &str) -> Result<reqwest::Url, McpError> {
    if value.is_empty() || value.len() > MAX_OAUTH_URL_LEN {
        return Err(McpError::OAuthRequest(format!("{label} is invalid")));
    }
    let url = reqwest::Url::parse(value)
        .map_err(|_| McpError::OAuthRequest(format!("{label} is invalid")))?;
    if !url.username().is_empty() || url.password().is_some() || url.fragment().is_some() {
        return Err(McpError::OAuthRequest(format!("{label} is not allowed")));
    }
    let loopback = url
        .host_str()
        .is_some_and(|host| matches!(host, "127.0.0.1" | "localhost" | "::1"));
    if url.scheme() != "https" && !(url.scheme() == "http" && loopback) {
        return Err(McpError::OAuthRequest(format!(
            "{label} must use HTTPS (except explicit loopback development servers)"
        )));
    }
    let literal_ip = url
        .host_str()
        .and_then(|host| host.parse::<std::net::IpAddr>().ok());
    if literal_ip.is_some_and(|address| !address.is_loopback() && !is_public_ip(address)) {
        return Err(McpError::OAuthRequest(format!(
            "{label} must not target a private or reserved address"
        )));
    }
    Ok(url)
}

fn is_public_ip(address: std::net::IpAddr) -> bool {
    match address {
        std::net::IpAddr::V4(address) => {
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
        std::net::IpAddr::V6(address) => {
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

fn protected_resource_metadata_url(endpoint: &reqwest::Url) -> Result<reqwest::Url, McpError> {
    let mut url = endpoint.clone();
    let path = endpoint.path().trim_start_matches('/');
    let metadata_path = if path.is_empty() {
        "/.well-known/oauth-protected-resource".to_string()
    } else {
        format!("/.well-known/oauth-protected-resource/{path}")
    };
    url.set_path(&metadata_path);
    url.set_query(None);
    Ok(url)
}

fn authorization_server_metadata_url(issuer: &reqwest::Url) -> Result<reqwest::Url, McpError> {
    let mut url = issuer.clone();
    let path = issuer.path().trim_matches('/');
    let metadata_path = if path.is_empty() {
        "/.well-known/oauth-authorization-server".to_string()
    } else {
        format!("/.well-known/oauth-authorization-server/{path}")
    };
    url.set_path(&metadata_path);
    url.set_query(None);
    Ok(url)
}

fn openid_configuration_url(issuer: &reqwest::Url) -> reqwest::Url {
    let mut url = issuer.clone();
    let path = issuer.path().trim_matches('/');
    let metadata_path = if path.is_empty() {
        "/.well-known/openid-configuration".to_string()
    } else {
        format!("/{path}/.well-known/openid-configuration")
    };
    url.set_path(&metadata_path);
    url.set_query(None);
    url
}

async fn discover_protected_resource_metadata(
    client: &reqwest::Client,
    endpoint: &reqwest::Url,
) -> Result<ProtectedResourceMetadata, McpError> {
    if let Ok(response) = client
        .get(endpoint.clone())
        .header("accept", "application/json")
        .send()
        .await
    {
        if let Some(metadata_url) = response
            .headers()
            .get_all(reqwest::header::WWW_AUTHENTICATE)
            .iter()
            .filter_map(|value| value.to_str().ok())
            .find_map(resource_metadata_from_www_authenticate)
        {
            let metadata_url = secure_url(&metadata_url, "protected-resource metadata endpoint")?;
            let metadata = get_json_bounded(client, metadata_url).await?;
            validate_protected_resource_metadata(endpoint, &metadata)?;
            return Ok(metadata);
        }
    }

    let mut candidates = vec![protected_resource_metadata_url(endpoint)?];
    let mut root = endpoint.clone();
    root.set_path("/.well-known/oauth-protected-resource");
    root.set_query(None);
    if !candidates.contains(&root) {
        candidates.push(root);
    }
    for candidate in candidates {
        if let Ok(metadata) = get_json_bounded(client, candidate).await {
            validate_protected_resource_metadata(endpoint, &metadata)?;
            return Ok(metadata);
        }
    }

    Ok(ProtectedResourceMetadata {
        resource: endpoint.as_str().to_string(),
        authorization_servers: vec![endpoint.origin().ascii_serialization()],
        scopes_supported: Vec::new(),
    })
}

fn validate_protected_resource_metadata(
    endpoint: &reqwest::Url,
    metadata: &ProtectedResourceMetadata,
) -> Result<(), McpError> {
    let resource = secure_url(&metadata.resource, "protected-resource identifier")?;
    if &resource != endpoint {
        return Err(McpError::OAuthRequest(
            "protected-resource metadata did not match the MCP endpoint".into(),
        ));
    }
    if metadata.authorization_servers.len() > MAX_OAUTH_METADATA_ITEMS
        || metadata.scopes_supported.len() > MAX_OAUTH_METADATA_ITEMS
        || metadata
            .authorization_servers
            .iter()
            .any(|value| value.is_empty() || value.len() > MAX_OAUTH_METADATA_VALUE_LEN)
        || metadata.scopes_supported.iter().any(|scope| {
            scope.is_empty()
                || scope.len() > MAX_OAUTH_SCOPE_LEN
                || scope.chars().any(char::is_whitespace)
        })
    {
        return Err(McpError::OAuthRequest(
            "protected-resource metadata exceeded supported bounds".into(),
        ));
    }
    Ok(())
}

fn resource_metadata_from_www_authenticate(value: &str) -> Option<String> {
    if !value
        .split_ascii_whitespace()
        .next()
        .is_some_and(|scheme| scheme.eq_ignore_ascii_case("bearer"))
    {
        return None;
    }
    if value.len() > MAX_OAUTH_METADATA_VALUE_LEN {
        return None;
    }
    let marker = "resource_metadata=";
    let lower = value.to_ascii_lowercase();
    let start = lower.find(marker)? + marker.len();
    let remainder = value[start..].trim_start();
    if let Some(quoted) = remainder.strip_prefix('"') {
        return quoted.split('"').next().map(str::to_string);
    }
    remainder
        .split([',', ' '])
        .next()
        .filter(|candidate| !candidate.is_empty())
        .map(str::to_string)
}

async fn discover_authorization_server_metadata(
    client: &reqwest::Client,
    issuer: &reqwest::Url,
) -> Result<AuthorizationServerMetadataResponse, McpError> {
    let candidates = [
        authorization_server_metadata_url(issuer)?,
        openid_configuration_url(issuer),
    ];
    for candidate in candidates {
        if let Ok(metadata) = get_json_bounded(client, candidate).await {
            return Ok(metadata);
        }
    }
    Err(McpError::OAuthRequest(
        "authorization-server metadata discovery could not be completed".into(),
    ))
}

fn validate_exact_issuer(
    requested: &reqwest::Url,
    discovered: Option<&str>,
) -> Result<(), McpError> {
    let discovered = discovered.ok_or_else(|| {
        McpError::OAuthRequest("authorization-server metadata omitted its issuer".into())
    })?;
    let discovered = secure_url(discovered, "authorization issuer")?;
    if &discovered != requested {
        return Err(McpError::OAuthRequest(
            "authorization-server metadata issuer did not exactly match discovery".into(),
        ));
    }
    Ok(())
}

fn validate_discovered_endpoint(
    issuer: Option<&str>,
    endpoint: &str,
    label: &str,
) -> Result<(), McpError> {
    let endpoint = secure_url(endpoint, label)?;
    if let Some(issuer) = issuer {
        let issuer = secure_url(issuer, "authorization issuer")?;
        if issuer.origin() != endpoint.origin() {
            return Err(McpError::OAuthRequest(format!(
                "{label} origin does not match the authorization issuer"
            )));
        }
    }
    Ok(())
}

async fn response_bytes_bounded(
    response: reqwest::Response,
    operation: &str,
) -> Result<Vec<u8>, McpError> {
    if let Some(length) = response.content_length() {
        if length > MAX_OAUTH_RESPONSE_BYTES as u64 {
            return Err(McpError::OAuthRequest(format!(
                "{operation} response was too large"
            )));
        }
    }
    let mut body = Vec::new();
    let mut stream = response.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|_| sanitized_request_error(operation))?;
        if body.len().saturating_add(chunk.len()) > MAX_OAUTH_RESPONSE_BYTES {
            return Err(McpError::OAuthRequest(format!(
                "{operation} response was too large"
            )));
        }
        body.extend_from_slice(&chunk);
    }
    Ok(body)
}

async fn parse_json_response<T: serde::de::DeserializeOwned>(
    response: reqwest::Response,
    operation: &str,
) -> Result<T, McpError> {
    let status = response.status();
    if !status.is_success() {
        return Err(McpError::OAuthRequest(format!(
            "{operation} returned HTTP {}",
            status.as_u16()
        )));
    }
    let body = response_bytes_bounded(response, operation).await?;
    serde_json::from_slice(&body)
        .map_err(|_| McpError::OAuthRequest(format!("{operation} returned invalid JSON")))
}

async fn get_json_bounded<T: serde::de::DeserializeOwned>(
    client: &reqwest::Client,
    url: reqwest::Url,
) -> Result<T, McpError> {
    let response = client
        .get(url)
        .header("accept", "application/json")
        .send()
        .await
        .map_err(|_| sanitized_request_error("OAuth metadata discovery"))?;
    parse_json_response(response, "OAuth metadata discovery").await
}

async fn parse_tokens_response(
    response: reqwest::Response,
    operation: &str,
) -> Result<McpOAuthTokens, McpError> {
    let mut tokens: McpOAuthTokens = parse_json_response(response, operation).await?;
    if !valid_tokens(&tokens) {
        return Err(McpError::OAuthRequest(format!(
            "{operation} returned an invalid token shape"
        )));
    }
    tokens.extra.insert(
        TOKEN_OBTAINED_AT_KEY.into(),
        serde_json::Value::from(current_time_millis()),
    );
    Ok(tokens)
}

fn sanitized_request_error(operation: &str) -> McpError {
    McpError::OAuthRequest(format!("{operation} could not be completed"))
}

fn current_time_millis() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .min(u64::MAX as u128) as u64
}

struct OwnedCodeExchangeParams {
    token_endpoint: String,
    client_id: String,
    code: String,
    redirect_uri: String,
    code_verifier: String,
    resource: String,
}

struct OwnedRefreshParams {
    token_endpoint: String,
    client_id: String,
    refresh_token: String,
    resource: String,
}

impl<'a> CodeExchangeParams<'a> {
    fn to_owned_refs(&self) -> OwnedCodeExchangeParams {
        OwnedCodeExchangeParams {
            token_endpoint: self.token_endpoint.to_string(),
            client_id: self.client_id.to_string(),
            code: self.code.to_string(),
            redirect_uri: self.redirect_uri.to_string(),
            code_verifier: self.code_verifier.to_string(),
            resource: self.resource.to_string(),
        }
    }
}

/// Minimal `application/x-www-form-urlencoded` encoder (RFC 3986 unreserved
/// passthrough; everything else percent-encoded).
fn form_encode(pairs: &[(&str, &str)]) -> String {
    pairs
        .iter()
        .map(|(key, value)| format!("{}={}", percent_encode(key), percent_encode(value)))
        .collect::<Vec<_>>()
        .join("&")
}

fn percent_encode(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for byte in value.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'.' | b'_' | b'~' => {
                out.push(byte as char)
            }
            _ => out.push_str(&format!("%{byte:02X}")),
        }
    }
    out
}

// ===========================================================================
// OAuthClientProvider (store + gate state machine)
// ===========================================================================

/// The `OAuthClientProvider` contract rmcp transports call during connect,
/// backed by the session store and the operation gate. Mirrors the TS
/// `McpOAuthProvider` class (without its browser opening: `interactive` flows
/// open via the injected `open_browser` callback in [`authorize_mcp_server`]).
///
/// `operation = Some(...)` marks an interactive flow: mutations are allowed
/// while it is the live, un-aborted owner. `None` marks a background
/// connection: mutations are allowed only while no interactive flow owns the
/// server.
pub struct McpOAuthProvider<'a> {
    server_id: String,
    binding: String,
    generation: McpOAuthGeneration,
    operation: Option<McpOAuthOperation>,
    gate: &'a McpOAuthOperationGate,
    store: &'a dyn McpOAuthStore,
    /// When present, mutations go to the private transaction buffer instead of
    /// the durable store (interactive re-authorization).
    transaction: Option<&'a Mutex<McpOAuthSessionTransaction>>,
    request_is_current: &'a (dyn Fn() -> bool + Send + Sync),
}

impl<'a> McpOAuthProvider<'a> {
    pub fn new(
        server_id: String,
        binding: String,
        operation: Option<McpOAuthOperation>,
        gate: &'a McpOAuthOperationGate,
        store: &'a dyn McpOAuthStore,
        transaction: Option<&'a Mutex<McpOAuthSessionTransaction>>,
        request_is_current: &'a (dyn Fn() -> bool + Send + Sync),
    ) -> Self {
        let generation = operation
            .as_ref()
            .map(McpOAuthOperation::generation)
            .unwrap_or_else(|| gate.snapshot(&server_id));
        Self {
            server_id,
            binding,
            generation,
            operation,
            gate,
            store,
            transaction,
            request_is_current,
        }
    }

    fn assert_can_mutate(&self) -> Result<(), McpError> {
        if !(self.request_is_current)() {
            return Err(McpError::DocumentInactive);
        }
        match &self.operation {
            Some(operation) => {
                if !self.gate.is_current_operation(operation) {
                    return Err(McpError::OAuthStale);
                }
            }
            None => {
                if !self.gate.can_mutate(&self.server_id, &self.generation) {
                    return Err(McpError::OAuthStale);
                }
            }
        }
        Ok(())
    }

    fn bound_session(&self) -> Result<McpOAuthSession, McpError> {
        self.assert_can_mutate()?;
        let session = match self.transaction {
            Some(transaction) => transaction.lock().unwrap().read(),
            None => self
                .store
                .get_owned(&self.server_id, &|| self.assert_can_mutate().is_ok())?,
        };
        self.assert_can_mutate()?;
        Ok(if session_matches_mcp_binding(&session, &self.binding) {
            session
        } else {
            McpOAuthSession::bound(&self.binding)
        })
    }

    fn save_session(&self, session: McpOAuthSession) -> Result<(), McpError> {
        self.assert_can_mutate()?;
        if let Some(transaction) = self.transaction {
            transaction.lock().unwrap().replace(session);
            self.assert_can_mutate()
        } else {
            self.store.set_owned(&self.server_id, &session, &|| {
                self.assert_can_mutate().is_ok()
            })
        }
    }

    /// The exact `redirect_uri` registered with the authorization server.
    pub fn redirect_url(&self) -> &'static str {
        OAUTH_REDIRECT_URI
    }

    /// Client metadata sent to dynamic registration (TS `clientMetadata`).
    pub fn client_metadata(&self) -> serde_json::Value {
        serde_json::json!({
            "client_name": "Aiden Agent",
            "redirect_uris": [OAUTH_REDIRECT_URI],
            "grant_types": ["authorization_code", "refresh_token"],
            "response_types": ["code"],
            "token_endpoint_auth_method": "none",
        })
    }

    pub fn client_information(&self) -> Result<Option<McpOAuthClientInformation>, McpError> {
        Ok(self
            .bound_session()?
            .client_information
            .map(|information| public_mcp_client_information(&information)))
    }

    pub fn save_client_information(
        &self,
        information: &McpOAuthClientInformation,
    ) -> Result<(), McpError> {
        self.assert_can_mutate()?;
        let mut session = self.bound_session()?;
        self.assert_can_mutate()?;
        session.authorization_binding = Some(self.binding.clone());
        session.client_information = Some(public_mcp_client_information(information));
        self.save_session(session)
    }

    pub fn tokens(&self) -> Result<Option<McpOAuthTokens>, McpError> {
        Ok(self.bound_session()?.tokens)
    }

    pub fn save_tokens(&self, tokens: McpOAuthTokens) -> Result<(), McpError> {
        self.assert_can_mutate()?;
        let mut session = self.bound_session()?;
        self.assert_can_mutate()?;
        session.authorization_binding = Some(self.binding.clone());
        session.tokens = Some(tokens);
        self.save_session(session)
    }

    fn mark_connection_verified(&self) -> Result<(), McpError> {
        self.assert_can_mutate()?;
        let mut session = self.bound_session()?;
        session
            .extra
            .insert(SESSION_VERIFIED_KEY.into(), serde_json::Value::Bool(true));
        self.save_session(session)
    }

    pub fn save_code_verifier(&self, code_verifier: String) -> Result<(), McpError> {
        self.assert_can_mutate()?;
        let mut session = self.bound_session()?;
        self.assert_can_mutate()?;
        session.authorization_binding = Some(self.binding.clone());
        session.code_verifier = Some(code_verifier);
        self.save_session(session)
    }

    pub fn code_verifier(&self) -> Result<String, McpError> {
        self.bound_session()?
            .code_verifier
            .ok_or(McpError::OAuthMissingVerifier)
    }

    /// Non-interactive providers must never open a browser — the caller that
    /// holds a live operation may open it via [`authorize_mcp_server`].
    pub fn redirect_to_authorization(&self, _authorization_url: &str) -> Result<(), McpError> {
        self.assert_can_mutate()?;
        Err(McpError::OAuthNeedsSignIn)
    }

    pub fn invalidate_credentials(&self, scope: McpOAuthInvalidationScope) -> Result<(), McpError> {
        self.assert_can_mutate()?;
        match scope {
            McpOAuthInvalidationScope::All => {
                if self.transaction.is_some() {
                    self.save_session(McpOAuthSession::bound(&self.binding))
                } else {
                    self.store
                        .clear_owned(&self.server_id, &|| self.assert_can_mutate().is_ok())
                }
            }
            McpOAuthInvalidationScope::Tokens
            | McpOAuthInvalidationScope::Verifier
            | McpOAuthInvalidationScope::Client => {
                let mut session = self.bound_session()?;
                self.assert_can_mutate()?;
                match scope {
                    McpOAuthInvalidationScope::Tokens => session.tokens = None,
                    McpOAuthInvalidationScope::Verifier => session.code_verifier = None,
                    McpOAuthInvalidationScope::Client => session.client_information = None,
                    McpOAuthInvalidationScope::All | McpOAuthInvalidationScope::Discovery => {
                        unreachable!("handled above")
                    }
                }
                self.save_session(session)
            }
            McpOAuthInvalidationScope::Discovery => Ok(()),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum McpOAuthInvalidationScope {
    All,
    Client,
    Tokens,
    Verifier,
    Discovery,
}

// ===========================================================================
// Interactive flow driver (mcp-oauth.ts authorizeMcpServer)
// ===========================================================================

/// Opens an authorization URL in the system browser (the Electron `shell`
/// equivalent; GPUI injects this).
pub type OpenBrowserFn = dyn Fn(&str) -> Result<(), McpError> + Send + Sync;

/// Dependencies for [`authorize_mcp_server`].
pub struct McpOAuthDeps<'a> {
    pub store: &'a dyn McpOAuthStore,
    pub gate: &'a McpOAuthOperationGate,
    pub http: &'a dyn McpOAuthHttp,
    /// Establishes a real MCP transport with the staged bearer token before
    /// the transaction is allowed to publish credentials.
    pub verifier: &'a dyn McpOAuthConnectionVerifier,
    pub is_current: &'a (dyn Fn() -> bool + Send + Sync),
    /// Opens the authorization URL in the system browser. `None` for
    /// background connections: the flow fails loudly instead of opening a
    /// browser.
    pub open_browser: Option<&'a OpenBrowserFn>,
    /// Loopback port (fixed `OAUTH_PORT`; tests may use 0).
    pub port: u16,
}

pub trait McpOAuthConnectionVerifier: Send + Sync {
    fn verify(&self, spec: crate::config::McpServerSpec) -> BoxFuture<'_, Result<(), McpError>>;
}

impl McpOAuthConnectionVerifier for crate::client::McpClientManager {
    fn verify(&self, spec: crate::config::McpServerSpec) -> BoxFuture<'_, Result<(), McpError>> {
        Box::pin(async move { self.verify_connection(&spec).await })
    }
}

/// Run the interactive OAuth flow for a remote MCP server: open the browser,
/// capture the code on the loopback, exchange it, and verify the connection
/// (`authorizeMcpServer`). Tokens land in the store for future connections.
///
/// Discovery, dynamic registration, PKCE, code exchange, and publication all
/// remain bound to the same operation generation.
pub async fn authorize_mcp_server(
    server: &crate::config::McpServerSpec,
    deps: McpOAuthDeps<'_>,
) -> Result<(), McpError> {
    if server.transport != McpTransport::Http && server.transport != McpTransport::Sse {
        return Err(McpError::OAuthOnStdio);
    }
    let binding = server
        .authorization_binding()
        .ok_or(McpError::MissingUrlForAuth)?;
    if !(deps.is_current)() {
        return Err(McpError::DocumentInactive);
    }
    let operation = deps.gate.begin(&server.server.id)?;
    let _operation_guard = OAuthOperationEndGuard {
        gate: deps.gate,
        operation: operation.clone(),
    };
    if !deps.gate.is_current_operation(&operation) {
        return Err(McpError::OAuthSuperseded);
    }
    let previous_session = match deps.store.get_owned(&server.server.id, &|| {
        (deps.is_current)() && deps.gate.is_current_operation(&operation)
    }) {
        Ok(session) => session,
        Err(error) => return Err(error),
    };
    let transaction = McpOAuthSessionTransaction::new(session_for_fresh_mcp_authorization(
        &previous_session,
        &binding,
    ));
    let transaction_mutex = Mutex::new(transaction);
    let provider = McpOAuthProvider::new(
        server.server.id.clone(),
        binding.clone(),
        Some(operation.clone()),
        deps.gate,
        deps.store,
        Some(&transaction_mutex),
        deps.is_current,
    );
    // Copy the borrowed dependencies out so the flow future and the rollback
    // path below can both use them.
    let (store, gate, is_current, http, verifier, open_browser, port) = (
        deps.store,
        deps.gate,
        deps.is_current,
        deps.http,
        deps.verifier,
        deps.open_browser,
        deps.port,
    );
    let mut commit_attempted = false;
    let result = async {
        // The loopback server lives for the whole flow (browser → code →
        // exchange → commit), matching TS's `finally { loopback?.close() }`.
        let loopback_server = LoopbackServer::bind(port).await?;
        let (authorization_url, metadata, state) =
            build_authorization_url(server, &provider, &binding, http).await?;
        let open = open_browser.ok_or(McpError::OAuthNeedsSignIn)?;
        open(&authorization_url)?;

        let code = loopback_server
            .wait_for_code_with_state(&state, Some(&operation.signal), None)
            .await?;
        exchange_and_save(&provider, &metadata, http, &code).await?;
        provider.assert_can_mutate()?;
        verifier
            .verify(spec_with_staged_oauth(server, &provider)?)
            .await?;
        provider.assert_can_mutate()?;
        provider.mark_connection_verified()?;

        commit_attempted = true;
        commit_transaction(
            server,
            store,
            gate,
            is_current,
            &operation,
            &transaction_mutex,
        )
    }
    .await;

    // Rollback the durable session when the flow failed after attempting a
    // commit (TS catch block).
    if let Err(error) = &result {
        if commit_attempted && gate.is_current_operation(&operation) {
            tracing::warn!(
                server = %server.server.id,
                %error,
                "MCP OAuth authorization failed after commit; restoring previous session"
            );
            let _ = store.set_owned(&server.server.id, &previous_session, &|| {
                is_current() && gate.is_current_operation(&operation)
            });
        }
    }
    result
}

fn spec_with_staged_oauth(
    server: &crate::config::McpServerSpec,
    provider: &McpOAuthProvider<'_>,
) -> Result<crate::config::McpServerSpec, McpError> {
    let tokens = provider.tokens()?.ok_or(McpError::OAuthNeedsSignIn)?;
    if !tokens.token_type.eq_ignore_ascii_case("bearer")
        || tokens.access_token.is_empty()
        || tokens.access_token.contains(['\r', '\n'])
    {
        return Err(McpError::OAuthNeedsSignIn);
    }
    let mut spec = server.clone();
    spec.remote
        .as_mut()
        .ok_or(McpError::MissingUrlForAuth)?
        .headers
        .insert(
            http::header::AUTHORIZATION.as_str().to_string(),
            format!("Bearer {}", tokens.access_token),
        );
    Ok(spec)
}

async fn build_authorization_url(
    server: &crate::config::McpServerSpec,
    provider: &McpOAuthProvider<'_>,
    binding: &str,
    http: &dyn McpOAuthHttp,
) -> Result<(String, McpAuthorizationServerMetadata, String), McpError> {
    provider.assert_can_mutate()?;
    let endpoint = server
        .remote
        .as_ref()
        .ok_or(McpError::MissingUrlForAuth)?
        .url
        .as_str();
    let metadata = http.fetch_authorization_metadata(endpoint).await?;
    provider.assert_can_mutate()?;
    let information = match provider.client_information()? {
        Some(information) => information,
        None => {
            let information = http
                .register_client(&metadata, &provider.client_metadata())
                .await?
                .ok_or_else(|| {
                    McpError::OAuthRequest(
                        "authorization server does not support dynamic client registration".into(),
                    )
                })?;
            provider.assert_can_mutate()?;
            provider.save_client_information(&information)?;
            public_mcp_client_information(&information)
        }
    };
    let pkce = PkcePair::new()?;
    provider.save_code_verifier(pkce.verifier)?;
    let state = base64url_encode(&random_bytes(32)?);
    let mut authorization = secure_url(&metadata.authorization_endpoint, "authorization endpoint")?;
    {
        let mut query = authorization.query_pairs_mut();
        query
            .append_pair("response_type", "code")
            .append_pair("client_id", &information.client_id)
            .append_pair("redirect_uri", provider.redirect_url())
            .append_pair("code_challenge", &pkce.challenge)
            .append_pair("code_challenge_method", "S256")
            .append_pair("state", &state)
            .append_pair("resource", binding);
        if !metadata.scopes_supported.is_empty() {
            query.append_pair("scope", &metadata.scopes_supported.join(" "));
        }
    }
    Ok((authorization.into(), metadata, state))
}

async fn exchange_and_save(
    provider: &McpOAuthProvider<'_>,
    metadata: &McpAuthorizationServerMetadata,
    http: &dyn McpOAuthHttp,
    code: &str,
) -> Result<(), McpError> {
    provider.assert_can_mutate()?;
    let information = provider.client_information()?.ok_or_else(|| {
        McpError::OAuthRequest("missing registered OAuth client information".into())
    })?;
    let verifier = provider.code_verifier()?;
    let tokens = http
        .exchange_authorization_code(CodeExchangeParams {
            token_endpoint: &metadata.token_endpoint,
            client_id: &information.client_id,
            code,
            redirect_uri: provider.redirect_url(),
            code_verifier: &verifier,
            resource: &provider.binding,
        })
        .await?;
    provider.assert_can_mutate()?;
    provider.save_tokens(tokens)
}

/// Non-secret Settings projection for one exact OAuth-bound server.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum McpOAuthStatus {
    Ready,
    NeedsSignIn,
}

pub fn oauth_status(
    server: &crate::config::McpServerSpec,
    store: &dyn McpOAuthStore,
) -> Result<McpOAuthStatus, McpError> {
    let Some(binding) = server.authorization_binding() else {
        return Ok(McpOAuthStatus::NeedsSignIn);
    };
    let session = store.get(&server.server.id)?;
    Ok(
        if session_matches_mcp_binding(&session, &binding)
            && session.tokens.is_some()
            && session_connection_verified(&session)
        {
            McpOAuthStatus::Ready
        } else {
            McpOAuthStatus::NeedsSignIn
        },
    )
}

/// Resolve an OAuth-enabled remote server for unattended runtime use. This
/// path may refresh an existing session but can never open a browser.
pub async fn resolve_noninteractive_oauth(
    mut server: crate::config::McpServerSpec,
    store: &dyn McpOAuthStore,
    gate: &McpOAuthOperationGate,
    http: &dyn McpOAuthHttp,
    is_current: &(dyn Fn() -> bool + Send + Sync),
) -> Result<crate::config::McpServerSpec, McpError> {
    if !server.server.oauth.unwrap_or(false) {
        return Ok(server);
    }
    let binding = server
        .authorization_binding()
        .ok_or(McpError::MissingUrlForAuth)?;
    let provider = McpOAuthProvider::new(
        server.server.id.clone(),
        binding.clone(),
        None,
        gate,
        store,
        None,
        is_current,
    );
    if !session_connection_verified(&provider.bound_session()?) {
        return Err(McpError::OAuthNeedsSignIn);
    }
    let mut tokens = provider.tokens()?.ok_or(McpError::OAuthNeedsSignIn)?;
    if token_needs_refresh(&tokens) {
        let refresh_token = tokens
            .refresh_token
            .clone()
            .ok_or(McpError::OAuthNeedsSignIn)?;
        let client = provider
            .client_information()?
            .ok_or(McpError::OAuthNeedsSignIn)?;
        let endpoint = server
            .remote
            .as_ref()
            .ok_or(McpError::MissingUrlForAuth)?
            .url
            .clone();
        let metadata = http.fetch_authorization_metadata(&endpoint).await?;
        provider.assert_can_mutate()?;
        let mut refreshed = http
            .refresh_tokens(RefreshParams {
                token_endpoint: &metadata.token_endpoint,
                client_id: &client.client_id,
                refresh_token: &refresh_token,
                resource: &binding,
            })
            .await?;
        provider.assert_can_mutate()?;
        if refreshed.refresh_token.is_none() {
            refreshed.refresh_token = Some(refresh_token);
        }
        provider.save_tokens(refreshed.clone())?;
        tokens = refreshed;
    }
    if !tokens.token_type.eq_ignore_ascii_case("bearer")
        || tokens.access_token.is_empty()
        || tokens.access_token.contains(['\r', '\n'])
    {
        return Err(McpError::OAuthNeedsSignIn);
    }
    let remote = server.remote.as_mut().ok_or(McpError::MissingUrlForAuth)?;
    remote.headers.insert(
        http::header::AUTHORIZATION.as_str().to_string(),
        format!("Bearer {}", tokens.access_token),
    );
    Ok(server)
}

fn session_connection_verified(session: &McpOAuthSession) -> bool {
    session
        .extra
        .get(SESSION_VERIFIED_KEY)
        .and_then(serde_json::Value::as_bool)
        == Some(true)
}

fn token_needs_refresh(tokens: &McpOAuthTokens) -> bool {
    let Some(expires_in) = tokens.expires_in else {
        return false;
    };
    let Some(obtained_at) = tokens
        .extra
        .get(TOKEN_OBTAINED_AT_KEY)
        .and_then(serde_json::Value::as_u64)
    else {
        return true;
    };
    let expires_at = obtained_at.saturating_add(expires_in.saturating_mul(1000));
    current_time_millis().saturating_add(TOKEN_EXPIRY_SKEW_SECONDS * 1000) >= expires_at
}

fn commit_transaction(
    server: &crate::config::McpServerSpec,
    store: &dyn McpOAuthStore,
    gate: &McpOAuthOperationGate,
    is_current: &(dyn Fn() -> bool + Send + Sync),
    operation: &McpOAuthOperation,
    transaction_mutex: &Mutex<McpOAuthSessionTransaction>,
) -> Result<(), McpError> {
    if !is_current() || !gate.is_current_operation(operation) {
        return Err(McpError::OAuthStale);
    }
    let session = transaction_mutex.lock().unwrap().read();
    store.set_owned(&server.server.id, &session, &|| {
        is_current() && gate.is_current_operation(operation)
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::{get_mcp_preset, server_from_preset};
    use crate::util::base64url_encode;
    use std::sync::atomic::{AtomicUsize, Ordering};

    struct FakeOAuthHttp {
        metadata: McpAuthorizationServerMetadata,
        registered: McpOAuthClientInformation,
        refreshed: McpOAuthTokens,
        metadata_calls: AtomicUsize,
        refresh_calls: AtomicUsize,
    }

    impl FakeOAuthHttp {
        fn new() -> Self {
            Self {
                metadata: McpAuthorizationServerMetadata {
                    issuer: Some("https://auth.example.test".into()),
                    authorization_endpoint: "https://auth.example.test/authorize".into(),
                    token_endpoint: "https://auth.example.test/token".into(),
                    registration_endpoint: Some("https://auth.example.test/register".into()),
                    code_challenge_methods_supported: vec!["S256".into()],
                    scopes_supported: vec!["mcp:tools".into()],
                },
                registered: McpOAuthClientInformation {
                    client_id: "public-client".into(),
                    client_name: None,
                    redirect_uris: Some(vec![OAUTH_REDIRECT_URI.into()]),
                    token_endpoint_auth_method: Some("none".into()),
                    grant_types: Some(vec!["authorization_code".into(), "refresh_token".into()]),
                    extra: serde_json::Map::from_iter([(
                        "client_secret".into(),
                        serde_json::Value::String("must-not-persist".into()),
                    )]),
                },
                refreshed: McpOAuthTokens {
                    access_token: "new-access".into(),
                    token_type: "Bearer".into(),
                    refresh_token: None,
                    expires_in: Some(3600),
                    ..Default::default()
                },
                metadata_calls: AtomicUsize::new(0),
                refresh_calls: AtomicUsize::new(0),
            }
        }
    }

    impl McpOAuthHttp for FakeOAuthHttp {
        fn fetch_authorization_metadata(
            &self,
            _mcp_endpoint: &str,
        ) -> BoxFuture<'_, Result<McpAuthorizationServerMetadata, McpError>> {
            self.metadata_calls.fetch_add(1, Ordering::SeqCst);
            Box::pin(std::future::ready(Ok(self.metadata.clone())))
        }

        fn register_client(
            &self,
            _metadata: &McpAuthorizationServerMetadata,
            _client_metadata: &serde_json::Value,
        ) -> BoxFuture<'_, Result<Option<McpOAuthClientInformation>, McpError>> {
            Box::pin(std::future::ready(Ok(Some(self.registered.clone()))))
        }

        fn exchange_authorization_code(
            &self,
            _params: CodeExchangeParams<'_>,
        ) -> BoxFuture<'_, Result<McpOAuthTokens, McpError>> {
            Box::pin(std::future::ready(Ok(McpOAuthTokens {
                access_token: "authorization-access".into(),
                token_type: "Bearer".into(),
                refresh_token: Some("authorization-refresh".into()),
                ..Default::default()
            })))
        }

        fn refresh_tokens(
            &self,
            _params: RefreshParams<'_>,
        ) -> BoxFuture<'_, Result<McpOAuthTokens, McpError>> {
            self.refresh_calls.fetch_add(1, Ordering::SeqCst);
            Box::pin(std::future::ready(Ok(self.refreshed.clone())))
        }
    }

    fn oauth_server() -> crate::config::McpServerSpec {
        crate::config::resolve_mcp_server(&aiden_data::portable_config::McpServer {
            id: "custom-oauth".into(),
            name: "Custom OAuth".into(),
            transport: aiden_data::portable_config::McpTransport::Http,
            command: None,
            args: None,
            env: None,
            url: Some("https://mcp.example.test/mcp?tenant=a".into()),
            headers: None,
            oauth: Some(true),
            preset_id: None,
            enabled: true,
        })
        .unwrap()
    }

    fn sample_session() -> McpOAuthSession {
        McpOAuthSession {
            authorization_binding: Some("https://mcp.example.test/mcp".into()),
            client_information: Some(McpOAuthClientInformation {
                client_id: "client-1".into(),
                client_name: None,
                redirect_uris: Some(vec![OAUTH_REDIRECT_URI.into()]),
                token_endpoint_auth_method: Some("none".into()),
                grant_types: Some(vec!["authorization_code".into(), "refresh_token".into()]),
                extra: serde_json::Map::new(),
            }),
            tokens: Some(McpOAuthTokens {
                access_token: "old-token".into(),
                token_type: "bearer".into(),
                refresh_token: Some("old-refresh".into()),
                scope: None,
                expires_in: Some(3600),
                extra: serde_json::Map::new(),
            }),
            code_verifier: Some("old-verifier".into()),
            extra: serde_json::Map::new(),
        }
    }

    #[test]
    fn fresh_authorization_preserves_registration_and_drops_tokens() {
        let session = sample_session();
        let binding = session.authorization_binding.clone().unwrap();
        let fresh = session_for_fresh_mcp_authorization(&session, &binding);
        assert_eq!(
            fresh.authorization_binding.as_deref(),
            Some(binding.as_str())
        );
        assert_eq!(
            fresh.client_information.as_ref().unwrap().client_id,
            "client-1"
        );
        assert_eq!(fresh.tokens, None);
        assert_eq!(fresh.code_verifier, None);
        assert_eq!(
            session.tokens.as_ref().unwrap().access_token,
            "old-token",
            "the rollback snapshot must not mutate"
        );
    }

    #[test]
    fn fresh_authorization_starts_empty_without_prior_registration() {
        let session = McpOAuthSession {
            tokens: Some(McpOAuthTokens {
                access_token: "old-token".into(),
                token_type: "bearer".into(),
                ..Default::default()
            }),
            ..Default::default()
        };
        let fresh = session_for_fresh_mcp_authorization(&session, "https://mcp.example.test/mcp");
        assert_eq!(
            fresh,
            McpOAuthSession::bound("https://mcp.example.test/mcp")
        );
    }

    #[test]
    fn registration_is_discarded_when_the_resource_endpoint_changes() {
        let mut old = sample_session();
        old.tokens = None;
        old.code_verifier = None;
        old.client_information = Some(McpOAuthClientInformation {
            client_id: "client-1".into(),
            client_name: None,
            redirect_uris: None,
            token_endpoint_auth_method: None,
            grant_types: None,
            extra: {
                let mut map = serde_json::Map::new();
                map.insert(
                    "client_secret".into(),
                    serde_json::Value::String("secret".into()),
                );
                map
            },
        });
        let fresh = session_for_fresh_mcp_authorization(&old, "https://attacker.example/mcp");
        assert_eq!(
            fresh,
            McpOAuthSession::bound("https://attacker.example/mcp")
        );
        assert!(!session_matches_mcp_binding(
            &old,
            "https://attacker.example/mcp"
        ));
    }

    #[test]
    fn authorization_binding_preserves_queries_and_removes_fragments_and_trailing_slash() {
        assert_eq!(
            mcp_authorization_binding("https://MCP.Example.test/mcp/?tenant=a#fragment"),
            "https://MCP.Example.test/mcp?tenant=a"
        );
        assert_ne!(
            mcp_authorization_binding("https://mcp.example.test/mcp?tenant=a"),
            mcp_authorization_binding("https://mcp.example.test/mcp?tenant=b")
        );
        // Legacy bindings (no query) fail closed against tenant-scoped URLs.
        assert!(!session_matches_mcp_binding(
            &McpOAuthSession::bound("https://mcp.example.test/mcp"),
            "https://mcp.example.test/mcp?tenant=a"
        ));
        assert_eq!(
            mcp_authorization_binding("https://mcp.example.test/mcp"),
            "https://mcp.example.test/mcp"
        );
    }

    #[test]
    fn dynamic_registration_secrets_are_not_retained() {
        let mut information = McpOAuthClientInformation {
            client_id: "public-client".into(),
            client_name: None,
            redirect_uris: Some(vec!["http://127.0.0.1/callback".into()]),
            token_endpoint_auth_method: None,
            grant_types: None,
            extra: serde_json::Map::new(),
        };
        information.extra.insert(
            "client_secret".into(),
            serde_json::Value::String("must-not-persist".into()),
        );
        information
            .extra
            .insert("client_secret_expires_at".into(), serde_json::json!(123));
        let public = public_mcp_client_information(&information);
        assert_eq!(public.client_id, "public-client");
        assert_eq!(
            public.redirect_uris,
            Some(vec!["http://127.0.0.1/callback".into()])
        );
        assert!(public.extra.get("client_secret").is_none());
        assert!(public.extra.get("client_secret_expires_at").is_none());
    }

    #[test]
    fn session_data_detection_distinguishes_an_absent_snapshot() {
        assert!(!has_mcp_oauth_session_data(&McpOAuthSession::default()));
        let tokens_only = McpOAuthSession {
            tokens: Some(McpOAuthTokens {
                access_token: "token".into(),
                token_type: "bearer".into(),
                ..Default::default()
            }),
            ..Default::default()
        };
        assert!(has_mcp_oauth_session_data(&tokens_only));
    }

    #[test]
    fn transaction_buffers_replacement_credentials_until_explicit_commit() {
        let previous = sample_session();
        let mut transaction = McpOAuthSessionTransaction::new(session_for_fresh_mcp_authorization(
            &previous,
            previous.authorization_binding.as_deref().unwrap(),
        ));
        let mut staged = transaction.read();
        staged.tokens = Some(McpOAuthTokens {
            access_token: "new-token".into(),
            token_type: "bearer".into(),
            ..Default::default()
        });
        transaction.replace(staged);
        assert_eq!(previous.tokens.as_ref().unwrap().access_token, "old-token");
        assert_eq!(
            transaction.read().tokens.as_ref().unwrap().access_token,
            "new-token"
        );
        // Reads return clones; mutating the returned value cannot leak back.
        let mut leaked = transaction.read();
        leaked.tokens.as_mut().unwrap().access_token = "mutated-outside".into();
        assert_eq!(
            transaction.read().tokens.as_ref().unwrap().access_token,
            "new-token"
        );
    }

    #[test]
    fn malformed_sessions_are_rejected_and_future_fields_preserved() {
        for malformed in [
            serde_json::Value::Null,
            serde_json::json!([]),
            serde_json::json!({"tokens": null}),
            serde_json::json!({"tokens": {"access_token": "token"}}),
            serde_json::json!({"clientInformation": {"client_id": 7}}),
            serde_json::json!({"codeVerifier": 7}),
        ] {
            let err = parse_mcp_oauth_session(malformed.clone()).unwrap_err();
            assert!(
                matches!(err, McpError::OAuthSessionMalformed(_)),
                "expected session error for {malformed}, got {err}"
            );
        }

        let parsed = parse_mcp_oauth_session(serde_json::json!({
            "authorizationBinding": "https://mcp.example.test/mcp",
            "tokens": {
                "access_token": "token",
                "token_type": "bearer",
                "futureTokenHint": {"mode": "device"}
            },
            "futureSessionState": {"generation": 2}
        }))
        .unwrap();
        assert_eq!(
            parsed.extra.get("futureSessionState"),
            Some(&serde_json::json!({"generation": 2}))
        );
        assert_eq!(
            parsed.tokens.unwrap().extra.get("futureTokenHint"),
            Some(&serde_json::json!({"mode": "device"}))
        );
    }

    // -- operation gate -----------------------------------------------------

    #[test]
    fn background_oauth_cannot_mutate_pkce_while_interactive_owns_the_server() {
        let gate = McpOAuthOperationGate::new();
        let background = gate.snapshot("linear");
        let operation = gate.begin("linear").unwrap();
        // The background snapshot (no signal) cannot mutate while the
        // interactive flow owns the server...
        assert!(gate.assert_mutation_allowed("linear", &background).is_err());
        // ...the interactive operation itself is current and may mutate...
        assert!(gate.is_current_operation(&operation));
        // ...and unrelated servers are untouched.
        assert!(gate
            .assert_mutation_allowed("notion", &gate.snapshot("notion"))
            .is_ok());
        gate.end(&operation);
        assert!(gate
            .assert_mutation_allowed("linear", &gate.snapshot("linear"))
            .is_ok());
    }

    #[test]
    fn duplicate_interactive_authorization_is_rejected() {
        let gate = McpOAuthOperationGate::new();
        gate.begin("linear").unwrap();
        assert!(matches!(
            gate.begin("linear"),
            Err(McpError::OAuthInProgress)
        ));
    }

    #[test]
    fn concurrent_begins_atomically_admit_exactly_one_owner() {
        let gate = std::sync::Arc::new(McpOAuthOperationGate::new());
        let barrier = std::sync::Arc::new(std::sync::Barrier::new(3));
        let handles = (0..2)
            .map(|_| {
                let gate = gate.clone();
                let barrier = barrier.clone();
                std::thread::spawn(move || {
                    barrier.wait();
                    gate.begin("linear")
                })
            })
            .collect::<Vec<_>>();
        barrier.wait();
        let results = handles
            .into_iter()
            .map(|handle| handle.join().unwrap())
            .collect::<Vec<_>>();
        assert_eq!(results.iter().filter(|result| result.is_ok()).count(), 1);
        assert_eq!(
            results
                .iter()
                .filter(|result| matches!(result, Err(McpError::OAuthInProgress)))
                .count(),
            1
        );
    }

    #[test]
    fn operation_end_guard_releases_owner_when_flow_is_dropped() {
        let gate = McpOAuthOperationGate::new();
        let operation = gate.begin("linear").unwrap();
        let guard = OAuthOperationEndGuard {
            gate: &gate,
            operation,
        };
        assert!(matches!(
            gate.begin("linear"),
            Err(McpError::OAuthInProgress)
        ));
        drop(guard);
        assert!(gate.begin("linear").is_ok());
    }

    #[test]
    fn invalidation_aborts_the_old_generation_without_clearing_a_newer_flow() {
        let gate = McpOAuthOperationGate::new();
        let old = gate.begin("linear").unwrap();
        gate.invalidate("linear");
        assert!(old.aborted());
        assert!(!gate.is_current(&old.generation()));
        assert!(gate
            .assert_mutation_allowed("linear", &old.generation())
            .is_err());

        let current = gate.begin("linear").unwrap();
        gate.end(&old);
        assert!(gate.is_current_operation(&current));
        gate.end(&current);
    }

    #[test]
    fn invalidation_permanently_supersedes_a_background_generation() {
        let gate = McpOAuthOperationGate::new();
        let background = gate.snapshot("linear");
        assert!(gate.assert_mutation_allowed("linear", &background).is_ok());
        gate.invalidate("linear");
        assert!(gate.assert_mutation_allowed("linear", &background).is_err());
        assert!(gate
            .assert_mutation_allowed("linear", &gate.snapshot("linear"))
            .is_ok());
    }

    #[test]
    fn suspension_blocks_new_operations_and_stale_writers_until_release() {
        let gate = McpOAuthOperationGate::new();
        let background = gate.snapshot("linear");
        let release = gate.suspend("linear");
        assert!(matches!(gate.begin("linear"), Err(McpError::OAuthUpdating)));
        assert!(gate.assert_mutation_allowed("linear", &background).is_err());
        let during = gate.snapshot("linear");
        assert!(!gate.is_current(&during));
        drop(release);
        assert!(!gate.is_current(&during));
        let next = gate.begin("linear").unwrap();
        assert!(gate.is_current_operation(&next));
    }

    #[test]
    fn is_current_distinguishes_background_and_interactive_generations() {
        let gate = McpOAuthOperationGate::new();
        let operation = gate.begin("linear").unwrap();
        // The interactive operation is current while owned...
        assert!(gate.is_current_operation(&operation));
        // ...but a background snapshot is not (the interactive flow owns it).
        assert!(!gate.is_current(&gate.snapshot("linear")));
        gate.end(&operation);
        assert!(gate.is_current(&gate.snapshot("linear")));
    }

    // -- PKCE ---------------------------------------------------------------

    #[test]
    fn pkce_verifier_and_challenge_are_well_formed() {
        let pair = PkcePair::new().unwrap();
        assert!((43..=128).contains(&pair.verifier.len()));
        assert!(pair
            .verifier
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_'));
        // S256 challenge = base64url(sha256(verifier)).
        let mut hasher = Sha256::new();
        hasher.update(pair.verifier.as_bytes());
        assert_eq!(pair.challenge, base64url_encode(&hasher.finalize()));
        assert!(!pair.challenge.contains('='), "no padding");
    }

    #[test]
    fn pkce_pairs_are_random() {
        let a = PkcePair::new().unwrap();
        let b = PkcePair::new().unwrap();
        assert_ne!(a.verifier, b.verifier);
        assert_ne!(a.challenge, b.challenge);
    }

    #[test]
    fn s256_challenge_is_deterministic() {
        let verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
        assert_eq!(
            pkce_s256_challenge(verifier),
            "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM"
        );
    }

    // -- loopback -----------------------------------------------------------

    #[tokio::test]
    async fn loopback_captures_an_authorization_code() {
        let server = LoopbackServer::bind(0).await.unwrap();
        let port = server.port();
        assert_ne!(port, 0);
        let request =
            format!("GET /callback?code=abc123&state=s HTTP/1.1\r\nhost: 127.0.0.1:{port}\r\n\r\n");
        tokio::spawn(async move {
            use tokio::io::{AsyncReadExt, AsyncWriteExt};
            let mut stream = tokio::net::TcpStream::connect(("127.0.0.1", port))
                .await
                .unwrap();
            stream.write_all(request.as_bytes()).await.unwrap();
            let mut response = Vec::new();
            stream.read_to_end(&mut response).await.unwrap();
            let response = String::from_utf8_lossy(&response);
            assert!(response.starts_with("HTTP/1.1 200 OK"));
            assert!(response.contains("Connected"));
        });
        let code = server
            .wait_for_code(None, Some(std::time::Duration::from_secs(5)))
            .await
            .unwrap();
        assert_eq!(code, "abc123");
    }

    #[tokio::test]
    async fn loopback_rejects_denied_and_other_paths() {
        let denied = LoopbackServer::bind(0).await.unwrap();
        let port = denied.port();
        tokio::spawn(async move {
            let mut stream = tokio::net::TcpStream::connect(("127.0.0.1", port))
                .await
                .unwrap();
            let _ = stream
                .write_all(b"GET /callback?error=access_denied&error_description=user%20said%20no HTTP/1.1\r\n\r\n")
                .await;
            let mut buf = [0u8; 256];
            let _ = stream.read(&mut buf).await;
        });
        let err = denied
            .wait_for_code(None, Some(std::time::Duration::from_secs(5)))
            .await
            .unwrap_err();
        assert!(matches!(err, McpError::OAuthDenied(_)));

        let no_code = LoopbackServer::bind(0).await.unwrap();
        let port = no_code.port();
        tokio::spawn(async move {
            let mut stream = tokio::net::TcpStream::connect(("127.0.0.1", port))
                .await
                .unwrap();
            let _ = stream
                .write_all(b"GET /callback?state=x HTTP/1.1\r\n\r\n")
                .await;
            let mut buf = [0u8; 256];
            let _ = stream.read(&mut buf).await;
        });
        let err = no_code
            .wait_for_code(None, Some(std::time::Duration::from_secs(5)))
            .await
            .unwrap_err();
        assert!(matches!(err, McpError::OAuthNoCode));
    }

    #[tokio::test]
    async fn loopback_honors_the_abort_signal() {
        let server = LoopbackServer::bind(0).await.unwrap();
        let token = AbortToken::new();
        let receiver = token.subscribe();
        token.abort();
        let err = server
            .wait_for_code(Some(&receiver), Some(std::time::Duration::from_secs(10)))
            .await
            .unwrap_err();
        assert!(matches!(err, McpError::OAuthSuperseded));
    }

    #[tokio::test]
    async fn loopback_reports_a_busy_port() {
        let first = LoopbackServer::bind(0).await.unwrap();
        let err = LoopbackServer::bind(first.port()).await.unwrap_err();
        assert!(matches!(err, McpError::OAuthPortBusy(_)));
    }

    #[tokio::test]
    async fn loopback_times_out_without_a_callback() {
        let server = LoopbackServer::bind(0).await.unwrap();
        let err = server
            .wait_for_code(None, Some(std::time::Duration::from_millis(50)))
            .await
            .unwrap_err();
        assert!(matches!(err, McpError::OAuthTimeout));
    }

    // -- store + provider ---------------------------------------------------

    #[test]
    fn provider_persists_tokens_and_registration_through_the_store() {
        let store = MemoryMcpOAuthStore::new();
        let gate = McpOAuthOperationGate::new();
        let provider = McpOAuthProvider::new(
            "linear".into(),
            "https://mcp.linear.app/mcp".into(),
            None,
            &gate,
            &store,
            None,
            &|| true,
        );
        provider
            .save_client_information(&McpOAuthClientInformation {
                client_id: "linear-client".into(),
                client_name: None,
                redirect_uris: Some(vec![OAUTH_REDIRECT_URI.into()]),
                token_endpoint_auth_method: None,
                grant_types: None,
                extra: serde_json::Map::new(),
            })
            .unwrap();
        provider
            .save_tokens(McpOAuthTokens {
                access_token: "access".into(),
                token_type: "bearer".into(),
                refresh_token: Some("refresh".into()),
                scope: None,
                expires_in: None,
                extra: serde_json::Map::new(),
            })
            .unwrap();
        provider.save_code_verifier("verifier-abc".into()).unwrap();

        let stored = store.get("linear").unwrap();
        assert_eq!(
            stored.client_information.unwrap().client_id,
            "linear-client"
        );
        assert_eq!(stored.tokens.unwrap().access_token, "access");
        assert_eq!(stored.code_verifier.as_deref(), Some("verifier-abc"));
        assert_eq!(
            stored.authorization_binding.as_deref(),
            Some("https://mcp.linear.app/mcp")
        );

        // A background generation cannot mutate while an interactive flow owns
        // the server.
        let operation = gate.begin("linear").unwrap();
        let provider_holding = McpOAuthProvider::new(
            "linear".into(),
            "https://mcp.linear.app/mcp".into(),
            Some(operation.clone()),
            &gate,
            &store,
            None,
            &|| true,
        );
        assert!(provider_holding
            .save_tokens(McpOAuthTokens {
                access_token: "x".into(),
                token_type: "bearer".into(),
                ..Default::default()
            })
            .is_ok());
        // A background provider of the same generation cannot mutate while
        // the interactive flow owns the server.
        assert!(McpOAuthProvider::new(
            "linear".into(),
            "https://mcp.linear.app/mcp".into(),
            None,
            &gate,
            &store,
            None,
            &|| true,
        )
        .save_tokens(McpOAuthTokens {
            access_token: "x".into(),
            token_type: "bearer".into(),
            ..Default::default()
        })
        .is_err());
        gate.end(&operation);
    }

    #[test]
    fn provider_invalidates_credentials_by_scope() {
        let store = MemoryMcpOAuthStore::new();
        let gate = McpOAuthOperationGate::new();
        let provider = McpOAuthProvider::new(
            "linear".into(),
            "https://mcp.linear.app/mcp".into(),
            None,
            &gate,
            &store,
            None,
            &|| true,
        );
        provider
            .save_tokens(McpOAuthTokens {
                access_token: "access".into(),
                token_type: "bearer".into(),
                refresh_token: Some("refresh".into()),
                ..Default::default()
            })
            .unwrap();
        provider.save_code_verifier("v".into()).unwrap();
        provider
            .invalidate_credentials(McpOAuthInvalidationScope::Tokens)
            .unwrap();
        assert!(store.get("linear").unwrap().tokens.is_none());
        assert!(store.get("linear").unwrap().code_verifier.is_some());
        provider
            .invalidate_credentials(McpOAuthInvalidationScope::All)
            .unwrap();
        assert_eq!(store.get("linear").unwrap(), McpOAuthSession::default());
    }

    #[test]
    fn provider_non_interactive_redirect_fails_loudly() {
        let store = MemoryMcpOAuthStore::new();
        let gate = McpOAuthOperationGate::new();
        let provider = McpOAuthProvider::new(
            "linear".into(),
            "https://mcp.linear.app/mcp".into(),
            None,
            &gate,
            &store,
            None,
            &|| true,
        );
        let err = provider
            .redirect_to_authorization("https://example.test/auth")
            .unwrap_err();
        assert_eq!(err, McpError::OAuthNeedsSignIn);
    }

    #[test]
    fn preset_server_specs_resolve_for_oauth() {
        let notion = get_mcp_preset("notion").unwrap();
        let server = server_from_preset(notion, None).unwrap();
        let spec = resolve_mcp_server(&server).unwrap();
        assert_eq!(
            spec.authorization_binding().as_deref(),
            Some("https://mcp.notion.com/mcp")
        );
        assert!(!spec.requires_preset_api_key());
    }

    #[tokio::test]
    async fn discovery_registration_and_pkce_build_an_exact_public_authorization_url() {
        let store = MemoryMcpOAuthStore::new();
        let gate = McpOAuthOperationGate::new();
        let http = FakeOAuthHttp::new();
        let server = oauth_server();
        let provider = McpOAuthProvider::new(
            server.server.id.clone(),
            server.authorization_binding().unwrap(),
            None,
            &gate,
            &store,
            None,
            &|| true,
        );

        let (url, metadata, state) = build_authorization_url(
            &server,
            &provider,
            &server.authorization_binding().unwrap(),
            &http,
        )
        .await
        .unwrap();
        let url = reqwest::Url::parse(&url).unwrap();
        let query = url
            .query_pairs()
            .into_owned()
            .collect::<std::collections::BTreeMap<_, _>>();
        assert_eq!(metadata.token_endpoint, "https://auth.example.test/token");
        assert_eq!(
            query.get("client_id").map(String::as_str),
            Some("public-client")
        );
        assert_eq!(
            query.get("code_challenge_method").map(String::as_str),
            Some("S256")
        );
        assert_eq!(query.get("state").map(String::as_str), Some(state.as_str()));
        assert_eq!(
            query.get("resource").map(String::as_str),
            Some("https://mcp.example.test/mcp?tenant=a")
        );
        assert!(query
            .get("code_challenge")
            .is_some_and(|value| !value.is_empty()));
        let stored = store.get("custom-oauth").unwrap();
        assert!(stored.code_verifier.is_some());
        assert!(stored
            .client_information
            .unwrap()
            .extra
            .get("client_secret")
            .is_none());
    }

    #[tokio::test]
    async fn unattended_resolution_never_discovers_or_opens_a_browser_without_a_session() {
        let http = FakeOAuthHttp::new();
        let error = resolve_noninteractive_oauth(
            oauth_server(),
            &MemoryMcpOAuthStore::new(),
            &McpOAuthOperationGate::new(),
            &http,
            &|| true,
        )
        .await
        .unwrap_err();
        assert_eq!(error, McpError::OAuthNeedsSignIn);
        assert_eq!(http.metadata_calls.load(Ordering::SeqCst), 0);
    }

    #[tokio::test]
    async fn unattended_resolution_refreshes_expired_tokens_and_retains_rotating_refresh_token() {
        let server = oauth_server();
        let store = MemoryMcpOAuthStore::new();
        let mut session = McpOAuthSession::bound(server.authorization_binding().unwrap());
        session
            .extra
            .insert(SESSION_VERIFIED_KEY.into(), serde_json::Value::Bool(true));
        session.client_information = Some(FakeOAuthHttp::new().registered);
        session.tokens = Some(McpOAuthTokens {
            access_token: "expired-access".into(),
            token_type: "Bearer".into(),
            refresh_token: Some("keep-refresh".into()),
            expires_in: Some(1),
            extra: serde_json::Map::from_iter([(
                TOKEN_OBTAINED_AT_KEY.into(),
                serde_json::Value::from(0_u64),
            )]),
            ..Default::default()
        });
        store.set(&server.server.id, &session).unwrap();
        let http = FakeOAuthHttp::new();
        let resolved = resolve_noninteractive_oauth(
            server,
            &store,
            &McpOAuthOperationGate::new(),
            &http,
            &|| true,
        )
        .await
        .unwrap();
        assert_eq!(http.refresh_calls.load(Ordering::SeqCst), 1);
        assert_eq!(
            resolved
                .remote
                .unwrap()
                .headers
                .get("authorization")
                .map(String::as_str),
            Some("Bearer new-access")
        );
        let stored = store.get("custom-oauth").unwrap().tokens.unwrap();
        assert_eq!(stored.refresh_token.as_deref(), Some("keep-refresh"));
    }

    #[tokio::test]
    async fn exact_connection_rebinding_fails_closed_before_network() {
        let server = oauth_server();
        let store = MemoryMcpOAuthStore::new();
        let mut session = sample_session();
        session.authorization_binding = Some("https://mcp.example.test/mcp?tenant=other".into());
        store.set(&server.server.id, &session).unwrap();
        assert_eq!(
            oauth_status(&server, &store).unwrap(),
            McpOAuthStatus::NeedsSignIn
        );
        let http = FakeOAuthHttp::new();
        let error = resolve_noninteractive_oauth(
            server,
            &store,
            &McpOAuthOperationGate::new(),
            &http,
            &|| true,
        )
        .await
        .unwrap_err();
        assert_eq!(error, McpError::OAuthNeedsSignIn);
        assert_eq!(http.metadata_calls.load(Ordering::SeqCst), 0);
    }

    #[test]
    fn secure_oauth_urls_deny_userinfo_fragments_and_non_loopback_http() {
        for denied in [
            "http://mcp.example.test/mcp",
            "https://user:password@mcp.example.test/mcp",
            "https://mcp.example.test/mcp#secret",
        ] {
            assert!(
                secure_url(denied, "test endpoint").is_err(),
                "accepted {denied}"
            );
        }
        assert!(secure_url("http://127.0.0.1:4321/mcp", "loopback").is_ok());
        assert!(secure_url("https://10.0.0.1/mcp", "private literal").is_err());
        assert!(validate_discovered_endpoint(
            Some("https://auth.example.test"),
            "https://other.example.test/token",
            "token endpoint"
        )
        .is_err());
    }

    #[test]
    fn protected_resource_metadata_requires_exact_resource_and_bounded_fields() {
        let endpoint = reqwest::Url::parse("https://mcp.example.test/mcp").unwrap();
        let valid = ProtectedResourceMetadata {
            resource: endpoint.as_str().into(),
            authorization_servers: vec!["https://auth.example.test".into()],
            scopes_supported: vec!["mcp:tools".into()],
        };
        assert!(validate_protected_resource_metadata(&endpoint, &valid).is_ok());

        let wrong = ProtectedResourceMetadata {
            resource: "https://other.example.test/mcp".into(),
            ..valid
        };
        assert!(validate_protected_resource_metadata(&endpoint, &wrong).is_err());
        let oversized = ProtectedResourceMetadata {
            resource: endpoint.as_str().into(),
            authorization_servers: vec!["https://auth.example.test".into()],
            scopes_supported: vec!["x".repeat(MAX_OAUTH_SCOPE_LEN + 1)],
        };
        assert!(validate_protected_resource_metadata(&endpoint, &oversized).is_err());
    }

    #[test]
    fn discovery_urls_follow_rfc8414_and_openid_path_rules() {
        let issuer = reqwest::Url::parse("https://auth.example.test/tenant").unwrap();
        assert_eq!(
            authorization_server_metadata_url(&issuer).unwrap().as_str(),
            "https://auth.example.test/.well-known/oauth-authorization-server/tenant"
        );
        assert_eq!(
            openid_configuration_url(&issuer).as_str(),
            "https://auth.example.test/tenant/.well-known/openid-configuration"
        );
    }

    #[tokio::test]
    async fn production_discovery_honors_www_authenticate_resource_metadata() {
        let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
            .await
            .unwrap();
        let port = listener.local_addr().unwrap().port();
        let endpoint = format!("http://127.0.0.1:{port}/mcp");
        let endpoint_for_server = endpoint.clone();
        let server = tokio::spawn(async move {
            for index in 0..2 {
                let (mut stream, _) = listener.accept().await.unwrap();
                let mut request = [0_u8; 2048];
                let read = stream.read(&mut request).await.unwrap();
                let request = String::from_utf8_lossy(&request[..read]);
                if index == 0 {
                    assert!(request.starts_with("GET /mcp "));
                    let challenge = format!(
                        "HTTP/1.1 401 Unauthorized\r\nWWW-Authenticate: Bearer resource_metadata=\"http://127.0.0.1:{port}/prm\"\r\nContent-Length: 0\r\n\r\n"
                    );
                    stream.write_all(challenge.as_bytes()).await.unwrap();
                } else {
                    assert!(request.starts_with("GET /prm "));
                    let body = serde_json::json!({
                        "resource": endpoint_for_server,
                        "authorization_servers": [format!("http://127.0.0.1:{port}")],
                        "scopes_supported": ["mcp:tools"]
                    })
                    .to_string();
                    let response = format!(
                        "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n{body}",
                        body.len()
                    );
                    stream.write_all(response.as_bytes()).await.unwrap();
                }
            }
        });
        let runtime = ReqwestMcpOAuthHttp::default();
        let endpoint_url = reqwest::Url::parse(&endpoint).unwrap();

        let metadata = discover_protected_resource_metadata(&runtime.client, &endpoint_url)
            .await
            .unwrap();

        assert_eq!(metadata.resource, endpoint);
        assert_eq!(metadata.scopes_supported, vec!["mcp:tools"]);
        server.await.unwrap();
    }

    #[tokio::test]
    async fn production_http_does_not_follow_redirects_or_leak_error_bodies() {
        let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
            .await
            .unwrap();
        let port = listener.local_addr().unwrap().port();
        tokio::spawn(async move {
            use tokio::io::{AsyncReadExt, AsyncWriteExt};
            let (mut stream, _) = listener.accept().await.unwrap();
            let mut request = [0_u8; 2048];
            let _ = stream.read(&mut request).await;
            stream
                .write_all(
                    b"HTTP/1.1 302 Found\r\nLocation: https://attacker.example/token\r\nContent-Length: 26\r\n\r\naccess_token=super-secret",
                )
                .await
                .unwrap();
        });
        let runtime = ReqwestMcpOAuthHttp::default();
        let error = get_json_bounded::<ProtectedResourceMetadata>(
            &runtime.client,
            reqwest::Url::parse(&format!("http://127.0.0.1:{port}/metadata")).unwrap(),
        )
        .await
        .unwrap_err()
        .to_string();
        assert!(error.contains("HTTP 302"));
        assert!(!error.contains("super-secret"));
        assert!(!error.contains("attacker.example"));
    }

    // -- form encoding ------------------------------------------------------

    #[test]
    fn form_encoding_percent_encodes_non_unreserved_chars() {
        let body = form_encode(&[("code", "a b+c/d")]);
        assert_eq!(body, "code=a%20b%2Bc%2Fd");
    }
}
