//! Interactive provider auth coordinator — port of
//! `main/services/provider-auth-flow-core.ts`.
//!
//! Owns the single global provider-auth session (API-key prompts and OAuth
//! handshakes) bound to exactly one renderer document. Security properties
//! preserved from the TS:
//!
//! - The active flow is owned by one `(owner id, document id)` pair; another
//!   renderer (or a replacement document in the same WebContents) cannot
//!   answer or cancel it.
//! - Provider display text, option ids, URLs and raw errors are replaced with
//!   structured, app-owned copy; token-like text never crosses IPC or
//!   diagnostics. Only https external URLs are opened.
//! - The flow has a bounded lifetime (`flowTimeoutMs`), credential commit is
//!   the point of no return, and provider-owned cleanup gets a bounded chance
//!   before the global slot is released.
//!
//! This module is async (`tokio`) and dependency-injected (backend factory,
//! external-open, diagnostics, id generator), so tests never touch a network
//! or a browser.

use std::collections::BTreeMap;
use std::future::Future;
use std::panic::AssertUnwindSafe;
use std::pin::Pin;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use futures::{future::BoxFuture, FutureExt};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use tokio::sync::{oneshot, watch, Notify};
use url::Url;

use crate::codex::OPENAI_CODEX_PROVIDER_ID;

/// `FLOW_ID_PATTERN` — the uuid v4 shape every flow/prompt id must match.
fn is_uuid_v4(value: &str) -> bool {
    let bytes = value.as_bytes();
    if bytes.len() != 36 {
        return false;
    }
    for index in [8usize, 13, 18, 23] {
        if bytes[index] != b'-' {
            return false;
        }
    }
    for (index, byte) in bytes.iter().enumerate() {
        if matches!(index, 8 | 13 | 18 | 23) {
            continue;
        }
        if !byte.is_ascii_hexdigit() {
            return false;
        }
    }
    // Version nibble (4) and variant nibble (8/9/a/b).
    if bytes[14] != b'4' || !matches!(bytes[19], b'8' | b'9' | b'a' | b'b') {
        return false;
    }
    true
}

const MAX_RESPONSE_LENGTH: usize = 8_192;
const MAX_EXTERNAL_URL_LENGTH: usize = 8_192;
const DEFAULT_FLOW_TIMEOUT_MS: u64 = 16 * 60 * 1_000;
const DEFAULT_AUTH_CLEANUP_TIMEOUT_MS: u64 = 5_000;

const SAFE_DIAGNOSTIC_CODES: &[&str] = &[
    "ABORT_ERR",
    "EADDRINUSE",
    "ECONNREFUSED",
    "ECONNRESET",
    "ENETUNREACH",
    "ETIMEDOUT",
];
const SAFE_ERROR_NAMES: &[&str] = &[
    "AbortError",
    "Error",
    "ModelsError",
    "ProviderAuthCancellationError",
    "TypeError",
];

// ===========================================================================
// A tiny AbortSignal (the TS `AbortSignal`): one-shot, shared, settable.
// ===========================================================================

#[derive(Debug, Clone, Default)]
pub struct AbortSignal {
    aborted: Arc<AtomicBool>,
    notify: Arc<Notify>,
}

impl AbortSignal {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn abort(&self) {
        self.aborted.store(true, Ordering::SeqCst);
        self.notify.notify_waiters();
    }

    pub fn is_aborted(&self) -> bool {
        self.aborted.load(Ordering::SeqCst)
    }

    pub(crate) async fn notified(&self) {
        if self.is_aborted() {
            return;
        }
        let notified = self.notify.notified();
        tokio::pin!(notified);
        notified.as_mut().enable();
        if self.is_aborted() {
            return;
        }
        notified.as_mut().await;
    }
}

// ===========================================================================
// Backend-owned error model (the TS `Error` surfaces the coordinator reads).
// ===========================================================================

/// A provider error the classifier can read safely: only the name, message,
/// and an allow-listed code ever reach diagnostics.
#[derive(Debug, Clone, thiserror::Error)]
#[error("{name}: {message}")]
pub struct AuthError {
    pub name: String,
    pub message: String,
    pub code: Option<String>,
}

impl AuthError {
    pub fn new(name: impl Into<String>, message: impl Into<String>) -> Self {
        Self {
            name: name.into(),
            message: message.into(),
            code: None,
        }
    }

    pub fn with_code(
        name: impl Into<String>,
        message: impl Into<String>,
        code: impl Into<String>,
    ) -> Self {
        Self {
            name: name.into(),
            message: message.into(),
            code: Some(code.into()),
        }
    }

    pub fn cancelled() -> Self {
        Self::new(
            "ProviderAuthCancellationError",
            "Provider authentication was cancelled.",
        )
    }
}

/// The interactive prompt/event surface handed to a backend (`AuthInteraction`).
#[derive(Debug, Clone)]
pub enum AuthPrompt {
    Select {
        message: String,
        options: Vec<AuthSelectOption>,
    },
    ManualCode {
        message: String,
        placeholder: Option<String>,
    },
    Secret {
        message: String,
        placeholder: Option<String>,
    },
    Text {
        message: String,
        placeholder: Option<String>,
    },
}

impl AuthPrompt {
    fn kind(&self) -> &'static str {
        match self {
            AuthPrompt::Select { .. } => "select",
            AuthPrompt::ManualCode { .. } => "manual_code",
            AuthPrompt::Secret { .. } => "secret",
            AuthPrompt::Text { .. } => "text",
        }
    }

    fn message(&self) -> &str {
        match self {
            AuthPrompt::Select { message, .. }
            | AuthPrompt::ManualCode { message, .. }
            | AuthPrompt::Secret { message, .. }
            | AuthPrompt::Text { message, .. } => message,
        }
    }

    fn placeholder(&self) -> Option<&str> {
        match self {
            AuthPrompt::ManualCode { placeholder, .. }
            | AuthPrompt::Secret { placeholder, .. }
            | AuthPrompt::Text { placeholder, .. } => placeholder.as_deref(),
            AuthPrompt::Select { .. } => None,
        }
    }
}

#[derive(Debug, Clone)]
pub struct AuthSelectOption {
    pub id: String,
    pub label: String,
    pub description: Option<String>,
}

#[derive(Debug, Clone)]
pub struct AuthLink {
    pub url: String,
    pub label: Option<String>,
}

#[derive(Debug, Clone)]
pub enum AuthEvent {
    AuthUrl {
        url: String,
        instructions: Option<String>,
    },
    DeviceCode {
        user_code: String,
        verification_uri: String,
        interval_seconds: Option<f64>,
        expires_in_seconds: Option<u64>,
    },
    Info {
        message: String,
        links: Option<Vec<AuthLink>>,
    },
    Progress {
        message: String,
    },
}

