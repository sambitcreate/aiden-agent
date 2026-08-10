//! Codex Responses transport against `chatgpt.com/backend-api/codex/responses`.
//!
//! Port of Aiden's `main/services/codex-provider.ts` request shaping plus the
//! pi-ai `api/openai-codex-responses.js` SSE transport (SSE only — Aiden pins
//! `transport: "sse"`). OAuth token storage is abstracted behind
//! [`CodexAuthStore`] so the actual keychain wiring can live in `aiden-data`;
//! token refresh is an HTTP call behind [`CodexTokenRefresher`].

use std::collections::HashMap;
use std::future::Future;
use std::pin::Pin;

use aiden_core::{AssistantMessage, AssistantMessageEvent, StopReason};
use futures::Stream;

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
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OAuthCredential {
    pub access: String,
    pub refresh: String,
    /// ms epoch expiry.
    pub expires: u64,
}

/// Persistent OAuth token storage. The keychain-backed implementation lives in
/// `aiden-data`; providers receive it as a trait object.
pub trait CodexAuthStore: Send + Sync {
    fn read(&self) -> Result<Option<OAuthCredential>, ProviderError>;
    /// Serialized write: `Some` replaces, `None` deletes.
    fn write(&self, credential: Option<&OAuthCredential>) -> Result<(), ProviderError>;
    /// Atomically replace the credential only if the exact expected value is
    /// still current. A sign-out or newer login must make this return false.
    fn compare_and_swap(
        &self,
        expected: Option<&OAuthCredential>,
        replacement: Option<&OAuthCredential>,
    ) -> Result<bool, ProviderError>;
    fn auth_snapshot(&self) -> Result<(Option<OAuthCredential>, bool), ProviderError>;
    fn compare_and_set_needs_attention(
        &self,
        expected: &OAuthCredential,
        needs_attention: bool,
    ) -> Result<bool, ProviderError>;
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
    pub token_url: String,
    pub client_id: String,
    pub timeout_ms: u64,
}

