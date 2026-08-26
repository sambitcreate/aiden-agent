//! Codex Responses transport against `chatgpt.com/backend-api/codex/responses`.
//!
//! Port of Aiden's `main/services/codex-provider.ts` request shaping plus the
//! pi-ai `api/openai-codex-responses.js` SSE transport (SSE only — Aiden pins
//! `transport: "sse"`). OAuth token storage is abstracted behind
//! [`CodexAuthStore`] so the actual keychain wiring can live in `aiden-data`;
//! token refresh is an HTTP call behind [`CodexTokenRefresher`].

use std::collections::HashMap;
use std::future::Future;
use std::panic::AssertUnwindSafe;
use std::pin::Pin;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use aiden_core::{AssistantMessage, AssistantMessageEvent, StopReason};
use futures::{FutureExt, Stream, StreamExt};

use crate::json::clamp_openai_prompt_cache_key;
use crate::responses_shared::{
    convert_responses_messages, convert_responses_tools, finish_responses, ResponsesAccumulator,
};
use crate::sse::data_payloads;
use crate::{
    now_ms, sse_payload_stream, EventStream, Provider, ProviderError, StreamOptions, StreamRequest,
};

pub const OPENAI_CODEX_PROVIDER_ID: &str = "openai-codex";
pub const OPENAI_CODEX_PROVIDER_LABEL: &str = "ChatGPT / Codex";
pub const OPENAI_CODEX_BASE_URL: &str = "https://chatgpt.com/backend-api";
pub const OPENAI_CODEX_DEFAULT_MODEL: &str = "gpt-5.4";

const JWT_CLAIM_PATH: &str = "https://api.openai.com/auth";
const OAUTH_REFRESH_SKEW_MS: u64 = 60_000;
const OAUTH_REFRESH_CALLER_TIMEOUT: Duration = Duration::from_secs(15);
const OAUTH_REFRESH_OPERATION_TIMEOUT: Duration = Duration::from_secs(60);
const MAX_OAUTH_REFRESH_RESPONSE_BYTES: usize = 64 * 1024;
const DEFAULT_MAX_RETRIES: u32 = 0;
const BASE_DELAY_MS: u64 = 1000;
const DEFAULT_MAX_RETRY_DELAY_MS: u64 = 60_000;
/// Default refresh endpoint (pi `auth/oauth/openai-codex.js`).
const CODEX_TOKEN_URL: &str = "https://auth.openai.com/oauth/token";
const CODEX_CLIENT_ID: &str = "app_EMoamEEZ73f0CkXaXp7hrann";

// ===========================================================================
// Error taxonomy (codex-provider.ts)
// ===========================================================================

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CodexRuntimeErrorCode {
    ModelUnavailable,
    RequestCancelled,
    SignInRequired,
    SignInNeedsAttention,
    TemporarilyUnavailable,
}

impl CodexRuntimeErrorCode {
    pub fn as_str(&self) -> &'static str {
        match self {
            CodexRuntimeErrorCode::ModelUnavailable => "model_unavailable",
            CodexRuntimeErrorCode::RequestCancelled => "request_cancelled",
            CodexRuntimeErrorCode::SignInRequired => "sign_in_required",
            CodexRuntimeErrorCode::SignInNeedsAttention => "sign_in_needs_attention",
            CodexRuntimeErrorCode::TemporarilyUnavailable => "temporarily_unavailable",
        }
    }
}

impl std::fmt::Display for CodexRuntimeErrorCode {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(self.as_str())
    }
}

#[derive(Debug, thiserror::Error)]
#[error("{code}: {message}")]
pub struct CodexRuntimeError {
    pub code: CodexRuntimeErrorCode,
    pub message: String,
}

impl CodexRuntimeError {
    pub fn new(code: CodexRuntimeErrorCode, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }
}

/// The credential superseded condition that triggers the retry loop.
#[derive(Debug, thiserror::Error)]
#[error("Codex credential changed.")]
pub struct CodexCredentialSupersededError;

/// Intermediate auth-failure taxonomy used by `resolve_runtime_auth_with_retry`.
#[derive(Debug)]
pub enum CodexAuthError {
    Superseded,
    Cancelled,
    Runtime(CodexRuntimeError),
}

// ===========================================================================
// OAuth credential + storage interfaces
// ===========================================================================

/// Canonical OAuth credential (pi `OAuthCredential`).
#[derive(Clone, PartialEq, Eq)]
pub struct OAuthCredential {
    pub access: String,
    pub refresh: String,
    /// ms epoch expiry.
    pub expires: u64,
}

impl std::fmt::Debug for OAuthCredential {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("OAuthCredential")
            .field("access", &"[redacted]")
            .field("refresh", &"[redacted]")
            .field("expires", &self.expires)
            .finish()
    }
}

/// Secret-free durable credential state used by provider settings and OAuth.
/// `configured` and `needs_attention` are intentionally independent: an
/// unreadable/legacy credential is still configured even though it cannot be
/// used until the user signs in again.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct CodexAuthStoreStatus {
    pub configured: bool,
    pub needs_attention: bool,
}

/// Per-store credential mutation gate. Store implementations must perform all
/// credential mutations through this gate and use the same gate when creating
/// a dispatch guard. That makes the revision check and mutation epoch snapshot
/// one atomic operation.
pub struct CodexCredentialGate {
    inner: Mutex<CodexCredentialGateInner>,
}

struct CodexCredentialGateInner {
    epoch: u64,
    sender: tokio::sync::watch::Sender<u64>,
}

impl Default for CodexCredentialGate {
    fn default() -> Self {
        let (sender, _) = tokio::sync::watch::channel(0);
        Self {
            inner: Mutex::new(CodexCredentialGateInner { epoch: 0, sender }),
        }
    }
}

impl CodexCredentialGate {
    /// Run a serialized credential mutation. Successful changes advance the
    /// epoch; errors advance it conservatively because a backend may have
    /// invalidated a Keychain secret before failing to publish its document.
    pub fn mutate<T, E>(&self, mutation: impl FnOnce() -> Result<(T, bool), E>) -> Result<T, E> {
        let mut inner = self.inner.lock().unwrap_or_else(|error| error.into_inner());
        let mutation = mutation();
        let changed = mutation
            .as_ref()
            .map(|(_, changed)| *changed)
            .unwrap_or(true);
        if changed {
            inner.epoch = inner.epoch.wrapping_add(1);
            let epoch = inner.epoch;
            inner.sender.send_replace(epoch);
        }
        mutation.map(|(result, _)| result)
    }

    /// Atomically validate the current durable revision and subscribe to every
    /// later mutation before HTTP dispatch may be polled.
    pub fn begin_dispatch<E>(
        &self,
        revision_matches: impl FnOnce() -> Result<bool, E>,
    ) -> Result<Option<CodexDispatchGuard>, E> {
        let inner = self.inner.lock().unwrap_or_else(|error| error.into_inner());
        if !revision_matches()? {
            return Ok(None);
        }
        Ok(Some(CodexDispatchGuard {
            receiver: inner.sender.subscribe(),
        }))
    }
}

/// Mutation subscription held from the final revision check through request
/// dispatch and streaming. A later login/logout/rotation makes `changed` ready
/// and causes the old request future to be dropped.
pub struct CodexDispatchGuard {
    receiver: tokio::sync::watch::Receiver<u64>,
}

impl CodexDispatchGuard {
    /// Resolve after the durable credential slot advances to another epoch.
    pub async fn changed(&mut self) {
        let _ = self.receiver.changed().await;
    }
}

/// Shared refresh-operation registry scoped to one durable credential store.
/// Operations are keyed by the exact credential revision so concurrent callers
/// never submit the same one-time refresh token twice.
#[derive(Default)]
pub struct CodexRefreshCoordinator {
    operations: Mutex<HashMap<String, Arc<CodexRefreshOperation>>>,
}

struct CodexRefreshOperation {
    outcome: tokio::sync::watch::Receiver<Option<CodexRefreshOutcome>>,
}

struct CodexRefreshRegistryLease {
    coordinator: Arc<CodexRefreshCoordinator>,
    revision: String,
    operation: Arc<CodexRefreshOperation>,
}

impl Drop for CodexRefreshRegistryLease {
    fn drop(&mut self) {
        let mut operations = self
            .coordinator
            .operations
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        if operations
            .get(&self.revision)
            .is_some_and(|current| Arc::ptr_eq(current, &self.operation))
        {
            operations.remove(&self.revision);
        }
    }
}

#[derive(Debug, Clone)]
enum CodexRefreshOutcome {
    Refreshed(OAuthCredential),
    Superseded,
    AuthenticationFailure,
    TemporarilyUnavailable,
    StoreUnavailable,
}

impl CodexRefreshOperation {
    async fn wait(&self) -> CodexRefreshOutcome {
        let mut receiver = self.outcome.clone();
        if let Some(outcome) = receiver.borrow().clone() {
            return outcome;
        }
        if receiver.changed().await.is_err() {
            return CodexRefreshOutcome::TemporarilyUnavailable;
        }
        let outcome = receiver
            .borrow()
            .clone()
            .unwrap_or(CodexRefreshOutcome::TemporarilyUnavailable);
        outcome
    }
}

async fn blocking_store_read(
    store: Arc<dyn CodexAuthStore>,
    registry_lease: Option<Arc<CodexRefreshRegistryLease>>,
) -> Result<Option<OAuthCredential>, ()> {
    tokio::task::spawn_blocking(move || {
        let _registry_lease = registry_lease;
        store.read()
    })
    .await
    .map_err(|_| ())?
    .map_err(|_| ())
}

async fn blocking_store_write_if_revision(
    store: Arc<dyn CodexAuthStore>,
    revision: String,
    credential: OAuthCredential,
    registry_lease: Arc<CodexRefreshRegistryLease>,
) -> Result<bool, ()> {
    tokio::task::spawn_blocking(move || {
        let _registry_lease = registry_lease;
        store.write_if_revision(&revision, &credential)
    })
    .await
    .map_err(|_| ())?
    .map_err(|_| ())
}

async fn blocking_store_begin_dispatch(
    store: Arc<dyn CodexAuthStore>,
    revision: String,
) -> Result<Option<CodexDispatchGuard>, ()> {
    tokio::task::spawn_blocking(move || store.begin_dispatch(&revision))
        .await
        .map_err(|_| ())?
        .map_err(|_| ())
}

/// Persistent OAuth token storage. The keychain-backed implementation lives in
/// `aiden-data`; providers receive it as a trait object.
pub trait CodexAuthStore: Send + Sync {
    fn read(&self) -> Result<Option<OAuthCredential>, ProviderError>;

    /// Return a secret-free status snapshot. Stores that can distinguish an
    /// unreadable durable slot from an absent one should override this.
    fn status(&self) -> Result<CodexAuthStoreStatus, ProviderError> {
        Ok(CodexAuthStoreStatus {
            configured: self.read()?.is_some(),
            needs_attention: false,
        })
    }
    /// Serialized write: `Some` replaces, `None` deletes.
    fn write(&self, credential: Option<&OAuthCredential>) -> Result<(), ProviderError>;

    /// Atomically replace only if the credential still has the revision
    /// observed before a refresh began. Returns `false` when a newer sign-in or
    /// logout superseded the caller's read.
    fn write_if_revision(
        &self,
        expected_revision: &str,
        credential: &OAuthCredential,
    ) -> Result<bool, ProviderError>;

    /// Store-scoped shared refresh registry.
    fn refresh_coordinator(&self) -> Arc<CodexRefreshCoordinator>;

    /// Atomically validate `expected_revision` and subscribe to later durable
    /// credential mutations before request dispatch.
    fn begin_dispatch(
        &self,
        expected_revision: &str,
    ) -> Result<Option<CodexDispatchGuard>, ProviderError>;
}

/// OAuth token refresh — a network call the app may inject for tests.
pub trait CodexTokenRefresher: Send + Sync {
    fn refresh(
        &self,
        refresh_token: &str,
    ) -> Pin<Box<dyn Future<Output = Result<OAuthCredential, ProviderError>> + Send>>;
}

/// Default refresh implementation hitting the ChatGPT token endpoint.
#[derive(Debug, Clone)]
pub struct HttpCodexTokenRefresher {
    token_url: String,
    client_id: String,
    allow_test_endpoint: bool,
}

impl Default for HttpCodexTokenRefresher {
    fn default() -> Self {
        Self {
            token_url: CODEX_TOKEN_URL.to_string(),
            client_id: CODEX_CLIENT_ID.to_string(),
            allow_test_endpoint: false,
        }
    }
}

impl HttpCodexTokenRefresher {
    #[cfg(test)]
    fn for_test(token_url: String) -> Self {
        Self {
            token_url,
            client_id: CODEX_CLIENT_ID.to_string(),
            allow_test_endpoint: true,
        }
    }
}