// ===========================================================================
// Wire DTOs (renderer contract)
// ===========================================================================

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderAuthSelectOptionDto {
    pub id: String,
    pub label: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderAuthPromptDto {
    pub flow_id: String,
    pub provider_id: String,
    pub prompt_id: String,
    #[serde(rename = "type")]
    pub r#type: String,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub placeholder: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub options: Option<Vec<ProviderAuthSelectOptionDto>>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum ProviderAuthEventDto {
    #[serde(rename = "info")]
    Info {
        flow_id: String,
        provider_id: String,
        message: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        links: Option<Vec<ProviderAuthLinkDto>>,
    },
    #[serde(rename = "auth_url")]
    AuthUrl {
        flow_id: String,
        provider_id: String,
        url: String,
        instructions: String,
    },
    #[serde(rename = "device_code")]
    DeviceCode {
        flow_id: String,
        provider_id: String,
        user_code: String,
        verification_uri: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        interval_seconds: Option<f64>,
        #[serde(skip_serializing_if = "Option::is_none")]
        expires_in_seconds: Option<u64>,
    },
    #[serde(rename = "progress")]
    Progress {
        flow_id: String,
        provider_id: String,
        message: String,
    },
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderAuthLinkDto {
    pub url: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderAuthDoneDto {
    pub flow_id: String,
    pub provider_id: String,
    pub cancelled: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProviderAuthErrorCode {
    PortBusy,
    RateLimited,
    TimedOut,
    VerificationFailed,
    SignInFailed,
}

impl ProviderAuthErrorCode {
    fn as_str(self) -> &'static str {
        match self {
            ProviderAuthErrorCode::PortBusy => "port_busy",
            ProviderAuthErrorCode::RateLimited => "rate_limited",
            ProviderAuthErrorCode::TimedOut => "timed_out",
            ProviderAuthErrorCode::VerificationFailed => "verification_failed",
            ProviderAuthErrorCode::SignInFailed => "sign_in_failed",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderAuthErrorDto {
    pub flow_id: String,
    pub provider_id: String,
    pub code: String,
    pub message: String,
}

// ===========================================================================
// Request models + parsing (the IPC parsers)
// ===========================================================================

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProviderAuthStartRequest {
    pub flow_id: String,
    pub provider_id: String,
    pub auth_type: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProviderAuthResponseRequest {
    pub flow_id: String,
    pub provider_id: String,
    pub prompt_id: String,
    pub value: String,
}

/// `ProviderAuthRequestError` — request/state-machine failures. The message
/// carries the TS wording so callers can match on it.
#[derive(Debug, Clone, thiserror::Error)]
#[error("{0}")]
pub struct ProviderAuthRequestError(pub String);

fn parse_provider_id(value: &str) -> Result<String, ProviderAuthRequestError> {
    let valid = !value.is_empty()
        && value.len() <= 128
        && value
            .as_bytes()
            .first()
            .is_some_and(|first| first.is_ascii_alphanumeric())
        && value
            .as_bytes()
            .iter()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(*byte, b'.' | b'_' | b':' | b'-'));
    if valid {
        Ok(value.to_string())
    } else {
        Err(ProviderAuthRequestError(
            "Provider authentication provider ID is invalid.".to_string(),
        ))
    }
}

fn parse_auth_type(value: Option<&str>) -> Result<String, ProviderAuthRequestError> {
    match value {
        None | Some("oauth") => Ok("oauth".to_string()),
        Some("api_key") => Ok("api_key".to_string()),
        _ => Err(ProviderAuthRequestError(
            "Provider authentication method is invalid.".to_string(),
        )),
    }
}

fn parse_flow_id(value: &str) -> Result<String, ProviderAuthRequestError> {
    if is_uuid_v4(value) {
        Ok(value.to_string())
    } else {
        Err(ProviderAuthRequestError(
            "Provider authentication flow ID is invalid.".to_string(),
        ))
    }
}

fn parse_prompt_id(value: &str) -> Result<String, ProviderAuthRequestError> {
    if is_uuid_v4(value) {
        Ok(value.to_string())
    } else {
        Err(ProviderAuthRequestError(
            "Provider authentication prompt ID is invalid.".to_string(),
        ))
    }
}

fn assert_exact_keys(
    record: &Map<String, Value>,
    allowed: &[&str],
) -> Result<(), ProviderAuthRequestError> {
    if record.keys().any(|key| !allowed.contains(&key.as_str())) {
        return Err(ProviderAuthRequestError(
            "Provider authentication request has an invalid shape.".to_string(),
        ));
    }
    Ok(())
}

/// `parseProviderAuthStartRequest`.
pub fn parse_provider_auth_start_request(
    value: &Value,
) -> Result<ProviderAuthStartRequest, ProviderAuthRequestError> {
    let Some(record) = value.as_object() else {
        return Err(ProviderAuthRequestError(
            "Provider authentication request is invalid.".to_string(),
        ));
    };
    assert_exact_keys(record, &["flowId", "providerId", "authType"])?;
    let flow_id = parse_flow_id(record.get("flowId").and_then(Value::as_str).ok_or_else(
        || ProviderAuthRequestError("Provider authentication request is invalid.".into()),
    )?)?;
    let provider_id = parse_provider_id(
        record
            .get("providerId")
            .and_then(Value::as_str)
            .ok_or_else(|| {
                ProviderAuthRequestError("Provider authentication request is invalid.".into())
            })?,
    )?;
    let auth_type = parse_auth_type(record.get("authType").and_then(Value::as_str))?;
    Ok(ProviderAuthStartRequest {
        flow_id,
        provider_id,
        auth_type,
    })
}

/// `parseProviderAuthResponseRequest`.
pub fn parse_provider_auth_response_request(
    value: &Value,
) -> Result<ProviderAuthResponseRequest, ProviderAuthRequestError> {
    let Some(record) = value.as_object() else {
        return Err(ProviderAuthRequestError(
            "Provider authentication response is invalid.".to_string(),
        ));
    };
    assert_exact_keys(record, &["flowId", "providerId", "promptId", "value"])?;
    let invalid =
        || ProviderAuthRequestError("Provider authentication response is invalid.".to_string());
    let flow_id = parse_flow_id(
        record
            .get("flowId")
            .and_then(Value::as_str)
            .ok_or_else(invalid)?,
    )?;
    let provider_id = parse_provider_id(
        record
            .get("providerId")
            .and_then(Value::as_str)
            .ok_or_else(invalid)?,
    )?;
    let prompt_id = parse_prompt_id(
        record
            .get("promptId")
            .and_then(Value::as_str)
            .ok_or_else(invalid)?,
    )?;
    let value = record
        .get("value")
        .and_then(Value::as_str)
        .ok_or_else(invalid)?;
    if value.len() > MAX_RESPONSE_LENGTH {
        return Err(invalid());
    }
    Ok(ProviderAuthResponseRequest {
        flow_id,
        provider_id,
        prompt_id,
        value: value.to_string(),
    })
}

/// `parseProviderAuthProviderId`.
pub fn parse_provider_auth_provider_id(value: &Value) -> Result<String, ProviderAuthRequestError> {
    let Some(value) = value.as_str() else {
        return Err(ProviderAuthRequestError(
            "Provider authentication provider ID is invalid.".to_string(),
        ));
    };
    parse_provider_id(value)
}

// ===========================================================================
// Owner + backend seams
// ===========================================================================

/// `ProviderAuthOwner` — the renderer document that owns the flow.
pub trait ProviderAuthOwner: Send + Sync {
    fn id(&self) -> u64;
    fn document_id(&self) -> &str;
    fn is_destroyed(&self) -> bool;
    /// Send a notification to the owning document. `Err` means the document
    /// is no longer active.
    #[allow(clippy::result_unit_err)]
    fn send(&self, channel: &str, payload: &Value) -> Result<(), ()>;
    /// Register an invalidation listener; returns the removal closure.
    fn on_invalidated(&self, listener: Arc<dyn Fn() + Send + Sync>) -> Box<dyn Fn() + Send + Sync>;
}

/// `ProviderAuthBackend` — provider-owned auth, prompted/notified through the
/// interaction surface.
pub trait ProviderAuthBackend: Send + Sync {
    fn snapshot(&self) -> BoxFuture<'static, Result<Value, AuthError>>;
    fn authenticate(
        &self,
        interaction: Arc<AuthInteraction>,
    ) -> BoxFuture<'static, Result<Value, AuthError>>;
    fn commit_credential(&self, credential: Value) -> BoxFuture<'static, Result<(), AuthError>>;
    fn logout(&self) -> BoxFuture<'static, Result<(), AuthError>>;
}

/// `AuthInteraction` — signal + prompt/notify callbacks handed to a backend.
/// `notify` returns `Err` when the coordinator rejects the event (invalid
/// external URL, malformed device code), which the backend must propagate —
/// mirroring the TS where the notify throw rejects the backend's promise.
pub struct AuthInteraction {
    pub signal: Arc<AbortSignal>,
    prompt: AuthPromptFn,
    notify: AuthNotifyFn,
}

impl AuthInteraction {
    pub fn prompt(
        &self,
        prompt: AuthPrompt,
        signal: Option<Arc<AbortSignal>>,
    ) -> BoxFuture<'static, Result<String, AuthError>> {
        (self.prompt)(prompt, signal)
    }

    pub fn notify(&self, event: AuthEvent) -> Result<(), AuthError> {
        (self.notify)(event)
    }
}

/// `ProviderAuthDiagnostic` — sanitized, allow-listed failure facts.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ProviderAuthDiagnostic {
    pub operation: &'static str,
    pub provider_id: String,
    pub error_name: String,
    pub error_code: Option<String>,
}

/// Provider-auth closure seams (type aliases keep the trait surface readable).
pub type AuthPromptFn = Arc<
    dyn Fn(AuthPrompt, Option<Arc<AbortSignal>>) -> BoxFuture<'static, Result<String, AuthError>>
        + Send
        + Sync,
>;
pub type AuthNotifyFn = Arc<dyn Fn(AuthEvent) -> Result<(), AuthError> + Send + Sync>;
pub type BackendFactory = Arc<dyn Fn(&str, &str) -> Arc<dyn ProviderAuthBackend> + Send + Sync>;
pub type OpenExternalFn = Arc<
    dyn Fn(&str) -> BoxFuture<'static, Result<(), Box<dyn std::error::Error + Send + Sync>>>
        + Send
        + Sync,
>;
pub type DiagnosticFn = Arc<dyn Fn(ProviderAuthDiagnostic) + Send + Sync>;
pub type CreateIdFn = Arc<dyn Fn() -> String + Send + Sync>;

/// `ProviderAuthFlowDependencies` — everything injected by the host.
pub struct ProviderAuthFlowDependencies {
    pub backend_for: BackendFactory,
    pub open_external: OpenExternalFn,
    pub diagnostic: Option<DiagnosticFn>,
    pub flow_timeout_ms: Option<u64>,
    pub auth_cleanup_timeout_ms: Option<u64>,
    pub create_id: Option<CreateIdFn>,
}

impl Default for ProviderAuthFlowDependencies {
    fn default() -> Self {
        Self {
            backend_for: Arc::new(|_, _| panic!("provider auth backend factory required")),
            open_external: Arc::new(|_| async { Ok(()) }.boxed()),
            diagnostic: None,
            flow_timeout_ms: None,
            auth_cleanup_timeout_ms: None,
            create_id: None,
        }
    }
}

// ===========================================================================
// Coordinator
// ===========================================================================

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Phase {
    Authenticating,
    Committing,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProviderAuthCancelOutcome {
    Cancelled,
    Finishing,
}

struct PendingPrompt {
    id: String,
    prompt_type: &'static str,
    /// select option id -> provider option id.
    select_values: Option<BTreeMap<String, String>>,
    tx: oneshot::Sender<Result<String, ()>>,
}

struct AuthSession {
    flow_id: String,
    provider_id: String,
    backend: Arc<dyn ProviderAuthBackend>,
    owner: Arc<dyn ProviderAuthOwner>,
    abort: Arc<AbortSignal>,
    phase: Mutex<Phase>,
    timed_out: AtomicBool,
    suppress_notifications: AtomicBool,
    pending_prompt: Mutex<Option<PendingPrompt>>,
    timeout_task: Mutex<Option<tokio::task::JoinHandle<()>>>,
    owner_invalidation: Mutex<Option<Box<dyn Fn() + Send + Sync>>>,
    finished: Arc<FinishedFlag>,
}

#[derive(Default)]
struct FinishedFlag {
    set: AtomicBool,
    notify: Notify,
}

impl FinishedFlag {
    fn set(&self) {
        self.set.store(true, Ordering::SeqCst);
        self.notify.notify_waiters();
    }

    pub(crate) async fn notified(&self) {
        if self.set.load(Ordering::SeqCst) {
            return;
        }
        let notified = self.notify.notified();
        tokio::pin!(notified);
        notified.as_mut().enable();
        if self.set.load(Ordering::SeqCst) {
            return;
        }
        notified.as_mut().await;
    }
}

struct CoordinatorState {
    active_session: Option<Arc<AuthSession>>,
    logout_operation: Option<Arc<LogoutOperation>>,
    disposed: bool,
}

struct LogoutOperation {
    outcome: watch::Receiver<Option<Result<Value, ProviderAuthRequestError>>>,
    finished: Arc<FinishedFlag>,
}

enum AuthenticationOutcome {
    Credential(Value),
    Error(AuthError),
    Aborted,
}

struct AuthenticationAttempt {
    outcome: BoxFuture<'static, AuthenticationOutcome>,
    settled: BoxFuture<'static, ()>,
}

struct PreparedPrompt {
    dto: ProviderAuthPromptDto,
    select_values: Option<BTreeMap<String, String>>,
}

/// `ProviderAuthFlowCoordinator`.
pub struct ProviderAuthFlowCoordinator {
    shared: Arc<CoordinatorShared>,
}

#[cfg(test)]
type BeforeCommitTransitionFn = Arc<dyn Fn() -> BoxFuture<'static, ()> + Send + Sync>;

struct CoordinatorShared {
    deps: ProviderAuthFlowDependencies,
    flow_timeout_ms: u64,
    auth_cleanup_timeout_ms: u64,
    create_id: CreateIdFn,
    state: Mutex<CoordinatorState>,
    #[cfg(test)]
    before_commit_transition: Mutex<Option<BeforeCommitTransitionFn>>,
}

impl ProviderAuthFlowCoordinator {
    pub fn new(deps: ProviderAuthFlowDependencies) -> Self {
        let flow_timeout_ms = deps.flow_timeout_ms.unwrap_or(DEFAULT_FLOW_TIMEOUT_MS);
        if flow_timeout_ms == 0 {
            panic!("Provider authentication timeout must be positive.");
        }
        let auth_cleanup_timeout_ms = deps
            .auth_cleanup_timeout_ms
            .unwrap_or(DEFAULT_AUTH_CLEANUP_TIMEOUT_MS);
        if auth_cleanup_timeout_ms == 0 {
            panic!("Provider authentication cleanup timeout must be positive.");
        }
        let create_id = deps.create_id.clone().unwrap_or_else(|| {
            Arc::new(|| uuid::Uuid::new_v4().to_string()) as Arc<dyn Fn() -> String + Send + Sync>
        });
        Self {
            shared: Arc::new(CoordinatorShared {
                deps,
                flow_timeout_ms,
                auth_cleanup_timeout_ms,
                create_id,
                state: Mutex::new(CoordinatorState {
                    active_session: None,
                    logout_operation: None,
                    disposed: false,
                }),
                #[cfg(test)]
                before_commit_transition: Mutex::new(None),
            }),
        }
    }

    fn assert_available(shared: &CoordinatorShared) -> Result<(), ProviderAuthRequestError> {
        if shared.state.lock().unwrap().disposed {
            return Err(ProviderAuthRequestError(
                "Provider authentication is shutting down.".to_string(),
            ));
        }
        Ok(())
    }

    fn assert_usable_owner(owner: &dyn ProviderAuthOwner) -> Result<(), ProviderAuthRequestError> {
        if owner.id() == 0 || owner.document_id().is_empty() || owner.is_destroyed() {
            return Err(ProviderAuthRequestError(
                "Provider authentication window is unavailable.".to_string(),
            ));
        }
        Ok(())
    }

    /// `status(providerId)` — the backend snapshot for a provider.
    pub fn status(
        &self,
        provider_id: &str,
    ) -> BoxFuture<'static, Result<Value, ProviderAuthRequestError>> {
        let shared = self.shared.clone();
        let provider_id = provider_id.to_string();
        async move {
            let valid_provider_id = parse_provider_id(&provider_id)?;
            Self::assert_available(&shared)?;
            let backend = (shared.deps.backend_for)(&valid_provider_id, "oauth");
            backend.snapshot().await.map_err(|error| {
                ProviderAuthRequestError(format!("{}: {}", error.name, error.message))
            })
        }
        .boxed()
    }

    /// `start(owner, request)` — begin an interactive flow for one document.
    pub fn start(
        &self,
        owner: Arc<dyn ProviderAuthOwner>,
        request: ProviderAuthStartRequest,
    ) -> Result<(), ProviderAuthRequestError> {
        let shared = self.shared.clone();
        Self::assert_available(&shared)?;
        Self::assert_usable_owner(owner.as_ref())?;
        parse_flow_id(&request.flow_id)?;
        let provider_id = parse_provider_id(&request.provider_id)?;
        let auth_type = parse_auth_type(Some(&request.auth_type))?;
        let backend = (shared.deps.backend_for)(&provider_id, &auth_type);

        let abort = Arc::new(AbortSignal::new());
        let session = Arc::new(AuthSession {
            flow_id: request.flow_id.clone(),
            provider_id: provider_id.clone(),
            backend,
            owner: owner.clone(),
            abort: abort.clone(),
            phase: Mutex::new(Phase::Authenticating),
            timed_out: AtomicBool::new(false),
            suppress_notifications: AtomicBool::new(false),
            pending_prompt: Mutex::new(None),
            timeout_task: Mutex::new(None),
            owner_invalidation: Mutex::new(None),
            finished: Arc::new(FinishedFlag::default()),
        });

        {
            let mut state = shared.state.lock().unwrap();
            if state.disposed {
                return Err(ProviderAuthRequestError(
                    "Provider authentication is shutting down.".to_string(),
                ));
            }
            if state.logout_operation.is_some() {
                return Err(ProviderAuthRequestError(codex_or(
                    &provider_id,
                    "ChatGPT sign-out is still in progress.",
                    "Provider sign-out is still in progress.",
                )));
            }
            if let Some(active) = &state.active_session {
                if active.flow_id == request.flow_id {
                    return Err(ProviderAuthRequestError(
                        "This provider authentication flow is already active.".to_string(),
                    ));
                }
                return Err(ProviderAuthRequestError(codex_or(
                    &provider_id,
                    "Another ChatGPT sign-in is already in progress.",
                    "Another provider sign-in is already in progress.",
                )));
            }
            state.active_session = Some(session.clone());
        }

        let invalidation = {
            let shared = shared.clone();
            let session = session.clone();
            let owner_for_check = owner.clone();
            let flow_id = request.flow_id.clone();
            Arc::new(move || {
                let active = shared.state.lock().unwrap().active_session.clone();
                let Some(active) = active else {
                    return;
                };
                if active.flow_id != flow_id
                    || active.owner.id() != owner_for_check.id()
                    || active.owner.document_id() != owner_for_check.document_id()
                {
                    return;
                }
                session.suppress_notifications.store(true, Ordering::SeqCst);
                Self::abort_session(&shared, &session);
            })
        };
        let registration = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            owner.on_invalidated(invalidation)
        }));
        let remove_invalidation = match registration {
            Ok(remove) => remove,
            Err(_) => {
                let mut state = shared.state.lock().unwrap();
                if state
                    .active_session
                    .as_ref()
                    .is_some_and(|active| Arc::ptr_eq(active, &session))
                {
                    state.active_session = None;
                }
                session.abort.abort();
                session.finished.set();
                return Err(ProviderAuthRequestError(
                    "Provider authentication window is unavailable.".to_string(),
                ));
            }
        };
        *session.owner_invalidation.lock().unwrap() = Some(remove_invalidation);
        if owner.is_destroyed() {
            session.suppress_notifications.store(true, Ordering::SeqCst);
            Self::abort_session(&shared, &session);
        }

        let timeout_task = {
            let session = session.clone();
            let shared = shared.clone();
            tokio::spawn(async move {
                tokio::time::sleep(Duration::from_millis(shared.flow_timeout_ms)).await;
                Self::timeout_session(&shared, &session);
            })
        };
        *session.timeout_task.lock().unwrap() = Some(timeout_task);

        let run_shared = shared.clone();
        tokio::spawn(async move {
            Self::run(run_shared, session).await;
        });
        Ok(())
    }

    /// `respond(owner, request)` — resolve the active prompt with a value.
    pub fn respond(
        &self,
        owner: Arc<dyn ProviderAuthOwner>,
        request: ProviderAuthResponseRequest,
    ) -> Result<(), ProviderAuthRequestError> {
        let shared = self.shared.clone();
        Self::assert_available(&shared)?;
        let session = Self::owned_session(&shared, owner, &request.flow_id, &request.provider_id)?;
        parse_prompt_id(&request.prompt_id)?;
        if request.value.len() > MAX_RESPONSE_LENGTH {
            return Err(ProviderAuthRequestError(
                "Provider authentication response is invalid.".to_string(),
            ));
        }
        let (pending_id, prompt_type, select_values) = {
            let slot = session.pending_prompt.lock().unwrap();
            let Some(pending) = slot.as_ref() else {
                return Err(ProviderAuthRequestError(
                    "This provider authentication prompt is no longer active.".to_string(),
                ));
            };
            (
                pending.id.clone(),
                pending.prompt_type,
                pending.select_values.clone(),
            )
        };
        if pending_id != request.prompt_id {
            return Err(ProviderAuthRequestError(
                "This provider authentication prompt is no longer active.".to_string(),
            ));
        }
        let resolved_value = if prompt_type == "select" {
            match select_values.and_then(|values| values.get(&request.value).cloned()) {
                Some(resolved) => resolved,
                None => {
                    return Err(ProviderAuthRequestError(
                        "Select one of the available sign-in options.".to_string(),
                    ))
                }
            }
        } else {
            request.value.clone()
        };
        let pending = session.pending_prompt.lock().unwrap().take();
        if let Some(pending) = pending {
            if pending.id == request.prompt_id {
                let _ = pending.tx.send(Ok(resolved_value));
            }
        }
        Ok(())
    }

    /// `cancel(owner, request)` — explicit user cancellation.
    pub fn cancel(
        &self,
        owner: Arc<dyn ProviderAuthOwner>,
        request: &ProviderAuthStartRequest,
    ) -> Result<ProviderAuthCancelOutcome, ProviderAuthRequestError> {
        let shared = self.shared.clone();
        Self::assert_available(&shared)?;
        let session = Self::owned_session(&shared, owner, &request.flow_id, &request.provider_id)?;
        if Self::abort_session(&shared, &session) {
            Ok(ProviderAuthCancelOutcome::Cancelled)
        } else {
            Ok(ProviderAuthCancelOutcome::Finishing)
        }
    }

    /// `logout(providerId)` — revoke the provider credential.
    pub fn logout(
        &self,
        provider_id: &str,
    ) -> BoxFuture<'static, Result<Value, ProviderAuthRequestError>> {
        let shared = self.shared.clone();
        let provider_id = provider_id.to_string();
        async move {
            let valid_provider_id = parse_provider_id(&provider_id)?;
            Self::assert_available(&shared)?;
            let backend = (shared.deps.backend_for)(&valid_provider_id, "oauth");
            let (outcome_tx, outcome_rx) = watch::channel(None);
            let operation = Arc::new(LogoutOperation {
                outcome: outcome_rx,
                finished: Arc::new(FinishedFlag::default()),
            });
            {
                let mut state = shared.state.lock().unwrap();
                if state.disposed {
                    return Err(ProviderAuthRequestError(
                        "Provider authentication is shutting down.".to_string(),
                    ));
                }
                if state.active_session.is_some() {
                    return Err(ProviderAuthRequestError(
                        "Finish or cancel the active provider sign-in before signing out."
                            .to_string(),
                    ));
                }
                if state.logout_operation.is_some() {
                    return Err(ProviderAuthRequestError(
                        "Provider sign-out is already in progress.".to_string(),
                    ));
                }
                state.logout_operation = Some(operation.clone());
            }
            let task_shared = shared.clone();
            let task_operation = operation.clone();
            tokio::spawn(async move {
                let task = async {
                    match backend.logout().await {
                        Ok(()) => match backend.snapshot().await {
                            Ok(snapshot) => Ok(snapshot),
                            Err(error) => Err(ProviderAuthRequestError(format!(
                                "{}: {}",
                                error.name, error.message
                            ))),
                        },
                        Err(error) => Err(ProviderAuthRequestError(format!(
                            "{}: {}",
                            error.name, error.message
                        ))),
                    }
                };
                let result = AssertUnwindSafe(task)
                    .catch_unwind()
                    .await
                    .unwrap_or_else(|_| {
                        Err(ProviderAuthRequestError(
                            "Provider sign-out did not complete.".to_string(),
                        ))
                    });
                {
                    let mut state = task_shared.state.lock().unwrap();
                    if state
                        .logout_operation
                        .as_ref()
                        .is_some_and(|current| Arc::ptr_eq(current, &task_operation))
                    {
                        state.logout_operation = None;
                    }
                }
                outcome_tx.send_replace(Some(result));
                task_operation.finished.set();
            });
            Self::wait_for_logout(&operation).await
        }
        .boxed()
    }

    /// `dispose()` — fire-and-forget shutdown.
    pub fn dispose(&self) {
        let shared = self.shared.clone();
        tokio::spawn(Self::shutdown_impl(shared));
    }

    /// `shutdown()` — wait for in-flight auth work before resolving.
    pub fn shutdown(&self) -> BoxFuture<'static, ()> {
        Box::pin(Self::shutdown_impl(self.shared.clone()))
    }

    async fn shutdown_impl(shared: Arc<CoordinatorShared>) {
        let (session, logout_operation) = {
            let mut state = shared.state.lock().unwrap();
            state.disposed = true;
            if let Some(session) = &state.active_session {
                session.suppress_notifications.store(true, Ordering::SeqCst);
                Self::abort_session(&shared, session);
            }
            (state.active_session.clone(), state.logout_operation.clone())
        };
        let mut waits: Vec<Pin<Box<dyn Future<Output = ()> + Send>>> = Vec::new();
        if let Some(session) = session {
            let finished = session.finished.clone();
            waits.push(Box::pin(async move { finished.notified().await }));
        }
        if let Some(operation) = logout_operation {
            waits.push(Box::pin(async move { operation.finished.notified().await }));
        }
        for wait in waits {
            wait.await;
        }
    }

    // -----------------------------------------------------------------------
    // Internals
    // -----------------------------------------------------------------------

    async fn run(shared: Arc<CoordinatorShared>, session: Arc<AuthSession>) {
        let attempt = Self::authenticate(&shared, &session);
        let outcome = attempt.outcome.await;
        match outcome {
            AuthenticationOutcome::Aborted => {
                Self::wait_for_authentication_cleanup(
                    attempt.settled,
                    shared.auth_cleanup_timeout_ms,
                )
                .await;
                if session.timed_out.load(Ordering::SeqCst) {
                    Self::send_error(&shared, &session, &AuthError::cancelled());
                } else {
                    Self::send_done(&shared, &session, true);
                }
            }
            AuthenticationOutcome::Error(error) => {
                if session.abort.is_aborted() && !session.timed_out.load(Ordering::SeqCst) {
                    Self::send_done(&shared, &session, true);
                } else {
                    Self::report_diagnostic(&shared, "login", &session, &error);
                    Self::send_error(&shared, &session, &error);
                }
            }
            AuthenticationOutcome::Credential(credential) => {
                #[cfg(test)]
                let before_commit = { shared.before_commit_transition.lock().unwrap().clone() };
                #[cfg(test)]
                if let Some(hook) = before_commit {
                    hook().await;
                }
                // Credential persistence is the point of no return. Holding the phase lock
                // across the abort recheck and transition makes cancel/timeout linearizable.
                let should_commit = {
                    let mut phase = session.phase.lock().unwrap();
                    if session.abort.is_aborted() {
                        false
                    } else {
                        *phase = Phase::Committing;
                        true
                    }
                };
                if !should_commit {
                    if session.timed_out.load(Ordering::SeqCst) {
                        Self::send_error(&shared, &session, &AuthError::cancelled());
                    } else {
                        Self::send_done(&shared, &session, true);
                    }
                    Self::finish_session(&shared, &session);
                    return;
                }
                if let Some(task) = session.timeout_task.lock().unwrap().take() {
                    task.abort();
                }
                match session.backend.commit_credential(credential).await {
                    Ok(()) => Self::send_done(&shared, &session, false),
                    Err(error) => {
                        Self::report_diagnostic(&shared, "login", &session, &error);
                        Self::send_error(&shared, &session, &error);
                    }
                }
            }
        }
        Self::finish_session(&shared, &session);
    }

    fn authenticate(
        shared: &Arc<CoordinatorShared>,
        session: &Arc<AuthSession>,
    ) -> AuthenticationAttempt {
        let session_for_prompt = session.clone();
        let shared_for_prompt = shared.clone();
        let prompt_fn: AuthPromptFn = Arc::new(move |prompt, signal| {
            Self::request_prompt(&shared_for_prompt, &session_for_prompt, prompt, signal)
        });
        let session_for_notify = session.clone();
        let shared_for_notify = shared.clone();
        let notify_fn: AuthNotifyFn =
            Arc::new(move |event| Self::notify(&shared_for_notify, &session_for_notify, event));
        let interaction = Arc::new(AuthInteraction {
            signal: session.abort.clone(),
            prompt: prompt_fn,
            notify: notify_fn,
        });

        let (tx, rx) = oneshot::channel();
        let backend = session.backend.clone();
        let authenticate_task = tokio::spawn(async move {
            let result = backend.authenticate(interaction).await;
            let _ = tx.send(result);
        });

        let outcome = {
            let abort = session.abort.clone();
            async move {
                tokio::select! {
                    result = rx => match result {
                        Ok(Ok(credential)) => AuthenticationOutcome::Credential(credential),
                        Ok(Err(error)) => AuthenticationOutcome::Error(error),
                        Err(_) => AuthenticationOutcome::Aborted,
                    },
                    _ = abort.notified() => AuthenticationOutcome::Aborted,
                }
            }
        };
        let settled = async move {
            let _ = authenticate_task.await;
        };
        AuthenticationAttempt {
            outcome: outcome.boxed(),
            settled: settled.boxed(),
        }
    }

    async fn wait_for_authentication_cleanup(settled: BoxFuture<'static, ()>, timeout_ms: u64) {
        let _ = tokio::time::timeout(Duration::from_millis(timeout_ms), settled).await;
    }

    fn request_prompt(
        shared: &Arc<CoordinatorShared>,
        session: &Arc<AuthSession>,
        prompt: AuthPrompt,
        prompt_signal: Option<Arc<AbortSignal>>,
    ) -> BoxFuture<'static, Result<String, AuthError>> {
        if !Self::is_current_session(shared, session) {
            return async { Err(AuthError::cancelled()) }.boxed();
        }
        if session.pending_prompt.lock().unwrap().is_some() {
            return async {
                Err(AuthError::new(
                    "Error",
                    "Provider authentication requested overlapping prompts.",
                ))
            }
            .boxed();
        }
        if session.abort.is_aborted() {
            return async { Err(AuthError::cancelled()) }.boxed();
        }
        if prompt_signal
            .as_ref()
            .is_some_and(|signal| signal.is_aborted())
        {
            return async {
                Err(AuthError::new(
                    "AbortError",
                    "The provider authentication prompt is no longer active.",
                ))
            }
            .boxed();
        }

        let prompt_id = (shared.create_id)();
        if !is_uuid_v4(&prompt_id) {
            return async {
                Err(AuthError::new(
                    "Error",
                    "Provider authentication generated an invalid prompt ID.",
                ))
            }
            .boxed();
        }
        let prepared = match Self::prepare_prompt(session, &prompt_id, &prompt) {
            Ok(prepared) => prepared,
            Err(error) => return async { Err(error) }.boxed(),
        };
        let (tx, rx) = oneshot::channel();
        let pending = PendingPrompt {
            id: prompt_id.clone(),
            prompt_type: prompt.kind(),
            select_values: prepared.select_values,
            tx,
        };
        *session.pending_prompt.lock().unwrap() = Some(pending);
        if !Self::safe_send(shared, session, "providers:auth:prompt", &prepared.dto) {
            Self::abort_session(shared, session);
        }

        let session = session.clone();
        let prompt_id_for_cleanup = prompt_id.clone();
        async move {
            let prompt_abort_future = async {
                match &prompt_signal {
                    Some(signal) => signal.notified().await,
                    None => std::future::pending::<()>().await,
                }
            };
            tokio::pin!(prompt_abort_future);
            tokio::select! {
                value = rx => match value {
                    Ok(Ok(value)) => Ok(value),
                    Ok(Err(())) | Err(_) => Err(AuthError::cancelled()),
                },
                _ = session.abort.notified() => {
                    Self::clear_pending_prompt(&session, &prompt_id_for_cleanup);
                    Err(AuthError::cancelled())
                }
                _ = &mut prompt_abort_future => {
                    Self::clear_pending_prompt(&session, &prompt_id_for_cleanup);
                    Err(AuthError::new("AbortError", "The provider authentication prompt is no longer active."))
                }
            }
        }
        .boxed()
    }

    fn notify(
        shared: &Arc<CoordinatorShared>,
        session: &Arc<AuthSession>,
        event: AuthEvent,
    ) -> Result<(), AuthError> {
        if !Self::is_current_session(shared, session) {
            return Ok(());
        }
        let codex = session.provider_id == OPENAI_CODEX_PROVIDER_ID;
        let flow_id = session.flow_id.clone();
        let provider_id = session.provider_id.clone();
        let dto: ProviderAuthEventDto = match event {
            AuthEvent::AuthUrl { url, instructions } => {
                let url = external_https_url(&url)?;
                let dto = ProviderAuthEventDto::AuthUrl {
                    flow_id: flow_id.clone(),
                    provider_id: provider_id.clone(),
                    url: url.clone(),
                    instructions: if codex {
                        "Complete sign-in in your browser.".to_string()
                    } else {
                        bounded_copy(
                            instructions.as_deref(),
                            "Complete setup in your browser.",
                            2_048,
                        )
                    },
                };
                Self::open_external(shared, &provider_id, &url);
                dto
            }
            AuthEvent::DeviceCode {
                user_code,
                verification_uri,
                interval_seconds,
                expires_in_seconds,
            } => {
                let verification_uri = external_https_url(&verification_uri)?;
                if user_code.is_empty() || user_code.len() > 256 {
                    return Err(AuthError::new(
                        "Error",
                        "Provider authentication supplied an invalid device code.",
                    ));
                }
                let dto = ProviderAuthEventDto::DeviceCode {
                    flow_id: flow_id.clone(),
                    provider_id: provider_id.clone(),
                    user_code,
                    verification_uri: verification_uri.clone(),
                    interval_seconds,
                    expires_in_seconds,
                };
                Self::open_external(shared, &provider_id, &verification_uri);
                dto
            }
            AuthEvent::Info { message, links } => {
                let links = if codex {
                    None
                } else {
                    links.map(|links| {
                        links
                            .iter()
                            .take(8)
                            .filter_map(|link| {
                                let mut parsed =
                                    Url::parse(&external_https_url(&link.url).ok()?).ok()?;
                                parsed.set_query(None);
                                parsed.set_fragment(None);
                                Some(ProviderAuthLinkDto {
                                    url: parsed.to_string(),
                                    label: Some(bounded_copy(link.label.as_deref(), "", 256))
                                        .filter(|value| !value.is_empty()),
                                })
                            })
                            .collect()
                    })
                };
                ProviderAuthEventDto::Info {
                    flow_id: flow_id.clone(),
                    provider_id: provider_id.clone(),
                    message: if codex {
                        "OpenAI provided an update during sign-in.".to_string()
                    } else {
                        bounded_copy(Some(&message), "Provider setup is in progress.", 2_048)
                    },
                    links,
                }
            }
            AuthEvent::Progress { message } => ProviderAuthEventDto::Progress {
                flow_id,
                provider_id,
                message: if codex {
                    "Signing in to ChatGPT…".to_string()
                } else {
                    bounded_copy(Some(&message), "Completing provider setup…", 2_048)
                },
            },
        };
        if !Self::safe_send(shared, session, "providers:auth:event", &dto) {
            Self::abort_session(shared, session);
        }
        Ok(())
    }

    fn open_external(shared: &Arc<CoordinatorShared>, provider_id: &str, url: &str) {
        let open_external = shared.deps.open_external.clone();
        let diagnostic = shared.deps.diagnostic.clone();
        let provider_id = provider_id.to_string();
        let url = url.to_string();
        tokio::spawn(async move {
            if let Err(error) = open_external(&url).await {
                if let Some(diagnostic) = diagnostic {
                    let name = error.to_string();
                    diagnostic(ProviderAuthDiagnostic {
                        operation: "open_external",
                        provider_id: provider_id.clone(),
                        error_name: "Error".to_string(),
                        error_code: None,
                    });
                    let _ = name;
                }
            }
        });
    }

    fn owned_session(
        shared: &CoordinatorShared,
        owner: Arc<dyn ProviderAuthOwner>,
        flow_id: &str,
        provider_id: &str,
    ) -> Result<Arc<AuthSession>, ProviderAuthRequestError> {
        Self::assert_usable_owner(owner.as_ref())?;
        let valid_flow_id = parse_flow_id(flow_id)?;
        let valid_provider_id = parse_provider_id(provider_id)?;
        let session = shared.state.lock().unwrap().active_session.clone();
        let Some(session) = session else {
            return Err(ProviderAuthRequestError(
                "Provider authentication flow is not owned by this window.".to_string(),
            ));
        };
        if session.flow_id != valid_flow_id
            || session.provider_id != valid_provider_id
            || session.owner.id() != owner.id()
            || session.owner.document_id() != owner.document_id()
        {
            return Err(ProviderAuthRequestError(
                "Provider authentication flow is not owned by this window.".to_string(),
            ));
        }
        Ok(session)
    }

    fn abort_session(shared: &CoordinatorShared, session: &AuthSession) -> bool {
        let _ = shared;
        let _phase = session.phase.lock().unwrap();
        if *_phase == Phase::Committing {
            return false;
        }
        if !session.abort.is_aborted() {
            session.abort.abort();
        }
        true
    }

    fn timeout_session(shared: &CoordinatorShared, session: &AuthSession) {
        let _ = shared;
        let _phase = session.phase.lock().unwrap();
        if *_phase == Phase::Committing {
            return;
        }
        session.timed_out.store(true, Ordering::SeqCst);
        if !session.abort.is_aborted() {
            session.abort.abort();
        }
    }

    async fn wait_for_logout(
        operation: &LogoutOperation,
    ) -> Result<Value, ProviderAuthRequestError> {
        let mut outcome = operation.outcome.clone();
        loop {
            if let Some(result) = outcome.borrow().clone() {
                return result;
            }
            if outcome.changed().await.is_err() {
                return Err(ProviderAuthRequestError(
                    "Provider sign-out did not complete.".to_string(),
                ));
            }
        }
    }

    fn finish_session(shared: &CoordinatorShared, session: &Arc<AuthSession>) {
        if let Some(task) = session.timeout_task.lock().unwrap().take() {
            task.abort();
        }
        if let Some(remove) = session.owner_invalidation.lock().unwrap().take() {
            remove();
        }
        // Drop any pending prompt sender: its waiter observes cancellation.
        *session.pending_prompt.lock().unwrap() = None;
        {
            let mut state = shared.state.lock().unwrap();
            if state
                .active_session
                .as_ref()
                .is_some_and(|active| Arc::ptr_eq(active, session))
            {
                state.active_session = None;
            }
        }
        session.finished.set();
    }

    fn clear_pending_prompt(session: &AuthSession, prompt_id: &str) {
        let mut slot = session.pending_prompt.lock().unwrap();
        if slot.as_ref().is_some_and(|pending| pending.id == prompt_id) {
            *slot = None;
        }
    }

    fn send_done(shared: &CoordinatorShared, session: &Arc<AuthSession>, cancelled: bool) {
        let dto = ProviderAuthDoneDto {
            flow_id: session.flow_id.clone(),
            provider_id: session.provider_id.clone(),
            cancelled,
        };
        let _ = Self::safe_send(shared, session, "providers:auth:done", &dto);
    }

    fn send_error(shared: &CoordinatorShared, session: &Arc<AuthSession>, error: &AuthError) {
        let (code, message) = classify_login_error(
            error,
            session.timed_out.load(Ordering::SeqCst),
            &session.provider_id,
        );
        let dto = ProviderAuthErrorDto {
            flow_id: session.flow_id.clone(),
            provider_id: session.provider_id.clone(),
            code: code.as_str().to_string(),
            message,
        };
        let _ = Self::safe_send(shared, session, "providers:auth:error", &dto);
    }

    fn safe_send(
        shared: &CoordinatorShared,
        session: &Arc<AuthSession>,
        channel: &str,
        payload: &impl Serialize,
    ) -> bool {
        if session.suppress_notifications.load(Ordering::SeqCst) || session.owner.is_destroyed() {
            return false;
        }
        let Ok(value) = serde_json::to_value(payload) else {
            return false;
        };
        match session.owner.send(channel, &value) {
            Ok(()) => true,
            Err(()) => {
                session.suppress_notifications.store(true, Ordering::SeqCst);
                Self::abort_session(shared, session);
                false
            }
        }
    }

    fn is_current_session(shared: &CoordinatorShared, session: &Arc<AuthSession>) -> bool {
        let active = shared.state.lock().unwrap().active_session.clone();
        active
            .as_ref()
            .is_some_and(|active| Arc::ptr_eq(active, session))
            && !session.abort.is_aborted()
    }

    fn report_diagnostic(
        shared: &CoordinatorShared,
        operation: &'static str,
        session: &Arc<AuthSession>,
        error: &AuthError,
    ) {
        if let Some(diagnostic) = &shared.deps.diagnostic {
            diagnostic(ProviderAuthDiagnostic {
                operation,
                provider_id: session.provider_id.clone(),
                error_name: error_name_of(error),
                error_code: error_code_of(error),
            });
        }
    }

    fn prepare_prompt(
        session: &AuthSession,
        prompt_id: &str,
        prompt: &AuthPrompt,
    ) -> Result<PreparedPrompt, AuthError> {
        let codex = session.provider_id == OPENAI_CODEX_PROVIDER_ID;
        let codex_copy = prompt_copy(prompt.kind());
        let (message, placeholder) = if codex {
            (codex_copy.0.clone(), codex_copy.1.clone())
        } else {
            (
                bounded_copy(Some(prompt.message()), &codex_copy.0, 2_048),
                prompt
                    .placeholder()
                    .map(|value| {
                        bounded_copy(Some(value), codex_copy.1.as_deref().unwrap_or(""), 2_048)
                    })
                    .filter(|value| !value.is_empty()),
            )
        };
        let base = ProviderAuthPromptDto {
            flow_id: session.flow_id.clone(),
            provider_id: session.provider_id.clone(),
            prompt_id: prompt_id.to_string(),
            r#type: prompt.kind().to_string(),
            message,
            placeholder,
            options: None,
        };
        match prompt {
            AuthPrompt::Select { options, .. } => {
                let option_count = options.len();
                if option_count == 0 || option_count > 32 {
                    return Err(AuthError::new(
                        "Error",
                        "Provider authentication supplied an invalid number of sign-in options.",
                    ));
                }
                let mut seen = std::collections::HashSet::new();
                for option in options {
                    if option.id.is_empty()
                        || option.id.len() > 256
                        || !seen.insert(option.id.clone())
                    {
                        return Err(AuthError::new(
                            "Error",
                            "Provider authentication supplied invalid sign-in options.",
                        ));
                    }
                }
                let mut select_values = BTreeMap::new();
                let dto_options = options
                    .iter()
                    .enumerate()
                    .map(|(index, option)| {
                        let id = format!("option-{}", index + 1);
                        select_values.insert(id.clone(), option.id.clone());
                        let (label, description) = select_option_copy(&option.id, index);
                        ProviderAuthSelectOptionDto {
                            id,
                            label: if codex {
                                label
                            } else {
                                bounded_copy(
                                    Some(&option.label),
                                    &format!("Option {}", index + 1),
                                    256,
                                )
                            },
                            description: if codex {
                                description.map(str::to_string)
                            } else {
                                Some(bounded_copy(option.description.as_deref(), "", 1_024))
                                    .filter(|value| !value.is_empty())
                            },
                        }
                    })
                    .collect();
                Ok(PreparedPrompt {
                    dto: ProviderAuthPromptDto {
                        options: Some(dto_options),
                        ..base
                    },
                    select_values: Some(select_values),
                })
            }
            _ => Ok(PreparedPrompt {
                dto: base,
                select_values: None,
            }),
        }
    }
}