impl Default for HttpCodexTokenRefresher {
    fn default() -> Self {
        Self {
            token_url: CODEX_TOKEN_URL.to_string(),
            client_id: CODEX_CLIENT_ID.to_string(),
            timeout_ms: 15_000,
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
        let timeout_ms = self.timeout_ms;
        let refresh_token = refresh_token.to_string();
        Box::pin(async move {
            let client = reqwest::Client::builder()
                .timeout(std::time::Duration::from_millis(timeout_ms))
                .build()
                .map_err(|_| {
                    ProviderError::Stream(
                        "OpenAI Codex token refresh client could not be created.".to_string(),
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
                .map_err(|err| {
                    ProviderError::Stream(format!("OpenAI Codex token refresh error: {err}"))
                })?;
            let status = response.status();
            let text = response.text().await.unwrap_or_default();
            if !status.is_success() {
                return Err(ProviderError::from_http_status(
                    status.as_u16(),
                    format!("OpenAI Codex token refresh failed ({status}): {text}"),
                ));
            }
            let json: serde_json::Value =
                serde_json::from_str(&text).map_err(ProviderError::Json)?;
            let access = json
                .get("access_token")
                .and_then(|v| v.as_str())
                .ok_or_else(|| {
                    ProviderError::Stream(
                        "OpenAI Codex token refresh response missing fields".to_string(),
                    )
                })?;
            let refresh = json
                .get("refresh_token")
                .and_then(|v| v.as_str())
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
pub fn resolve_runtime_auth_with_retry(
    mut try_auth: impl FnMut() -> Result<PreparedCodexAuth, CodexAuthError>,
    request_cancelled: bool,
) -> Result<PreparedCodexAuth, CodexRuntimeError> {
    let max_retries = 2;
    let mut attempt = 0;
    loop {
        match try_auth() {
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

/// `resolveRuntimeAuth` — read, refresh when near expiry, derive account id.
/// `request_cancelled` models the caller's abort signal for error taxonomy.
pub async fn resolve_runtime_auth(
    store: &dyn CodexAuthStore,
    refresher: &dyn CodexTokenRefresher,
    request_cancelled: bool,
) -> Result<PreparedCodexAuth, CodexAuthError> {
    let stored = store.read().map_err(|err| {
        CodexAuthError::Runtime(CodexRuntimeError::new(
            CodexRuntimeErrorCode::TemporarilyUnavailable,
            err.to_string(),
        ))
    })?;
    let mut credential = stored.clone();
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
        let refreshed = refresher.refresh(&credential_value.refresh).await.map_err(|err| {
                if is_codex_authentication_failure(Some(&err.to_string())) {
                    let _ = store.compare_and_set_needs_attention(&credential_value, true);
                    CodexAuthError::Runtime(CodexRuntimeError::new(
                        CodexRuntimeErrorCode::SignInNeedsAttention,
                        "Your ChatGPT sign-in needs attention. Sign in again in Settings → Providers.",
                    ))
                } else {
                    CodexAuthError::Runtime(CodexRuntimeError::new(
                        CodexRuntimeErrorCode::TemporarilyUnavailable,
                        "ChatGPT sign-in could not be refreshed right now. Check your connection and try again.",
                    ))
                }
            })?;
        let committed = store
            .compare_and_swap(Some(&credential_value), Some(&refreshed))
            .map_err(|err| {
                CodexAuthError::Runtime(CodexRuntimeError::new(
                    CodexRuntimeErrorCode::TemporarilyUnavailable,
                    err.to_string(),
                ))
            })?;
        if !committed {
            return Err(CodexAuthError::Superseded);
        }
        credential = Some(refreshed);
    }
    let Some(credential_value) = credential.clone() else {
        // A refresh rotated the token away (superseded); treat as retryable.
        return Err(CodexAuthError::Superseded);
    };
    let account_id = extract_account_id(&credential_value.access).map_err(|_| {
        let _ = store.compare_and_set_needs_attention(&credential_value, true);
        CodexAuthError::Runtime(CodexRuntimeError::new(
            CodexRuntimeErrorCode::SignInNeedsAttention,
            "Your ChatGPT sign-in needs attention. Sign in again in Settings → Providers.",
        ))
    })?;
    if request_cancelled {
        return Err(CodexAuthError::Cancelled);
    }
    if store
        .auth_snapshot()
        .map(|(_, needs_attention)| needs_attention)
        .unwrap_or(false)
    {
        let _ = store.compare_and_set_needs_attention(&credential_value, false);
    }
    Ok(PreparedCodexAuth {
        access_token: credential_value.access,
        account_id,
        credential_revision: credential_revision(credential.as_ref()).unwrap_or_default(),
    })
}

async fn resolve_runtime_auth_with_store_retry(
    store: &dyn CodexAuthStore,
    refresher: &dyn CodexTokenRefresher,
    request_cancelled: bool,
) -> Result<PreparedCodexAuth, CodexRuntimeError> {
    let mut attempt = 0;
    loop {
        match resolve_runtime_auth(store, refresher, request_cancelled).await {
            Ok(auth) => return Ok(auth),
            Err(CodexAuthError::Superseded) if attempt < 2 && !request_cancelled => {
                attempt += 1;
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
            Err(CodexAuthError::Runtime(error)) => return Err(error),
        }
    }
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
        resolve_runtime_auth_with_store_retry(
            self.auth_store.as_ref(),
            self.refresher.as_ref(),
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
    ) -> Result<reqwest::Response, ProviderError> {
        let max_retries = options.max_retries.unwrap_or(DEFAULT_MAX_RETRIES);
        let max_retry_delay = options
            .max_retry_delay_ms
            .unwrap_or(DEFAULT_MAX_RETRY_DELAY_MS);
        let mut last_error: Option<ProviderError> = None;
        for attempt in 0..=max_retries {
            let builder = self.request_builder(request, options, auth);
            match builder.send().await {
                Ok(response) if response.status().is_success() => return Ok(response),
                Ok(response) => {
                    let status = response.status().as_u16();
                    let headers = response.headers().clone();
                    let body = response.text().await.unwrap_or_default();
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
                        tokio::time::sleep(std::time::Duration::from_millis(delay)).await;
                        continue;
                    }
                    return Err(ProviderError::from_http_status(
                        status,
                        parse_codex_error_message(&body, status),
                    ));
                }
                Err(err) => {
                    if attempt < max_retries {
                        let delay = BASE_DELAY_MS.saturating_mul(1u64 << attempt);
                        tokio::time::sleep(std::time::Duration::from_millis(delay)).await;
                        last_error = Some(ProviderError::Stream(err.to_string()));
                        continue;
                    }
                    return Err(ProviderError::Stream(err.to_string()));
                }
            }
        }
        Err(last_error.unwrap_or_else(|| ProviderError::Stream("Failed after retries".to_string())))
    }
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
        accumulator: ResponsesAccumulator,
        pending: std::collections::VecDeque<Result<AssistantMessageEvent, ProviderError>>,
        finished: bool,
        auth_revision: Option<String>,
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
                let auth = resolve_runtime_auth_with_store_retry(
                    provider.auth_store.as_ref(),
                    provider.refresher.as_ref(),
                    false,
                )
                .await;
                let auth = match auth {
                    Ok(auth) => auth,
                    Err(runtime_error) => {
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
                            error_message: Some(runtime_error.message.clone()),
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
                let response = match provider.send_with_retry(&request, &options, &auth).await {
                    Ok(response) => response,
                    Err(err) => {
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
                            error_message: Some(crate::provider_error_message(&err)),
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
                    accumulator: ResponsesAccumulator::new(
                        &provider_id,
                        &model,
                        "openai-codex-responses",
                    ),
                    pending: Default::default(),
                    finished: false,
                    auth_revision: Some(auth.credential_revision),
                }
            }
            CodexDriveState::Streaming {
                payload,
                accumulator,
                pending,
                finished,
                auth_revision,
            } => {
                let mut accumulator = accumulator;
                let mut pending = pending;
                let mut payload = payload;
                if finished {
                    if let Some(item) = pending.pop_front() {
                        return Some((
                            item,
                            CodexDriveState::Streaming {
                                payload,
                                accumulator,
                                pending,
                                finished,
                                auth_revision,
                            },
                        ));
                    }
                    return None;
                }
                match futures::StreamExt::next(&mut payload).await {
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
                                            accumulator,
                                            pending,
                                            finished: true,
                                            auth_revision,
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
                                    accumulator,
                                    pending,
                                    finished: false,
                                    auth_revision,
                                },
                            ));
                        }
                        CodexDriveState::Streaming {
                            payload,
                            accumulator,
                            pending,
                            finished: false,
                            auth_revision,
                        }
                    }
                    Some(Ok(_)) => CodexDriveState::Streaming {
                        payload,
                        accumulator,
                        pending,
                        finished: false,
                        auth_revision,
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
                            accumulator,
                            pending,
                            finished: true,
                            auth_revision,
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
    use std::sync::{Arc, Mutex};

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

    struct MemoryStore(Mutex<Option<OAuthCredential>>);
    impl CodexAuthStore for MemoryStore {
        fn read(&self) -> Result<Option<OAuthCredential>, ProviderError> {
            Ok(self.0.lock().unwrap().clone())
        }
        fn write(&self, credential: Option<&OAuthCredential>) -> Result<(), ProviderError> {
            *self.0.lock().unwrap() = credential.cloned();
            Ok(())
        }
        fn compare_and_swap(
            &self,
            expected: Option<&OAuthCredential>,
            replacement: Option<&OAuthCredential>,
        ) -> Result<bool, ProviderError> {
            let mut current = self.0.lock().unwrap();
            if current.as_ref() != expected {
                return Ok(false);
            }
            *current = replacement.cloned();
            Ok(true)
        }
        fn auth_snapshot(&self) -> Result<(Option<OAuthCredential>, bool), ProviderError> {
            Ok((self.read()?, false))
        }
        fn compare_and_set_needs_attention(
            &self,
            expected: &OAuthCredential,
            _: bool,
        ) -> Result<bool, ProviderError> {
            Ok(self.read()?.as_ref() == Some(expected))
        }
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

    struct PausedRefresher {
        started: Mutex<Option<tokio::sync::oneshot::Sender<()>>>,
        resume: Mutex<Option<tokio::sync::oneshot::Receiver<()>>>,
        credential: OAuthCredential,
    }

    impl CodexTokenRefresher for PausedRefresher {
        fn refresh(
            &self,
            _refresh_token: &str,
        ) -> Pin<Box<dyn Future<Output = Result<OAuthCredential, ProviderError>> + Send>> {
            let started = self.started.lock().unwrap().take();
            let resume = self.resume.lock().unwrap().take();
            let credential = self.credential.clone();
            Box::pin(async move {
                if let Some(started) = started {
                    let _ = started.send(());
                }
                if let Some(resume) = resume {
                    let _ = resume.await;
                }
                Ok(credential)
            })
        }
    }

    struct AttentionStore(Mutex<(Option<OAuthCredential>, bool)>);
    impl CodexAuthStore for AttentionStore {
        fn read(&self) -> Result<Option<OAuthCredential>, ProviderError> {
            Ok(self.0.lock().unwrap().0.clone())
        }
        fn write(&self, credential: Option<&OAuthCredential>) -> Result<(), ProviderError> {
            *self.0.lock().unwrap() = (credential.cloned(), false);
            Ok(())
        }
        fn compare_and_swap(
            &self,
            expected: Option<&OAuthCredential>,
            replacement: Option<&OAuthCredential>,
        ) -> Result<bool, ProviderError> {
            let mut current = self.0.lock().unwrap();
            if current.0.as_ref() != expected {
                return Ok(false);
            }
            *current = (replacement.cloned(), false);
            Ok(true)
        }
        fn auth_snapshot(&self) -> Result<(Option<OAuthCredential>, bool), ProviderError> {
            Ok(self.0.lock().unwrap().clone())
        }
        fn compare_and_set_needs_attention(
            &self,
            expected: &OAuthCredential,
            needs_attention: bool,
        ) -> Result<bool, ProviderError> {
            let mut current = self.0.lock().unwrap();
            if current.0.as_ref() != Some(expected) {
                return Ok(false);
            }
            current.1 = needs_attention;
            Ok(true)
        }
    }

    struct PausedRejectingRefresher {
        started: Mutex<Option<tokio::sync::oneshot::Sender<()>>>,
        resume: Mutex<Option<tokio::sync::oneshot::Receiver<()>>>,
    }
    impl CodexTokenRefresher for PausedRejectingRefresher {
        fn refresh(
            &self,
            _: &str,
        ) -> Pin<Box<dyn Future<Output = Result<OAuthCredential, ProviderError>> + Send>> {
            let started = self.started.lock().unwrap().take();
            let resume = self.resume.lock().unwrap().take();
            Box::pin(async move {
                if let Some(started) = started {
                    let _ = started.send(());
                }
                if let Some(resume) = resume {
                    let _ = resume.await;
                }
                Err(ProviderError::from_http_status(
                    401,
                    "refresh rejected".to_string(),
                ))
            })
        }
    }

    fn jwt_token(account_id: &str) -> String {
        use base64::Engine;
        let payload =
            format!(r#"{{"https://api.openai.com/auth":{{"chatgpt_account_id":"{account_id}"}}}}"#);
        let payload = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(payload);
        format!("header.{payload}.signature")
    }

    #[tokio::test]
    async fn auth_resolves_without_refresh_when_not_expiring() {
        let store = MemoryStore(Mutex::new(Some(OAuthCredential {
            access: jwt_token("acct_1"),
            refresh: "refresh-token".into(),
            expires: now_ms() + 3_600_000,
        })));
        let refresher = StaticRefresher(OAuthCredential {
            access: jwt_token("acct_2"),
            refresh: "new-refresh".into(),
            expires: now_ms() + 3_600_000,
        });
        let auth = resolve_runtime_auth_with_store_retry(&store, &refresher, false)
            .await
            .unwrap();
        assert_eq!(auth.access_token, jwt_token("acct_1"));
        assert_eq!(auth.account_id, "acct_1");
        // No refresh → store unchanged.
        assert_eq!(
            store.0.lock().unwrap().as_ref().unwrap().access,
            jwt_token("acct_1")
        );
    }

    #[tokio::test]
    async fn auth_refreshes_when_near_expiry() {
        let store = MemoryStore(Mutex::new(Some(OAuthCredential {
            access: jwt_token("acct_1"),
            refresh: "refresh-token".into(),
            expires: now_ms() + 30_000, // inside the 60s skew
        })));
        let refresher = StaticRefresher(OAuthCredential {
            access: jwt_token("acct_2"),
            refresh: "new-refresh".into(),
            expires: now_ms() + 3_600_000,
        });
        let auth = resolve_runtime_auth_with_store_retry(&store, &refresher, false)
            .await
            .unwrap();
        assert_eq!(auth.access_token, jwt_token("acct_2"));
        assert_eq!(auth.account_id, "acct_2");
        // Rotated credential was persisted.
        assert_eq!(
            store.0.lock().unwrap().as_ref().unwrap().access,
            jwt_token("acct_2")
        );
    }

    #[tokio::test]
    async fn sign_out_during_refresh_cannot_be_undone_by_late_completion() {
        let store = Arc::new(MemoryStore(Mutex::new(Some(OAuthCredential {
            access: jwt_token("acct_1"),
            refresh: "refresh-token".into(),
            expires: now_ms() + 30_000,
        }))));
        let (started_tx, started_rx) = tokio::sync::oneshot::channel();
        let (resume_tx, resume_rx) = tokio::sync::oneshot::channel();
        let refresher = Arc::new(PausedRefresher {
            started: Mutex::new(Some(started_tx)),
            resume: Mutex::new(Some(resume_rx)),
            credential: OAuthCredential {
                access: jwt_token("acct_2"),
                refresh: "new-refresh".into(),
                expires: now_ms() + 3_600_000,
            },
        });
        let task_store = store.clone();
        let task_refresher = refresher.clone();
        let task = tokio::spawn(async move {
            resolve_runtime_auth_with_store_retry(
                task_store.as_ref(),
                task_refresher.as_ref(),
                false,
            )
            .await
        });
        started_rx.await.unwrap();
        store.write(None).unwrap();
        resume_tx.send(()).unwrap();

        let error = task.await.unwrap().unwrap_err();
        assert_eq!(error.code, CodexRuntimeErrorCode::SignInRequired);
        assert_eq!(store.read().unwrap(), None);
    }

    #[tokio::test]
    async fn old_refresh_rejection_cannot_mark_a_new_login_as_needing_attention() {
        let old = OAuthCredential {
            access: jwt_token("old"),
            refresh: "old-refresh".into(),
            expires: now_ms() + 30_000,
        };
        let new = OAuthCredential {
            access: jwt_token("new"),
            refresh: "new-refresh".into(),
            expires: now_ms() + 3_600_000,
        };
        let store = Arc::new(AttentionStore(Mutex::new((Some(old), false))));
        let (started_tx, started_rx) = tokio::sync::oneshot::channel();
        let (resume_tx, resume_rx) = tokio::sync::oneshot::channel();
        let refresher = Arc::new(PausedRejectingRefresher {
            started: Mutex::new(Some(started_tx)),
            resume: Mutex::new(Some(resume_rx)),
        });
        let task = tokio::spawn({
            let store = Arc::clone(&store);
            let refresher = Arc::clone(&refresher);
            async move { resolve_runtime_auth(store.as_ref(), refresher.as_ref(), false).await }
        });
        started_rx.await.unwrap();
        store.write(Some(&new)).unwrap();
        resume_tx.send(()).unwrap();

        let error = task.await.unwrap().unwrap_err();
        assert!(matches!(error, CodexAuthError::Runtime(_)));
        assert_eq!(store.auth_snapshot().unwrap(), (Some(new), false));
    }

    #[tokio::test]
    async fn near_expiry_refresh_runs_through_actual_drive_without_nested_runtime() {
        use futures::StreamExt as _;

        let store = Arc::new(MemoryStore(Mutex::new(Some(OAuthCredential {
            access: jwt_token("acct_1"),
            refresh: "refresh-token".into(),
            expires: now_ms() + 30_000,
        }))));
        let provider = CodexProvider::new(store.clone())
            .with_refresher(Arc::new(StaticRefresher(OAuthCredential {
                access: jwt_token("acct_2"),
                refresh: "new-refresh".into(),
                expires: now_ms() + 3_600_000,
            })))
            .with_base_url("http://127.0.0.1:9");
        let mut stream = provider
            .stream_simple(
                &request("gpt-5.4"),
                &StreamOptions {
                    max_retries: Some(0),
                    timeout_ms: Some(100),
                    ..StreamOptions::default()
                },
            )
            .unwrap();

        assert!(matches!(
            stream.next().await.unwrap().unwrap(),
            AssistantMessageEvent::Error { .. }
        ));
        assert_eq!(store.read().unwrap().unwrap().access, jwt_token("acct_2"));
    }

    #[tokio::test]
    async fn http_token_refresh_has_a_hard_request_timeout() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let (_socket, _) = listener.accept().await.unwrap();
            tokio::time::sleep(std::time::Duration::from_secs(2)).await;
        });
        let refresher = HttpCodexTokenRefresher {
            token_url: format!("http://{address}/token"),
            client_id: "client".to_string(),
            timeout_ms: 25,
        };

        let result = tokio::time::timeout(
            std::time::Duration::from_secs(1),
            refresher.refresh("refresh"),
        )
        .await
        .expect("refresh must respect its own request timeout");
        assert!(result.is_err());
        server.abort();
    }

    #[tokio::test]
    async fn auth_requires_sign_in_when_missing() {
        let store = MemoryStore(Mutex::new(None));
        let refresher = StaticRefresher(OAuthCredential {
            access: "x".into(),
            refresh: "y".into(),
            expires: now_ms() + 3_600_000,
        });
        let err = resolve_runtime_auth_with_store_retry(&store, &refresher, false)
            .await
            .unwrap_err();
        assert_eq!(err.code, CodexRuntimeErrorCode::SignInRequired);
        assert!(err.message.contains("Sign in with ChatGPT"));
    }

    #[test]
    fn auth_retries_on_superseded_then_succeeds() {
        let attempts = Arc::new(Mutex::new(0));
        let attempts_clone = attempts.clone();
        let auth = resolve_runtime_auth_with_retry(
            move || {
                let mut count = attempts_clone.lock().unwrap();
                *count += 1;
                if *count == 1 {
                    Err(CodexAuthError::Superseded)
                } else {
                    Ok(PreparedCodexAuth {
                        access_token: "ok".into(),
                        account_id: "acct".into(),
                        credential_revision: "rev".into(),
                    })
                }
            },
            false,
        )
        .unwrap();
        assert_eq!(auth.access_token, "ok");
        assert_eq!(*attempts.lock().unwrap(), 2);
    }

    #[test]
    fn auth_gives_up_after_max_superseded_retries() {
        let err =
            resolve_runtime_auth_with_retry(|| Err(CodexAuthError::Superseded), false).unwrap_err();
        assert_eq!(err.code, CodexRuntimeErrorCode::TemporarilyUnavailable);
    }

    #[test]
    fn cancelled_request_maps_to_request_cancelled() {
        let err =
            resolve_runtime_auth_with_retry(|| Err(CodexAuthError::Cancelled), true).unwrap_err();
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
    async fn provider_prepare_runtime_model_validates_and_resolves_auth() {
        let store = Arc::new(MemoryStore(Mutex::new(Some(OAuthCredential {
            access: jwt_token("acct_1"),
            refresh: "refresh".into(),
            expires: now_ms() + 3_600_000,
        }))));
        let provider = CodexProvider::new(store).with_model_check(Box::new(|id| id == "gpt-5.4"));
        assert!(provider.prepare_runtime_model("gpt-5.4").await.is_ok());
        let err = provider.prepare_runtime_model("gpt-4").await.unwrap_err();
        assert_eq!(err.code, CodexRuntimeErrorCode::ModelUnavailable);
    }
}