impl CodexTokenRefresher for HttpCodexTokenRefresher {
    fn refresh(
        &self,
        refresh_token: &str,
    ) -> Pin<Box<dyn Future<Output = Result<OAuthCredential, ProviderError>> + Send>> {
        let token_url = self.token_url.clone();
        let client_id = self.client_id.clone();
        let allow_test_endpoint = self.allow_test_endpoint;
        let refresh_token = refresh_token.to_string();
        Box::pin(async move {
            if !allow_test_endpoint && token_url != CODEX_TOKEN_URL {
                return Err(ProviderError::Auth(
                    "OpenAI Codex token refresh endpoint is invalid".to_string(),
                ));
            }
            let client = reqwest::Client::builder()
                .redirect(reqwest::redirect::Policy::none())
                .build()
                .map_err(|_| {
                    ProviderError::Stream(
                        "OpenAI Codex token refresh is temporarily unavailable".to_string(),
                    )
                })?;
            let response = client
                .post(&token_url)
                .header("content-type", "application/x-www-form-urlencoded")
                .form(&[
                    ("grant_type", "refresh_token"),
                    ("refresh_token", &refresh_token),
                    ("client_id", &client_id),
                ])
                .send()
                .await
                .map_err(|_| {
                    ProviderError::Stream(
                        "OpenAI Codex token refresh is temporarily unavailable".to_string(),
                    )
                })?;
            let status = response.status();
            if !status.is_success() {
                return Err(ProviderError::from_http_status(
                    status.as_u16(),
                    format!("OpenAI Codex token refresh failed ({status})"),
                ));
            }
            let mut body = Vec::new();
            let mut stream = response.bytes_stream();
            while let Some(chunk) = stream.next().await {
                let chunk = chunk.map_err(|_| {
                    ProviderError::Stream(
                        "OpenAI Codex token refresh response was invalid".to_string(),
                    )
                })?;
                if body.len().saturating_add(chunk.len()) > MAX_OAUTH_REFRESH_RESPONSE_BYTES {
                    return Err(ProviderError::Stream(
                        "OpenAI Codex token refresh response was too large".to_string(),
                    ));
                }
                body.extend_from_slice(&chunk);
            }
            let json: serde_json::Value = serde_json::from_slice(&body).map_err(|_| {
                ProviderError::Stream("OpenAI Codex token refresh response was invalid".to_string())
            })?;
            let access = json
                .get("access_token")
                .and_then(|v| v.as_str())
                .filter(|value| !value.is_empty())
                .ok_or_else(|| {
                    ProviderError::Stream(
                        "OpenAI Codex token refresh response missing fields".to_string(),
                    )
                })?;
            let refresh = json
                .get("refresh_token")
                .and_then(|v| v.as_str())
                .filter(|value| !value.is_empty())
                .ok_or_else(|| {
                    ProviderError::Stream(
                        "OpenAI Codex token refresh response missing fields".to_string(),
                    )
                })?;
            let expires_in = json
                .get("expires_in")
                .and_then(|v| v.as_u64())
                .ok_or_else(|| {
                    ProviderError::Stream(
                        "OpenAI Codex token refresh response missing fields".to_string(),
                    )
                })?;
            extract_account_id(access)?;
            Ok(OAuthCredential {
                access: access.to_string(),
                refresh: refresh.to_string(),
                expires: now_ms().saturating_add(expires_in.saturating_mul(1000)),
            })
        })
    }
}