// ===========================================================================
// Pure helpers
// ===========================================================================

fn codex_or(provider_id: &str, codex_message: &str, other_message: &str) -> String {
    if provider_id == OPENAI_CODEX_PROVIDER_ID {
        codex_message.to_string()
    } else {
        other_message.to_string()
    }
}

fn external_https_url(value: &str) -> Result<String, AuthError> {
    if value.is_empty() || value.len() > MAX_EXTERNAL_URL_LENGTH {
        return Err(AuthError::new(
            "Error",
            "Provider authentication supplied an invalid external URL.",
        ));
    }
    let Ok(url) = Url::parse(value) else {
        return Err(AuthError::new(
            "Error",
            "Provider authentication supplied an invalid external URL.",
        ));
    };
    if url.scheme() != "https"
        || !url.username().is_empty()
        || url.password().is_some()
        || url.host_str().is_none()
    {
        return Err(AuthError::new(
            "Error",
            "Provider authentication supplied an invalid external URL.",
        ));
    }
    Ok(url.to_string())
}

fn error_name_of(error: &AuthError) -> String {
    if SAFE_ERROR_NAMES.contains(&error.name.as_str()) {
        error.name.clone()
    } else {
        "UnknownError".to_string()
    }
}

fn error_code_of(error: &AuthError) -> Option<String> {
    let code = error.code.as_deref()?;
    SAFE_DIAGNOSTIC_CODES
        .contains(&code)
        .then(|| code.to_string())
}

fn error_classifier_text(error: &AuthError) -> String {
    format!(
        "{} {} {}",
        error.name,
        error.code.as_deref().unwrap_or(""),
        error.message
    )
    .to_lowercase()
}

/// `classifyLoginError` — actionable, sanitized error codes.
pub fn classify_login_error(
    error: &AuthError,
    timed_out: bool,
    provider_id: &str,
) -> (ProviderAuthErrorCode, String) {
    let codex = provider_id == OPENAI_CODEX_PROVIDER_ID;
    if timed_out {
        return (
            ProviderAuthErrorCode::TimedOut,
            if codex {
                "ChatGPT sign-in timed out. Start a new sign-in attempt to try again.".to_string()
            } else {
                "Provider setup timed out. Start a new setup attempt to try again.".to_string()
            },
        );
    }
    let text = error_classifier_text(error);
    if text.contains("eaddrinuse") || (text.contains("1455") && text.contains("listen")) {
        return (
            ProviderAuthErrorCode::PortBusy,
            if codex {
                "The local sign-in port is busy. Try again and choose Device code instead."
                    .to_string()
            } else {
                "The local setup port is busy. Try the provider's alternate setup method."
                    .to_string()
            },
        );
    }
    if text.contains("429") || text.contains("rate limit") || text.contains("too many request") {
        return (
            ProviderAuthErrorCode::RateLimited,
            if codex {
                "OpenAI is temporarily limiting sign-in attempts. Wait a moment, then try again."
                    .to_string()
            } else {
                "The provider is temporarily limiting setup attempts. Wait a moment, then try again."
                    .to_string()
            },
        );
    }
    if text.contains("timed out")
        || text.contains("timeout")
        || text.contains("expired_token")
        || text.contains("device code expired")
    {
        return (
            ProviderAuthErrorCode::TimedOut,
            if codex {
                "ChatGPT sign-in expired. Start a new sign-in attempt to try again.".to_string()
            } else {
                "Provider setup expired. Start a new setup attempt to try again.".to_string()
            },
        );
    }
    if text.contains("state mismatch") || text.contains("verification") {
        return (
            ProviderAuthErrorCode::VerificationFailed,
            if codex {
                "OpenAI could not verify this sign-in response. Start a new sign-in attempt."
                    .to_string()
            } else {
                "The provider could not verify this setup response. Start a new attempt."
                    .to_string()
            },
        );
    }
    (
        ProviderAuthErrorCode::SignInFailed,
        if codex {
            "ChatGPT sign-in did not complete. Try again or use Device code.".to_string()
        } else {
            "Provider setup did not complete. Check the requested information and try again."
                .to_string()
        },
    )
}

fn prompt_copy(prompt_type: &str) -> (String, Option<String>) {
    match prompt_type {
        "select" => ("Choose how to sign in to ChatGPT.".to_string(), None),
        "manual_code" => (
            "Paste the authorization code or redirect URL from your browser.".to_string(),
            Some("Authorization code or redirect URL".to_string()),
        ),
        "secret" => ("Enter the requested sign-in secret.".to_string(), None),
        _ => ("Enter the requested sign-in information.".to_string(), None),
    }
}

fn bounded_copy(value: Option<&str>, fallback: &str, max_length: usize) -> String {
    match value {
        Some(value) => {
            let text = value.trim();
            if text.is_empty() {
                fallback.to_string()
            } else {
                text.chars().take(max_length).collect()
            }
        }
        None => fallback.to_string(),
    }
}