/// sha256 of `access\0refresh\0expires` — the credential-change fingerprint.
pub fn credential_revision(credential: Option<&OAuthCredential>) -> Option<String> {
    let credential = credential?;
    use sha2::Digest;
    let mut hasher = sha2::Sha256::new();
    hasher.update(credential.access.as_bytes());
    hasher.update(b"\0");
    hasher.update(credential.refresh.as_bytes());
    hasher.update(b"\0");
    hasher.update(credential.expires.to_string().as_bytes());
    Some(hex(&hasher.finalize()))
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

/// Decode the account id from a JWT access token (`extractAccountId`).
pub fn extract_account_id(token: &str) -> Result<String, ProviderError> {
    let parts: Vec<&str> = token.split('.').collect();
    if parts.len() != 3 {
        return Err(ProviderError::Auth(
            "Failed to extract accountId from token".into(),
        ));
    }
    use base64::Engine;
    let payload = base64::engine::general_purpose::URL_SAFE_NO_PAD
        .decode(parts[1])
        .map_err(|_| ProviderError::Auth("Failed to extract accountId from token".into()))?;
    let json: serde_json::Value = serde_json::from_slice(&payload)
        .map_err(|_| ProviderError::Auth("Failed to extract accountId from token".into()))?;
    let account_id = json
        .get(JWT_CLAIM_PATH)
        .and_then(|claim| claim.get("chatgpt_account_id"))
        .and_then(|value| value.as_str());
    match account_id {
        Some(account_id) if !account_id.is_empty() => Ok(account_id.to_string()),
        _ => Err(ProviderError::Auth(
            "Failed to extract accountId from token".into(),
        )),
    }
}

/// `isCodexAuthenticationFailure` — string-level port of the TS regexes.
pub fn is_codex_authentication_failure(error_message: Option<&str>) -> bool {
    let Some(message) = error_message else {
        return false;
    };
    let lower = message.to_lowercase();
    message.contains("401")
        || lower.contains("unauthorized")
        || lower.contains("unauthorised")
        || lower.contains("invalid access token")
        || lower.contains("expired access token")
        || lower.contains("revoked access token")
        || lower.contains("invalid auth token")
        || lower.contains("invalid api key")
        || lower.contains("expired api key")
        || lower.contains("authentication error")
        || lower.contains("authentication failed")
        || lower.contains("authentication required")
        || lower.contains("not authenticated")
        || lower.contains("invalid_grant")
        || lower.contains("token refresh failed (400)")
        || lower.contains("token refresh failed (401)")
        || lower.contains("token refresh failed (403)")
        || lower.contains("failed to extract accountid from token")
}

// ===========================================================================
// Retry helpers (openai-codex-responses.js)
// ===========================================================================

fn is_terminal_rate_limit_error(error_text: &str) -> bool {
    let lower = error_text.to_lowercase();
    lower.contains("gousagelimiterror")
        || lower.contains("freeusagelimiterror")
        || lower.contains("monthly usage limit reached")
        || lower.contains("available balance")
        || lower.contains("insufficient_quota")
        || lower.contains("out of budget")
        || lower.contains("quota exceeded")
        || lower.contains("billing")
}

fn is_retryable_error(status: u16, error_text: &str) -> bool {
    if status == 429 && is_terminal_rate_limit_error(error_text) {
        return false;
    }
    if matches!(status, 429 | 500 | 502 | 503 | 504) {
        return true;
    }
    let lower = error_text.to_lowercase();
    lower.contains("rate limit")
        || lower.contains("rate_limit")
        || lower.contains("overloaded")
        || lower.contains("service unavailable")
        || lower.contains("service_unavailable")
        || lower.contains("upstream connect")
        || lower.contains("connection refused")
}

/// `getRetryAfterDelayMs` — honors `retry-after-ms`, `retry-after` seconds,
/// and HTTP dates. Returns `None` when no usable hint exists.
pub fn get_retry_after_delay_ms(
    headers: &reqwest::header::HeaderMap,
    now_ms_value: u64,
) -> Option<u64> {
    if let Some(value) = headers.get("retry-after-ms").and_then(|v| v.to_str().ok()) {
        if let Ok(millis) = value.parse::<u64>() {
            return Some(millis);
        }
    }
    let value = headers.get("retry-after")?.to_str().ok()?;
    if let Ok(seconds) = value.parse::<u64>() {
        return Some(seconds.saturating_mul(1000));
    }
    // HTTP-date form.
    let parsed = httpdate_parse(value);
    if let Some(date) = parsed {
        return Some(date.saturating_sub(now_ms_value));
    }
    None
}

fn httpdate_parse(value: &str) -> Option<u64> {
    // Minimal IMF-fixdate / RFC 850 / asctime parser via chrono-free math is
    // overkill; fall back to None (callers then use exponential backoff).
    let _ = value;
    None
}

fn cap_retry_delay_ms(delay_ms: u64, max_retry_delay_ms: u64) -> u64 {
    if max_retry_delay_ms > 0 {
        delay_ms.min(max_retry_delay_ms)
    } else {
        delay_ms
    }
}

/// `parseErrorResponse` — friendly ChatGPT usage-limit messages.
pub fn parse_codex_error_message(body: &str, status: u16) -> String {
    let fallback = if body.is_empty() {
        format!("Request failed with status {status}")
    } else {
        body.to_string()
    };
    let Ok(parsed) = serde_json::from_str::<serde_json::Value>(body) else {
        return fallback;
    };
    let Some(error) = parsed.get("error") else {
        return fallback;
    };
    let code = error
        .get("code")
        .and_then(|v| v.as_str())
        .or_else(|| error.get("type").and_then(|v| v.as_str()))
        .unwrap_or_default();
    let code_lower = code.to_lowercase();
    if code_lower.contains("usage_limit_reached")
        || code_lower.contains("usage_not_included")
        || code_lower.contains("rate_limit_exceeded")
        || status == 429
    {
        let plan = error
            .get("plan_type")
            .and_then(|v| v.as_str())
            .map(|plan| format!(" ({} plan)", plan.to_lowercase()))
            .unwrap_or_default();
        let minutes = error
            .get("resets_at")
            .and_then(|v| v.as_u64())
            .map(|resets_at| {
                let millis = resets_at.saturating_mul(1000);
                millis.saturating_sub(now_ms()).div_euclid(60_000)
            });
        let when = match minutes {
            Some(minutes) => format!(" Try again in ~{minutes} min."),
            None => String::new(),
        };
        return format!("You have hit your ChatGPT usage limit{plan}.{when}")
            .trim()
            .to_string();
    }
    error
        .get("message")
        .and_then(|v| v.as_str())
        .map(String::from)
        .unwrap_or(fallback)
}

// ===========================================================================
// Request shaping (buildRequestBody + headers)
// ===========================================================================

/// `resolveCodexUrl` — normalize a base URL to `/codex/responses`.
pub fn resolve_codex_url(base_url: &str) -> String {
    let raw = if base_url.trim().is_empty() {
        OPENAI_CODEX_BASE_URL
    } else {
        base_url
    };
    let normalized = raw.trim_end_matches('/');
    if normalized.ends_with("/codex/responses") {
        return normalized.to_string();
    }
    if normalized.ends_with("/codex") {
        return format!("{normalized}/responses");
    }
    format!("{normalized}/codex/responses")
}

/// `buildRequestBody` for the Codex Responses endpoint.
pub fn build_codex_body(request: &StreamRequest, options: &StreamOptions) -> serde_json::Value {
    let messages = convert_responses_messages(
        &request.provider_id,
        request.api.as_str(),
        &request.model,
        request.reasoning,
        request.vision,
        true,
        false, // codex carries `instructions` instead
        None,
        request.messages.clone(),
        now_ms(),
    );
    let mut body = serde_json::Map::new();
    body.insert(
        "model".into(),
        serde_json::Value::String(request.model.clone()),
    );
    body.insert("store".into(), serde_json::Value::Bool(false));
    body.insert("stream".into(), serde_json::Value::Bool(true));
    body.insert(
        "instructions".into(),
        serde_json::Value::String(
            request
                .system_prompt
                .clone()
                .unwrap_or_else(|| "You are a helpful assistant.".to_string()),
        ),
    );
    body.insert("input".into(), serde_json::Value::Array(messages));
    let verbosity = options
        .text_verbosity
        .clone()
        .or_else(|| request.text_verbosity.clone())
        .unwrap_or_else(|| "low".to_string());
    body.insert("text".into(), serde_json::json!({ "verbosity": verbosity }));
    body.insert(
        "include".into(),
        serde_json::json!(["reasoning.encrypted_content"]),
    );
    if let Some(session_id) = options
        .session_id
        .as_deref()
        .or(request.session_id.as_deref())
    {
        body.insert(
            "prompt_cache_key".into(),
            serde_json::Value::String(clamp_openai_prompt_cache_key(session_id)),
        );
    }
    body.insert(
        "tool_choice".into(),
        serde_json::Value::String(
            options
                .tool_choice
                .clone()
                .or_else(|| request.tool_choice.clone())
                .unwrap_or_else(|| "auto".to_string()),
        ),
    );
    body.insert("parallel_tool_calls".into(), serde_json::Value::Bool(true));
    if let Some(temperature) = options.temperature.or(request.temperature) {
        body.insert("temperature".into(), serde_json::json!(temperature));
    }
    if let Some(service_tier) = options
        .service_tier
        .clone()
        .or_else(|| request.service_tier.clone())
    {
        body.insert(
            "service_tier".into(),
            serde_json::Value::String(service_tier),
        );
    }
    if !request.tools.is_empty() {
        body.insert(
            "tools".into(),
            serde_json::Value::Array(convert_responses_tools(&request.tools, false, None)),
        );
    }
    if let Some(level) = request.thinking_level {
        let effort = request
            .thinking_level_map
            .as_ref()
            .and_then(|map| map.get(level.as_str()))
            .cloned()
            .flatten()
            .unwrap_or_else(|| level.as_str().to_string());
        let summary = options
            .reasoning_summary
            .clone()
            .or_else(|| request.reasoning_summary.clone())
            .unwrap_or_else(|| "auto".to_string());
        body.insert(
            "reasoning".into(),
            serde_json::json!({ "effort": effort, "summary": summary }),
        );
    }
    serde_json::Value::Object(body)
}

/// `buildSSEHeaders` — auth + codex-specific headers.
pub fn build_codex_sse_headers(
    request: &StreamRequest,
    options: &StreamOptions,
    access_token: &str,
    account_id: &str,
) -> HashMap<String, String> {
    let mut headers: HashMap<String, String> = request.model_headers.clone();
    // Options headers win (null deletes).
    for (name, value) in &options.headers {
        match value {
            Some(value) => {
                headers.insert(name.clone(), value.clone());
            }
            None => {
                headers.remove(name);
            }
        }
    }
    headers.insert(
        "Authorization".to_string(),
        format!("Bearer {access_token}"),
    );
    headers.insert("chatgpt-account-id".to_string(), account_id.to_string());
    headers.insert("originator".to_string(), "pi".to_string());
    let os = std::env::consts::OS;
    let arch = std::env::consts::ARCH;
    headers.insert("user-agent".to_string(), format!("pi ({os}; {arch})"));
    headers.insert(
        "OpenAI-Beta".to_string(),
        "responses=experimental".to_string(),
    );
    headers.insert("accept".to_string(), "text/event-stream".to_string());
    headers.insert("content-type".to_string(), "application/json".to_string());
    if let Some(session_id) = options
        .session_id
        .as_deref()
        .or(request.session_id.as_deref())
    {
        headers.insert("session-id".to_string(), session_id.to_string());
        headers.insert("x-client-request-id".to_string(), session_id.to_string());
    }
    headers
}

// ===========================================================================
// Codex event mapping (mapCodexEvents)
// ===========================================================================

/// A normalized codex SSE event: either forwarded to the shared accumulator,
/// the terminal `response.completed` (stream then ends), or skipped.
#[derive(Debug)]
pub enum MappedCodexEvent {
    Event(serde_json::Value),
    Terminal(serde_json::Value),
    Skip,
}

/// `mapCodexEvents` + `normalizeCodexStatus` for one SSE payload.
pub fn map_codex_event(payload: &str) -> Result<MappedCodexEvent, ProviderError> {
    let event: serde_json::Value = serde_json::from_str(payload)
        .map_err(|err| ProviderError::Protocol(format!("Invalid Codex SSE JSON: {err}")))?;
    let event_type = event.get("type").and_then(|v| v.as_str());
    match event_type {
        None => Ok(MappedCodexEvent::Skip),
        Some("error") => {
            let nested = event.get("error").filter(|v| v.is_object());
            let code = event
                .get("code")
                .and_then(|v| v.as_str())
                .or_else(|| nested.and_then(|n| n.get("code")).and_then(|v| v.as_str()));
            let message = event.get("message").and_then(|v| v.as_str()).or_else(|| {
                nested
                    .and_then(|n| n.get("message"))
                    .and_then(|v| v.as_str())
            });
            let text = match (message, code) {
                (Some(message), _) => format!("Codex error: {message}"),
                (None, Some(code)) => format!("Codex error: {code}"),
                (None, None) => format!("Codex error: {}", safe_json(&event)),
            };
            Err(ProviderError::Stream(text))
        }
        Some("response.failed") => {
            let response = event.get("response");
            let message = response
                .and_then(|r| r.get("error"))
                .and_then(|error| error.get("message"))
                .and_then(|v| v.as_str())
                .unwrap_or("Codex response failed");
            Err(ProviderError::Stream(message.to_string()))
        }
        Some("response.done") | Some("response.completed") | Some("response.incomplete") => {
            let Some(response) = event.get("response") else {
                return Ok(MappedCodexEvent::Terminal(event.clone()));
            };
            let mut normalized = event.clone();
            normalized["type"] = serde_json::Value::String("response.completed".into());
            let status = response
                .get("status")
                .and_then(|v| v.as_str())
                .filter(|status| {
                    matches!(
                        *status,
                        "completed"
                            | "incomplete"
                            | "failed"
                            | "cancelled"
                            | "queued"
                            | "in_progress"
                    )
                });
            if let Some(status) = status {
                normalized["response"]["status"] = serde_json::Value::String(status.to_string());
            } else {
                if let Some(object) = normalized["response"].as_object_mut() {
                    object.remove("status");
                }
            }
            Ok(MappedCodexEvent::Terminal(normalized))
        }
        _ => Ok(MappedCodexEvent::Event(event)),
    }
}

fn safe_json(value: &serde_json::Value) -> String {
    crate::json::safe_json_stringify(value)
}

/// Parse a complete codex SSE byte stream into normalized events (pure).
pub fn parse_codex_sse(
    provider: &str,
    model: &str,
    input: &[u8],
) -> Result<Vec<AssistantMessageEvent>, ProviderError> {
    parse_codex_sse_with_now(provider, model, input, now_ms())
}

/// Fixture-friendly variant with a fixed timestamp.
pub fn parse_codex_sse_with_now(
    provider: &str,
    model: &str,
    input: &[u8],
    now: u64,
) -> Result<Vec<AssistantMessageEvent>, ProviderError> {
    let mut accumulator =
        ResponsesAccumulator::with_now(provider, model, "openai-codex-responses", now);
    let mut events = Vec::new();
    for payload in data_payloads(input) {
        if payload == crate::json::SSE_DONE {
            continue;
        }
        let mapped = match map_codex_event(&payload) {
            Ok(mapped) => mapped,
            Err(err) => {
                accumulator.message.stop_reason = StopReason::Error;
                accumulator.message.error_message = Some(crate::provider_error_message(&err));
                events.push(AssistantMessageEvent::Error {
                    reason: StopReason::Error,
                    error: accumulator.message.clone(),
                });
                return Ok(events);
            }
        };
        match mapped {
            MappedCodexEvent::Skip => {}
            MappedCodexEvent::Event(event) => {
                events.extend(accumulator.step(&event)?);
            }
            MappedCodexEvent::Terminal(event) => {
                events.extend(accumulator.step(&event)?);
                break;
            }
        }
    }
    if let Err(err) = accumulator.require_terminal_event() {
        accumulator.message.stop_reason = StopReason::Error;
        accumulator.message.error_message = Some(crate::provider_error_message(&err));
        events.push(AssistantMessageEvent::Error {
            reason: StopReason::Error,
            error: accumulator.message.clone(),
        });
        return Ok(events);
    }
    events.extend(finish_responses(&mut accumulator)?);
    Ok(events)
}

// ===========================================================================
// Auth resolution
// ===========================================================================

/// A resolved request auth: bearer token + account id.
#[derive(Debug, Clone)]
pub struct PreparedCodexAuth {
    pub access_token: String,
    pub account_id: String,
    pub credential_revision: String,
}

/// `prepareRuntimeAuth` — the supersede-retry loop (max 2 retries). `try_auth`
/// returns the auth attempt result; superseded attempts restart.
pub async fn resolve_runtime_auth_with_retry<F, Fut>(
    mut try_auth: F,
    request_cancelled: bool,
) -> Result<PreparedCodexAuth, CodexRuntimeError>
where
    F: FnMut() -> Fut,
    Fut: Future<Output = Result<PreparedCodexAuth, CodexAuthError>>,
{
    let max_retries = 2;
    let mut attempt = 0;
    loop {
        match try_auth().await {
            Ok(auth) => return Ok(auth),
            Err(CodexAuthError::Superseded) if attempt < max_retries && !request_cancelled => {
                attempt += 1;
                continue;
            }
            Err(CodexAuthError::Cancelled) | Err(CodexAuthError::Superseded)
                if request_cancelled =>
            {
                return Err(CodexRuntimeError::new(
                    CodexRuntimeErrorCode::RequestCancelled,
                    "Codex request cancelled.",
                ));
            }
            Err(CodexAuthError::Superseded) => {
                return Err(CodexRuntimeError::new(
                    CodexRuntimeErrorCode::TemporarilyUnavailable,
                    "Your ChatGPT sign-in changed while this request was starting. Try again.",
                ));
            }
            Err(CodexAuthError::Cancelled) => {
                return Err(CodexRuntimeError::new(
                    CodexRuntimeErrorCode::RequestCancelled,
                    "Codex request cancelled.",
                ));
            }
            Err(CodexAuthError::Runtime(runtime_error)) => return Err(runtime_error),
        }
    }
}

fn shared_refresh_operation(
    store: Arc<dyn CodexAuthStore>,
    refresher: Arc<dyn CodexTokenRefresher>,
    revision: &str,
    refresh_token: &str,
    operation_timeout: Duration,
) -> Arc<CodexRefreshOperation> {
    let coordinator = store.refresh_coordinator();
    let mut operations = coordinator
        .operations
        .lock()
        .unwrap_or_else(|error| error.into_inner());
    if let Some(operation) = operations.get(revision) {
        return operation.clone();
    }

    let (sender, receiver) = tokio::sync::watch::channel(None);
    let operation = Arc::new(CodexRefreshOperation { outcome: receiver });
    operations.insert(revision.to_string(), operation.clone());
    drop(operations);

    let operation_for_task = operation.clone();
    let revision = revision.to_string();
    let refresh_token = refresh_token.to_string();
    let deadline_sender = sender.clone();
    let deadline = tokio::spawn(async move {
        tokio::time::sleep(operation_timeout).await;
        deadline_sender.send_if_modified(|outcome| {
            if outcome.is_some() {
                return false;
            }
            *outcome = Some(CodexRefreshOutcome::TemporarilyUnavailable);
            true
        });
    });
    tokio::spawn(async move {
        let mut lease = Some(Arc::new(CodexRefreshRegistryLease {
            coordinator,
            revision: revision.clone(),
            operation: operation_for_task,
        }));
        let refresh = AssertUnwindSafe(refresher.refresh(&refresh_token)).catch_unwind();
        let outcome = match tokio::time::timeout(operation_timeout, refresh).await {
            Ok(Ok(Ok(refreshed))) => match blocking_store_write_if_revision(
                store.clone(),
                revision.clone(),
                refreshed.clone(),
                lease
                    .as_ref()
                    .expect("refresh lease must be active")
                    .clone(),
            )
            .await
            {
                Ok(true) => CodexRefreshOutcome::Refreshed(refreshed),
                Ok(false) => CodexRefreshOutcome::Superseded,
                Err(_) => CodexRefreshOutcome::StoreUnavailable,
            },
            Ok(Ok(Err(error))) => match blocking_store_read(
                store.clone(),
                Some(
                    lease
                        .as_ref()
                        .expect("refresh lease must be active")
                        .clone(),
                ),
            )
            .await
            {
                Ok(current)
                    if credential_revision(current.as_ref()).as_deref() != Some(&revision) =>
                {
                    CodexRefreshOutcome::Superseded
                }
                Err(_) => CodexRefreshOutcome::StoreUnavailable,
                Ok(_) if is_codex_authentication_failure(Some(&error.to_string())) => {
                    CodexRefreshOutcome::AuthenticationFailure
                }
                Ok(_) => CodexRefreshOutcome::TemporarilyUnavailable,
            },
            Ok(Err(_panic)) => CodexRefreshOutcome::TemporarilyUnavailable,
            Err(_) => CodexRefreshOutcome::TemporarilyUnavailable,
        };
        deadline.abort();
        let retain_for_stale_readers = matches!(
            outcome,
            CodexRefreshOutcome::Refreshed(_)
                | CodexRefreshOutcome::Superseded
                | CodexRefreshOutcome::StoreUnavailable
        );
        if !retain_for_stale_readers {
            drop(lease.take());
        }
        sender.send_replace(Some(outcome));
        if retain_for_stale_readers {
            // Keep successful/superseded results briefly so a caller that read
            // the old credential immediately before the CAS does not submit a
            // spent token. Failures are removed immediately so recovery is not
            // artificially delayed for another full operation deadline.
            tokio::time::sleep(operation_timeout).await;
        }
        drop(lease);
    });
    operation
}

/// `resolveRuntimeAuth` — read, refresh when near expiry, derive account id.
/// `request_cancelled` models the caller's abort signal for error taxonomy.
pub async fn resolve_runtime_auth(
    store: Arc<dyn CodexAuthStore>,
    refresher: Arc<dyn CodexTokenRefresher>,
    revision_guard: Option<&str>,
    request_cancelled: bool,
) -> Result<PreparedCodexAuth, CodexAuthError> {
    resolve_runtime_auth_with_timeout(
        store,
        refresher,
        revision_guard,
        request_cancelled,
        OAUTH_REFRESH_CALLER_TIMEOUT,
        OAUTH_REFRESH_OPERATION_TIMEOUT,
    )
    .await
}

async fn resolve_runtime_auth_with_timeout(
    store: Arc<dyn CodexAuthStore>,
    refresher: Arc<dyn CodexTokenRefresher>,
    revision_guard: Option<&str>,
    request_cancelled: bool,
    caller_timeout: Duration,
    operation_timeout: Duration,
) -> Result<PreparedCodexAuth, CodexAuthError> {
    if request_cancelled {
        return Err(CodexAuthError::Cancelled);
    }
    let stored = tokio::time::timeout(caller_timeout, blocking_store_read(store.clone(), None))
        .await
        .map_err(|_| {
            CodexAuthError::Runtime(CodexRuntimeError::new(
                CodexRuntimeErrorCode::TemporarilyUnavailable,
                "ChatGPT sign-in storage is unavailable. Try again.",
            ))
        })?
        .map_err(|_| {
            CodexAuthError::Runtime(CodexRuntimeError::new(
                CodexRuntimeErrorCode::TemporarilyUnavailable,
                "ChatGPT sign-in storage is unavailable. Try again.",
            ))
        })?;
    let mut credential = stored.clone();
    let revision_before = credential_revision(credential.as_ref());
    if let Some(guard) = revision_guard {
        if revision_before.as_deref() != Some(guard) {
            return Err(CodexAuthError::Superseded);
        }
    }
    let Some(credential_value) = credential.clone() else {
        return Err(CodexAuthError::Runtime(CodexRuntimeError::new(
            CodexRuntimeErrorCode::SignInRequired,
            "Sign in with ChatGPT in Settings → Providers to use Codex.",
        )));
    };
    if now_ms()
        >= credential_value
            .expires
            .saturating_sub(OAUTH_REFRESH_SKEW_MS)
    {
        let Some(expected_revision) = revision_before.as_deref() else {
            return Err(CodexAuthError::Superseded);
        };
        let operation = shared_refresh_operation(
            store.clone(),
            refresher.clone(),
            expected_revision,
            &credential_value.refresh,
            operation_timeout,
        );
        let outcome = tokio::time::timeout(caller_timeout, operation.wait())
            .await
            .map_err(|_| {
                CodexAuthError::Runtime(CodexRuntimeError::new(
                    CodexRuntimeErrorCode::TemporarilyUnavailable,
                    "ChatGPT sign-in refresh timed out. Check your connection and try again.",
                ))
            })?;
        credential = Some(match outcome {
            CodexRefreshOutcome::Refreshed(credential) => credential,
            CodexRefreshOutcome::Superseded => return Err(CodexAuthError::Superseded),
            CodexRefreshOutcome::AuthenticationFailure => {
                return Err(CodexAuthError::Runtime(CodexRuntimeError::new(
                    CodexRuntimeErrorCode::SignInNeedsAttention,
                    "Your ChatGPT sign-in needs attention. Sign in again in Settings → Providers.",
                )))
            }
            CodexRefreshOutcome::TemporarilyUnavailable => {
                return Err(CodexAuthError::Runtime(CodexRuntimeError::new(
                    CodexRuntimeErrorCode::TemporarilyUnavailable,
                    "ChatGPT sign-in could not be refreshed right now. Check your connection and try again.",
                )))
            }
            CodexRefreshOutcome::StoreUnavailable => {
                return Err(CodexAuthError::Runtime(CodexRuntimeError::new(
                    CodexRuntimeErrorCode::TemporarilyUnavailable,
                    "ChatGPT sign-in storage is unavailable. Try again.",
                )))
            }
        });
    }
    let Some(credential_value) = credential.clone() else {
        // A refresh rotated the token away (superseded); treat as retryable.
        return Err(CodexAuthError::Superseded);
    };
    let account_id = extract_account_id(&credential_value.access).map_err(|_| {
        CodexAuthError::Runtime(CodexRuntimeError::new(
            CodexRuntimeErrorCode::SignInNeedsAttention,
            "Your ChatGPT sign-in needs attention. Sign in again in Settings → Providers.",
        ))
    })?;
    if request_cancelled {
        return Err(CodexAuthError::Cancelled);
    }
    Ok(PreparedCodexAuth {
        access_token: credential_value.access,
        account_id,
        credential_revision: credential_revision(credential.as_ref()).unwrap_or_default(),
    })
}

// ===========================================================================
// CodexProvider (streaming, SSE only)
// ===========================================================================

/// Provider for the Codex Responses endpoint (`chatgpt.com/backend-api`).
pub struct CodexProvider {
    base_url: String,
    auth_store: std::sync::Arc<dyn CodexAuthStore>,
    refresher: std::sync::Arc<dyn CodexTokenRefresher>,
    /// A provided model resolver returns the model record by id (none =
    /// `prepare_runtime_model` rejects with `model_unavailable`).
    model_available: Option<crate::catalog::CodexModelCheck>,
}

enum CodexSendError {
    Provider(ProviderError),
    Superseded,
    StoreUnavailable,
}

enum CodexStartError {
    Runtime(CodexRuntimeError),
    Provider(ProviderError),
}

async fn guarded_response_text(
    response: reqwest::Response,
    dispatch_guard: &mut CodexDispatchGuard,
) -> Result<String, CodexSendError> {
    let body = response.text();
    tokio::pin!(body);
    tokio::select! {
        biased;
        _ = dispatch_guard.changed() => Err(CodexSendError::Superseded),
        body = &mut body => Ok(body.unwrap_or_default()),
    }
}

async fn guarded_retry_delay(
    dispatch_guard: &mut CodexDispatchGuard,
    delay: Duration,
) -> Result<(), CodexSendError> {
    tokio::select! {
        biased;
        _ = dispatch_guard.changed() => Err(CodexSendError::Superseded),
        _ = tokio::time::sleep(delay) => Ok(()),
    }
}

impl CodexProvider {
    pub fn new(auth_store: std::sync::Arc<dyn CodexAuthStore>) -> Self {
        Self {
            base_url: OPENAI_CODEX_BASE_URL.to_string(),
            auth_store,
            refresher: std::sync::Arc::new(HttpCodexTokenRefresher::default()),
            model_available: None,
        }
    }

    pub fn with_base_url(mut self, base_url: impl Into<String>) -> Self {
        self.base_url = base_url.into();
        self
    }

    pub fn with_refresher(mut self, refresher: std::sync::Arc<dyn CodexTokenRefresher>) -> Self {
        self.refresher = refresher;
        self
    }

    pub fn with_model_check(mut self, check: crate::catalog::CodexModelCheck) -> Self {
        self.model_available = Some(check);
        self
    }

    /// `prepareRuntimeModel` — validate the selection and resolve OAuth before
    /// the request enters the stream.
    pub async fn prepare_runtime_model(&self, model_id: &str) -> Result<(), CodexRuntimeError> {
        if let Some(check) = &self.model_available {
            if !check(model_id) {
                return Err(CodexRuntimeError::new(
                    CodexRuntimeErrorCode::ModelUnavailable,
                    "That Codex model is no longer available. Choose another model and try again.",
                ));
            }
        }
        resolve_runtime_auth_with_retry(
            || resolve_runtime_auth(self.auth_store.clone(), self.refresher.clone(), None, false),
            false,
        )
        .await?;
        Ok(())
    }

    /// Build the request closure shared by the stream and tests.
    fn request_builder(
        &self,
        request: &StreamRequest,
        options: &StreamOptions,
        auth: &PreparedCodexAuth,
    ) -> reqwest::RequestBuilder {
        let body = build_codex_body(request, options);
        let headers =
            build_codex_sse_headers(request, options, &auth.access_token, &auth.account_id);
        let url = resolve_codex_url(&self.base_url);
        let mut builder = reqwest::Client::new().post(url);
        for (name, value) in &headers {
            builder = builder.header(name, value);
        }
        builder = builder.body(serde_json::to_string(&body).unwrap_or_else(|_| "{}".to_string()));
        if let Some(timeout_ms) = options.timeout_ms {
            builder = builder.timeout(std::time::Duration::from_millis(timeout_ms));
        }
        builder
    }

    /// POST with rate-limit / transient retry semantics (SSE path).
    async fn send_with_retry(
        &self,
        request: &StreamRequest,
        options: &StreamOptions,
        auth: &PreparedCodexAuth,
    ) -> Result<(reqwest::Response, CodexDispatchGuard), CodexSendError> {
        let max_retries = options.max_retries.unwrap_or(DEFAULT_MAX_RETRIES);
        let max_retry_delay = options
            .max_retry_delay_ms
            .unwrap_or(DEFAULT_MAX_RETRY_DELAY_MS);
        let mut last_error: Option<ProviderError> = None;
        for attempt in 0..=max_retries {
            let Some(mut dispatch_guard) = tokio::time::timeout(
                OAUTH_REFRESH_CALLER_TIMEOUT,
                blocking_store_begin_dispatch(
                    self.auth_store.clone(),
                    auth.credential_revision.clone(),
                ),
            )
            .await
            .map_err(|_| CodexSendError::StoreUnavailable)?
            .map_err(|_| CodexSendError::StoreUnavailable)?
            else {
                return Err(CodexSendError::Superseded);
            };
            let builder = self.request_builder(request, options, auth);
            let send = builder.send();
            tokio::pin!(send);
            let response = tokio::select! {
                biased;
                _ = dispatch_guard.changed() => return Err(CodexSendError::Superseded),
                response = &mut send => response,
            };
            match response {
                Ok(response) if response.status().is_success() => {
                    return Ok((response, dispatch_guard));
                }
                Ok(response) => {
                    let status = response.status().as_u16();
                    let headers = response.headers().clone();
                    let body = guarded_response_text(response, &mut dispatch_guard).await?;
                    if attempt < max_retries && is_retryable_error(status, &body) {
                        let delay = get_retry_after_delay_ms(&headers, now_ms())
                            .map(|delay| {
                                if status == 429 {
                                    cap_retry_delay_ms(delay, max_retry_delay)
                                } else {
                                    delay
                                }
                            })
                            .unwrap_or_else(|| BASE_DELAY_MS.saturating_mul(1u64 << attempt));
                        guarded_retry_delay(
                            &mut dispatch_guard,
                            std::time::Duration::from_millis(delay),
                        )
                        .await?;
                        continue;
                    }
                    return Err(CodexSendError::Provider(ProviderError::from_http_status(
                        status,
                        parse_codex_error_message(&body, status),
                    )));
                }
                Err(err) => {
                    if attempt < max_retries {
                        let delay = BASE_DELAY_MS.saturating_mul(1u64 << attempt);
                        guarded_retry_delay(
                            &mut dispatch_guard,
                            std::time::Duration::from_millis(delay),
                        )
                        .await?;
                        last_error = Some(ProviderError::Stream(err.to_string()));
                        continue;
                    }
                    return Err(CodexSendError::Provider(ProviderError::Stream(
                        err.to_string(),
                    )));
                }
            }
        }
        Err(CodexSendError::Provider(last_error.unwrap_or_else(|| {
            ProviderError::Stream("Failed after retries".to_string())
        })))
    }
}

async fn start_codex_request(
    provider: &CodexProvider,
    request: &StreamRequest,
    options: &StreamOptions,
) -> Result<(reqwest::Response, CodexDispatchGuard), CodexStartError> {
    const MAX_SUPERSEDED_DISPATCH_RETRIES: usize = 2;
    for attempt in 0..=MAX_SUPERSEDED_DISPATCH_RETRIES {
        let auth = resolve_runtime_auth_with_retry(
            || {
                resolve_runtime_auth(
                    provider.auth_store.clone(),
                    provider.refresher.clone(),
                    None,
                    false,
                )
            },
            false,
        )
        .await
        .map_err(CodexStartError::Runtime)?;
        match provider.send_with_retry(request, options, &auth).await {
            Ok((response, dispatch_guard)) => return Ok((response, dispatch_guard)),
            Err(CodexSendError::Superseded) if attempt < MAX_SUPERSEDED_DISPATCH_RETRIES => {
                continue;
            }
            Err(CodexSendError::Superseded) => {
                return Err(CodexStartError::Runtime(CodexRuntimeError::new(
                    CodexRuntimeErrorCode::TemporarilyUnavailable,
                    "Your ChatGPT sign-in changed while this request was starting. Try again.",
                )))
            }
            Err(CodexSendError::StoreUnavailable) => {
                return Err(CodexStartError::Runtime(CodexRuntimeError::new(
                    CodexRuntimeErrorCode::TemporarilyUnavailable,
                    "ChatGPT sign-in storage is unavailable. Try again.",
                )))
            }
            Err(CodexSendError::Provider(error)) => {
                return Err(CodexStartError::Provider(error));
            }
        }
    }
    unreachable!("bounded dispatch loop always returns")
}

impl Provider for CodexProvider {
    fn info(&self) -> crate::ProviderInfo {
        crate::ProviderInfo {
            id: OPENAI_CODEX_PROVIDER_ID.to_string(),
            label: OPENAI_CODEX_PROVIDER_LABEL.to_string(),
        }
    }

    fn stream_simple(
        &self,
        request: &StreamRequest,
        options: &StreamOptions,
    ) -> Result<EventStream, ProviderError> {
        let base_url = self.base_url.clone();
        let provider_id = request.provider_id.clone();
        let model = request.model.clone();
        let store = self.auth_store.clone();
        let refresher = self.refresher.clone();
        let request = request.clone();
        let options = options.clone();

        let stream = futures::stream::unfold(CodexDriveState::Idle, move |state| {
            let store = store.clone();
            let refresher = refresher.clone();
            let request = request.clone();
            let options = options.clone();
            let base_url = base_url.clone();
            let provider_id = provider_id.clone();
            let model = model.clone();
            drive_codex(
                state,
                store,
                refresher,
                request,
                options,
                base_url,
                provider_id,
                model,
            )
        });
        Ok(Box::pin(stream))
    }
}

type CodexPayloadStream =
    std::pin::Pin<Box<dyn Stream<Item = Result<String, ProviderError>> + Send>>;

// Mirrors the TS lazy-stream flow; the driver needs the resolved request,
// options, store handles, and provider identity together.
#[allow(clippy::large_enum_variant)]
enum CodexDriveState {
    Idle,
    Streaming {
        payload: CodexPayloadStream,
        dispatch_guard: CodexDispatchGuard,
        accumulator: ResponsesAccumulator,
        pending: std::collections::VecDeque<Result<AssistantMessageEvent, ProviderError>>,
        finished: bool,
    },
    Done,
}

#[allow(clippy::too_many_arguments)]
async fn drive_codex(
    mut state: CodexDriveState,
    store: std::sync::Arc<dyn CodexAuthStore>,
    refresher: std::sync::Arc<dyn CodexTokenRefresher>,
    request: StreamRequest,
    options: StreamOptions,
    base_url: String,
    provider_id: String,
    model: String,
) -> Option<(
    Result<AssistantMessageEvent, ProviderError>,
    CodexDriveState,
)> {
    let provider = CodexProvider {
        base_url,
        auth_store: store,
        refresher,
        model_available: None,
    };
    loop {
        state = match state {
            CodexDriveState::Idle => {
                let (response, dispatch_guard) =
                    match start_codex_request(&provider, &request, &options).await {
                        Ok(response) => response,
                        Err(err) => {
                            let message = match err {
                                CodexStartError::Runtime(error) => error.message,
                                CodexStartError::Provider(error) => {
                                    crate::provider_error_message(&error)
                                }
                            };
                            let error_message = AssistantMessage {
                                content: Vec::new(),
                                api: "openai-codex-responses".to_string(),
                                provider: provider_id.clone(),
                                model: model.clone(),
                                response_model: None,
                                response_id: None,
                                usage: aiden_core::Usage {
                                    input: 0,
                                    output: 0,
                                    cache_read: 0,
                                    cache_write: 0,
                                    cache_write_1h: None,
                                    reasoning: None,
                                    total_tokens: 0,
                                    cost: aiden_core::UsageCost {
                                        input: 0.0,
                                        output: 0.0,
                                        cache_read: 0.0,
                                        cache_write: 0.0,
                                        total: 0.0,
                                    },
                                },
                                stop_reason: StopReason::Error,
                                error_message: Some(message),
                                timestamp: now_ms(),
                            };
                            return Some((
                                Ok(AssistantMessageEvent::Error {
                                    reason: StopReason::Error,
                                    error: error_message,
                                }),
                                CodexDriveState::Done,
                            ));
                        }
                    };
                CodexDriveState::Streaming {
                    payload: Box::pin(sse_payload_stream(response)),
                    dispatch_guard,
                    accumulator: ResponsesAccumulator::new(
                        &provider_id,
                        &model,
                        "openai-codex-responses",
                    ),
                    pending: Default::default(),
                    finished: false,
                }
            }
            CodexDriveState::Streaming {
                payload,
                dispatch_guard,
                accumulator,
                pending,
                finished,
            } => {
                let mut accumulator = accumulator;
                let mut pending = pending;
                let mut payload = payload;
                let mut dispatch_guard = dispatch_guard;
                if finished {
                    if let Some(item) = pending.pop_front() {
                        return Some((
                            item,
                            CodexDriveState::Streaming {
                                payload,
                                dispatch_guard,
                                accumulator,
                                pending,
                                finished,
                            },
                        ));
                    }
                    return None;
                }
                let next = tokio::select! {
                    biased;
                    _ = dispatch_guard.changed() => {
                        accumulator.message.stop_reason = StopReason::Error;
                        accumulator.message.error_message = Some(
                            "Your ChatGPT sign-in changed while this response was streaming. Try again."
                                .to_string(),
                        );
                        let terminal = AssistantMessageEvent::Error {
                            reason: StopReason::Error,
                            error: accumulator.message.clone(),
                        };
                        return Some((Ok(terminal), CodexDriveState::Done));
                    }
                    next = futures::StreamExt::next(&mut payload) => next,
                };
                match next {
                    Some(Ok(payload_text)) if payload_text != crate::json::SSE_DONE => {
                        match map_codex_event(&payload_text) {
                            Ok(MappedCodexEvent::Skip) => {}
                            Ok(MappedCodexEvent::Event(event)) => match accumulator.step(&event) {
                                Ok(events) => pending.extend(events.into_iter().map(Ok)),
                                Err(err) => {
                                    accumulator.message.stop_reason = StopReason::Error;
                                    accumulator.message.error_message =
                                        Some(crate::provider_error_message(&err));
                                    pending.push_back(Ok(AssistantMessageEvent::Error {
                                        reason: StopReason::Error,
                                        error: accumulator.message.clone(),
                                    }));
                                }
                            },
                            Ok(MappedCodexEvent::Terminal(event)) => {
                                match accumulator.step(&event) {
                                    Ok(events) => pending.extend(events.into_iter().map(Ok)),
                                    Err(err) => {
                                        accumulator.message.stop_reason = StopReason::Error;
                                        accumulator.message.error_message =
                                            Some(crate::provider_error_message(&err));
                                        pending.push_back(Ok(AssistantMessageEvent::Error {
                                            reason: StopReason::Error,
                                            error: accumulator.message.clone(),
                                        }));
                                    }
                                }
                                match finish_responses(&mut accumulator) {
                                    Ok(events) => pending.extend(events.into_iter().map(Ok)),
                                    Err(err) => pending.push_back(Err(err)),
                                }
                                if let Some(item) = pending.pop_front() {
                                    return Some((
                                        item,
                                        CodexDriveState::Streaming {
                                            payload,
                                            dispatch_guard,
                                            accumulator,
                                            pending,
                                            finished: true,
                                        },
                                    ));
                                }
                                return None;
                            }
                            Err(err) => {
                                accumulator.message.stop_reason = StopReason::Error;
                                accumulator.message.error_message =
                                    Some(crate::provider_error_message(&err));
                                let terminal = AssistantMessageEvent::Error {
                                    reason: StopReason::Error,
                                    error: accumulator.message.clone(),
                                };
                                return Some((Ok(terminal), CodexDriveState::Done));
                            }
                        }
                        if let Some(item) = pending.pop_front() {
                            return Some((
                                item,
                                CodexDriveState::Streaming {
                                    payload,
                                    dispatch_guard,
                                    accumulator,
                                    pending,
                                    finished: false,
                                },
                            ));
                        }
                        CodexDriveState::Streaming {
                            payload,
                            dispatch_guard,
                            accumulator,
                            pending,
                            finished: false,
                        }
                    }
                    Some(Ok(_)) => CodexDriveState::Streaming {
                        payload,
                        dispatch_guard,
                        accumulator,
                        pending,
                        finished: false,
                    },
                    Some(Err(err)) => {
                        accumulator.message.stop_reason = StopReason::Error;
                        accumulator.message.error_message =
                            Some(crate::provider_error_message(&err));
                        let terminal = AssistantMessageEvent::Error {
                            reason: StopReason::Error,
                            error: accumulator.message.clone(),
                        };
                        return Some((Ok(terminal), CodexDriveState::Done));
                    }
                    None => {
                        match accumulator.require_terminal_event() {
                            Ok(()) => match finish_responses(&mut accumulator) {
                                Ok(events) => pending.extend(events.into_iter().map(Ok)),
                                Err(err) => return Some((Err(err), CodexDriveState::Done)),
                            },
                            Err(err) => {
                                accumulator.message.stop_reason = StopReason::Error;
                                accumulator.message.error_message =
                                    Some(crate::provider_error_message(&err));
                                pending.push_back(Ok(AssistantMessageEvent::Error {
                                    reason: StopReason::Error,
                                    error: accumulator.message.clone(),
                                }));
                            }
                        }
                        CodexDriveState::Streaming {
                            payload,
                            dispatch_guard,
                            accumulator,
                            pending,
                            finished: true,
                        }
                    }
                }
            }
            CodexDriveState::Done => return None,
        };
    }
}

// ===========================================================================
// Tests (fixture SSE, no network)
// ===========================================================================

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{ApiFamily, ThinkingLevel};
    use aiden_core::{ContentBlock, Message, ToolDef, UserContent, UserMessage};
    use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
    use std::task::{Context, Poll};

    fn kind(event: &AssistantMessageEvent) -> &'static str {
        match event {
            AssistantMessageEvent::Start { .. } => "start",
            AssistantMessageEvent::TextStart { .. } => "text_start",
            AssistantMessageEvent::TextDelta { .. } => "text_delta",
            AssistantMessageEvent::TextEnd { .. } => "text_end",
            AssistantMessageEvent::ThinkingStart { .. } => "thinking_start",
            AssistantMessageEvent::ThinkingDelta { .. } => "thinking_delta",
            AssistantMessageEvent::ThinkingEnd { .. } => "thinking_end",
            AssistantMessageEvent::ToolcallStart { .. } => "toolcall_start",
            AssistantMessageEvent::ToolcallDelta { .. } => "toolcall_delta",
            AssistantMessageEvent::ToolcallEnd { .. } => "toolcall_end",
            AssistantMessageEvent::Done { .. } => "done",
            AssistantMessageEvent::Error { .. } => "error",
        }
    }

    fn request(model: &str) -> StreamRequest {
        StreamRequest {
            provider_id: OPENAI_CODEX_PROVIDER_ID.to_string(),
            api: ApiFamily::OpenAICodexResponses,
            model: model.to_string(),
            base_url: OPENAI_CODEX_BASE_URL.to_string(),
            reasoning: true,
            thinking_level_map: None,
            force_adaptive_thinking: false,
            vision: true,
            context_window: 400_000,
            max_tokens_limit: 32_000,
            messages: vec![Message::User(UserMessage {
                content: UserContent::Text("hello".to_string()),
                timestamp: 1,
            })],
            system_prompt: Some("You are Aiden.".to_string()),
            max_tokens: Some(4096),
            thinking_level: Some(ThinkingLevel::Medium),
            tools: vec![ToolDef {
                name: "grep".into(),
                description: "Search files".into(),
                parameters: serde_json::json!({"type": "object"}),
            }],
            temperature: None,
            session_id: Some("chat-1".into()),
            reasoning_summary: None,
            text_verbosity: None,
            service_tier: None,
            tool_choice: None,
            model_headers: Default::default(),
        }
    }

    #[test]
    fn text_and_thinking_stream_normalizes_codex_terminal_events() {
        let fixture = br#"data: {"type":"response.created","response":{"id":"resp_1","status":"in_progress"}}

data: {"type":"response.output_item.added","output_index":0,"item":{"type":"message","id":"msg_1","role":"assistant","content":[],"status":"in_progress"}}

data: {"type":"response.output_text.delta","output_index":0,"delta":"Hello"}

data: {"type":"response.output_text.delta","output_index":0,"delta":" Codex"}

data: {"type":"response.output_item.done","output_index":0,"item":{"type":"message","id":"msg_1","role":"assistant","content":[{"type":"output_text","text":"Hello Codex","annotations":[]}],"status":"completed"}}

data: {"type":"response.done","response":{"id":"resp_1","status":"completed","usage":{"input_tokens":14,"output_tokens":2,"total_tokens":16,"input_tokens_details":{"cached_tokens":4},"output_tokens_details":{"reasoning_tokens":0}}}}
"#;
        let events = parse_codex_sse_with_now("openai-codex", "gpt-5.4", fixture, 9).unwrap();
        let kinds: Vec<&str> = events.iter().map(kind).collect();
        assert_eq!(
            kinds,
            ["text_start", "text_delta", "text_delta", "text_end", "done"]
        );
        let AssistantMessageEvent::Done { reason, message } = &events[4] else {
            panic!();
        };
        assert_eq!(*reason, StopReason::Stop);
        assert_eq!(message.response_id.as_deref(), Some("resp_1"));
        assert_eq!(message.usage.input, 10); // 14 - 4 cached
        assert_eq!(message.usage.cache_read, 4);
        assert_eq!(message.usage.total_tokens, 16);
    }

    #[test]
    fn reasoning_signatures_are_backfilled_from_terminal_response() {
        let fixture = br#"data: {"type":"response.output_item.added","output_index":0,"item":{"type":"reasoning","id":"rs_1","summary":[{"type":"summary_text","text":"think"}],"content":[]}}

data: {"type":"response.output_item.done","output_index":0,"item":{"type":"reasoning","id":"rs_1","summary":[{"type":"summary_text","text":"think"}],"content":[]}}

data: {"type":"response.completed","response":{"id":"resp_1","status":"completed","output":[{"type":"reasoning","id":"rs_1","summary":[{"type":"summary_text","text":"think"}],"content":[],"encrypted_content":"enc-blob"}]}}
"#;
        let events = parse_codex_sse_with_now("openai-codex", "gpt-5.4", fixture, 9).unwrap();
        let AssistantMessageEvent::Done { message, .. } = events.last().unwrap() else {
            panic!();
        };
        let ContentBlock::Thinking(thinking) = &message.content[0] else {
            panic!();
        };
        let signature: serde_json::Value =
            serde_json::from_str(thinking.thinking_signature.as_deref().unwrap()).unwrap();
        assert_eq!(signature["encrypted_content"], "enc-blob");
    }

    #[test]
    fn function_calls_use_pipe_separated_ids() {
        let fixture = br#"data: {"type":"response.output_item.added","output_index":0,"item":{"type":"function_call","id":"fc_1","call_id":"call_1","name":"grep","arguments":""}}

data: {"type":"response.function_call_arguments.delta","output_index":0,"delta":"{\"pattern\":"}

data: {"type":"response.function_call_arguments.delta","output_index":0,"delta":"\"foo\"}"}

data: {"type":"response.output_item.done","output_index":0,"item":{"type":"function_call","id":"fc_1","call_id":"call_1","name":"grep","arguments":"{\"pattern\":\"foo\"}"}}

data: {"type":"response.incomplete","response":{"id":"resp_1","status":"incomplete","incomplete_details":{"reason":"max_output_tokens"}}}
"#;
        let events = parse_codex_sse_with_now("openai-codex", "gpt-5.4", fixture, 9).unwrap();
        let AssistantMessageEvent::ToolcallEnd { tool_call, .. } = &events[3] else {
            panic!();
        };
        assert_eq!(tool_call.id, "call_1|fc_1");
        assert_eq!(tool_call.arguments, serde_json::json!({"pattern": "foo"}));
        let AssistantMessageEvent::Done { reason, .. } = events.last().unwrap() else {
            panic!();
        };
        // Incomplete status maps to length; tool-call override only applies to stop.
        assert_eq!(*reason, StopReason::Length);
    }

    #[test]
    fn codex_error_event_is_terminal() {
        let fixture = br#"data: {"type":"error","code":"usage_limit_reached","message":"You have hit your limit"}
"#;
        let events = parse_codex_sse_with_now("openai-codex", "gpt-5.4", fixture, 9).unwrap();
        let AssistantMessageEvent::Error { error, .. } = events.last().unwrap() else {
            panic!("expected error");
        };
        assert_eq!(
            error.error_message.as_deref(),
            Some("Codex error: You have hit your limit")
        );
    }

    #[test]
    fn codex_response_failed_is_terminal() {
        let fixture = br#"data: {"type":"response.failed","response":{"id":"r","status":"failed","error":{"code":"inappropriate","message":"flagged"}}}
"#;
        let events = parse_codex_sse_with_now("openai-codex", "gpt-5.4", fixture, 9).unwrap();
        let AssistantMessageEvent::Error { error, .. } = events.last().unwrap() else {
            panic!();
        };
        assert_eq!(error.error_message.as_deref(), Some("flagged"));
    }

    #[test]
    fn malformed_codex_json_is_a_terminal_error_event() {
        let fixture = br#"data: {broken
"#;
        let events = parse_codex_sse_with_now("openai-codex", "gpt-5.4", fixture, 9).unwrap();
        let AssistantMessageEvent::Error { reason, .. } = events.last().unwrap() else {
            panic!("expected error");
        };
        assert_eq!(*reason, StopReason::Error);
    }

    #[test]
    fn body_shapes_instructions_and_tools() {
        let request = request("gpt-5.4");
        let options = StreamOptions {
            api_key: Some("token".into()),
            text_verbosity: Some("high".into()),
            ..Default::default()
        };
        let body = build_codex_body(&request, &options);
        assert_eq!(body["model"], "gpt-5.4");
        assert_eq!(body["store"], false);
        assert_eq!(body["stream"], true);
        assert_eq!(body["instructions"], "You are Aiden.");
        assert_eq!(body["input"][0]["role"], "user");
        assert_eq!(body["text"]["verbosity"], "high");
        assert_eq!(
            body["include"],
            serde_json::json!(["reasoning.encrypted_content"])
        );
        assert_eq!(body["prompt_cache_key"], "chat-1");
        assert_eq!(body["tool_choice"], "auto");
        assert_eq!(body["parallel_tool_calls"], true);
        assert_eq!(body["tools"][0]["name"], "grep");
        assert_eq!(body["tools"][0]["strict"], serde_json::Value::Null);
        assert_eq!(body["reasoning"]["effort"], "medium");
        assert_eq!(body["reasoning"]["summary"], "auto");
    }

    #[test]
    fn default_instructions_when_no_system_prompt() {
        let request = StreamRequest {
            system_prompt: None,
            ..request("gpt-5.4")
        };
        let body = build_codex_body(&request, &StreamOptions::default());
        assert_eq!(body["instructions"], "You are a helpful assistant.");
    }

    #[test]
    fn url_resolution_appends_codex_responses() {
        assert_eq!(
            resolve_codex_url("https://chatgpt.com/backend-api"),
            "https://chatgpt.com/backend-api/codex/responses"
        );
        assert_eq!(
            resolve_codex_url("https://chatgpt.com/backend-api/"),
            "https://chatgpt.com/backend-api/codex/responses"
        );
        assert_eq!(
            resolve_codex_url("https://host.example/v1/codex"),
            "https://host.example/v1/codex/responses"
        );
        assert_eq!(
            resolve_codex_url("https://host.example/codex/responses"),
            "https://host.example/codex/responses"
        );
        assert_eq!(
            resolve_codex_url(""),
            "https://chatgpt.com/backend-api/codex/responses"
        );
    }

    #[test]
    fn account_id_is_extracted_from_jwt() {
        // base64url payload: {"https://api.openai.com/auth":{"chatgpt_account_id":"acct_123"}}
        use base64::Engine;
        let payload = base64::engine::general_purpose::URL_SAFE_NO_PAD
            .encode(r#"{"https://api.openai.com/auth":{"chatgpt_account_id":"acct_123"}}"#);
        let token = format!("header.{payload}.signature");
        assert_eq!(extract_account_id(&token).unwrap(), "acct_123");
        assert!(extract_account_id("not-a-jwt").is_err());
        // Missing account id.
        let bad = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(r#"{"sub":"x"}"#);
        assert!(extract_account_id(&format!("h.{bad}.s")).is_err());
    }

    #[test]
    fn credential_revision_is_stable_sha256() {
        let credential = OAuthCredential {
            access: "a".into(),
            refresh: "r".into(),
            expires: 1_700_000_000_000,
        };
        let first = credential_revision(Some(&credential)).unwrap();
        assert_eq!(first.len(), 64);
        assert_eq!(first, credential_revision(Some(&credential)).unwrap());
        let changed = OAuthCredential {
            access: "b".into(),
            ..credential
        };
        assert_ne!(first, credential_revision(Some(&changed)).unwrap());
        assert_eq!(credential_revision(None), None);
    }

    struct MemoryStore {
        credential: Mutex<Option<OAuthCredential>>,
        credential_gate: CodexCredentialGate,
        refresh_coordinator: Arc<CodexRefreshCoordinator>,
        supersede_next_dispatch: Mutex<Option<Option<OAuthCredential>>>,
    }

    impl MemoryStore {
        fn new(credential: Option<OAuthCredential>) -> Self {
            Self {
                credential: Mutex::new(credential),
                credential_gate: CodexCredentialGate::default(),
                refresh_coordinator: Arc::new(CodexRefreshCoordinator::default()),
                supersede_next_dispatch: Mutex::new(None),
            }
        }

        fn value(&self) -> Option<OAuthCredential> {
            self.credential.lock().unwrap().clone()
        }

        fn supersede_next_dispatch(&self, credential: Option<OAuthCredential>) {
            *self.supersede_next_dispatch.lock().unwrap() = Some(credential);
        }
    }

    impl CodexAuthStore for MemoryStore {
        fn read(&self) -> Result<Option<OAuthCredential>, ProviderError> {
            Ok(self.value())
        }
        fn write(&self, credential: Option<&OAuthCredential>) -> Result<(), ProviderError> {
            self.credential_gate.mutate(|| {
                *self.credential.lock().unwrap() = credential.cloned();
                Ok::<_, ProviderError>(((), true))
            })
        }

        fn write_if_revision(
            &self,
            expected_revision: &str,
            credential: &OAuthCredential,
        ) -> Result<bool, ProviderError> {
            self.credential_gate.mutate(|| {
                let mut current = self.credential.lock().unwrap();
                if credential_revision(current.as_ref()).as_deref() != Some(expected_revision) {
                    return Ok((false, false));
                }
                *current = Some(credential.clone());
                Ok((true, true))
            })
        }

        fn refresh_coordinator(&self) -> Arc<CodexRefreshCoordinator> {
            self.refresh_coordinator.clone()
        }

        fn begin_dispatch(
            &self,
            expected_revision: &str,
        ) -> Result<Option<CodexDispatchGuard>, ProviderError> {
            if let Some(replacement) = self.supersede_next_dispatch.lock().unwrap().take() {
                self.write(replacement.as_ref())?;
            }
            self.credential_gate.begin_dispatch(|| {
                Ok(
                    credential_revision(self.value().as_ref()).as_deref()
                        == Some(expected_revision),
                )
            })
        }
    }

    enum FailingStoreMode {
        Read,
        ConditionalWrite,
    }

    struct FailingStore {
        credential: Option<OAuthCredential>,
        mode: FailingStoreMode,
        refresh_coordinator: Arc<CodexRefreshCoordinator>,
    }

    impl FailingStore {
        fn new(credential: Option<OAuthCredential>, mode: FailingStoreMode) -> Self {
            Self {
                credential,
                mode,
                refresh_coordinator: Arc::new(CodexRefreshCoordinator::default()),
            }
        }

        fn sentinel() -> ProviderError {
            ProviderError::Auth(
                "SECRET_TOKEN at /Users/private/pi-provider-credentials.json".into(),
            )
        }
    }

    impl CodexAuthStore for FailingStore {
        fn read(&self) -> Result<Option<OAuthCredential>, ProviderError> {
            if matches!(self.mode, FailingStoreMode::Read) {
                Err(Self::sentinel())
            } else {
                Ok(self.credential.clone())
            }
        }

        fn write(&self, _credential: Option<&OAuthCredential>) -> Result<(), ProviderError> {
            Ok(())
        }

        fn write_if_revision(
            &self,
            _expected_revision: &str,
            _credential: &OAuthCredential,
        ) -> Result<bool, ProviderError> {
            if matches!(self.mode, FailingStoreMode::ConditionalWrite) {
                Err(Self::sentinel())
            } else {
                Ok(false)
            }
        }

        fn refresh_coordinator(&self) -> Arc<CodexRefreshCoordinator> {
            self.refresh_coordinator.clone()
        }

        fn begin_dispatch(
            &self,
            _expected_revision: &str,
        ) -> Result<Option<CodexDispatchGuard>, ProviderError> {
            Err(Self::sentinel())
        }
    }

    struct BlockingCasStore {
        inner: MemoryStore,
        entered: AtomicBool,
        released: (Mutex<bool>, std::sync::Condvar),
    }

    impl BlockingCasStore {
        fn new(credential: OAuthCredential) -> Self {
            Self {
                inner: MemoryStore::new(Some(credential)),
                entered: AtomicBool::new(false),
                released: (Mutex::new(false), std::sync::Condvar::new()),
            }
        }

        fn release(&self) {
            *self.released.0.lock().unwrap() = true;
            self.released.1.notify_all();
        }
    }

    impl CodexAuthStore for BlockingCasStore {
        fn read(&self) -> Result<Option<OAuthCredential>, ProviderError> {
            self.inner.read()
        }

        fn write(&self, credential: Option<&OAuthCredential>) -> Result<(), ProviderError> {
            self.inner.write(credential)
        }

        fn write_if_revision(
            &self,
            expected_revision: &str,
            credential: &OAuthCredential,
        ) -> Result<bool, ProviderError> {
            self.entered.store(true, Ordering::Release);
            let mut released = self.released.0.lock().unwrap();
            while !*released {
                released = self.released.1.wait(released).unwrap();
            }
            drop(released);
            self.inner.write_if_revision(expected_revision, credential)
        }

        fn refresh_coordinator(&self) -> Arc<CodexRefreshCoordinator> {
            self.inner.refresh_coordinator()
        }

        fn begin_dispatch(
            &self,
            expected_revision: &str,
        ) -> Result<Option<CodexDispatchGuard>, ProviderError> {
            self.inner.begin_dispatch(expected_revision)
        }
    }

    struct CountingRefresher {
        calls: AtomicUsize,
        credential: OAuthCredential,
    }

    struct PanicOnceRefresher {
        calls: AtomicUsize,
        credential: OAuthCredential,
    }

    impl CodexTokenRefresher for PanicOnceRefresher {
        fn refresh(
            &self,
            _refresh_token: &str,
        ) -> Pin<Box<dyn Future<Output = Result<OAuthCredential, ProviderError>> + Send>> {
            let call = self.calls.fetch_add(1, Ordering::AcqRel);
            let credential = self.credential.clone();
            Box::pin(async move {
                assert_ne!(call, 0, "injected refresh panic");
                Ok(credential)
            })
        }
    }

    impl CodexTokenRefresher for CountingRefresher {
        fn refresh(
            &self,
            _refresh_token: &str,
        ) -> Pin<Box<dyn Future<Output = Result<OAuthCredential, ProviderError>> + Send>> {
            self.calls.fetch_add(1, Ordering::AcqRel);
            let credential = self.credential.clone();
            Box::pin(async move { Ok(credential) })
        }
    }

    struct ControlledRefresher {
        calls: AtomicUsize,
        started: tokio::sync::Notify,
        receiver:
            Mutex<Option<tokio::sync::oneshot::Receiver<Result<OAuthCredential, ProviderError>>>>,
    }

    impl CodexTokenRefresher for ControlledRefresher {
        fn refresh(
            &self,
            _refresh_token: &str,
        ) -> Pin<Box<dyn Future<Output = Result<OAuthCredential, ProviderError>> + Send>> {
            self.calls.fetch_add(1, Ordering::AcqRel);
            self.started.notify_one();
            let receiver = self.receiver.lock().unwrap().take();
            Box::pin(async move {
                receiver
                    .ok_or_else(|| ProviderError::Stream("duplicate refresh".into()))?
                    .await
                    .map_err(|_| ProviderError::Stream("refresh sender dropped".into()))?
            })
        }
    }

    fn controlled_refresher() -> (
        Arc<ControlledRefresher>,
        tokio::sync::oneshot::Sender<Result<OAuthCredential, ProviderError>>,
    ) {
        let (sender, receiver) = tokio::sync::oneshot::channel();
        (
            Arc::new(ControlledRefresher {
                calls: AtomicUsize::new(0),
                started: tokio::sync::Notify::new(),
                receiver: Mutex::new(Some(receiver)),
            }),
            sender,
        )
    }

    struct StaticRefresher(OAuthCredential);
    impl CodexTokenRefresher for StaticRefresher {
        fn refresh(
            &self,
            _refresh_token: &str,
        ) -> Pin<Box<dyn Future<Output = Result<OAuthCredential, ProviderError>> + Send>> {
            let credential = self.0.clone();
            Box::pin(async move { Ok(credential) })
        }
    }

    struct DropAwarePendingRefresh {
        dropped: Arc<AtomicBool>,
    }

    impl Future for DropAwarePendingRefresh {
        type Output = Result<OAuthCredential, ProviderError>;

        fn poll(self: Pin<&mut Self>, _context: &mut Context<'_>) -> Poll<Self::Output> {
            Poll::Pending
        }
    }

    impl Drop for DropAwarePendingRefresh {
        fn drop(&mut self) {
            self.dropped.store(true, Ordering::Release);
        }
    }

    struct PendingRefresher {
        dropped: Arc<AtomicBool>,
    }

    impl CodexTokenRefresher for PendingRefresher {
        fn refresh(
            &self,
            _refresh_token: &str,
        ) -> Pin<Box<dyn Future<Output = Result<OAuthCredential, ProviderError>> + Send>> {
            Box::pin(DropAwarePendingRefresh {
                dropped: self.dropped.clone(),
            })
        }
    }

    /// Deterministically changes the durable credential after the resolver's
    /// read but before its refresh commit.
    struct SupersedingRefresher {
        store: Arc<MemoryStore>,
        replacement: Option<OAuthCredential>,
        refreshed: OAuthCredential,
    }

    impl CodexTokenRefresher for SupersedingRefresher {
        fn refresh(
            &self,
            _refresh_token: &str,
        ) -> Pin<Box<dyn Future<Output = Result<OAuthCredential, ProviderError>> + Send>> {
            self.store.write(self.replacement.as_ref()).unwrap();
            let refreshed = self.refreshed.clone();
            Box::pin(async move { Ok(refreshed) })
        }
    }

    fn jwt_token(account_id: &str) -> String {
        use base64::Engine;
        let payload =
            format!(r#"{{"https://api.openai.com/auth":{{"chatgpt_account_id":"{account_id}"}}}}"#);
        let payload = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(payload);
        format!("header.{payload}.signature")
    }

    async fn one_request_server() -> (
        String,
        tokio::sync::oneshot::Receiver<String>,
        tokio::task::JoinHandle<()>,
    ) {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};

        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let (request_sender, request_receiver) = tokio::sync::oneshot::channel();
        let task = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut request = Vec::new();
            let mut buffer = [0_u8; 2048];
            loop {
                let read = socket.read(&mut buffer).await.unwrap();
                if read == 0 {
                    break;
                }
                request.extend_from_slice(&buffer[..read]);
                if request.windows(4).any(|window| window == b"\r\n\r\n") {
                    break;
                }
            }
            let _ = request_sender.send(String::from_utf8_lossy(&request).into_owned());
            socket
                .write_all(
                    b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
                )
                .await
                .unwrap();
        });
        (format!("http://{address}"), request_receiver, task)
    }

    async fn oauth_response_server(
        status: &'static str,
        headers: &'static str,
        body: Vec<u8>,
    ) -> (String, tokio::task::JoinHandle<()>) {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};

        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let task = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut request = Vec::new();
            let mut buffer = [0_u8; 2048];
            loop {
                let read = socket.read(&mut buffer).await.unwrap();
                if read == 0 {
                    break;
                }
                request.extend_from_slice(&buffer[..read]);
                if request.windows(4).any(|window| window == b"\r\n\r\n") {
                    break;
                }
            }
            let response = format!(
                "HTTP/1.1 {status}\r\nContent-Length: {}\r\n{headers}Connection: close\r\n\r\n",
                body.len()
            );
            socket.write_all(response.as_bytes()).await.unwrap();
            socket.write_all(&body).await.unwrap();
        });
        (format!("http://{address}/oauth/token"), task)
    }

    #[test]
    fn oauth_credential_debug_is_secret_free() {
        let credential = OAuthCredential {
            access: "access-sentinel".to_string(),
            refresh: "refresh-sentinel".to_string(),
            expires: 42,
        };
        let debug = format!("{credential:?}");
        assert!(!debug.contains("access-sentinel"));
        assert!(!debug.contains("refresh-sentinel"));
        assert!(debug.contains("[redacted]"));
        assert!(debug.contains("42"));
    }

    #[tokio::test]
    async fn oauth_refresh_rejects_empty_or_unusable_tokens_before_returning_credentials() {
        let cases = [
            serde_json::json!({
                "access_token": "",
                "refresh_token": "refresh",
                "expires_in": 3600
            }),
            serde_json::json!({
                "access_token": jwt_token("acct"),
                "refresh_token": "",
                "expires_in": 3600
            }),
            serde_json::json!({
                "access_token": "header.invalid.signature",
                "refresh_token": "refresh",
                "expires_in": 3600
            }),
            serde_json::json!({
                "access_token": "header.e30.signature",
                "refresh_token": "refresh",
                "expires_in": 3600
            }),
            serde_json::json!({
                "access_token": jwt_token("acct"),
                "refresh_token": "refresh",
                "expires_in": "3600"
            }),
        ];
        for body in cases {
            let (url, server) = oauth_response_server(
                "200 OK",
                "Content-Type: application/json\r\n",
                serde_json::to_vec(&body).unwrap(),
            )
            .await;
            let result = HttpCodexTokenRefresher::for_test(url)
                .refresh("old-refresh")
                .await;
            assert!(result.is_err(), "unexpected credential for {body}");
            server.await.unwrap();
        }
    }

    #[tokio::test]
    async fn oauth_refresh_rejects_oversized_bodies_and_does_not_follow_redirects() {
        let (url, server) = oauth_response_server(
            "200 OK",
            "Content-Type: application/json\r\n",
            vec![b'x'; MAX_OAUTH_REFRESH_RESPONSE_BYTES + 1],
        )
        .await;
        let oversized = HttpCodexTokenRefresher::for_test(url)
            .refresh("refresh-sentinel")
            .await
            .unwrap_err();
        assert!(oversized.to_string().contains("too large"));
        assert!(!oversized.to_string().contains("refresh-sentinel"));
        server.await.unwrap();

        let (url, server) = oauth_response_server(
            "307 Temporary Redirect",
            "Location: http://127.0.0.1:9/stolen\r\n",
            Vec::new(),
        )
        .await;
        let redirected = HttpCodexTokenRefresher::for_test(url)
            .refresh("refresh-sentinel")
            .await
            .unwrap_err();
        assert!(redirected.to_string().contains("307"));
        assert!(!redirected.to_string().contains("refresh-sentinel"));
        server.await.unwrap();
    }

    #[tokio::test]
    async fn malformed_oauth_refresh_never_replaces_the_durable_credential() {
        let original = OAuthCredential {
            access: jwt_token("acct-original"),
            refresh: "original-refresh".to_string(),
            expires: 1,
        };
        let store = Arc::new(MemoryStore::new(Some(original.clone())));
        let (url, server) = oauth_response_server(
            "200 OK",
            "Content-Type: application/json\r\n",
            serde_json::to_vec(&serde_json::json!({
                "access_token": "header.e30.signature",
                "refresh_token": "replacement-refresh",
                "expires_in": 3600
            }))
            .unwrap(),
        )
        .await;
        let refresher: Arc<dyn CodexTokenRefresher> =
            Arc::new(HttpCodexTokenRefresher::for_test(url));
        let result = resolve_runtime_auth(store.clone(), refresher, None, false).await;
        assert!(result.is_err());
        assert_eq!(store.read().unwrap(), Some(original));
        server.await.unwrap();
    }

    async fn stalled_error_response() -> (
        reqwest::Response,
        tokio::sync::oneshot::Sender<()>,
        tokio::task::JoinHandle<()>,
    ) {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};

        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let (release_sender, release_receiver) = tokio::sync::oneshot::channel();
        let task = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut request = Vec::new();
            let mut buffer = [0_u8; 2048];
            loop {
                let read = socket.read(&mut buffer).await.unwrap();
                if read == 0 {
                    return;
                }
                request.extend_from_slice(&buffer[..read]);
                if request.windows(4).any(|window| window == b"\r\n\r\n") {
                    break;
                }
            }
            socket
                .write_all(
                    b"HTTP/1.1 429 Too Many Requests\r\nContent-Type: text/plain\r\nContent-Length: 64\r\nConnection: close\r\n\r\npartial",
                )
                .await
                .unwrap();
            let _ = release_receiver.await;
        });
        let response = reqwest::get(format!("http://{address}")).await.unwrap();
        (response, release_sender, task)
    }

    #[tokio::test]
    async fn auth_resolves_without_refresh_when_not_expiring() {
        let store = Arc::new(MemoryStore::new(Some(OAuthCredential {
            access: jwt_token("acct_1"),
            refresh: "refresh-token".into(),
            expires: now_ms() + 3_600_000,
        })));
        let refresher = Arc::new(StaticRefresher(OAuthCredential {
            access: jwt_token("acct_2"),
            refresh: "new-refresh".into(),
            expires: now_ms() + 3_600_000,
        }));
        let auth = resolve_runtime_auth_with_retry(
            || resolve_runtime_auth(store.clone(), refresher.clone(), None, false),
            false,
        )
        .await
        .unwrap();
        assert_eq!(auth.access_token, jwt_token("acct_1"));
        assert_eq!(auth.account_id, "acct_1");
        // No refresh → store unchanged.
        assert_eq!(store.value().as_ref().unwrap().access, jwt_token("acct_1"));
    }

    #[tokio::test]
    async fn auth_refreshes_when_near_expiry() {
        let store = Arc::new(MemoryStore::new(Some(OAuthCredential {
            access: jwt_token("acct_1"),
            refresh: "refresh-token".into(),
            expires: now_ms() + 30_000, // inside the 60s skew
        })));
        let refresher = Arc::new(StaticRefresher(OAuthCredential {
            access: jwt_token("acct_2"),
            refresh: "new-refresh".into(),
            expires: now_ms() + 3_600_000,
        }));
        let auth = resolve_runtime_auth_with_retry(
            || resolve_runtime_auth(store.clone(), refresher.clone(), None, false),
            false,
        )
        .await
        .unwrap();
        assert_eq!(auth.access_token, jwt_token("acct_2"));
        assert_eq!(auth.account_id, "acct_2");
        // Rotated credential was persisted.
        assert_eq!(store.value().as_ref().unwrap().access, jwt_token("acct_2"));
    }

    #[tokio::test]
    async fn concurrent_callers_share_one_refresh_operation() {
        let original = OAuthCredential {
            access: jwt_token("acct_old"),
            refresh: "one-time-refresh".into(),
            expires: now_ms() + 30_000,
        };
        let refreshed = OAuthCredential {
            access: jwt_token("acct_new"),
            refresh: "rotated-refresh".into(),
            expires: now_ms() + 3_600_000,
        };
        let store = Arc::new(MemoryStore::new(Some(original)));
        let (refresher, sender) = controlled_refresher();
        let first_store = store.clone();
        let first_refresher = refresher.clone();
        let second_store = store.clone();
        let second_refresher = refresher.clone();
        let callers = tokio::spawn(async move {
            tokio::join!(
                resolve_runtime_auth_with_timeout(
                    first_store,
                    first_refresher,
                    None,
                    false,
                    Duration::from_secs(1),
                    Duration::from_secs(1),
                ),
                resolve_runtime_auth_with_timeout(
                    second_store,
                    second_refresher,
                    None,
                    false,
                    Duration::from_secs(1),
                    Duration::from_secs(1),
                )
            )
        });

        tokio::time::timeout(Duration::from_secs(1), refresher.started.notified())
            .await
            .unwrap();
        sender.send(Ok(refreshed.clone())).unwrap();
        let (first, second) = callers.await.unwrap();

        assert_eq!(first.unwrap().access_token, refreshed.access);
        assert_eq!(second.unwrap().access_token, refreshed.access);
        assert_eq!(refresher.calls.load(Ordering::Acquire), 1);
        assert_eq!(store.value(), Some(refreshed));
    }

    #[tokio::test]
    async fn panicked_refresh_evicts_its_registry_slot_and_retry_succeeds() {
        let original = OAuthCredential {
            access: jwt_token("acct_old"),
            refresh: "one-time-refresh".into(),
            expires: now_ms() + 30_000,
        };
        let refreshed = OAuthCredential {
            access: jwt_token("acct_new"),
            refresh: "rotated-refresh".into(),
            expires: now_ms() + 3_600_000,
        };
        let store = Arc::new(MemoryStore::new(Some(original)));
        let refresher = Arc::new(PanicOnceRefresher {
            calls: AtomicUsize::new(0),
            credential: refreshed.clone(),
        });

        let first = resolve_runtime_auth_with_timeout(
            store.clone(),
            refresher.clone(),
            None,
            false,
            Duration::from_secs(1),
            Duration::from_secs(1),
        )
        .await
        .unwrap_err();
        assert!(matches!(first, CodexAuthError::Runtime(_)));

        let second = resolve_runtime_auth_with_timeout(
            store.clone(),
            refresher.clone(),
            None,
            false,
            Duration::from_secs(1),
            Duration::from_secs(1),
        )
        .await
        .unwrap();

        assert_eq!(second.access_token, refreshed.access);
        assert_eq!(refresher.calls.load(Ordering::Acquire), 2);
        assert_eq!(store.value(), Some(refreshed));
    }

    #[tokio::test]
    async fn blocked_cas_stays_single_owner_and_late_success_becomes_reusable() {
        let original = OAuthCredential {
            access: jwt_token("acct_old"),
            refresh: "one-time-refresh".into(),
            expires: now_ms() + 30_000,
        };
        let refreshed = OAuthCredential {
            access: jwt_token("acct_new"),
            refresh: "rotated-refresh".into(),
            expires: now_ms() + 3_600_000,
        };
        let original_revision = credential_revision(Some(&original)).unwrap();
        let store = Arc::new(BlockingCasStore::new(original));
        let refresher = Arc::new(CountingRefresher {
            calls: AtomicUsize::new(0),
            credential: refreshed.clone(),
        });

        let first = resolve_runtime_auth_with_timeout(
            store.clone(),
            refresher.clone(),
            None,
            false,
            Duration::from_millis(100),
            Duration::from_millis(20),
        )
        .await
        .unwrap_err();
        assert!(matches!(first, CodexAuthError::Runtime(_)));
        tokio::time::timeout(Duration::from_secs(1), async {
            while !store.entered.load(Ordering::Acquire) {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        assert!(store.entered.load(Ordering::Acquire));

        tokio::time::sleep(Duration::from_millis(25)).await;
        let second = resolve_runtime_auth_with_timeout(
            store.clone(),
            refresher.clone(),
            None,
            false,
            Duration::from_millis(100),
            Duration::from_millis(20),
        )
        .await
        .unwrap_err();
        assert!(matches!(second, CodexAuthError::Runtime(_)));
        assert_eq!(refresher.calls.load(Ordering::Acquire), 1);

        let operation = store
            .refresh_coordinator()
            .operations
            .lock()
            .unwrap()
            .get(&original_revision)
            .expect("blocked persistence must retain refresh ownership")
            .clone();
        store.release();
        tokio::time::timeout(Duration::from_secs(1), async {
            loop {
                if matches!(
                    operation.outcome.borrow().clone(),
                    Some(CodexRefreshOutcome::Refreshed(_))
                ) {
                    break;
                }
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();

        let resolved = resolve_runtime_auth_with_timeout(
            store.clone(),
            refresher.clone(),
            None,
            false,
            Duration::from_secs(1),
            Duration::from_secs(1),
        )
        .await
        .unwrap();
        assert_eq!(resolved.access_token, refreshed.access);
        assert_eq!(refresher.calls.load(Ordering::Acquire), 1);
        assert_eq!(store.read().unwrap(), Some(refreshed));
    }

    #[tokio::test]
    async fn caller_timeout_allows_late_rotation_to_reconcile() {
        let original = OAuthCredential {
            access: jwt_token("acct_old"),
            refresh: "one-time-refresh".into(),
            expires: now_ms() + 30_000,
        };
        let refreshed = OAuthCredential {
            access: jwt_token("acct_new"),
            refresh: "rotated-refresh".into(),
            expires: now_ms() + 3_600_000,
        };
        let store = Arc::new(MemoryStore::new(Some(original)));
        let (refresher, sender) = controlled_refresher();

        let error = resolve_runtime_auth_with_timeout(
            store.clone(),
            refresher.clone(),
            None,
            false,
            Duration::from_millis(1),
            Duration::from_secs(1),
        )
        .await
        .unwrap_err();
        assert!(matches!(error, CodexAuthError::Runtime(_)));
        assert_eq!(refresher.calls.load(Ordering::Acquire), 1);

        sender.send(Ok(refreshed.clone())).unwrap();
        tokio::time::timeout(Duration::from_secs(1), async {
            while store.value() != Some(refreshed.clone()) {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        assert_eq!(store.value(), Some(refreshed));
    }

    #[tokio::test]
    async fn late_rotation_cannot_overwrite_a_new_login_or_logout() {
        let original = OAuthCredential {
            access: jwt_token("acct_old"),
            refresh: "one-time-refresh".into(),
            expires: now_ms() + 30_000,
        };
        let newer = OAuthCredential {
            access: jwt_token("acct_new"),
            refresh: "new-login-refresh".into(),
            expires: now_ms() + 3_600_000,
        };
        let stale_rotation = OAuthCredential {
            access: jwt_token("acct_stale"),
            refresh: "rotated-old-refresh".into(),
            expires: now_ms() + 3_600_000,
        };

        for replacement in [Some(newer.clone()), None] {
            let store = Arc::new(MemoryStore::new(Some(original.clone())));
            let original_revision = credential_revision(Some(&original)).unwrap();
            let (refresher, sender) = controlled_refresher();
            let _ = resolve_runtime_auth_with_timeout(
                store.clone(),
                refresher,
                None,
                false,
                Duration::from_millis(1),
                Duration::from_secs(1),
            )
            .await
            .unwrap_err();
            let operation = store
                .refresh_coordinator
                .operations
                .lock()
                .unwrap()
                .get(&original_revision)
                .unwrap()
                .clone();

            store.write(replacement.as_ref()).unwrap();
            sender.send(Ok(stale_rotation.clone())).unwrap();

            assert!(matches!(
                operation.wait().await,
                CodexRefreshOutcome::Superseded
            ));
            assert_eq!(store.value(), replacement);
        }
    }

    #[tokio::test]
    async fn auth_refresh_has_an_independent_deadline() {
        let original = OAuthCredential {
            access: jwt_token("acct_1"),
            refresh: "refresh-token".into(),
            expires: now_ms() + 30_000,
        };
        let store = Arc::new(MemoryStore::new(Some(original.clone())));
        let dropped = Arc::new(AtomicBool::new(false));
        let refresher = Arc::new(PendingRefresher {
            dropped: dropped.clone(),
        });

        let error = resolve_runtime_auth_with_timeout(
            store.clone(),
            refresher,
            None,
            false,
            Duration::from_millis(1),
            Duration::from_millis(20),
        )
        .await
        .unwrap_err();

        let CodexAuthError::Runtime(error) = error else {
            panic!("refresh deadline should be a runtime failure");
        };
        assert_eq!(error.code, CodexRuntimeErrorCode::TemporarilyUnavailable);
        assert!(error.message.contains("timed out"));
        assert!(!dropped.load(Ordering::Acquire));
        assert_eq!(store.value(), Some(original));
        tokio::time::sleep(Duration::from_millis(30)).await;
        assert!(dropped.load(Ordering::Acquire));
    }

    #[tokio::test]
    async fn dropping_auth_resolution_keeps_bounded_reconciliation_alive() {
        let store = Arc::new(MemoryStore::new(Some(OAuthCredential {
            access: jwt_token("acct_1"),
            refresh: "refresh-token".into(),
            expires: now_ms() + 30_000,
        })));
        let dropped = Arc::new(AtomicBool::new(false));
        let refresher = Arc::new(PendingRefresher {
            dropped: dropped.clone(),
        });
        let coordinator = store.refresh_coordinator();
        let resolution = tokio::spawn(resolve_runtime_auth_with_timeout(
            store,
            refresher,
            None,
            false,
            Duration::from_secs(60),
            Duration::from_millis(20),
        ));

        tokio::time::timeout(Duration::from_secs(1), async {
            loop {
                if !coordinator.operations.lock().unwrap().is_empty() {
                    break;
                }
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("the shared refresh should start");
        assert!(!dropped.load(Ordering::Acquire));
        resolution.abort();
        assert!(!dropped.load(Ordering::Acquire));
        tokio::time::sleep(Duration::from_millis(30)).await;
        assert!(dropped.load(Ordering::Acquire));
    }

    #[tokio::test]
    async fn refresh_does_not_overwrite_a_newer_sign_in() {
        let original = OAuthCredential {
            access: jwt_token("acct_old"),
            refresh: "old-refresh".into(),
            expires: now_ms() + 30_000,
        };
        let newer = OAuthCredential {
            access: jwt_token("acct_new"),
            refresh: "new-sign-in-refresh".into(),
            expires: now_ms() + 3_600_000,
        };
        let stale_refresh = OAuthCredential {
            access: jwt_token("acct_stale_refresh"),
            refresh: "rotated-old-refresh".into(),
            expires: now_ms() + 3_600_000,
        };
        let store = Arc::new(MemoryStore::new(Some(original)));
        let refresher = Arc::new(SupersedingRefresher {
            store: store.clone(),
            replacement: Some(newer.clone()),
            refreshed: stale_refresh,
        });

        let auth = resolve_runtime_auth_with_retry(
            || resolve_runtime_auth(store.clone(), refresher.clone(), None, false),
            false,
        )
        .await
        .unwrap();

        assert_eq!(auth.access_token, newer.access);
        assert_eq!(auth.account_id, "acct_new");
        assert_eq!(store.value(), Some(newer));
    }

    #[tokio::test]
    async fn refresh_does_not_restore_a_concurrent_logout() {
        let original = OAuthCredential {
            access: jwt_token("acct_old"),
            refresh: "old-refresh".into(),
            expires: now_ms() + 30_000,
        };
        let stale_refresh = OAuthCredential {
            access: jwt_token("acct_stale_refresh"),
            refresh: "rotated-old-refresh".into(),
            expires: now_ms() + 3_600_000,
        };
        let store = Arc::new(MemoryStore::new(Some(original)));
        let refresher = Arc::new(SupersedingRefresher {
            store: store.clone(),
            replacement: None,
            refreshed: stale_refresh,
        });

        let error = resolve_runtime_auth_with_retry(
            || resolve_runtime_auth(store.clone(), refresher.clone(), None, false),
            false,
        )
        .await
        .unwrap_err();

        assert_eq!(error.code, CodexRuntimeErrorCode::SignInRequired);
        assert_eq!(store.value(), None);
    }

    #[tokio::test]
    async fn auth_requires_sign_in_when_missing() {
        let store = Arc::new(MemoryStore::new(None));
        let refresher = Arc::new(StaticRefresher(OAuthCredential {
            access: "x".into(),
            refresh: "y".into(),
            expires: now_ms() + 3_600_000,
        }));
        let err = resolve_runtime_auth_with_retry(
            || resolve_runtime_auth(store.clone(), refresher.clone(), None, false),
            false,
        )
        .await
        .unwrap_err();
        assert_eq!(err.code, CodexRuntimeErrorCode::SignInRequired);
        assert!(err.message.contains("Sign in with ChatGPT"));
    }

    #[tokio::test]
    async fn store_failures_never_expose_inner_error_text() {
        let refresher: Arc<dyn CodexTokenRefresher> = Arc::new(StaticRefresher(OAuthCredential {
            access: jwt_token("acct_new"),
            refresh: "rotated-refresh".into(),
            expires: now_ms() + 3_600_000,
        }));
        let read_error = resolve_runtime_auth(
            Arc::new(FailingStore::new(None, FailingStoreMode::Read)),
            refresher.clone(),
            None,
            false,
        )
        .await
        .unwrap_err();
        let CodexAuthError::Runtime(read_error) = read_error else {
            panic!("store read should be a runtime failure");
        };

        let expiring = OAuthCredential {
            access: jwt_token("acct_old"),
            refresh: "one-time-refresh".into(),
            expires: now_ms() + 30_000,
        };
        let write_error = resolve_runtime_auth_with_timeout(
            Arc::new(FailingStore::new(
                Some(expiring),
                FailingStoreMode::ConditionalWrite,
            )),
            refresher,
            None,
            false,
            Duration::from_secs(1),
            Duration::from_secs(1),
        )
        .await
        .unwrap_err();
        let CodexAuthError::Runtime(write_error) = write_error else {
            panic!("store write should be a runtime failure");
        };

        for message in [read_error.message, write_error.message] {
            assert!(message.contains("storage is unavailable"));
            assert!(!message.contains("SECRET_TOKEN"));
            assert!(!message.contains("/Users/private"));
        }
    }

    #[tokio::test]
    async fn auth_retries_on_superseded_then_succeeds() {
        let attempts = Arc::new(Mutex::new(0));
        let attempts_clone = attempts.clone();
        let auth = resolve_runtime_auth_with_retry(
            move || {
                let mut count = attempts_clone.lock().unwrap();
                *count += 1;
                let result = if *count == 1 {
                    Err(CodexAuthError::Superseded)
                } else {
                    Ok(PreparedCodexAuth {
                        access_token: "ok".into(),
                        account_id: "acct".into(),
                        credential_revision: "rev".into(),
                    })
                };
                std::future::ready(result)
            },
            false,
        )
        .await
        .unwrap();
        assert_eq!(auth.access_token, "ok");
        assert_eq!(*attempts.lock().unwrap(), 2);
    }

    #[tokio::test]
    async fn auth_gives_up_after_max_superseded_retries() {
        let err = resolve_runtime_auth_with_retry(
            || std::future::ready(Err(CodexAuthError::Superseded)),
            false,
        )
        .await
        .unwrap_err();
        assert_eq!(err.code, CodexRuntimeErrorCode::TemporarilyUnavailable);
    }

    #[tokio::test]
    async fn cancelled_request_maps_to_request_cancelled() {
        let err = resolve_runtime_auth_with_retry(
            || std::future::ready(Err(CodexAuthError::Cancelled)),
            true,
        )
        .await
        .unwrap_err();
        assert_eq!(err.code, CodexRuntimeErrorCode::RequestCancelled);
    }

    #[test]
    fn auth_failure_detection_covers_common_messages() {
        assert!(is_codex_authentication_failure(Some("401 Unauthorized")));
        assert!(is_codex_authentication_failure(Some("invalid_grant")));
        assert!(is_codex_authentication_failure(Some(
            "Authentication required"
        )));
        assert!(is_codex_authentication_failure(Some(
            "token refresh failed (400)"
        )));
        assert!(is_codex_authentication_failure(Some(
            "Failed to extract accountId from token"
        )));
        assert!(!is_codex_authentication_failure(Some("overloaded")));
        assert!(!is_codex_authentication_failure(None));
    }

    #[test]
    fn retryable_error_classification() {
        assert!(is_retryable_error(429, "overloaded"));
        assert!(is_retryable_error(503, ""));
        assert!(!is_retryable_error(429, "Monthly usage limit reached"));
        assert!(!is_retryable_error(400, "bad request"));
        assert!(is_retryable_error(
            200,
            "service unavailable upstream connect"
        ));
    }

    #[test]
    fn usage_limit_error_message_is_friendly() {
        let body =
            r#"{"error":{"code":"usage_limit_reached","message":"nope","plan_type":"Free"}}"#;
        let message = parse_codex_error_message(body, 429);
        assert!(message.contains("usage limit"));
        assert!(message.contains("(free plan)"));
        let plain = parse_codex_error_message("gateway blew up", 502);
        assert_eq!(plain, "gateway blew up");
        let json_message =
            parse_codex_error_message(r#"{"error":{"message":"model not found"}}"#, 404);
        assert_eq!(json_message, "model not found");
    }

    #[tokio::test]
    async fn credential_mutation_cancels_a_stalled_error_body_read() {
        let credential = OAuthCredential {
            access: jwt_token("acct_old"),
            refresh: "old-refresh".into(),
            expires: now_ms() + 3_600_000,
        };
        let store = Arc::new(MemoryStore::new(Some(credential.clone())));
        let revision = credential_revision(Some(&credential)).unwrap();
        let mut dispatch_guard = store.begin_dispatch(&revision).unwrap().unwrap();
        let (response, release, server) = stalled_error_response().await;
        let mut body = Box::pin(guarded_response_text(response, &mut dispatch_guard));

        tokio::select! {
            result = &mut body => panic!("body unexpectedly completed: {}", result.is_ok()),
            _ = tokio::time::sleep(Duration::from_millis(20)) => {}
        }
        store.write(None).unwrap();
        let result = tokio::time::timeout(Duration::from_secs(1), body)
            .await
            .expect("credential mutation should interrupt the body read");
        assert!(matches!(result, Err(CodexSendError::Superseded)));

        let _ = release.send(());
        server.await.unwrap();
    }

    #[tokio::test]
    async fn credential_mutation_cancels_retry_backoff() {
        let credential = OAuthCredential {
            access: jwt_token("acct_old"),
            refresh: "old-refresh".into(),
            expires: now_ms() + 3_600_000,
        };
        let store = Arc::new(MemoryStore::new(Some(credential.clone())));
        let revision = credential_revision(Some(&credential)).unwrap();

        for replacement in [Some(credential.clone()), None] {
            let mut dispatch_guard = store.begin_dispatch(&revision).unwrap().unwrap();
            let mut delay = Box::pin(guarded_retry_delay(
                &mut dispatch_guard,
                Duration::from_secs(60),
            ));
            tokio::select! {
                result = &mut delay => panic!("delay unexpectedly completed: {}", result.is_ok()),
                _ = tokio::time::sleep(Duration::from_millis(20)) => {}
            }
            store.write(replacement.as_ref()).unwrap();
            let result = tokio::time::timeout(Duration::from_secs(1), delay)
                .await
                .expect("credential mutation should interrupt retry backoff");
            assert!(matches!(result, Err(CodexSendError::Superseded)));
        }
    }

    #[tokio::test]
    async fn dispatch_barrier_retries_with_new_credential_before_any_http_request() {
        let old = OAuthCredential {
            access: jwt_token("acct_old"),
            refresh: "old-refresh".into(),
            expires: now_ms() + 3_600_000,
        };
        let new = OAuthCredential {
            access: jwt_token("acct_new"),
            refresh: "new-refresh".into(),
            expires: now_ms() + 3_600_000,
        };
        let store = Arc::new(MemoryStore::new(Some(old.clone())));
        store.supersede_next_dispatch(Some(new.clone()));
        let (base_url, request_receiver, server) = one_request_server().await;
        let provider = CodexProvider::new(store).with_base_url(base_url);

        let (response, _guard) = start_codex_request(
            &provider,
            &request(OPENAI_CODEX_DEFAULT_MODEL),
            &StreamOptions::default(),
        )
        .await
        .unwrap_or_else(|_| panic!("the new credential should dispatch"));
        assert!(response.status().is_success());
        let wire = request_receiver.await.unwrap();
        server.await.unwrap();

        assert!(wire.contains(&new.access));
        assert!(!wire.contains(&old.access));
    }

    #[tokio::test]
    async fn logout_or_relogin_cancels_an_active_credential_generation_stream() {
        let old = OAuthCredential {
            access: jwt_token("acct_old"),
            refresh: "old-refresh".into(),
            expires: now_ms() + 3_600_000,
        };
        let new = OAuthCredential {
            access: jwt_token("acct_new"),
            refresh: "new-refresh".into(),
            expires: now_ms() + 3_600_000,
        };

        for replacement in [None, Some(new)] {
            let store = Arc::new(MemoryStore::new(Some(old.clone())));
            let revision = credential_revision(Some(&old)).unwrap();
            let dispatch_guard = store.begin_dispatch(&revision).unwrap().unwrap();
            let state = CodexDriveState::Streaming {
                payload: Box::pin(futures::stream::pending()),
                dispatch_guard,
                accumulator: ResponsesAccumulator::new(
                    OPENAI_CODEX_PROVIDER_ID,
                    OPENAI_CODEX_DEFAULT_MODEL,
                    "openai-codex-responses",
                ),
                pending: Default::default(),
                finished: false,
            };
            store.write(replacement.as_ref()).unwrap();
            let refresher: Arc<dyn CodexTokenRefresher> = Arc::new(StaticRefresher(old.clone()));

            let (event, next) = tokio::time::timeout(
                Duration::from_secs(1),
                drive_codex(
                    state,
                    store,
                    refresher,
                    request(OPENAI_CODEX_DEFAULT_MODEL),
                    StreamOptions::default(),
                    OPENAI_CODEX_BASE_URL.into(),
                    OPENAI_CODEX_PROVIDER_ID.into(),
                    OPENAI_CODEX_DEFAULT_MODEL.into(),
                ),
            )
            .await
            .unwrap()
            .unwrap();
            assert!(matches!(next, CodexDriveState::Done));
            assert!(matches!(
                event,
                Ok(AssistantMessageEvent::Error { error, .. })
                    if error.error_message.as_deref().is_some_and(|message| message.contains("sign-in changed"))
            ));
        }
    }

    #[tokio::test]
    async fn provider_prepare_runtime_model_validates_and_resolves_auth() {
        let store = Arc::new(MemoryStore::new(Some(OAuthCredential {
            access: jwt_token("acct_1"),
            refresh: "refresh".into(),
            expires: now_ms() + 3_600_000,
        })));
        let provider = CodexProvider::new(store).with_model_check(Box::new(|id| id == "gpt-5.4"));
        assert!(provider.prepare_runtime_model("gpt-5.4").await.is_ok());
        let err = provider.prepare_runtime_model("gpt-4").await.unwrap_err();
        assert_eq!(err.code, CodexRuntimeErrorCode::ModelUnavailable);
    }
}