/// `selectOptionCopy` — the reviewed Codex product wording for known
/// provider option ids.
fn select_option_copy(provider_option_id: &str, index: usize) -> (String, Option<&'static str>) {
    match provider_option_id {
        "browser" => (
            "Browser login".to_string(),
            Some("Complete sign-in in your default browser."),
        ),
        "device_code" => (
            "Device code".to_string(),
            Some("Use a short code on OpenAI's verification page."),
        ),
        _ => (format!("Sign-in option {}", index + 1), None),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::sync::atomic::AtomicU64;

    const PROVIDER_ID: &str = "openai-codex";
    const FLOW_A: &str = "11111111-1111-4111-8111-111111111111";
    const FLOW_B: &str = "22222222-2222-4222-8222-222222222222";
    const PROMPT_A: &str = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const PROMPT_B: &str = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

    /// A one-shot sender both sides can hold; the test side takes the sender
    /// out to resolve the closure's await exactly once.
    fn sender_slot<T>(tx: oneshot::Sender<T>) -> Arc<Mutex<Option<oneshot::Sender<T>>>> {
        Arc::new(Mutex::new(Some(tx)))
    }

    fn receiver_slot<T>(rx: oneshot::Receiver<T>) -> Arc<Mutex<Option<oneshot::Receiver<T>>>> {
        Arc::new(Mutex::new(Some(rx)))
    }

    async fn take_receiver<T>(slot: &Mutex<Option<oneshot::Receiver<T>>>) -> Option<T> {
        let receiver = { slot.lock().unwrap().take() };
        receiver?.await.ok()
    }

    fn send_value<T>(slot: &Mutex<Option<oneshot::Sender<T>>>, value: T) {
        if let Some(tx) = slot.lock().unwrap().take() {
            let _ = tx.send(value);
        }
    }

    type InvalidationListener = Arc<dyn Fn() + Send + Sync>;

    #[derive(Clone)]
    struct FakeOwner {
        id: u64,
        document_id: String,
        sent: Arc<Mutex<Vec<(String, Value)>>>,
        listeners: Arc<Mutex<Vec<InvalidationListener>>>,
        destroyed: Arc<AtomicBool>,
    }

    impl FakeOwner {
        fn new(id: u64) -> Self {
            Self::with_document(id, &format!("document-{id}"))
        }

        fn with_document(id: u64, document_id: &str) -> Self {
            Self {
                id,
                document_id: document_id.to_string(),
                sent: Arc::new(Mutex::new(Vec::new())),
                listeners: Arc::new(Mutex::new(Vec::new())),
                destroyed: Arc::new(AtomicBool::new(false)),
            }
        }

        fn invalidate(&self) {
            let listeners = self.listeners.lock().unwrap().clone();
            for listener in listeners {
                listener();
            }
        }

        fn destroy(&self) {
            self.destroyed.store(true, Ordering::SeqCst);
            self.invalidate();
        }
    }

    impl ProviderAuthOwner for FakeOwner {
        fn id(&self) -> u64 {
            self.id
        }
        fn document_id(&self) -> &str {
            &self.document_id
        }
        fn is_destroyed(&self) -> bool {
            self.destroyed.load(Ordering::SeqCst)
        }
        fn send(&self, channel: &str, payload: &Value) -> Result<(), ()> {
            if self.destroyed.load(Ordering::SeqCst) {
                return Err(());
            }
            self.sent
                .lock()
                .unwrap()
                .push((channel.to_string(), payload.clone()));
            Ok(())
        }
        fn on_invalidated(&self, listener: InvalidationListener) -> Box<dyn Fn() + Send + Sync> {
            self.listeners.lock().unwrap().push(listener.clone());
            let listeners = self.listeners.clone();
            Box::new(move || {
                listeners
                    .lock()
                    .unwrap()
                    .retain(|candidate| !Arc::ptr_eq(candidate, &listener));
            })
        }
    }

    struct PanickingOwner(FakeOwner);

    impl ProviderAuthOwner for PanickingOwner {
        fn id(&self) -> u64 {
            self.0.id()
        }

        fn document_id(&self) -> &str {
            self.0.document_id()
        }

        fn is_destroyed(&self) -> bool {
            false
        }

        fn send(&self, channel: &str, payload: &Value) -> Result<(), ()> {
            self.0.send(channel, payload)
        }

        fn on_invalidated(&self, _listener: InvalidationListener) -> Box<dyn Fn() + Send + Sync> {
            panic!("listener registration failed")
        }
    }

    type LoginFn = Arc<
        dyn Fn(Arc<AuthInteraction>) -> BoxFuture<'static, Result<Value, AuthError>> + Send + Sync,
    >;
    type CommitFn = Arc<dyn Fn(Value) -> BoxFuture<'static, Result<(), AuthError>> + Send + Sync>;
    type LogoutFn = Arc<dyn Fn() -> BoxFuture<'static, Result<(), AuthError>> + Send + Sync>;

    struct FakeBackend {
        snapshot_fn: Arc<dyn Fn() -> Value + Send + Sync>,
        authenticate_fn: LoginFn,
        commit_fn: CommitFn,
        logout_fn: LogoutFn,
    }

    impl ProviderAuthBackend for FakeBackend {
        fn snapshot(&self) -> BoxFuture<'static, Result<Value, AuthError>> {
            let snapshot = (self.snapshot_fn)();
            async move { Ok(snapshot) }.boxed()
        }
        fn authenticate(
            &self,
            interaction: Arc<AuthInteraction>,
        ) -> BoxFuture<'static, Result<Value, AuthError>> {
            (self.authenticate_fn)(interaction)
        }
        fn commit_credential(
            &self,
            credential: Value,
        ) -> BoxFuture<'static, Result<(), AuthError>> {
            (self.commit_fn)(credential)
        }
        fn logout(&self) -> BoxFuture<'static, Result<(), AuthError>> {
            (self.logout_fn)()
        }
    }

    fn snapshot_value(configured: bool) -> Value {
        json!({
            "id": PROVIDER_ID,
            "name": "OpenAI Codex",
            "authName": "OpenAI (ChatGPT Plus/Pro)",
            "configured": configured,
            "needsAttention": false,
            "models": [],
        })
    }

    fn backend(login: LoginFn) -> Arc<FakeBackend> {
        let configured = Arc::new(AtomicBool::new(false));
        let snapshot_configured = configured.clone();
        let commit_configured = configured.clone();
        let logout_configured = configured.clone();
        Arc::new(FakeBackend {
            snapshot_fn: Arc::new(move || {
                snapshot_value(snapshot_configured.load(Ordering::SeqCst))
            }),
            authenticate_fn: login,
            commit_fn: Arc::new(move |_credential| {
                let configured = commit_configured.clone();
                async move {
                    configured.store(true, Ordering::SeqCst);
                    Ok(())
                }
                .boxed()
            }),
            logout_fn: Arc::new(move || {
                let configured = logout_configured.clone();
                async move {
                    configured.store(false, Ordering::SeqCst);
                    Ok(())
                }
                .boxed()
            }),
        })
    }

    fn ids(values: &[&str]) -> CreateIdFn {
        let values: Vec<String> = values.iter().map(|value| value.to_string()).collect();
        let index = Arc::new(Mutex::new(0usize));
        Arc::new(move || {
            let mut index = index.lock().unwrap();
            let value = values
                .get(*index)
                .cloned()
                .unwrap_or_else(|| PROMPT_A.to_string());
            *index += 1;
            value
        })
    }

    struct MakeOptions {
        login: LoginFn,
        opened: Arc<Mutex<Vec<String>>>,
        diagnostics: Arc<Mutex<Vec<ProviderAuthDiagnostic>>>,
        timeout_ms: Option<u64>,
        cleanup_timeout_ms: Option<u64>,
        create_id: Option<CreateIdFn>,
    }

    impl Default for MakeOptions {
        fn default() -> Self {
            Self {
                login: Arc::new(|_interaction| async { Ok(json!({})) }.boxed()),
                opened: Arc::new(Mutex::new(Vec::new())),
                diagnostics: Arc::new(Mutex::new(Vec::new())),
                timeout_ms: None,
                cleanup_timeout_ms: None,
                create_id: None,
            }
        }
    }

    fn make_coordinator(options: MakeOptions) -> ProviderAuthFlowCoordinator {
        let provider_backend = backend(options.login);
        let opened = options.opened;
        let diagnostics = options.diagnostics;
        ProviderAuthFlowCoordinator::new(ProviderAuthFlowDependencies {
            backend_for: Arc::new(move |_provider_id, _auth_type| provider_backend.clone()),
            open_external: Arc::new(move |url| {
                opened.lock().unwrap().push(url.to_string());
                async { Ok(()) }.boxed()
            }),
            diagnostic: Some(Arc::new(move |event| {
                diagnostics.lock().unwrap().push(event)
            })),
            flow_timeout_ms: options.timeout_ms,
            auth_cleanup_timeout_ms: options.cleanup_timeout_ms,
            create_id: options.create_id,
        })
    }

    fn request(flow_id: &str) -> ProviderAuthStartRequest {
        ProviderAuthStartRequest {
            flow_id: flow_id.to_string(),
            provider_id: PROVIDER_ID.to_string(),
            auth_type: "oauth".to_string(),
        }
    }

    fn messages<T: serde::de::DeserializeOwned>(owner: &FakeOwner, channel: &str) -> Vec<T> {
        owner
            .sent
            .lock()
            .unwrap()
            .iter()
            .filter(|(entry_channel, _)| entry_channel == channel)
            .filter_map(|(_, payload)| serde_json::from_value(payload.clone()).ok())
            .collect()
    }

    async fn wait_for_messages(owner: &FakeOwner, channel: &str) {
        wait_for_messages_n(owner, channel, 1).await;
    }

    async fn wait_for_messages_n(owner: &FakeOwner, channel: &str, count: usize) {
        for _ in 0..300 {
            if messages::<Value>(owner, channel).len() >= count {
                return;
            }
            tokio::task::yield_now().await;
        }
        panic!("Timed out waiting for {channel} on owner {}", owner.id);
    }

    async fn wait_for(predicate: impl Fn() -> bool) {
        for _ in 0..300 {
            if predicate() {
                return;
            }
            tokio::task::yield_now().await;
        }
        panic!("Timed out waiting for condition");
    }

    fn done_dto(flow_id: &str, cancelled: bool) -> ProviderAuthDoneDto {
        ProviderAuthDoneDto {
            flow_id: flow_id.to_string(),
            provider_id: PROVIDER_ID.to_string(),
            cancelled,
        }
    }

    #[tokio::test]
    async fn browser_flow_forwards_only_prompts_and_events_and_opens_the_validated_auth_url() {
        let opened = Arc::new(Mutex::new(Vec::<String>::new()));
        let owner = Arc::new(FakeOwner::new(1));
        let coordinator = make_coordinator(MakeOptions {
            opened: opened.clone(),
            login: Arc::new(|interaction| {
                async move {
                    let method = interaction
                        .prompt(
                            AuthPrompt::Select {
                                message: "Choose a login method".to_string(),
                                options: vec![
                                    AuthSelectOption {
                                        id: "browser".to_string(),
                                        label: "Browser".to_string(),
                                        description: None,
                                    },
                                    AuthSelectOption {
                                        id: "device_code".to_string(),
                                        label: "Device code".to_string(),
                                        description: None,
                                    },
                                ],
                            },
                            None,
                        )
                        .await?;
                    assert_eq!(method, "browser");
                    interaction.notify(AuthEvent::AuthUrl {
                        url: "https://auth.openai.com/oauth/authorize?state=temporary".to_string(),
                        instructions: Some("Continue in your browser.".to_string()),
                    })?;
                    let manual = interaction
                        .prompt(
                            AuthPrompt::ManualCode {
                                message: "Paste a callback URL".to_string(),
                                placeholder: Some(
                                    "http://localhost:1455/auth/callback".to_string(),
                                ),
                            },
                            None,
                        )
                        .await?;
                    assert_eq!(manual, "callback-code");
                    Ok(json!({}))
                }
                .boxed()
            }),
            ..Default::default()
        });

        coordinator
            .start(owner.clone(), request(FLOW_A))
            .expect("start");
        wait_for_messages(&owner, "providers:auth:prompt").await;
        let select: ProviderAuthPromptDto =
            messages::<ProviderAuthPromptDto>(&owner, "providers:auth:prompt")[0].clone();
        assert_eq!(select.r#type, "select");
        assert_eq!(
            select.options,
            Some(vec![
                ProviderAuthSelectOptionDto {
                    id: "option-1".to_string(),
                    label: "Browser login".to_string(),
                    description: Some("Complete sign-in in your default browser.".to_string()),
                },
                ProviderAuthSelectOptionDto {
                    id: "option-2".to_string(),
                    label: "Device code".to_string(),
                    description: Some(
                        "Use a short code on OpenAI's verification page.".to_string()
                    ),
                },
            ])
        );
        coordinator
            .respond(
                owner.clone(),
                ProviderAuthResponseRequest {
                    flow_id: FLOW_A.to_string(),
                    provider_id: PROVIDER_ID.to_string(),
                    prompt_id: select.prompt_id.clone(),
                    value: "option-1".to_string(),
                },
            )
            .expect("respond");

        wait_for_messages(&owner, "providers:auth:event").await;
        let auth_event: ProviderAuthEventDto =
            messages::<ProviderAuthEventDto>(&owner, "providers:auth:event")[0].clone();
        assert!(
            matches!(auth_event, ProviderAuthEventDto::AuthUrl { url, .. } if url == "https://auth.openai.com/oauth/authorize?state=temporary")
        );
        assert_eq!(
            *opened.lock().unwrap(),
            vec!["https://auth.openai.com/oauth/authorize?state=temporary".to_string()]
        );

        wait_for_messages_n(&owner, "providers:auth:prompt", 2).await;
        let manual: ProviderAuthPromptDto =
            messages::<ProviderAuthPromptDto>(&owner, "providers:auth:prompt")[1].clone();
        assert_eq!(manual.r#type, "manual_code");
        coordinator
            .respond(
                owner.clone(),
                ProviderAuthResponseRequest {
                    flow_id: FLOW_A.to_string(),
                    provider_id: PROVIDER_ID.to_string(),
                    prompt_id: manual.prompt_id.clone(),
                    value: "callback-code".to_string(),
                },
            )
            .expect("respond manual");

        wait_for_messages(&owner, "providers:auth:done").await;
        assert_eq!(
            messages::<ProviderAuthDoneDto>(&owner, "providers:auth:done"),
            vec![done_dto(FLOW_A, false)]
        );
        assert!(messages::<Value>(&owner, "providers:auth:error").is_empty());
    }

    #[tokio::test]
    async fn pi_native_api_key_setup_preserves_provider_owned_multi_field_prompts() {
        let owner = Arc::new(FakeOwner::new(1));
        let seen: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(Vec::new()));
        let coordinator = {
            let seen = seen.clone();
            ProviderAuthFlowCoordinator::new(ProviderAuthFlowDependencies {
                backend_for: Arc::new(move |provider_id, auth_type| {
                    assert_eq!(provider_id, "cloudflare");
                    assert_eq!(auth_type, "api_key");
                    let seen = seen.clone();
                    backend(Arc::new(move |interaction| {
                        let seen = seen.clone();
                        async move {
                            let token_value = interaction
                                .prompt(
                                    AuthPrompt::Secret {
                                        message: "Cloudflare API token".to_string(),
                                        placeholder: Some(
                                            "Token with AI Gateway access".to_string(),
                                        ),
                                    },
                                    None,
                                )
                                .await?;
                            seen.lock().unwrap().push(token_value);
                            let account_value = interaction
                                .prompt(
                                    AuthPrompt::Text {
                                        message: "Cloudflare account ID".to_string(),
                                        placeholder: Some("32-character account ID".to_string()),
                                    },
                                    None,
                                )
                                .await?;
                            seen.lock().unwrap().push(account_value);
                            Ok(json!({
                                "type": "api_key",
                                "key": seen.lock().unwrap()[0],
                                "env": { "CLOUDFLARE_ACCOUNT_ID": seen.lock().unwrap()[1] },
                            }))
                        }
                        .boxed()
                    }))
                }),
                open_external: Arc::new(|_| async { Ok(()) }.boxed()),
                create_id: Some(ids(&[PROMPT_A, PROMPT_B])),
                ..Default::default()
            })
        };
        coordinator
            .start(
                owner.clone(),
                ProviderAuthStartRequest {
                    flow_id: FLOW_A.to_string(),
                    provider_id: "cloudflare".to_string(),
                    auth_type: "api_key".to_string(),
                },
            )
            .expect("start");
        wait_for_messages(&owner, "providers:auth:prompt").await;
        let token: ProviderAuthPromptDto =
            messages::<ProviderAuthPromptDto>(&owner, "providers:auth:prompt")[0].clone();
        assert_eq!(token.message, "Cloudflare API token");
        assert_eq!(
            token.placeholder.as_deref(),
            Some("Token with AI Gateway access")
        );
        coordinator
            .respond(
                owner.clone(),
                ProviderAuthResponseRequest {
                    flow_id: FLOW_A.to_string(),
                    provider_id: "cloudflare".to_string(),
                    prompt_id: token.prompt_id.clone(),
                    value: "token".to_string(),
                },
            )
            .expect("respond token");

        wait_for_messages_n(&owner, "providers:auth:prompt", 2).await;
        let account: ProviderAuthPromptDto =
            messages::<ProviderAuthPromptDto>(&owner, "providers:auth:prompt")[1].clone();
        assert_eq!(account.message, "Cloudflare account ID");
        coordinator
            .respond(
                owner.clone(),
                ProviderAuthResponseRequest {
                    flow_id: FLOW_A.to_string(),
                    provider_id: "cloudflare".to_string(),
                    prompt_id: account.prompt_id.clone(),
                    value: "account".to_string(),
                },
            )
            .expect("respond account");
        wait_for_messages(&owner, "providers:auth:done").await;
        assert_eq!(
            *seen.lock().unwrap(),
            vec!["token".to_string(), "account".to_string()]
        );
    }

    #[tokio::test]
    async fn device_code_flow_forwards_the_temporary_code_and_opens_its_https_verification_page() {
        let opened = Arc::new(Mutex::new(Vec::<String>::new()));
        let owner = Arc::new(FakeOwner::new(1));
        let coordinator = make_coordinator(MakeOptions {
            opened: opened.clone(),
            login: Arc::new(|interaction| {
                async move {
                    interaction.notify(AuthEvent::DeviceCode {
                        user_code: "ABCD-EFGH".to_string(),
                        verification_uri: "https://auth.openai.com/codex/device".to_string(),
                        interval_seconds: Some(5.0),
                        expires_in_seconds: Some(900),
                    })?;
                    Ok(json!({}))
                }
                .boxed()
            }),
            ..Default::default()
        });
        coordinator
            .start(owner.clone(), request(FLOW_A))
            .expect("start");
        wait_for_messages(&owner, "providers:auth:done").await;
        assert_eq!(
            messages::<ProviderAuthEventDto>(&owner, "providers:auth:event"),
            vec![ProviderAuthEventDto::DeviceCode {
                flow_id: FLOW_A.to_string(),
                provider_id: PROVIDER_ID.to_string(),
                user_code: "ABCD-EFGH".to_string(),
                verification_uri: "https://auth.openai.com/codex/device".to_string(),
                interval_seconds: Some(5.0),
                expires_in_seconds: Some(900),
            }]
        );
        assert_eq!(
            *opened.lock().unwrap(),
            vec!["https://auth.openai.com/codex/device".to_string()]
        );
    }

    #[tokio::test]
    async fn non_https_authorization_urls_are_blocked_before_opening_or_crossing_ipc() {
        let opened = Arc::new(Mutex::new(Vec::<String>::new()));
        let owner = Arc::new(FakeOwner::new(1));
        let coordinator = make_coordinator(MakeOptions {
            opened: opened.clone(),
            login: Arc::new(|interaction| {
                async move {
                    interaction.notify(AuthEvent::AuthUrl {
                        url: "http://evil.example/steal".to_string(),
                        instructions: None,
                    })?;
                    Ok(json!({}))
                }
                .boxed()
            }),
            ..Default::default()
        });
        coordinator
            .start(owner.clone(), request(FLOW_A))
            .expect("start");
        wait_for_messages(&owner, "providers:auth:error").await;
        assert!(opened.lock().unwrap().is_empty());
        assert!(messages::<Value>(&owner, "providers:auth:event").is_empty());
        let error: ProviderAuthErrorDto =
            messages::<ProviderAuthErrorDto>(&owner, "providers:auth:error")[0].clone();
        assert_eq!(error.code, "sign_in_failed");
    }

    #[tokio::test]
    async fn a_different_renderer_cannot_answer_or_cancel_an_owned_flow() {
        let owner = Arc::new(FakeOwner::new(1));
        let attacker = Arc::new(FakeOwner::new(2));
        let coordinator = make_coordinator(MakeOptions {
            login: Arc::new(|interaction| {
                async move {
                    interaction
                        .prompt(
                            AuthPrompt::Text {
                                message: "Continue".to_string(),
                                placeholder: None,
                            },
                            None,
                        )
                        .await?;
                    Ok(json!({}))
                }
                .boxed()
            }),
            ..Default::default()
        });
        coordinator
            .start(owner.clone(), request(FLOW_A))
            .expect("start");
        wait_for_messages(&owner, "providers:auth:prompt").await;
        let prompt: ProviderAuthPromptDto =
            messages::<ProviderAuthPromptDto>(&owner, "providers:auth:prompt")[0].clone();

        assert!(coordinator
            .respond(
                attacker.clone(),
                ProviderAuthResponseRequest {
                    flow_id: FLOW_A.to_string(),
                    provider_id: PROVIDER_ID.to_string(),
                    prompt_id: prompt.prompt_id.clone(),
                    value: "x".to_string(),
                },
            )
            .is_err());
        assert!(coordinator
            .cancel(attacker.clone(), &request(FLOW_A))
            .is_err());
        assert!(attacker.sent.lock().unwrap().is_empty());

        assert!(matches!(
            coordinator.cancel(owner.clone(), &request(FLOW_A)).unwrap(),
            ProviderAuthCancelOutcome::Cancelled
        ));
        wait_for_messages(&owner, "providers:auth:done").await;
    }

    #[tokio::test]
    async fn a_replacement_document_in_the_same_webcontents_cannot_control_the_old_flow() {
        let original = Arc::new(FakeOwner::with_document(1, "document-old"));
        let replacement = Arc::new(FakeOwner::with_document(1, "document-new"));
        let coordinator = make_coordinator(MakeOptions {
            login: Arc::new(|interaction| {
                async move {
                    interaction
                        .prompt(
                            AuthPrompt::Text {
                                message: "Continue".to_string(),
                                placeholder: None,
                            },
                            None,
                        )
                        .await?;
                    Ok(json!({}))
                }
                .boxed()
            }),
            ..Default::default()
        });
        coordinator
            .start(original.clone(), request(FLOW_A))
            .expect("start");
        wait_for_messages(&original, "providers:auth:prompt").await;
        let prompt: ProviderAuthPromptDto =
            messages::<ProviderAuthPromptDto>(&original, "providers:auth:prompt")[0].clone();

        let err = coordinator
            .respond(
                replacement.clone(),
                ProviderAuthResponseRequest {
                    flow_id: FLOW_A.to_string(),
                    provider_id: PROVIDER_ID.to_string(),
                    prompt_id: prompt.prompt_id.clone(),
                    value: "x".to_string(),
                },
            )
            .unwrap_err();
        assert!(err.0.contains("not owned by this window"));
        let err = coordinator
            .cancel(replacement.clone(), &request(FLOW_A))
            .unwrap_err();
        assert!(err.0.contains("not owned by this window"));
        assert!(replacement.sent.lock().unwrap().is_empty());

        original.invalidate();
    }

    #[tokio::test]
    async fn select_prompts_accept_only_an_advertised_option_id() {
        let owner = Arc::new(FakeOwner::new(1));
        let coordinator = make_coordinator(MakeOptions {
            login: Arc::new(|interaction| {
                async move {
                    interaction
                        .prompt(
                            AuthPrompt::Select {
                                message: "Choose".to_string(),
                                options: vec![AuthSelectOption {
                                    id: "browser".to_string(),
                                    label: "Browser".to_string(),
                                    description: None,
                                }],
                            },
                            None,
                        )
                        .await?;
                    Ok(json!({}))
                }
                .boxed()
            }),
            ..Default::default()
        });
        coordinator
            .start(owner.clone(), request(FLOW_A))
            .expect("start");
        wait_for_messages(&owner, "providers:auth:prompt").await;
        let prompt: ProviderAuthPromptDto =
            messages::<ProviderAuthPromptDto>(&owner, "providers:auth:prompt")[0].clone();

        let err = coordinator
            .respond(
                owner.clone(),
                ProviderAuthResponseRequest {
                    flow_id: FLOW_A.to_string(),
                    provider_id: PROVIDER_ID.to_string(),
                    prompt_id: prompt.prompt_id.clone(),
                    value: "bogus".to_string(),
                },
            )
            .unwrap_err();
        assert!(err.0.contains("available sign-in options"));
        coordinator.cancel(owner.clone(), &request(FLOW_A)).unwrap();
        wait_for_messages(&owner, "providers:auth:done").await;
    }

    #[tokio::test]
    async fn explicit_cancellation_produces_a_cancelled_terminal_event_not_an_error() {
        let owner = Arc::new(FakeOwner::new(1));
        let coordinator = make_coordinator(MakeOptions {
            login: Arc::new(|interaction| {
                async move {
                    interaction
                        .prompt(
                            AuthPrompt::Secret {
                                message: "Wait".to_string(),
                                placeholder: None,
                            },
                            None,
                        )
                        .await?;
                    Ok(json!({}))
                }
                .boxed()
            }),
            ..Default::default()
        });
        coordinator
            .start(owner.clone(), request(FLOW_A))
            .expect("start");
        wait_for_messages(&owner, "providers:auth:prompt").await;
        assert!(matches!(
            coordinator.cancel(owner.clone(), &request(FLOW_A)).unwrap(),
            ProviderAuthCancelOutcome::Cancelled
        ));
        wait_for_messages(&owner, "providers:auth:done").await;
        assert_eq!(
            messages::<ProviderAuthDoneDto>(&owner, "providers:auth:done"),
            vec![done_dto(FLOW_A, true)]
        );
        assert!(messages::<Value>(&owner, "providers:auth:error").is_empty());
    }

    #[tokio::test]
    async fn destroying_the_owner_cancels_silently_and_releases_the_global_flow_slot() {
        let first = Arc::new(FakeOwner::new(1));
        let second = Arc::new(FakeOwner::new(2));
        let coordinator = make_coordinator(MakeOptions {
            login: Arc::new(|interaction| {
                async move {
                    interaction
                        .prompt(
                            AuthPrompt::Text {
                                message: "Wait".to_string(),
                                placeholder: None,
                            },
                            None,
                        )
                        .await?;
                    Ok(json!({}))
                }
                .boxed()
            }),
            ..Default::default()
        });
        coordinator
            .start(first.clone(), request(FLOW_A))
            .expect("start");
        wait_for_messages(&first, "providers:auth:prompt").await;
        first.destroy();

        for _ in 0..300 {
            if coordinator.start(second.clone(), request(FLOW_B)).is_ok() {
                break;
            }
            tokio::task::yield_now().await;
        }
        assert!(messages::<Value>(&first, "providers:auth:done").is_empty());
        coordinator
            .cancel(second.clone(), &request(FLOW_B))
            .unwrap();
        wait_for_messages(&second, "providers:auth:done").await;
    }

    #[tokio::test]
    async fn renderer_document_invalidation_cancels_a_flow_even_when_webcontents_survives() {
        let owner = Arc::new(FakeOwner::new(1));
        let coordinator = make_coordinator(MakeOptions {
            login: Arc::new(|interaction| {
                async move {
                    interaction
                        .prompt(
                            AuthPrompt::Text {
                                message: "Wait".to_string(),
                                placeholder: None,
                            },
                            None,
                        )
                        .await?;
                    Ok(json!({}))
                }
                .boxed()
            }),
            ..Default::default()
        });
        coordinator
            .start(owner.clone(), request(FLOW_A))
            .expect("start");
        wait_for_messages(&owner, "providers:auth:prompt").await;
        owner.invalidate();

        for _ in 0..300 {
            if coordinator.start(owner.clone(), request(FLOW_B)).is_ok() {
                break;
            }
            tokio::task::yield_now().await;
        }
        assert!(messages::<Value>(&owner, "providers:auth:done").is_empty());
        coordinator.cancel(owner.clone(), &request(FLOW_B)).unwrap();
        wait_for_messages(&owner, "providers:auth:done").await;
    }

    #[tokio::test]
    async fn the_overall_timeout_aborts_the_flow_and_reports_a_safe_retryable_error() {
        let owner = Arc::new(FakeOwner::new(1));
        let coordinator = make_coordinator(MakeOptions {
            timeout_ms: Some(10),
            login: Arc::new(|interaction| {
                async move {
                    interaction
                        .prompt(
                            AuthPrompt::Text {
                                message: "Wait".to_string(),
                                placeholder: None,
                            },
                            None,
                        )
                        .await?;
                    Ok(json!({}))
                }
                .boxed()
            }),
            ..Default::default()
        });
        coordinator
            .start(owner.clone(), request(FLOW_A))
            .expect("start");
        tokio::time::sleep(Duration::from_millis(20)).await;
        wait_for_messages(&owner, "providers:auth:error").await;
        let errors: Vec<ProviderAuthErrorDto> = messages(&owner, "providers:auth:error");
        assert_eq!(errors.len(), 1);
        assert_eq!(errors[0].code, "timed_out");
        assert_eq!(
            errors[0].message,
            "ChatGPT sign-in timed out. Start a new sign-in attempt to try again."
        );
        assert!(messages::<Value>(&owner, "providers:auth:done").is_empty());
    }

    #[tokio::test]
    async fn timeout_is_terminal_but_cleanup_gets_a_bounded_chance_before_the_slot_is_released() {
        let authentication_calls = Arc::new(AtomicBool::new(false));
        let commits = Arc::new(AtomicU64::new(0));
        let configured = Arc::new(AtomicBool::new(false));
        let custom_backend = {
            let authentication_calls = authentication_calls.clone();
            let commits = commits.clone();
            let snapshot_configured = configured.clone();
            let commit_configured = configured.clone();
            let logout_configured = configured.clone();
            FakeBackend {
                snapshot_fn: Arc::new(move || {
                    snapshot_value(snapshot_configured.load(Ordering::SeqCst))
                }),
                authenticate_fn: Arc::new(move |_interaction| {
                    let authentication_calls = authentication_calls.clone();
                    async move {
                        if authentication_calls.swap(true, Ordering::SeqCst) {
                            Ok(json!({}))
                        } else {
                            std::future::pending::<Result<Value, AuthError>>().await
                        }
                    }
                    .boxed()
                }),
                commit_fn: Arc::new(move |_credential| {
                    let commits = commits.clone();
                    let configured = commit_configured.clone();
                    async move {
                        commits.fetch_add(1, Ordering::SeqCst);
                        configured.store(true, Ordering::SeqCst);
                        Ok(())
                    }
                    .boxed()
                }),
                logout_fn: Arc::new(move || {
                    let configured = logout_configured.clone();
                    async move {
                        configured.store(false, Ordering::SeqCst);
                        Ok(())
                    }
                    .boxed()
                }),
            }
        };
        let custom_backend = Arc::new(custom_backend);
        let coordinator = ProviderAuthFlowCoordinator::new(ProviderAuthFlowDependencies {
            backend_for: Arc::new(move |_provider_id, _auth_type| custom_backend.clone()),
            open_external: Arc::new(|_| async { Ok(()) }.boxed()),
            flow_timeout_ms: Some(10),
            auth_cleanup_timeout_ms: Some(20),
            create_id: Some(ids(&[PROMPT_A, PROMPT_B])),
            ..Default::default()
        });
        let first = Arc::new(FakeOwner::new(1));
        coordinator
            .start(first.clone(), request(FLOW_A))
            .expect("start");
        tokio::time::sleep(Duration::from_millis(20)).await;

        let second = Arc::new(FakeOwner::new(2));
        let err = coordinator
            .start(second.clone(), request(FLOW_B))
            .unwrap_err();
        assert!(err
            .0
            .contains("Another ChatGPT sign-in is already in progress"));
        assert!(messages::<Value>(&first, "providers:auth:error").is_empty());
        tokio::time::sleep(Duration::from_millis(30)).await;
        wait_for_messages(&first, "providers:auth:error").await;
        coordinator
            .start(second.clone(), request(FLOW_B))
            .expect("start");
        wait_for_messages(&second, "providers:auth:done").await;
        assert_eq!(commits.load(Ordering::SeqCst), 1);
        assert!(configured.load(Ordering::SeqCst));
    }

    #[tokio::test]
    async fn cancelled_authentication_cannot_commit_a_late_credential() {
        let (first_tx, first_rx) = oneshot::channel::<Value>();
        let first_tx_slot = sender_slot(first_tx);
        let first_rx = receiver_slot(first_rx);
        let authentication_calls = Arc::new(AtomicU64::new(0));
        let commits = Arc::new(AtomicU64::new(0));
        let custom_backend = {
            let authentication_calls = authentication_calls.clone();
            let commits = commits.clone();
            let first_rx = first_rx.clone();
            FakeBackend {
                snapshot_fn: Arc::new(|| snapshot_value(false)),
                authenticate_fn: Arc::new(move |_interaction| {
                    let authentication_calls = authentication_calls.clone();
                    let first_rx = first_rx.clone();
                    async move {
                        if authentication_calls.fetch_add(1, Ordering::SeqCst) == 0 {
                            match take_receiver(&first_rx).await {
                                Some(value) => Ok(value),
                                None => Err(AuthError::new("Error", "channel closed")),
                            }
                        } else {
                            Ok(json!({}))
                        }
                    }
                    .boxed()
                }),
                commit_fn: Arc::new(move |_credential| {
                    let commits = commits.clone();
                    async move {
                        commits.fetch_add(1, Ordering::SeqCst);
                        Ok(())
                    }
                    .boxed()
                }),
                logout_fn: Arc::new(|| async { Ok(()) }.boxed()),
            }
        };
        let custom_backend = Arc::new(custom_backend);
        let coordinator = ProviderAuthFlowCoordinator::new(ProviderAuthFlowDependencies {
            backend_for: Arc::new(move |_provider_id, _auth_type| custom_backend.clone()),
            open_external: Arc::new(|_| async { Ok(()) }.boxed()),
            create_id: Some(ids(&[PROMPT_A, PROMPT_B])),
            ..Default::default()
        });
        let first = Arc::new(FakeOwner::new(1));
        coordinator
            .start(first.clone(), request(FLOW_A))
            .expect("start");
        tokio::task::yield_now().await;
        assert!(matches!(
            coordinator.cancel(first.clone(), &request(FLOW_A)).unwrap(),
            ProviderAuthCancelOutcome::Cancelled
        ));
        assert!(messages::<Value>(&first, "providers:auth:done").is_empty());
        assert_eq!(commits.load(Ordering::SeqCst), 0);

        let second = Arc::new(FakeOwner::new(2));
        let err = coordinator
            .start(second.clone(), request(FLOW_B))
            .unwrap_err();
        assert!(err
            .0
            .contains("Another ChatGPT sign-in is already in progress"));

        send_value(&first_tx_slot, json!({ "late": true }));
        wait_for_messages(&first, "providers:auth:done").await;
        assert_eq!(commits.load(Ordering::SeqCst), 0);

        coordinator
            .start(second.clone(), request(FLOW_B))
            .expect("start");
        wait_for_messages(&second, "providers:auth:done").await;
        assert_eq!(commits.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn cancel_wins_a_paused_precommit_transition_and_the_slot_recovers() {
        let commits = Arc::new(AtomicU64::new(0));
        let custom_backend = Arc::new(FakeBackend {
            snapshot_fn: Arc::new(|| snapshot_value(false)),
            authenticate_fn: Arc::new(|_| async { Ok(json!({})) }.boxed()),
            commit_fn: {
                let commits = commits.clone();
                Arc::new(move |_| {
                    let commits = commits.clone();
                    async move {
                        commits.fetch_add(1, Ordering::SeqCst);
                        Ok(())
                    }
                    .boxed()
                })
            },
            logout_fn: Arc::new(|| async { Ok(()) }.boxed()),
        });
        let coordinator = ProviderAuthFlowCoordinator::new(ProviderAuthFlowDependencies {
            backend_for: Arc::new(move |_, _| custom_backend.clone()),
            open_external: Arc::new(|_| async { Ok(()) }.boxed()),
            ..Default::default()
        });
        let entered = Arc::new(Notify::new());
        let release = Arc::new(Notify::new());
        *coordinator.shared.before_commit_transition.lock().unwrap() = Some(Arc::new({
            let entered = entered.clone();
            let release = release.clone();
            move || {
                let entered = entered.clone();
                let release = release.clone();
                async move {
                    entered.notify_one();
                    release.notified().await;
                }
                .boxed()
            }
        }));
        let owner = Arc::new(FakeOwner::new(1));
        coordinator.start(owner.clone(), request(FLOW_A)).unwrap();
        entered.notified().await;
        assert_eq!(
            coordinator.cancel(owner.clone(), &request(FLOW_A)).unwrap(),
            ProviderAuthCancelOutcome::Cancelled
        );
        release.notify_one();
        wait_for_messages(&owner, "providers:auth:done").await;
        assert_eq!(commits.load(Ordering::SeqCst), 0);

        *coordinator.shared.before_commit_transition.lock().unwrap() = None;
        let next = Arc::new(FakeOwner::new(2));
        coordinator.start(next.clone(), request(FLOW_B)).unwrap();
        wait_for_messages(&next, "providers:auth:done").await;
        assert_eq!(commits.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn timeout_wins_a_paused_precommit_transition_without_persisting() {
        let commits = Arc::new(AtomicU64::new(0));
        let custom_backend = Arc::new(FakeBackend {
            snapshot_fn: Arc::new(|| snapshot_value(false)),
            authenticate_fn: Arc::new(|_| async { Ok(json!({})) }.boxed()),
            commit_fn: {
                let commits = commits.clone();
                Arc::new(move |_| {
                    let commits = commits.clone();
                    async move {
                        commits.fetch_add(1, Ordering::SeqCst);
                        Ok(())
                    }
                    .boxed()
                })
            },
            logout_fn: Arc::new(|| async { Ok(()) }.boxed()),
        });
        let coordinator = ProviderAuthFlowCoordinator::new(ProviderAuthFlowDependencies {
            backend_for: Arc::new(move |_, _| custom_backend.clone()),
            open_external: Arc::new(|_| async { Ok(()) }.boxed()),
            flow_timeout_ms: Some(10),
            ..Default::default()
        });
        let entered = Arc::new(Notify::new());
        let release = Arc::new(Notify::new());
        *coordinator.shared.before_commit_transition.lock().unwrap() = Some(Arc::new({
            let entered = entered.clone();
            let release = release.clone();
            move || {
                let entered = entered.clone();
                let release = release.clone();
                async move {
                    entered.notify_one();
                    release.notified().await;
                }
                .boxed()
            }
        }));
        let owner = Arc::new(FakeOwner::new(1));
        coordinator.start(owner.clone(), request(FLOW_A)).unwrap();
        entered.notified().await;
        tokio::time::sleep(Duration::from_millis(20)).await;
        release.notify_one();
        wait_for_messages(&owner, "providers:auth:error").await;
        assert_eq!(commits.load(Ordering::SeqCst), 0);
        let errors: Vec<ProviderAuthErrorDto> = messages(&owner, "providers:auth:error");
        assert_eq!(errors[0].code, "timed_out");
    }

    #[tokio::test]
    async fn late_provider_callbacks_unwind_through_cleanup_before_the_session_is_released() {
        let (continue_tx, continue_rx) = oneshot::channel::<()>();
        let continue_tx_slot = sender_slot(continue_tx);
        let continue_rx = receiver_slot(continue_rx);
        let cleanup_calls = Arc::new(AtomicU64::new(0));
        let cleanup_for_login = cleanup_calls.clone();
        let opened = Arc::new(Mutex::new(Vec::<String>::new()));
        let coordinator = make_coordinator(MakeOptions {
            opened: opened.clone(),
            login: Arc::new(move |interaction| {
                let continue_rx = continue_rx.clone();
                let cleanup_calls = cleanup_for_login.clone();
                async move {
                    let _ = take_receiver(&continue_rx).await;
                    let _ = interaction.notify(AuthEvent::AuthUrl {
                        url: "https://auth.openai.com/oauth/authorize?state=late".to_string(),
                        instructions: None,
                    });
                    let prompt_result = interaction
                        .prompt(
                            AuthPrompt::ManualCode {
                                message: "Paste redirect URL".to_string(),
                                placeholder: None,
                            },
                            None,
                        )
                        .await;
                    cleanup_calls.fetch_add(1, Ordering::SeqCst);
                    prompt_result?;
                    Ok(json!({}))
                }
                .boxed()
            }),
            ..Default::default()
        });
        let owner = Arc::new(FakeOwner::new(1));
        coordinator
            .start(owner.clone(), request(FLOW_A))
            .expect("start");
        tokio::task::yield_now().await;
        coordinator.cancel(owner.clone(), &request(FLOW_A)).unwrap();
        assert!(messages::<Value>(&owner, "providers:auth:done").is_empty());
        let err = coordinator
            .start(Arc::new(FakeOwner::new(2)), request(FLOW_B))
            .unwrap_err();
        assert!(err
            .0
            .contains("Another ChatGPT sign-in is already in progress"));

        send_value(&continue_tx_slot, ());
        wait_for(|| cleanup_calls.load(Ordering::SeqCst) >= 1).await;
        assert_eq!(cleanup_calls.load(Ordering::SeqCst), 1);
        wait_for_messages(&owner, "providers:auth:done").await;
        assert!(opened.lock().unwrap().is_empty());
        assert!(messages::<Value>(&owner, "providers:auth:event").is_empty());
    }

    #[tokio::test]
    async fn credential_commit_is_a_point_of_no_return_and_cannot_emit_a_false_cancellation() {
        let commit_started = Arc::new(AtomicBool::new(false));
        let commit_started_for_fn = commit_started.clone();
        let (finish_tx, finish_rx) = oneshot::channel::<()>();
        let finish_tx_slot = sender_slot(finish_tx);
        let finish_rx = receiver_slot(finish_rx);
        let configured = Arc::new(AtomicBool::new(false));
        let configured_snapshot = configured.clone();
        let configured_commit = configured.clone();
        let custom_backend = {
            FakeBackend {
                snapshot_fn: Arc::new(move || {
                    snapshot_value(configured_snapshot.load(Ordering::SeqCst))
                }),
                authenticate_fn: Arc::new(|_interaction| {
                    async { Ok(json!({ "token": "main-process-only" })) }.boxed()
                }),
                commit_fn: Arc::new(move |_credential| {
                    let commit_started = commit_started_for_fn.clone();
                    let finish_rx = finish_rx.clone();
                    let configured = configured_commit.clone();
                    async move {
                        commit_started.store(true, Ordering::SeqCst);
                        let _ = take_receiver(&finish_rx).await;
                        configured.store(true, Ordering::SeqCst);
                        Ok(())
                    }
                    .boxed()
                }),
                logout_fn: Arc::new(|| async { Ok(()) }.boxed()),
            }
        };
        let custom_backend = Arc::new(custom_backend);
        let coordinator = ProviderAuthFlowCoordinator::new(ProviderAuthFlowDependencies {
            backend_for: Arc::new(move |_provider_id, _auth_type| custom_backend.clone()),
            open_external: Arc::new(|_| async { Ok(()) }.boxed()),
            flow_timeout_ms: Some(10),
            create_id: Some(ids(&[PROMPT_A])),
            ..Default::default()
        });
        let owner = Arc::new(FakeOwner::new(1));
        coordinator
            .start(owner.clone(), request(FLOW_A))
            .expect("start");
        wait_for(|| commit_started.load(Ordering::SeqCst)).await;
        tokio::time::sleep(Duration::from_millis(20)).await;

        assert!(matches!(
            coordinator.cancel(owner.clone(), &request(FLOW_A)).unwrap(),
            ProviderAuthCancelOutcome::Finishing
        ));
        send_value(&finish_tx_slot, ());
        wait_for_messages(&owner, "providers:auth:done").await;
        assert_eq!(
            messages::<ProviderAuthDoneDto>(&owner, "providers:auth:done"),
            vec![done_dto(FLOW_A, false)]
        );
        assert!(messages::<Value>(&owner, "providers:auth:error").is_empty());
        let status = coordinator.status(PROVIDER_ID).await.unwrap();
        assert_eq!(status["configured"].as_bool(), Some(true));
    }

    #[tokio::test]
    async fn per_prompt_abort_clears_the_prompt_without_cancelling_a_successful_flow() {
        let owner = Arc::new(FakeOwner::new(1));
        let coordinator = make_coordinator(MakeOptions {
            login: Arc::new(|interaction| {
                async move {
                    let prompt_abort = AbortSignal::new();
                    let pending = interaction.prompt(
                        AuthPrompt::ManualCode {
                            message: "Paste a callback URL".to_string(),
                            placeholder: None,
                        },
                        Some(Arc::new(prompt_abort.clone())),
                    );
                    tokio::task::yield_now().await;
                    prompt_abort.abort();
                    let result = pending.await;
                    assert_eq!(result.as_ref().unwrap_err().name, "AbortError");
                    Ok(json!({}))
                }
                .boxed()
            }),
            ..Default::default()
        });
        coordinator
            .start(owner.clone(), request(FLOW_A))
            .expect("start");
        wait_for_messages(&owner, "providers:auth:done").await;
        assert_eq!(
            messages::<ProviderAuthDoneDto>(&owner, "providers:auth:done"),
            vec![done_dto(FLOW_A, false)]
        );
    }

    #[tokio::test]
    async fn only_one_login_flow_may_run_at_once() {
        let owner = Arc::new(FakeOwner::new(1));
        let other = Arc::new(FakeOwner::new(2));
        let coordinator = make_coordinator(MakeOptions {
            login: Arc::new(|interaction| {
                async move {
                    interaction
                        .prompt(
                            AuthPrompt::Text {
                                message: "Wait".to_string(),
                                placeholder: None,
                            },
                            None,
                        )
                        .await?;
                    Ok(json!({}))
                }
                .boxed()
            }),
            ..Default::default()
        });
        coordinator
            .start(owner.clone(), request(FLOW_A))
            .expect("start");
        let err = coordinator
            .start(other.clone(), request(FLOW_B))
            .unwrap_err();
        assert!(err
            .0
            .contains("Another ChatGPT sign-in is already in progress"));
        coordinator.cancel(owner.clone(), &request(FLOW_A)).unwrap();
        wait_for_messages(&owner, "providers:auth:done").await;
    }

    #[tokio::test]
    async fn status_and_logout_expose_only_the_provider_snapshot() {
        let coordinator = make_coordinator(MakeOptions::default());
        let status = coordinator.status(PROVIDER_ID).await.unwrap();
        assert_eq!(status["configured"].as_bool(), Some(false));

        let owner = Arc::new(FakeOwner::new(1));
        coordinator
            .start(owner.clone(), request(FLOW_A))
            .expect("start");
        wait_for_messages(&owner, "providers:auth:done").await;
        let status = coordinator.status(PROVIDER_ID).await.unwrap();
        assert_eq!(status["configured"].as_bool(), Some(true));
        let logout = coordinator.logout(PROVIDER_ID).await.unwrap();
        assert_eq!(logout["configured"].as_bool(), Some(false));
    }

    #[tokio::test]
    async fn raw_provider_errors_and_token_like_text_never_cross_ipc_or_diagnostics() {
        let sentinel = "eyJhbGciOiJub25lIn0.super-secret-token.signature";
        let diagnostics = Arc::new(Mutex::new(Vec::new()));
        let owner = Arc::new(FakeOwner::new(1));
        let coordinator = make_coordinator(MakeOptions {
            diagnostics: diagnostics.clone(),
            login: Arc::new(move |_interaction| {
                let sentinel = sentinel.to_string();
                async move {
                    Err(AuthError::new(
                        "Error",
                        format!("token exchange rejected access_token={sentinel}"),
                    ))
                }
                .boxed()
            }),
            ..Default::default()
        });
        coordinator
            .start(owner.clone(), request(FLOW_A))
            .expect("start");
        wait_for_messages(&owner, "providers:auth:error").await;

        let sent_json = serde_json::to_string(&*owner.sent.lock().unwrap()).unwrap();
        assert!(!sent_json.contains(sentinel));
        let diag_json = serde_json::to_string(&*diagnostics.lock().unwrap()).unwrap();
        assert!(!diag_json.contains(sentinel));
        assert_eq!(
            *diagnostics.lock().unwrap(),
            vec![ProviderAuthDiagnostic {
                operation: "login",
                provider_id: PROVIDER_ID.to_string(),
                error_name: "Error".to_string(),
                error_code: None,
            }]
        );
    }

    #[tokio::test]
    async fn provider_display_text_and_option_ids_are_replaced_with_structured_app_owned_copy() {
        let sentinel = "eyJhbGciOiJub25lIn0.super-secret-token.signature";
        let owner = Arc::new(FakeOwner::new(1));
        let coordinator = make_coordinator(MakeOptions {
            login: Arc::new(move |interaction| {
                let sentinel = sentinel.to_string();
                async move {
                    interaction.notify(AuthEvent::Info {
                        message: format!("Bearer {sentinel}"),
                        links: Some(vec![AuthLink {
                            url: format!("https://auth.openai.com/help?client_secret={sentinel}"),
                            label: Some(format!("api_key={sentinel}")),
                        }]),
                    })?;
                    let _ = interaction
                        .prompt(
                            AuthPrompt::Select {
                                message: format!("token={sentinel}"),
                                options: vec![AuthSelectOption {
                                    id: format!("client_secret={sentinel}"),
                                    label: "sk-provider-secret-value".to_string(),
                                    description: Some(format!("Bearer abc+/def== {sentinel}")),
                                }],
                            },
                            None,
                        )
                        .await?;
                    Ok(json!({}))
                }
                .boxed()
            }),
            ..Default::default()
        });
        coordinator
            .start(owner.clone(), request(FLOW_A))
            .expect("start");
        wait_for_messages(&owner, "providers:auth:prompt").await;

        let sent_json = serde_json::to_string(&*owner.sent.lock().unwrap()).unwrap();
        assert!(!sent_json.contains(sentinel));
        assert!(!sent_json.contains("sk-provider-secret-value"));
        assert_eq!(
            messages::<ProviderAuthEventDto>(&owner, "providers:auth:event"),
            vec![ProviderAuthEventDto::Info {
                flow_id: FLOW_A.to_string(),
                provider_id: PROVIDER_ID.to_string(),
                message: "OpenAI provided an update during sign-in.".to_string(),
                links: None,
            }]
        );
        let prompt: ProviderAuthPromptDto =
            messages::<ProviderAuthPromptDto>(&owner, "providers:auth:prompt")[0].clone();
        assert_eq!(
            prompt.options,
            Some(vec![ProviderAuthSelectOptionDto {
                id: "option-1".to_string(),
                label: "Sign-in option 1".to_string(),
                description: None,
            }])
        );
        coordinator.cancel(owner.clone(), &request(FLOW_A)).unwrap();
        wait_for_messages(&owner, "providers:auth:done").await;
    }

    #[tokio::test]
    async fn known_provider_failures_map_to_actionable_sanitized_error_codes() {
        let cases: Vec<(AuthError, &str)> = vec![
            (
                AuthError::with_code(
                    "Error",
                    "listen EADDRINUSE: address already in use 127.0.0.1:1455",
                    "EADDRINUSE",
                ),
                "port_busy",
            ),
            (
                AuthError::new("Error", "HTTP 429: rate limit exceeded"),
                "rate_limited",
            ),
            (
                AuthError::new("Error", "State mismatch: sentinel-secret"),
                "verification_failed",
            ),
        ];
        for (failure, expected_code) in cases {
            let owner = Arc::new(FakeOwner::new(1));
            let coordinator = make_coordinator(MakeOptions {
                login: Arc::new(move |_interaction| {
                    let failure = failure.clone();
                    async move { Err(failure) }.boxed()
                }),
                ..Default::default()
            });
            coordinator
                .start(owner.clone(), request(FLOW_A))
                .expect("start");
            wait_for_messages(&owner, "providers:auth:error").await;
            let error: ProviderAuthErrorDto =
                messages::<ProviderAuthErrorDto>(&owner, "providers:auth:error")[0].clone();
            assert_eq!(error.code, expected_code);
            let sent_json = serde_json::to_string(&*owner.sent.lock().unwrap()).unwrap();
            assert!(!sent_json.contains("sentinel-secret"));
        }
    }

    #[tokio::test]
    async fn pi_device_code_expiry_is_classified_as_a_timeout_with_retry_guidance() {
        let owner = Arc::new(FakeOwner::new(1));
        let coordinator = make_coordinator(MakeOptions {
            login: Arc::new(|_interaction| {
                async { Err(AuthError::new("Error", "Device flow timed out")) }.boxed()
            }),
            ..Default::default()
        });
        coordinator
            .start(owner.clone(), request(FLOW_A))
            .expect("start");
        wait_for_messages(&owner, "providers:auth:error").await;
        let errors: Vec<ProviderAuthErrorDto> = messages(&owner, "providers:auth:error");
        assert_eq!(errors.len(), 1);
        assert_eq!(errors[0].code, "timed_out");
        assert_eq!(
            errors[0].message,
            "ChatGPT sign-in expired. Start a new sign-in attempt to try again."
        );
    }

    #[tokio::test]
    async fn login_cannot_start_while_logout_is_mutating_credentials() {
        let (finish_tx, finish_rx) = oneshot::channel::<()>();
        let finish_tx_slot = sender_slot(finish_tx);
        let finish_rx = receiver_slot(finish_rx);
        let configured = Arc::new(AtomicBool::new(false));
        let configured_snapshot = configured.clone();
        let configured_logout = configured.clone();
        let custom_backend = {
            FakeBackend {
                snapshot_fn: Arc::new(move || {
                    snapshot_value(configured_snapshot.load(Ordering::SeqCst))
                }),
                authenticate_fn: Arc::new(|_interaction| async { Ok(json!({})) }.boxed()),
                commit_fn: Arc::new(|_credential| async { Ok(()) }.boxed()),
                logout_fn: Arc::new(move || {
                    let finish_rx = finish_rx.clone();
                    let configured = configured_logout.clone();
                    async move {
                        let _ = take_receiver(&finish_rx).await;
                        configured.store(false, Ordering::SeqCst);
                        Ok(())
                    }
                    .boxed()
                }),
            }
        };
        let custom_backend = Arc::new(custom_backend);
        let coordinator = ProviderAuthFlowCoordinator::new(ProviderAuthFlowDependencies {
            backend_for: Arc::new(move |_provider_id, _auth_type| custom_backend.clone()),
            open_external: Arc::new(|_| async { Ok(()) }.boxed()),
            ..Default::default()
        });
        let logout = tokio::spawn(coordinator.logout(PROVIDER_ID));
        tokio::task::yield_now().await;
        let err = coordinator
            .start(Arc::new(FakeOwner::new(1)), request(FLOW_A))
            .unwrap_err();
        assert!(err.0.contains("sign-out is still in progress"));
        send_value(&finish_tx_slot, ());
        let _ = logout.await.unwrap();
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn concurrent_starts_atomically_reserve_the_single_session() {
        let barrier = Arc::new(std::sync::Barrier::new(2));
        let custom_backend = backend(Arc::new(|interaction| {
            async move {
                interaction.signal.notified().await;
                Err(AuthError::cancelled())
            }
            .boxed()
        }));
        let coordinator = Arc::new(ProviderAuthFlowCoordinator::new(
            ProviderAuthFlowDependencies {
                backend_for: Arc::new({
                    let barrier = barrier.clone();
                    move |_, _| {
                        barrier.wait();
                        custom_backend.clone()
                    }
                }),
                open_external: Arc::new(|_| async { Ok(()) }.boxed()),
                ..Default::default()
            },
        ));
        let first_owner = Arc::new(FakeOwner::new(1));
        let second_owner = Arc::new(FakeOwner::new(2));
        let first = tokio::task::spawn_blocking({
            let coordinator = coordinator.clone();
            let owner = first_owner.clone();
            move || coordinator.start(owner, request(FLOW_A))
        });
        let second = tokio::task::spawn_blocking({
            let coordinator = coordinator.clone();
            let owner = second_owner.clone();
            move || coordinator.start(owner, request(FLOW_B))
        });
        let first = first.await.unwrap();
        let second = second.await.unwrap();
        assert_eq!(usize::from(first.is_ok()) + usize::from(second.is_ok()), 1);
        let (owner, flow) = if first.is_ok() {
            (first_owner, FLOW_A)
        } else {
            (second_owner, FLOW_B)
        };
        assert_eq!(
            coordinator.cancel(owner.clone(), &request(flow)).unwrap(),
            ProviderAuthCancelOutcome::Cancelled
        );
        wait_for_messages(&owner, "providers:auth:done").await;
    }

    #[tokio::test]
    async fn listener_registration_failure_rolls_back_the_session_reservation() {
        let coordinator = make_coordinator(MakeOptions::default());
        let error = coordinator
            .start(Arc::new(PanickingOwner(FakeOwner::new(1))), request(FLOW_A))
            .unwrap_err();
        assert!(error.0.contains("window is unavailable"));

        let owner = Arc::new(FakeOwner::new(2));
        coordinator.start(owner.clone(), request(FLOW_B)).unwrap();
        wait_for_messages(&owner, "providers:auth:done").await;
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn concurrent_start_and_logout_cannot_both_reserve_the_global_slot() {
        let barrier = Arc::new(std::sync::Barrier::new(2));
        let release_logout = Arc::new(Notify::new());
        let custom_backend = Arc::new(FakeBackend {
            snapshot_fn: Arc::new(|| snapshot_value(false)),
            authenticate_fn: Arc::new(|interaction| {
                async move {
                    interaction.signal.notified().await;
                    Err(AuthError::cancelled())
                }
                .boxed()
            }),
            commit_fn: Arc::new(|_| async { Ok(()) }.boxed()),
            logout_fn: Arc::new({
                let release_logout = release_logout.clone();
                move || {
                    let release_logout = release_logout.clone();
                    async move {
                        release_logout.notified().await;
                        Ok(())
                    }
                    .boxed()
                }
            }),
        });
        let coordinator = Arc::new(ProviderAuthFlowCoordinator::new(
            ProviderAuthFlowDependencies {
                backend_for: Arc::new({
                    let barrier = barrier.clone();
                    move |_, _| {
                        barrier.wait();
                        custom_backend.clone()
                    }
                }),
                open_external: Arc::new(|_| async { Ok(()) }.boxed()),
                ..Default::default()
            },
        ));
        let owner = Arc::new(FakeOwner::new(1));
        let start = tokio::task::spawn_blocking({
            let coordinator = coordinator.clone();
            let owner = owner.clone();
            move || coordinator.start(owner, request(FLOW_A))
        });
        let logout = tokio::spawn({
            let coordinator = coordinator.clone();
            async move { coordinator.logout(PROVIDER_ID).await }
        });
        let start_result = start.await.unwrap();
        if start_result.is_ok() {
            assert!(logout.await.unwrap().is_err());
            coordinator.cancel(owner.clone(), &request(FLOW_A)).unwrap();
            wait_for_messages(&owner, "providers:auth:done").await;
        } else {
            release_logout.notify_one();
            assert!(logout.await.unwrap().is_ok());
        }
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn concurrent_logouts_atomically_reserve_one_operation() {
        let barrier = Arc::new(std::sync::Barrier::new(2));
        let logout_started = Arc::new(AtomicU64::new(0));
        let release_logout = Arc::new(Notify::new());
        let custom_backend = Arc::new(FakeBackend {
            snapshot_fn: Arc::new(|| snapshot_value(false)),
            authenticate_fn: Arc::new(|_| async { Ok(json!({})) }.boxed()),
            commit_fn: Arc::new(|_| async { Ok(()) }.boxed()),
            logout_fn: Arc::new({
                let logout_started = logout_started.clone();
                let release_logout = release_logout.clone();
                move || {
                    let logout_started = logout_started.clone();
                    let release_logout = release_logout.clone();
                    async move {
                        logout_started.fetch_add(1, Ordering::SeqCst);
                        release_logout.notified().await;
                        Ok(())
                    }
                    .boxed()
                }
            }),
        });
        let coordinator = Arc::new(ProviderAuthFlowCoordinator::new(
            ProviderAuthFlowDependencies {
                backend_for: Arc::new({
                    let barrier = barrier.clone();
                    move |_, _| {
                        barrier.wait();
                        custom_backend.clone()
                    }
                }),
                open_external: Arc::new(|_| async { Ok(()) }.boxed()),
                ..Default::default()
            },
        ));
        let handle = tokio::runtime::Handle::current();
        let first = tokio::task::spawn_blocking({
            let coordinator = coordinator.clone();
            let handle = handle.clone();
            move || handle.block_on(coordinator.logout(PROVIDER_ID))
        });
        let second = tokio::task::spawn_blocking({
            let coordinator = coordinator.clone();
            move || handle.block_on(coordinator.logout(PROVIDER_ID))
        });
        tokio::time::timeout(Duration::from_secs(1), async {
            while logout_started.load(Ordering::SeqCst) != 1 {
                tokio::task::yield_now().await;
            }
            while !first.is_finished() && !second.is_finished() {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        let (winner, loser) = if first.is_finished() {
            (second, first)
        } else {
            (first, second)
        };
        assert!(loser.await.unwrap().is_err());
        release_logout.notify_one();
        assert!(winner.await.unwrap().is_ok());
        assert_eq!(logout_started.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn dropping_a_logout_waiter_does_not_release_the_operation() {
        let logout_started = Arc::new(AtomicBool::new(false));
        let release_logout = Arc::new(Notify::new());
        let custom_backend = Arc::new(FakeBackend {
            snapshot_fn: Arc::new(|| snapshot_value(false)),
            authenticate_fn: Arc::new(|_| async { Ok(json!({})) }.boxed()),
            commit_fn: Arc::new(|_| async { Ok(()) }.boxed()),
            logout_fn: Arc::new({
                let logout_started = logout_started.clone();
                let release_logout = release_logout.clone();
                move || {
                    let logout_started = logout_started.clone();
                    let release_logout = release_logout.clone();
                    async move {
                        logout_started.store(true, Ordering::SeqCst);
                        release_logout.notified().await;
                        Ok(())
                    }
                    .boxed()
                }
            }),
        });
        let coordinator = Arc::new(ProviderAuthFlowCoordinator::new(
            ProviderAuthFlowDependencies {
                backend_for: Arc::new(move |_, _| custom_backend.clone()),
                open_external: Arc::new(|_| async { Ok(()) }.boxed()),
                ..Default::default()
            },
        ));
        let logout = tokio::spawn({
            let coordinator = coordinator.clone();
            async move { coordinator.logout(PROVIDER_ID).await }
        });
        wait_for(|| logout_started.load(Ordering::SeqCst)).await;
        logout.abort();
        let error = coordinator
            .start(Arc::new(FakeOwner::new(1)), request(FLOW_A))
            .unwrap_err();
        assert!(error.0.contains("sign-out is still in progress"));
        release_logout.notify_one();
        tokio::time::timeout(Duration::from_secs(1), async {
            while coordinator
                .shared
                .state
                .lock()
                .unwrap()
                .logout_operation
                .is_some()
            {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        let owner = Arc::new(FakeOwner::new(2));
        coordinator.start(owner.clone(), request(FLOW_B)).unwrap();
        wait_for_messages(&owner, "providers:auth:done").await;
    }

    #[tokio::test]
    async fn shutdown_waits_for_an_in_flight_credential_commit_before_resolving() {
        let commit_started = Arc::new(AtomicBool::new(false));
        let commit_started_for_fn = commit_started.clone();
        let (finish_tx, finish_rx) = oneshot::channel::<()>();
        let finish_tx_slot = sender_slot(finish_tx);
        let finish_rx = receiver_slot(finish_rx);
        let committed = Arc::new(AtomicBool::new(false));
        let committed_snapshot = committed.clone();
        let committed_commit = committed.clone();
        let custom_backend = {
            FakeBackend {
                snapshot_fn: Arc::new(move || {
                    snapshot_value(committed_snapshot.load(Ordering::SeqCst))
                }),
                authenticate_fn: Arc::new(|_interaction| {
                    async { Ok(json!({ "token": "main-process-only" })) }.boxed()
                }),
                commit_fn: Arc::new(move |_credential| {
                    let commit_started = commit_started_for_fn.clone();
                    let finish_rx = finish_rx.clone();
                    let committed = committed_commit.clone();
                    async move {
                        commit_started.store(true, Ordering::SeqCst);
                        let _ = take_receiver(&finish_rx).await;
                        committed.store(true, Ordering::SeqCst);
                        Ok(())
                    }
                    .boxed()
                }),
                logout_fn: Arc::new(|| async { Ok(()) }.boxed()),
            }
        };
        let custom_backend = Arc::new(custom_backend);
        let coordinator = ProviderAuthFlowCoordinator::new(ProviderAuthFlowDependencies {
            backend_for: Arc::new(move |_provider_id, _auth_type| custom_backend.clone()),
            open_external: Arc::new(|_| async { Ok(()) }.boxed()),
            ..Default::default()
        });
        let owner = Arc::new(FakeOwner::new(1));
        coordinator
            .start(owner.clone(), request(FLOW_A))
            .expect("start");
        wait_for(|| commit_started.load(Ordering::SeqCst)).await;

        let shutdown = tokio::spawn(coordinator.shutdown());
        tokio::task::yield_now().await;
        assert!(!shutdown.is_finished());
        let err = coordinator
            .start(owner.clone(), request(FLOW_B))
            .unwrap_err();
        assert!(err.0.contains("shutting down"));

        send_value(&finish_tx_slot, ());
        shutdown.await.unwrap();
        assert!(committed.load(Ordering::SeqCst));
        assert!(messages::<Value>(&owner, "providers:auth:done").is_empty());
    }

    #[tokio::test]
    async fn shutdown_waits_for_an_aborted_authentication_backend_to_finish_cleanup() {
        let started = Arc::new(AtomicBool::new(false));
        let started_for_fn = started.clone();
        let (finish_tx, finish_rx) = oneshot::channel::<Value>();
        let finish_tx_slot = sender_slot(finish_tx);
        let finish_rx = receiver_slot(finish_rx);
        let commits = Arc::new(AtomicU64::new(0));
        let custom_backend = {
            let commits = commits.clone();
            FakeBackend {
                snapshot_fn: Arc::new(|| snapshot_value(false)),
                authenticate_fn: Arc::new(move |_interaction| {
                    let started = started_for_fn.clone();
                    let finish_rx = finish_rx.clone();
                    async move {
                        started.store(true, Ordering::SeqCst);
                        match take_receiver(&finish_rx).await {
                            Some(value) => Ok(value),
                            None => Err(AuthError::new("Error", "closed")),
                        }
                    }
                    .boxed()
                }),
                commit_fn: Arc::new(move |_credential| {
                    let commits = commits.clone();
                    async move {
                        commits.fetch_add(1, Ordering::SeqCst);
                        Ok(())
                    }
                    .boxed()
                }),
                logout_fn: Arc::new(|| async { Ok(()) }.boxed()),
            }
        };
        let custom_backend = Arc::new(custom_backend);
        let coordinator = ProviderAuthFlowCoordinator::new(ProviderAuthFlowDependencies {
            backend_for: Arc::new(move |_provider_id, _auth_type| custom_backend.clone()),
            open_external: Arc::new(|_| async { Ok(()) }.boxed()),
            auth_cleanup_timeout_ms: Some(1_000),
            ..Default::default()
        });
        let owner = Arc::new(FakeOwner::new(1));
        coordinator
            .start(owner.clone(), request(FLOW_A))
            .expect("start");
        wait_for(|| started.load(Ordering::SeqCst)).await;

        let shutdown = coordinator.shutdown();
        tokio::task::yield_now().await;

        send_value(&finish_tx_slot, json!({ "late": true }));
        shutdown.await;
        assert_eq!(commits.load(Ordering::SeqCst), 0);
        assert!(messages::<Value>(&owner, "providers:auth:done").is_empty());
    }

    #[tokio::test]
    async fn shutdown_waits_for_an_in_flight_logout_before_resolving() {
        let started = Arc::new(AtomicBool::new(false));
        let started_for_fn = started.clone();
        let (finish_tx, finish_rx) = oneshot::channel::<()>();
        let finish_tx_slot = sender_slot(finish_tx);
        let finish_rx = receiver_slot(finish_rx);
        let custom_backend = {
            let finish_rx = finish_rx.clone();
            FakeBackend {
                snapshot_fn: Arc::new(|| snapshot_value(false)),
                authenticate_fn: Arc::new(|_interaction| async { Ok(json!({})) }.boxed()),
                commit_fn: Arc::new(|_credential| async { Ok(()) }.boxed()),
                logout_fn: Arc::new(move || {
                    let started = started_for_fn.clone();
                    let finish_rx = finish_rx.clone();
                    async move {
                        started.store(true, Ordering::SeqCst);
                        let _ = take_receiver(&finish_rx).await;
                        Ok(())
                    }
                    .boxed()
                }),
            }
        };
        let custom_backend = Arc::new(custom_backend);
        let coordinator = ProviderAuthFlowCoordinator::new(ProviderAuthFlowDependencies {
            backend_for: Arc::new(move |_provider_id, _auth_type| custom_backend.clone()),
            open_external: Arc::new(|_| async { Ok(()) }.boxed()),
            ..Default::default()
        });
        let logout = tokio::spawn(coordinator.logout(PROVIDER_ID));
        wait_for(|| started.load(Ordering::SeqCst)).await;

        let shutdown = coordinator.shutdown();
        tokio::task::yield_now().await;

        send_value(&finish_tx_slot, ());
        let _ = logout.await.unwrap();
        shutdown.await;
    }

    #[test]
    fn ipc_request_parsers_reject_malformed_ids_excess_fields_and_oversized_input() {
        let err = parse_provider_auth_start_request(&json!({
            "flowId": "guessable",
            "providerId": PROVIDER_ID,
        }))
        .unwrap_err();
        assert!(err.0.contains("flow ID is invalid"));

        let mut extra = serde_json::Map::new();
        extra.insert("flowId".into(), Value::String(FLOW_A.into()));
        extra.insert("providerId".into(), Value::String(PROVIDER_ID.into()));
        extra.insert("authType".into(), Value::String("oauth".into()));
        extra.insert("extra".into(), Value::Bool(true));
        let err = parse_provider_auth_start_request(&Value::Object(extra)).unwrap_err();
        assert!(err.0.contains("invalid shape"));

        let err = parse_provider_auth_response_request(&json!({
            "flowId": FLOW_A,
            "providerId": PROVIDER_ID,
            "promptId": PROMPT_A,
            "value": "x".repeat(8_193),
        }))
        .unwrap_err();
        assert!(err.0.contains("response is invalid"));
    }
}
