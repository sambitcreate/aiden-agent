//! Apple Foundation Models helper client (port of
//! `main/services/foundation-models-connection.ts` +
//! `foundation-models-connection-core.ts`).
//!
//! The Swift helper app (`native/apple-foundation-models`) exchanges JSON via
//! files: a `request.json` in, a `response.json` out, a `process-id` file the
//! host can signal, and a `cancelled` marker, all under a private
//! `aiden-foundation-models-*` tempdir. This module replicates that protocol
//! exactly on the Rust side; the Swift helper itself is untouched.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

use aiden_core::chat_title::{FoundationModelsConnectionState, FoundationModelsConnectionStatus};
use futures::future::BoxFuture;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tokio_util::sync::CancellationToken;

pub type FoundationModelsCancellationToken = CancellationToken;

pub const FOUNDATION_MODELS_PROTOCOL_VERSION: i64 = 1;
const STATUS_TIMEOUT_MS: u64 = 5_000;
const GENERATION_TIMEOUT_MS: u64 = 15_000;
const STABLE_STATUS_TTL_MS: u64 = 30_000;
const PREPARING_STATUS_TTL_MS: u64 = 5_000;
const MAX_REQUEST_BYTES: usize = 20_000;
const MAX_RESPONSE_BYTES: u64 = 64 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum NativeFoundationModelsMethod {
    Availability,
    GenerateTitle,
}

impl NativeFoundationModelsMethod {
    pub fn as_str(self) -> &'static str {
        match self {
            NativeFoundationModelsMethod::Availability => "availability",
            NativeFoundationModelsMethod::GenerateTitle => "generateTitle",
        }
    }
}

/// The exact `request.json` shape (`FoundationModelsRequest` in Protocol.swift).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct NativeFoundationModelsRequest {
    pub version: i64,
    pub method: NativeFoundationModelsMethod,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub prompt: Option<String>,
}

impl NativeFoundationModelsRequest {
    pub fn availability() -> Self {
        Self {
            version: FOUNDATION_MODELS_PROTOCOL_VERSION,
            method: NativeFoundationModelsMethod::Availability,
            prompt: None,
        }
    }

    pub fn generate_title(prompt: impl Into<String>) -> Self {
        Self {
            version: FOUNDATION_MODELS_PROTOCOL_VERSION,
            method: NativeFoundationModelsMethod::GenerateTitle,
            prompt: Some(prompt.into()),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FoundationModelsState {
    Ready,
    DeviceNotEligible,
    AppleIntelligenceDisabled,
    ModelPreparing,
    Unavailable,
}

impl FoundationModelsState {
    pub fn as_str(self) -> &'static str {
        match self {
            FoundationModelsState::Ready => "ready",
            FoundationModelsState::DeviceNotEligible => "device_not_eligible",
            FoundationModelsState::AppleIntelligenceDisabled => "apple_intelligence_disabled",
            FoundationModelsState::ModelPreparing => "model_preparing",
            FoundationModelsState::Unavailable => "unavailable",
        }
    }
}

/// The `FoundationModelsResult` from Protocol.swift.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct FoundationModelsResult {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub state: Option<FoundationModelsState>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct NativeFoundationModelsError {
    pub code: String,
    pub message: String,
    pub retryable: bool,
}

/// The exact `response.json` shape (`FoundationModelsResponse`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct FoundationModelsResponse {
    pub version: i64,
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub result: Option<FoundationModelsResult>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<NativeFoundationModelsError>,
}

impl FoundationModelsResponse {
    pub fn success(state: Option<FoundationModelsState>, title: Option<String>) -> Self {
        Self {
            version: FOUNDATION_MODELS_PROTOCOL_VERSION,
            ok: true,
            result: Some(FoundationModelsResult { state, title }),
            error: None,
        }
    }
}

#[derive(Debug, Clone)]
pub struct NativeFoundationModelsRunOptions {
    pub timeout_ms: u64,
    pub signal: Option<CancellationToken>,
}

/// Error taxonomy mirroring `FoundationModelsConnectionError`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FoundationModelsConnectionError {
    pub code: String,
    pub message: String,
    pub retryable: bool,
}

impl FoundationModelsConnectionError {
    pub fn new(code: impl Into<String>, message: impl Into<String>) -> Self {
        Self {
            code: code.into(),
            message: message.into(),
            retryable: false,
        }
    }

    pub fn retryable(code: impl Into<String>, message: impl Into<String>) -> Self {
        Self {
            code: code.into(),
            message: message.into(),
            retryable: true,
        }
    }
}

impl std::fmt::Display for FoundationModelsConnectionError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            formatter,
            "foundation models error {}: {}",
            self.code, self.message
        )
    }
}

impl std::error::Error for FoundationModelsConnectionError {}

fn connection_status(
    state: FoundationModelsConnectionState,
    detail: &str,
    retryable: bool,
) -> FoundationModelsConnectionStatus {
    FoundationModelsConnectionStatus {
        id: "apple-foundation-models".into(),
        label: "Apple Foundation Models".into(),
        state,
        detail: detail.to_string(),
        local: true,
        title_only: true,
        retryable,
    }
}

fn system_version_major(value: &str) -> Option<u64> {
    let mut digits = String::new();
    for character in value.trim().chars() {
        if character.is_ascii_digit() {
            digits.push(character);
        } else {
            break;
        }
    }
    digits.parse().ok()
}

fn connection_state_as_str(state: FoundationModelsConnectionState) -> &'static str {
    match state {
        FoundationModelsConnectionState::Ready => "ready",
        FoundationModelsConnectionState::UnsupportedOs => "unsupported_os",
        FoundationModelsConnectionState::DeviceNotEligible => "device_not_eligible",
        FoundationModelsConnectionState::AppleIntelligenceDisabled => "apple_intelligence_disabled",
        FoundationModelsConnectionState::ModelPreparing => "model_preparing",
        FoundationModelsConnectionState::HelperUnavailable => "helper_unavailable",
        FoundationModelsConnectionState::Unavailable => "unavailable",
        FoundationModelsConnectionState::Error => "error",
    }
}

/// The platform gate: `null` (not applicable), a fixed status (blocked), or
/// `undefined` (proceed to the helper).
#[derive(Debug, Clone, PartialEq)]
pub enum PlatformGate {
    NotApplicable,
    Blocked(FoundationModelsConnectionStatus),
    Proceed,
}

pub fn platform_foundation_models_status(
    platform: &str,
    arch: &str,
    system_version: &str,
) -> PlatformGate {
    if platform != "darwin" {
        return PlatformGate::NotApplicable;
    }
    let major = system_version_major(system_version);
    if major.is_none() || major.unwrap_or(0) < 26 {
        return PlatformGate::Blocked(connection_status(
            FoundationModelsConnectionState::UnsupportedOs,
            "Apple Foundation Models require macOS 26 or later.",
            false,
        ));
    }
    if arch != "arm64" {
        return PlatformGate::Blocked(connection_status(
            FoundationModelsConnectionState::DeviceNotEligible,
            "Apple Foundation Models require an Apple Intelligence-capable Mac.",
            false,
        ));
    }
    PlatformGate::Proceed
}

fn map_native_availability(
    state: Option<FoundationModelsState>,
) -> FoundationModelsConnectionStatus {
    match state {
        Some(FoundationModelsState::Ready) => connection_status(
            FoundationModelsConnectionState::Ready,
            "Ready to create chat titles on this Mac.",
            false,
        ),
        Some(FoundationModelsState::DeviceNotEligible) => connection_status(
            FoundationModelsConnectionState::DeviceNotEligible,
            "This Mac does not support Apple Intelligence.",
            false,
        ),
        Some(FoundationModelsState::AppleIntelligenceDisabled) => connection_status(
            FoundationModelsConnectionState::AppleIntelligenceDisabled,
            "Turn on Apple Intelligence in System Settings to use on-device titles.",
            false,
        ),
        Some(FoundationModelsState::ModelPreparing) => connection_status(
            FoundationModelsConnectionState::ModelPreparing,
            "The on-device model is still downloading or preparing.",
            true,
        ),
        Some(FoundationModelsState::Unavailable) | None => connection_status(
            FoundationModelsConnectionState::Unavailable,
            "Apple Foundation Models are unavailable.",
            false,
        ),
    }
}

/// Parse and strictly validate a helper `response.json` payload.
pub fn parse_foundation_models_response(
    value: &str,
) -> Result<FoundationModelsResponse, FoundationModelsConnectionError> {
    let parsed: Value = serde_json::from_str(value).map_err(|_| {
        FoundationModelsConnectionError::new(
            "invalid_response",
            "The native helper returned invalid JSON.",
        )
    })?;
    if !parsed.is_object() {
        return Err(FoundationModelsConnectionError::new(
            "invalid_response",
            "The native helper returned an invalid response.",
        ));
    }
    let response = parsed.as_object().expect("checked");
    if response.get("version").and_then(Value::as_i64) != Some(FOUNDATION_MODELS_PROTOCOL_VERSION)
        || !response.get("ok").is_some_and(Value::is_boolean)
    {
        return Err(FoundationModelsConnectionError::new(
            "invalid_response",
            "The native helper protocol did not match this version of Aiden.",
        ));
    }
    let ok = response.get("ok").and_then(Value::as_bool).unwrap_or(false);
    if ok {
        let result = response
            .get("result")
            .and_then(Value::as_object)
            .ok_or_else(|| {
                FoundationModelsConnectionError::new(
                    "invalid_response",
                    "The native helper returned no result.",
                )
            })?;
        let valid_states = [
            "ready",
            "device_not_eligible",
            "apple_intelligence_disabled",
            "model_preparing",
            "unavailable",
        ];
        if let Some(state) = result.get("state") {
            if !state.is_string() || !valid_states.contains(&state.as_str().unwrap_or_default()) {
                return Err(FoundationModelsConnectionError::new(
                    "invalid_response",
                    "The native helper returned an invalid availability state.",
                ));
            }
        }
        if let Some(title) = result.get("title") {
            if !title.is_string() {
                return Err(FoundationModelsConnectionError::new(
                    "invalid_response",
                    "The native helper returned an invalid title.",
                ));
            }
        }
        if result.get("state").is_none() && result.get("title").is_none() {
            return Err(FoundationModelsConnectionError::new(
                "invalid_response",
                "The native helper returned an empty result.",
            ));
        }
    } else {
        let error = response
            .get("error")
            .and_then(Value::as_object)
            .ok_or_else(|| {
                FoundationModelsConnectionError::new(
                    "invalid_response",
                    "The native helper returned no error details.",
                )
            })?;
        let valid = error.get("code").is_some_and(Value::is_string)
            && error.get("message").is_some_and(Value::is_string)
            && error.get("retryable").is_some_and(Value::is_boolean);
        if !valid {
            return Err(FoundationModelsConnectionError::new(
                "invalid_response",
                "The native helper returned invalid error details.",
            ));
        }
    }
    serde_json::from_value(parsed).map_err(|_| {
        FoundationModelsConnectionError::new(
            "invalid_response",
            "The native helper returned an invalid response.",
        )
    })
}

// ===========================================================================
// Connection state machine (foundation-models-connection-core.ts)
// ===========================================================================

pub type NativeFoundationModelsRequestRunner = Arc<
    dyn Fn(
            NativeFoundationModelsRequest,
            NativeFoundationModelsRunOptions,
        )
            -> BoxFuture<'static, Result<FoundationModelsResponse, FoundationModelsConnectionError>>
        + Send
        + Sync,
>;

/// A completed or in-flight status read shared between concurrent callers.
struct InFlightFm {
    result: std::sync::Mutex<Option<Option<FoundationModelsConnectionStatus>>>,
    completion: tokio::sync::Notify,
}

struct CachedFmStatus {
    value: Option<FoundationModelsConnectionStatus>,
    expires_at: u64,
}

/// The connection factory from `createFoundationModelsConnection`.
pub struct FoundationModelsConnection {
    platform: String,
    arch: String,
    system_version: String,
    now: Arc<dyn Fn() -> u64 + Send + Sync>,
    run_request: NativeFoundationModelsRequestRunner,
    cached: std::sync::Mutex<Option<CachedFmStatus>>,
    in_flight: tokio::sync::Mutex<Option<Arc<InFlightFm>>>,
    lifecycle: CancellationToken,
    disposed: AtomicBool,
}

impl FoundationModelsConnection {
    pub fn new(
        platform: impl Into<String>,
        arch: impl Into<String>,
        system_version: impl Into<String>,
        now: Arc<dyn Fn() -> u64 + Send + Sync>,
        run_request: NativeFoundationModelsRequestRunner,
    ) -> Self {
        Self {
            platform: platform.into(),
            arch: arch.into(),
            system_version: system_version.into(),
            now,
            run_request,
            cached: std::sync::Mutex::new(None),
            in_flight: tokio::sync::Mutex::new(None),
            lifecycle: CancellationToken::new(),
            disposed: AtomicBool::new(false),
        }
    }

    fn platform_gate(&self) -> PlatformGate {
        platform_foundation_models_status(&self.platform, &self.arch, &self.system_version)
    }

    async fn load_status(&self) -> Option<FoundationModelsConnectionStatus> {
        if self.disposed.load(Ordering::SeqCst) {
            return None;
        }
        match self.platform_gate() {
            PlatformGate::NotApplicable => return None,
            PlatformGate::Blocked(status) => return Some(status),
            PlatformGate::Proceed => {}
        }
        let response = match (self.run_request)(
            NativeFoundationModelsRequest::availability(),
            NativeFoundationModelsRunOptions {
                timeout_ms: STATUS_TIMEOUT_MS,
                signal: Some(self.lifecycle.child_token()),
            },
        )
        .await
        {
            Ok(response) => response,
            Err(error) => {
                return Some(connection_status(
                    if error.code == "helper_missing" {
                        FoundationModelsConnectionState::HelperUnavailable
                    } else {
                        FoundationModelsConnectionState::Error
                    },
                    if error.code == "helper_missing" {
                        "The native helper is not included in this build."
                    } else {
                        "Apple Foundation Models could not be checked."
                    },
                    error.retryable,
                ))
            }
        };
        if !response.ok {
            return Some(connection_status(
                FoundationModelsConnectionState::Error,
                response
                    .error
                    .as_ref()
                    .map(|error| error.message.as_str())
                    .unwrap_or("Apple Foundation Models could not be checked."),
                response
                    .error
                    .as_ref()
                    .map(|error| error.retryable)
                    .unwrap_or(false),
            ));
        }
        Some(map_native_availability(
            response.result.and_then(|result| result.state),
        ))
    }

    /// Read the connection status with a short cache and single-flight dedup.
    pub async fn status(&self, force: bool) -> Option<FoundationModelsConnectionStatus> {
        if self.disposed.load(Ordering::SeqCst) {
            return None;
        }
        match self.platform_gate() {
            PlatformGate::NotApplicable => return None,
            PlatformGate::Blocked(status) => return Some(status),
            PlatformGate::Proceed => {}
        }
        if !force {
            if let Some(cached) = self.cached.lock().unwrap().as_ref() {
                if (self.now)() < cached.expires_at {
                    return cached.value.clone();
                }
            }
        }
        if let Some(existing) = self.in_flight.lock().await.clone() {
            return self.await_in_flight(&existing).await;
        }
        let in_flight = Arc::new(InFlightFm {
            result: std::sync::Mutex::new(None),
            completion: tokio::sync::Notify::new(),
        });
        {
            let mut slot = self.in_flight.lock().await;
            if let Some(existing) = slot.as_ref() {
                return self.await_in_flight(existing).await;
            }
            *slot = Some(Arc::clone(&in_flight));
        }
        let value = self.load_status().await;
        let ttl = if value
            .as_ref()
            .map(|status| {
                status.state == FoundationModelsConnectionState::ModelPreparing || status.retryable
            })
            .unwrap_or(false)
        {
            PREPARING_STATUS_TTL_MS
        } else {
            STABLE_STATUS_TTL_MS
        };
        *self.cached.lock().unwrap() = Some(CachedFmStatus {
            value: value.clone(),
            expires_at: (self.now)() + ttl,
        });
        *in_flight.result.lock().unwrap() = Some(value.clone());
        in_flight.completion.notify_waiters();
        {
            let mut slot = self.in_flight.lock().await;
            if slot
                .as_ref()
                .map(|existing| Arc::ptr_eq(existing, &in_flight))
                .unwrap_or(false)
            {
                *slot = None;
            }
        }
        value
    }

    async fn await_in_flight(
        &self,
        existing: &Arc<InFlightFm>,
    ) -> Option<FoundationModelsConnectionStatus> {
        loop {
            if let Some(value) = existing.result.lock().unwrap().clone() {
                return value;
            }
            existing.completion.notified().await;
        }
    }

    /// Generate an on-device title with a bounded helper run.
    pub async fn generate_title(
        &self,
        prompt: &str,
        signal: Option<&CancellationToken>,
    ) -> Result<String, FoundationModelsConnectionError> {
        if self.disposed.load(Ordering::SeqCst) {
            return Err(FoundationModelsConnectionError::new(
                "cancelled",
                "Title generation was cancelled.",
            ));
        }
        match self.platform_gate() {
            PlatformGate::NotApplicable => {
                return Err(FoundationModelsConnectionError::new(
                    "unsupported_platform",
                    "Apple Foundation Models are available only on macOS.",
                ))
            }
            PlatformGate::Blocked(status) => {
                return Err(FoundationModelsConnectionError::new(
                    connection_state_as_str(status.state),
                    status.detail,
                ))
            }
            PlatformGate::Proceed => {}
        }
        let request_signal = self.lifecycle.child_token();
        let request = (self.run_request)(
            NativeFoundationModelsRequest::generate_title(prompt),
            NativeFoundationModelsRunOptions {
                timeout_ms: GENERATION_TIMEOUT_MS,
                signal: Some(request_signal.clone()),
            },
        );
        tokio::pin!(request);
        let response = match signal {
            Some(signal) => tokio::select! {
                response = &mut request => response,
                () = signal.cancelled() => {
                    request_signal.cancel();
                    request.await
                }
            },
            None => request.await,
        };
        let response = match response {
            Ok(response) => response,
            Err(error) => {
                if error.code != "cancelled" {
                    *self.cached.lock().unwrap() = Some(CachedFmStatus {
                        value: Some(connection_status(
                            FoundationModelsConnectionState::Error,
                            "Apple Foundation Models could not generate a title.",
                            error.retryable,
                        )),
                        expires_at: (self.now)() + PREPARING_STATUS_TTL_MS,
                    });
                }
                return Err(error);
            }
        };
        if !response.ok {
            let error = response.error.unwrap_or(NativeFoundationModelsError {
                code: "generation_failed".into(),
                message: "Apple Foundation Models could not generate a title.".into(),
                retryable: false,
            });
            if error.code == "model_unavailable" || error.code == "assets_unavailable" {
                *self.cached.lock().unwrap() = Some(CachedFmStatus {
                    value: Some(connection_status(
                        FoundationModelsConnectionState::Unavailable,
                        &error.message,
                        error.retryable,
                    )),
                    expires_at: (self.now)() + PREPARING_STATUS_TTL_MS,
                });
            }
            return Err(FoundationModelsConnectionError {
                code: error.code,
                message: error.message,
                retryable: error.retryable,
            });
        }
        let title = response
            .result
            .and_then(|result| result.title)
            .map(|title| title.trim().to_string())
            .unwrap_or_default();
        if title.is_empty() {
            return Err(FoundationModelsConnectionError::new(
                "invalid_response",
                "Apple Foundation Models returned an empty title.",
            ));
        }
        Ok(title)
    }

    pub fn clear_status(&self) {
        *self.cached.lock().unwrap() = None;
    }

    /// Cancels every connection-owned request and synchronously asks all
    /// trusted helper children spawned by this process to terminate.
    pub fn dispose(&self) {
        self.disposed.store(true, Ordering::SeqCst);
        self.lifecycle.cancel();
        terminate_active_foundation_helpers();
    }
}

/// The connection factory mirroring `createFoundationModelsConnection`.
pub fn create_foundation_models_connection(
    platform: impl Into<String>,
    arch: impl Into<String>,
    system_version: impl Into<String>,
    now: Arc<dyn Fn() -> u64 + Send + Sync>,
    run_request: NativeFoundationModelsRequestRunner,
) -> FoundationModelsConnection {
    FoundationModelsConnection::new(platform, arch, system_version, now, run_request)
}

// ===========================================================================
// Helper runner (foundation-models-connection.ts): the file exchange.
// ===========================================================================

const FORCED_FINISH_MS: u64 = 2_000;
const MAX_HELPER_STDOUT_BYTES: u64 = 64 * 1024;
const MAX_HELPER_STDERR_BYTES: u64 = 8 * 1024;
#[derive(Clone)]
struct HelperTermination {
    active: Arc<Mutex<bool>>,
    terminate: Arc<dyn Fn() + Send + Sync>,
}

impl HelperTermination {
    fn new(terminate: Arc<dyn Fn() + Send + Sync>) -> Self {
        Self {
            active: Arc::new(Mutex::new(true)),
            terminate,
        }
    }

    fn run(&self) {
        // Hold the same guard used by `deactivate` through the callback. Once
        // unregister returns, a callback cloned by a concurrent dispose has
        // therefore either completed or observed the inactive state; it can
        // never signal a PID after waitpid has made that number reusable.
        if let Ok(active) = self.active.lock() {
            if *active {
                (self.terminate)();
            }
        }
    }

    fn deactivate(&self) {
        if let Ok(mut active) = self.active.lock() {
            *active = false;
        }
    }
}

fn active_helper_terminations() -> &'static Mutex<HashMap<u64, HelperTermination>> {
    static ACTIVE: OnceLock<Mutex<HashMap<u64, HelperTermination>>> = OnceLock::new();
    ACTIVE.get_or_init(|| Mutex::new(HashMap::new()))
}

fn register_helper_termination(termination: Arc<dyn Fn() + Send + Sync>) -> u64 {
    static NEXT_ID: AtomicU64 = AtomicU64::new(1);
    let id = NEXT_ID.fetch_add(1, Ordering::SeqCst);
    if let Ok(mut active) = active_helper_terminations().lock() {
        active.insert(id, HelperTermination::new(termination));
    }
    id
}

fn unregister_helper_termination(id: u64) {
    if let Ok(mut active) = active_helper_terminations().lock() {
        if let Some(termination) = active.remove(&id) {
            termination.deactivate();
        }
    }
}

fn terminate_active_foundation_helpers() {
    let terminations = active_helper_terminations()
        .lock()
        .map(|active| active.values().cloned().collect::<Vec<_>>())
        .unwrap_or_default();
    for terminate in terminations {
        terminate.run();
    }
}

/// A spawned helper process the runner can wait on and terminate.
pub trait FoundationHelperChild: Send {
    /// Wait for the helper to exit, draining its stdout/stderr with the same
    /// byte caps as TypeScript. Returns the exit code (`None` on signal).
    fn wait(&mut self) -> BoxFuture<'_, Result<Option<i32>, FoundationModelsConnectionError>>;
    fn terminate(&mut self);
}

/// Spawns the helper for one request. The production implementation launches
/// `Aiden Foundation Models Helper.app` via `/usr/bin/open -W -n`.
pub trait FoundationHelperSpawner: Send + Sync + 'static {
    fn spawn(
        &self,
        request_path: &std::path::Path,
        response_path: &std::path::Path,
        process_path: &std::path::Path,
        cancellation_path: &std::path::Path,
    ) -> Result<Box<dyn FoundationHelperChild>, FoundationModelsConnectionError>;
}

/// The production spawner: `/usr/bin/open -W -n <helper.app> --args
/// --request-file <r> --response-file <r2> --process-file <p>
/// --cancellation-file <c>`.
pub struct OpenHelperSpawner {
    pub helper_path: PathBuf,
    pub environment: HashMap<String, String>,
}

impl OpenHelperSpawner {
    /// The bounded environment from `helperEnvironment()`: a fixed PATH plus
    /// the locale/temp/user passthroughs.
    pub fn environment(source: &HashMap<String, String>) -> HashMap<String, String> {
        let mut environment = HashMap::new();
        environment.insert(
            "PATH".to_string(),
            "/usr/bin:/bin:/usr/sbin:/sbin".to_string(),
        );
        for key in [
            "HOME",
            "LANG",
            "LC_ALL",
            "TMPDIR",
            "USER",
            "__CF_USER_TEXT_ENCODING",
        ] {
            if let Some(value) = source.get(key) {
                if !value.is_empty() {
                    environment.insert(key.to_string(), value.clone());
                }
            }
        }
        environment
    }
}

#[cfg(unix)]
struct OpenHelperChild {
    child: tokio::process::Child,
    termination_id: Arc<AtomicU64>,
}

#[cfg(unix)]
impl FoundationHelperChild for OpenHelperChild {
    fn wait(&mut self) -> BoxFuture<'_, Result<Option<i32>, FoundationModelsConnectionError>> {
        let termination_id = Arc::clone(&self.termination_id);
        let child = &mut self.child;
        Box::pin(async move {
            let stdout = child.stdout.take();
            let stderr = child.stderr.take();
            let stdout_task = stdout.map(|mut stream| {
                tokio::spawn(async move {
                    let mut bytes: u64 = 0;
                    let mut buffer = [0_u8; 64 * 1024];
                    loop {
                        match tokio::io::AsyncReadExt::read(&mut stream, &mut buffer).await {
                            Ok(0) | Err(_) => break,
                            Ok(count) => {
                                bytes += count as u64;
                                if bytes > MAX_HELPER_STDOUT_BYTES {
                                    return Err("The native helper returned too much data.");
                                }
                            }
                        }
                    }
                    Ok(())
                })
            });
            let stderr_task = stderr.map(|mut stream| {
                tokio::spawn(async move {
                    let mut bytes: u64 = 0;
                    let mut buffer = [0_u8; 64 * 1024];
                    loop {
                        match tokio::io::AsyncReadExt::read(&mut stream, &mut buffer).await {
                            Ok(0) | Err(_) => break,
                            Ok(count) => {
                                bytes += count as u64;
                                if bytes > MAX_HELPER_STDERR_BYTES {
                                    return Err(
                                        "The native helper returned too much diagnostic data.",
                                    );
                                }
                            }
                        }
                    }
                    Ok(())
                })
            });
            let status = child.wait().await.map_err(|_| {
                FoundationModelsConnectionError::new("helper_failed", "The native helper failed.")
            })?;
            let id = termination_id.swap(0, Ordering::SeqCst);
            if id != 0 {
                unregister_helper_termination(id);
            }
            if let Some(stdout_task) = stdout_task {
                if let Ok(Err(message)) = stdout_task.await {
                    return Err(FoundationModelsConnectionError::new(
                        "output_too_large",
                        message,
                    ));
                }
            }
            if let Some(stderr_task) = stderr_task {
                if let Ok(Err(message)) = stderr_task.await {
                    return Err(FoundationModelsConnectionError::new(
                        "output_too_large",
                        message,
                    ));
                }
            }
            Ok(status.code())
        })
    }

    fn terminate(&mut self) {
        let id = self.termination_id.swap(0, Ordering::SeqCst);
        if id != 0 {
            unregister_helper_termination(id);
        }
        let _ = self.child.start_kill();
    }
}

#[cfg(unix)]
impl Drop for OpenHelperChild {
    fn drop(&mut self) {
        self.terminate();
    }
}

#[cfg(unix)]
impl FoundationHelperSpawner for OpenHelperSpawner {
    fn spawn(
        &self,
        request_path: &std::path::Path,
        response_path: &std::path::Path,
        process_path: &std::path::Path,
        cancellation_path: &std::path::Path,
    ) -> Result<Box<dyn FoundationHelperChild>, FoundationModelsConnectionError> {
        use std::process::Stdio;
        let child = tokio::process::Command::new("/usr/bin/open")
            .arg("-W")
            .arg("-n")
            .arg(&self.helper_path)
            .arg("--args")
            .arg("--request-file")
            .arg(request_path)
            .arg("--response-file")
            .arg(response_path)
            .arg("--process-file")
            .arg(process_path)
            .arg("--cancellation-file")
            .arg(cancellation_path)
            .envs(&self.environment)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true)
            .spawn()
            .map_err(|error| {
                if error.kind() == std::io::ErrorKind::NotFound {
                    FoundationModelsConnectionError::new(
                        "helper_missing",
                        "The Apple Foundation Models helper is unavailable.",
                    )
                } else {
                    FoundationModelsConnectionError::new(
                        "helper_failed",
                        "The Apple Foundation Models helper is unavailable.",
                    )
                }
            })?;
        let cancellation_path = cancellation_path.to_path_buf();
        // The registry deliberately owns only the race-free cooperative
        // cancellation marker. It must never retain a raw numeric PID: the OS
        // may reuse that PID after waitpid reaps the launcher but before this
        // future resumes to unregister. The live request path terminates via
        // the owned `tokio::process::Child`, whose kill-on-drop remains the
        // final best-effort fallback.
        let termination_id = register_helper_termination(Arc::new(move || {
            write_cancelled_file(&cancellation_path);
        }));
        Ok(Box::new(OpenHelperChild {
            child,
            termination_id: Arc::new(AtomicU64::new(termination_id)),
        }))
    }
}

fn write_cancelled_file(path: &Path) {
    let _ = std::fs::write(path, b"");
}

#[cfg(unix)]
fn terminate_helper(process_path: &Path, child: &mut dyn FoundationHelperChild) {
    // The process-id file is helper-controlled and must never authorize a
    // signal to an arbitrary process. Terminate only the child handle Aiden
    // actually spawned; the cancellation file asks the helper to cooperate.
    let _ = process_path;
    child.terminate();
}

/// Run one helper request through the file exchange: prepare the tempdir,
/// write `request.json`, spawn the helper, and read back `response.json`.
pub async fn run_helper_request(
    request: &NativeFoundationModelsRequest,
    options: &NativeFoundationModelsRunOptions,
    spawner: &dyn FoundationHelperSpawner,
    temp_root: &Path,
) -> Result<FoundationModelsResponse, FoundationModelsConnectionError> {
    let payload = serde_json::to_vec(request).map_err(|_| {
        FoundationModelsConnectionError::new(
            "invalid_request",
            "The native title request is too large.",
        )
    })?;
    if payload.len() > MAX_REQUEST_BYTES {
        return Err(FoundationModelsConnectionError::new(
            "invalid_request",
            "The native title request is too large.",
        ));
    }
    if options
        .signal
        .as_ref()
        .is_some_and(|token| token.is_cancelled())
    {
        return Err(FoundationModelsConnectionError::new(
            "cancelled",
            "Title generation was cancelled.",
        ));
    }

    let exchange = tempfile::Builder::new()
        .prefix("aiden-foundation-models-")
        .tempdir_in(temp_root)
        .map_err(|_| {
            FoundationModelsConnectionError::new(
                "helper_failed",
                "The native title request could not be prepared.",
            )
        })?;
    let exchange_directory = exchange.path().to_path_buf();
    let request_path = exchange_directory.join("request.json");
    let response_path = exchange_directory.join("response.json");
    let process_path = exchange_directory.join("process-id");
    let cancellation_path = exchange_directory.join("cancelled");
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&exchange_directory, std::fs::Permissions::from_mode(0o700))
            .map_err(|_| {
                FoundationModelsConnectionError::new(
                    "helper_failed",
                    "The native title request could not be prepared.",
                )
            })?;
        let write_result = std::fs::write(&request_path, &payload).and_then(|()| {
            std::fs::set_permissions(&request_path, std::fs::Permissions::from_mode(0o600))
        });
        if write_result.is_err() {
            let _ = std::fs::remove_dir_all(&exchange_directory);
            return Err(FoundationModelsConnectionError::new(
                "helper_failed",
                "The native title request could not be prepared.",
            ));
        }
    }
    if options
        .signal
        .as_ref()
        .is_some_and(|token| token.is_cancelled())
    {
        let _ = std::fs::remove_dir_all(&exchange_directory);
        return Err(FoundationModelsConnectionError::new(
            "cancelled",
            "Title generation was cancelled.",
        ));
    }

    let mut child = match spawner.spawn(
        &request_path,
        &response_path,
        &process_path,
        &cancellation_path,
    ) {
        Ok(child) => child,
        Err(error) => {
            let _ = std::fs::remove_dir_all(&exchange_directory);
            return Err(error);
        }
    };

    // Wait for the helper with a timeout and cancellation. The wait future
    // borrows `child`, so the timeout/cancellation arms only race the future
    // itself; termination happens after the wait future is dropped.
    let mut wait = Box::pin(child.wait());
    let timeout = tokio::time::sleep(Duration::from_millis(options.timeout_ms));
    tokio::pin!(timeout);
    let cancellation = async {
        match options.signal.as_ref() {
            Some(signal) => signal.cancelled().await,
            None => std::future::pending::<()>().await,
        }
    };
    tokio::pin!(cancellation);
    let (stop, wait_result) = tokio::select! {
        result = &mut wait => (None, Some(result)),
        () = &mut timeout => (Some("timeout"), None),
        () = &mut cancellation => (Some("cancelled"), None),
    };
    drop(wait);

    let error = match stop {
        Some("cancelled") => Some(FoundationModelsConnectionError::new(
            "cancelled",
            "Title generation was cancelled.",
        )),
        Some("timeout") => Some(FoundationModelsConnectionError::retryable(
            "timeout",
            "The native helper timed out.",
        )),
        _ => None,
    };
    if let Some(error) = error {
        write_cancelled_file(&cancellation_path);
        #[cfg(unix)]
        terminate_helper(&process_path, child.as_mut());
        #[cfg(not(unix))]
        child.terminate();
        if stop == Some("timeout") {
            tokio::time::sleep(Duration::from_millis(FORCED_FINISH_MS)).await;
        }
        let _ = std::fs::remove_dir_all(&exchange_directory);
        return Err(error);
    }

    let exit_code = match wait_result.expect("wait settled") {
        Ok(exit_code) => exit_code,
        Err(error) => {
            let _ = std::fs::remove_dir_all(&exchange_directory);
            return Err(error);
        }
    };
    if exit_code != Some(0) {
        let _ = std::fs::remove_dir_all(&exchange_directory);
        return Err(FoundationModelsConnectionError::new(
            "helper_failed",
            "The Apple Foundation Models helper failed.",
        ));
    }
    let metadata = match tokio::fs::metadata(&response_path).await {
        Ok(metadata) => metadata,
        Err(_) => {
            let _ = std::fs::remove_dir_all(&exchange_directory);
            return Err(FoundationModelsConnectionError::new(
                "helper_failed",
                "The Apple Foundation Models helper failed.",
            ));
        }
    };
    if metadata.len() > MAX_RESPONSE_BYTES {
        let _ = std::fs::remove_dir_all(&exchange_directory);
        return Err(FoundationModelsConnectionError::new(
            "output_too_large",
            "The native helper returned too much data.",
        ));
    }
    let contents = match tokio::fs::read_to_string(&response_path).await {
        Ok(contents) => contents,
        Err(_) => {
            let _ = std::fs::remove_dir_all(&exchange_directory);
            return Err(FoundationModelsConnectionError::new(
                "helper_failed",
                "The Apple Foundation Models helper failed.",
            ));
        }
    };
    let _ = std::fs::remove_dir_all(&exchange_directory);
    parse_foundation_models_response(&contents)
}

/// Default temp root matching `os.tmpdir()`.
pub fn default_temp_root() -> PathBuf {
    std::env::temp_dir()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};

    fn run(now: u64) -> Arc<dyn Fn() -> u64 + Send + Sync> {
        let now = Arc::new(AtomicU64::new(now));
        Arc::new(move || now.load(Ordering::SeqCst))
    }

    #[test]
    fn protocol_version_is_exact() {
        assert_eq!(FOUNDATION_MODELS_PROTOCOL_VERSION, 1);
    }

    #[test]
    fn request_serializes_to_the_swift_contract_shape() {
        let availability = NativeFoundationModelsRequest::availability();
        assert_eq!(
            serde_json::to_string(&availability).unwrap(),
            r#"{"version":1,"method":"availability"}"#
        );
        let title = NativeFoundationModelsRequest::generate_title("Name this chat");
        assert_eq!(
            serde_json::to_string(&title).unwrap(),
            r#"{"version":1,"method":"generateTitle","prompt":"Name this chat"}"#
        );
    }

    #[test]
    fn parses_success_and_error_fixture_transcripts() {
        // From the Swift ProtocolTests/TS test sources.
        let ready: FoundationModelsResponse =
            serde_json::from_str(r#"{"version":1,"ok":true,"result":{"state":"ready"}}"#).unwrap();
        assert_eq!(
            ready.result.unwrap().state,
            Some(FoundationModelsState::Ready)
        );

        let title = parse_foundation_models_response(
            r#"{"version":1,"ok":true,"result":{"title":"My Chat"}}"#,
        )
        .unwrap();
        assert_eq!(title.result.unwrap().title.as_deref(), Some("My Chat"));

        let both = parse_foundation_models_response(
            r#"{"version":1,"ok":true,"result":{"state":"ready","title":"X"}}"#,
        )
        .unwrap();
        assert_eq!(
            both.result.unwrap().state,
            Some(FoundationModelsState::Ready)
        );

        let unavailable = parse_foundation_models_response(
            r#"{"version":1,"ok":true,"result":{"state":"unavailable"}}"#,
        )
        .unwrap();
        assert_eq!(
            unavailable.result.unwrap().state,
            Some(FoundationModelsState::Unavailable)
        );

        let preparing = parse_foundation_models_response(
            r#"{"version":1,"ok":true,"result":{"state":"model_preparing"}}"#,
        )
        .unwrap();
        assert_eq!(
            preparing.result.unwrap().state,
            Some(FoundationModelsState::ModelPreparing)
        );

        let device_not_eligible = parse_foundation_models_response(
            r#"{"version":1,"ok":true,"result":{"state":"device_not_eligible"}}"#,
        )
        .unwrap();
        assert_eq!(
            device_not_eligible.result.unwrap().state,
            Some(FoundationModelsState::DeviceNotEligible)
        );

        let failure = parse_foundation_models_response(
            r#"{"version":1,"ok":false,"error":{"code":"rate_limited","message":"Try later.","retryable":true}}"#,
        )
        .unwrap();
        let error = failure.error.unwrap();
        assert_eq!(error.code, "rate_limited");
        assert_eq!(error.message, "Try later.");
        assert!(error.retryable);
    }

    #[test]
    fn rejects_invalid_response_transcripts() {
        fn code(value: &str) -> String {
            parse_foundation_models_response(value).unwrap_err().code
        }
        assert_eq!(code("not json"), "invalid_response");
        assert_eq!(code("\"just-a-string\""), "invalid_response");
        assert_eq!(code("null"), "invalid_response");
        assert_eq!(
            code(r#"{"version":2,"ok":true,"result":{"state":"ready"}}"#),
            "invalid_response"
        );
        assert_eq!(
            code(r#"{"version":1,"ok":true,"result":"ready"}"#),
            "invalid_response"
        );
        assert_eq!(
            code(r#"{"version":1,"ok":true,"result":{}}"#),
            "invalid_response"
        );
        assert_eq!(
            code(r#"{"version":1,"ok":true,"result":{"title":42}}"#),
            "invalid_response"
        );
        assert_eq!(
            code(r#"{"version":1,"ok":true,"result":{"state":"future"}}"#),
            "invalid_response"
        );
        assert_eq!(code(r#"{"version":1,"ok":false}"#), "invalid_response");
        assert_eq!(
            code(
                r#"{"version":1,"ok":false,"error":{"code":"x","message":"y","retryable":"yes"}}"#
            ),
            "invalid_response"
        );
    }

    #[test]
    fn platform_gate_matches_the_26_boundary_and_arch() {
        assert_eq!(
            platform_foundation_models_status("linux", "arm64", "26.0"),
            PlatformGate::NotApplicable
        );
        match platform_foundation_models_status("darwin", "arm64", "abc") {
            PlatformGate::Blocked(status) => {
                assert_eq!(status.state, FoundationModelsConnectionState::UnsupportedOs)
            }
            other => panic!("unexpected {other:?}"),
        }
        match platform_foundation_models_status("darwin", "arm64", "15.9.1") {
            PlatformGate::Blocked(status) => {
                assert_eq!(status.state, FoundationModelsConnectionState::UnsupportedOs)
            }
            other => panic!("unexpected {other:?}"),
        }
        assert_eq!(
            platform_foundation_models_status("darwin", "arm64", "26.0.0"),
            PlatformGate::Proceed
        );
        match platform_foundation_models_status("darwin", "x64", "26.0") {
            PlatformGate::Blocked(status) => {
                assert_eq!(
                    status.state,
                    FoundationModelsConnectionState::DeviceNotEligible
                )
            }
            other => panic!("unexpected {other:?}"),
        }
    }

    #[tokio::test]
    async fn deduplicates_and_caches_status_reads() {
        let now = Arc::new(AtomicU64::new(1_000));
        let now_clock = Arc::clone(&now);
        let calls = Arc::new(AtomicU64::new(0));
        let calls_holder = Arc::clone(&calls);
        let run_request: NativeFoundationModelsRequestRunner = Arc::new(
            move |_request: NativeFoundationModelsRequest,
                  _options: NativeFoundationModelsRunOptions|
                  -> BoxFuture<
                'static,
                Result<FoundationModelsResponse, FoundationModelsConnectionError>,
            > {
                calls_holder.fetch_add(1, Ordering::SeqCst);
                Box::pin(async {
                    Ok(FoundationModelsResponse::success(
                        Some(FoundationModelsState::Ready),
                        None,
                    ))
                })
            },
        );
        let connection = create_foundation_models_connection(
            "darwin",
            "arm64",
            "26.0",
            Arc::new(move || now_clock.load(Ordering::SeqCst)),
            run_request,
        );
        let first = connection.status(false).await;
        let second = connection.status(false).await;
        assert_eq!(
            first.as_ref().unwrap().state,
            FoundationModelsConnectionState::Ready
        );
        assert_eq!(
            second.as_ref().unwrap().state,
            FoundationModelsConnectionState::Ready
        );
        assert_eq!(calls.load(Ordering::SeqCst), 1);
        now.store(1_000 + 31_000, Ordering::SeqCst);
        let third = connection.status(false).await;
        assert_eq!(
            third.as_ref().unwrap().state,
            FoundationModelsConnectionState::Ready
        );
        assert_eq!(calls.load(Ordering::SeqCst), 2);
    }

    #[tokio::test]
    async fn maps_availability_states_and_title_errors() {
        let responses: Arc<std::sync::Mutex<Vec<FoundationModelsResponse>>> =
            Arc::new(std::sync::Mutex::new(vec![
                FoundationModelsResponse::success(
                    Some(FoundationModelsState::AppleIntelligenceDisabled),
                    None,
                ),
                FoundationModelsResponse {
                    version: 1,
                    ok: false,
                    result: None,
                    error: Some(NativeFoundationModelsError {
                        code: "rate_limited".into(),
                        message: "Try later.".into(),
                        retryable: true,
                    }),
                },
            ]));
        let run_request: NativeFoundationModelsRequestRunner =
            Arc::new(move |_request, _options| {
                let responses = Arc::clone(&responses);
                Box::pin(async move { Ok(responses.lock().unwrap().remove(0)) })
            });
        let connection =
            create_foundation_models_connection("darwin", "arm64", "26.0", run(1_000), run_request);
        let status = connection.status(false).await.unwrap();
        assert_eq!(
            status.state,
            FoundationModelsConnectionState::AppleIntelligenceDisabled
        );
        let error = connection
            .generate_title("Name this chat", None)
            .await
            .unwrap_err();
        assert_eq!(error.code, "rate_limited");
        assert!(error.retryable);
    }

    #[tokio::test]
    async fn downgrades_cached_readiness_after_a_native_availability_failure() {
        let calls = Arc::new(AtomicU64::new(0));
        let calls_holder = Arc::clone(&calls);
        let run_request: NativeFoundationModelsRequestRunner =
            Arc::new(move |request, _options| {
                let calls = Arc::clone(&calls_holder);
                Box::pin(async move {
                    calls.fetch_add(1, Ordering::SeqCst);
                    if request.method == NativeFoundationModelsMethod::Availability {
                        Ok(FoundationModelsResponse::success(
                            Some(FoundationModelsState::Ready),
                            None,
                        ))
                    } else {
                        Ok(FoundationModelsResponse {
                            version: 1,
                            ok: false,
                            result: None,
                            error: Some(NativeFoundationModelsError {
                                code: "assets_unavailable".into(),
                                message: "The on-device model is temporarily unavailable.".into(),
                                retryable: true,
                            }),
                        })
                    }
                })
            });
        let connection =
            create_foundation_models_connection("darwin", "arm64", "26.0", run(1_000), run_request);
        assert_eq!(
            connection.status(false).await.unwrap().state,
            FoundationModelsConnectionState::Ready
        );
        let error = connection
            .generate_title("Name this chat", None)
            .await
            .unwrap_err();
        assert!(error.message.contains("temporarily unavailable"));
        assert_eq!(
            connection.status(false).await.unwrap().state,
            FoundationModelsConnectionState::Unavailable
        );
        assert_eq!(calls.load(Ordering::SeqCst), 2);
    }

    #[tokio::test]
    async fn file_exchange_round_trips_against_a_fake_helper() {
        struct FakeChild {
            exchange: std::path::PathBuf,
            response: String,
            exit_code: i32,
        }
        impl FoundationHelperChild for FakeChild {
            fn wait(
                &mut self,
            ) -> BoxFuture<'_, Result<Option<i32>, FoundationModelsConnectionError>> {
                let response = self.response.clone();
                let exit_code = self.exit_code;
                let exchange = self.exchange.clone();
                Box::pin(async move {
                    // Mirror the Swift helper: write the response.json atomically.
                    let response_path = exchange.join("response.json");
                    std::fs::write(&response_path, response).unwrap();
                    Ok(Some(exit_code))
                })
            }
            fn terminate(&mut self) {}
        }
        struct FakeSpawner {
            response: String,
            exit_code: i32,
        }
        impl FoundationHelperSpawner for FakeSpawner {
            fn spawn(
                &self,
                request_path: &Path,
                _response_path: &Path,
                _process_path: &Path,
                _cancellation_path: &Path,
            ) -> Result<Box<dyn FoundationHelperChild>, FoundationModelsConnectionError>
            {
                Ok(Box::new(FakeChild {
                    exchange: request_path
                        .parent()
                        .expect("request lives in the exchange dir")
                        .to_path_buf(),
                    response: self.response.clone(),
                    exit_code: self.exit_code,
                }))
            }
        }

        let temp = tempfile::tempdir().unwrap();
        let spawner = FakeSpawner {
            response: r#"{"version":1,"ok":true,"result":{"title":"My Chat"}}"#.into(),
            exit_code: 0,
        };
        let response = run_helper_request(
            &NativeFoundationModelsRequest::generate_title("Name this chat"),
            &NativeFoundationModelsRunOptions {
                timeout_ms: 2_000,
                signal: None,
            },
            &spawner,
            temp.path(),
        )
        .await
        .unwrap();
        assert_eq!(response.result.unwrap().title.as_deref(), Some("My Chat"));
        // The exchange directory is cleaned up after the run.
        let leftovers: Vec<_> = std::fs::read_dir(temp.path())
            .unwrap()
            .filter_map(|entry| entry.ok())
            .filter(|entry| {
                entry
                    .file_name()
                    .to_string_lossy()
                    .starts_with("aiden-foundation-models-")
            })
            .collect();
        assert!(leftovers.is_empty(), "exchange dir leaked: {leftovers:?}");
    }

    #[tokio::test]
    async fn file_exchange_rejects_oversized_requests_before_spawning() {
        let spawns = Arc::new(AtomicU64::new(0));
        let spawns_holder = Arc::clone(&spawns);
        struct CountingSpawner {
            spawns: Arc<AtomicU64>,
        }
        impl FoundationHelperSpawner for CountingSpawner {
            fn spawn(
                &self,
                _request_path: &Path,
                _response_path: &Path,
                _process_path: &Path,
                _cancellation_path: &Path,
            ) -> Result<Box<dyn FoundationHelperChild>, FoundationModelsConnectionError>
            {
                self.spawns.fetch_add(1, Ordering::SeqCst);
                unreachable!("must not spawn for an oversized request")
            }
        }
        let _ = spawns;
        let request = NativeFoundationModelsRequest::generate_title("x".repeat(20_001));
        let error = run_helper_request(
            &request,
            &NativeFoundationModelsRunOptions {
                timeout_ms: 2_000,
                signal: None,
            },
            &CountingSpawner {
                spawns: spawns_holder,
            },
            std::env::temp_dir().as_path(),
        )
        .await
        .unwrap_err();
        assert_eq!(error.code, "invalid_request");
    }

    #[tokio::test]
    async fn file_exchange_fails_closed_when_exclusive_tempdir_cannot_be_created() {
        struct NeverSpawner;
        impl FoundationHelperSpawner for NeverSpawner {
            fn spawn(
                &self,
                _: &Path,
                _: &Path,
                _: &Path,
                _: &Path,
            ) -> Result<Box<dyn FoundationHelperChild>, FoundationModelsConnectionError>
            {
                panic!("helper must not spawn without an exclusively owned exchange directory")
            }
        }

        let temp = tempfile::tempdir().unwrap();
        let not_a_directory = temp.path().join("occupied");
        std::fs::write(&not_a_directory, b"attacker-controlled").unwrap();
        let error = run_helper_request(
            &NativeFoundationModelsRequest::availability(),
            &NativeFoundationModelsRunOptions {
                timeout_ms: 100,
                signal: None,
            },
            &NeverSpawner,
            &not_a_directory,
        )
        .await
        .unwrap_err();

        assert_eq!(error.code, "helper_failed");
        assert_eq!(
            std::fs::read(&not_a_directory).unwrap(),
            b"attacker-controlled"
        );
    }

    #[tokio::test]
    async fn file_exchange_cancellation_wakes_and_terminates_without_waiting_for_deadline() {
        struct PendingChild {
            terminated: Arc<AtomicBool>,
        }
        impl FoundationHelperChild for PendingChild {
            fn wait(
                &mut self,
            ) -> BoxFuture<'_, Result<Option<i32>, FoundationModelsConnectionError>> {
                Box::pin(std::future::pending())
            }

            fn terminate(&mut self) {
                self.terminated.store(true, Ordering::SeqCst);
            }
        }
        struct PendingSpawner {
            terminated: Arc<AtomicBool>,
        }
        impl FoundationHelperSpawner for PendingSpawner {
            fn spawn(
                &self,
                _: &Path,
                _: &Path,
                _: &Path,
                _: &Path,
            ) -> Result<Box<dyn FoundationHelperChild>, FoundationModelsConnectionError>
            {
                Ok(Box::new(PendingChild {
                    terminated: Arc::clone(&self.terminated),
                }))
            }
        }

        let temp = tempfile::tempdir().unwrap();
        let signal = CancellationToken::new();
        let cancel = signal.clone();
        let terminated = Arc::new(AtomicBool::new(false));
        let start = tokio::time::Instant::now();
        let cancellation = tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(20)).await;
            cancel.cancel();
        });
        let error = run_helper_request(
            &NativeFoundationModelsRequest::availability(),
            &NativeFoundationModelsRunOptions {
                timeout_ms: 15_000,
                signal: Some(signal),
            },
            &PendingSpawner {
                terminated: Arc::clone(&terminated),
            },
            temp.path(),
        )
        .await
        .unwrap_err();
        cancellation.await.unwrap();

        assert_eq!(error.code, "cancelled");
        assert!(terminated.load(Ordering::SeqCst));
        assert!(start.elapsed() < Duration::from_millis(500));
    }

    #[test]
    fn connection_dispose_synchronously_terminates_an_active_owned_helper() {
        let terminated = Arc::new(AtomicBool::new(false));
        let terminated_for_callback = Arc::clone(&terminated);
        let temp = tempfile::tempdir().unwrap();
        let marker = temp.path().join("cancelled");
        let marker_for_callback = marker.clone();
        let id = register_helper_termination(Arc::new(move || {
            write_cancelled_file(&marker_for_callback);
            terminated_for_callback.store(true, Ordering::SeqCst);
        }));
        let runner: NativeFoundationModelsRequestRunner = Arc::new(|_, _| {
            Box::pin(std::future::pending::<
                Result<FoundationModelsResponse, FoundationModelsConnectionError>,
            >())
        });
        let connection =
            create_foundation_models_connection("darwin", "arm64", "26.0", run(1_000), runner);

        connection.dispose();

        unregister_helper_termination(id);
        assert!(terminated.load(Ordering::SeqCst));
        assert!(marker.is_file());
    }

    #[test]
    fn a_dispose_callback_captured_before_reap_is_inert_after_unregister() {
        let signalled_after_reap = Arc::new(AtomicBool::new(false));
        let signalled = Arc::clone(&signalled_after_reap);
        let id = register_helper_termination(Arc::new(move || {
            signalled.store(true, Ordering::SeqCst);
        }));
        let stale_dispose_callback = active_helper_terminations()
            .lock()
            .unwrap()
            .get(&id)
            .cloned()
            .expect("registered helper termination");

        // `OpenHelperChild::wait` performs this unregister immediately after
        // wait returns, before it awaits either output-drain task. Force the
        // stronger schedule where dispose already captured the entry but does
        // not run it until after the helper was reaped and unregistered.
        unregister_helper_termination(id);
        stale_dispose_callback.run();

        assert!(!signalled_after_reap.load(Ordering::SeqCst));
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn reaped_open_child_is_unregistered_while_output_is_still_draining() {
        use std::process::Stdio;

        let signalled_after_reap = Arc::new(AtomicBool::new(false));
        let signalled = Arc::clone(&signalled_after_reap);
        let id = register_helper_termination(Arc::new(move || {
            signalled.store(true, Ordering::SeqCst);
        }));
        // The shell exits immediately while its background child retains the
        // stdout/stderr pipes, creating the real waitpid-reaped/output-drain
        // interval that previously made a captured numeric PID unsafe.
        let mut process = tokio::process::Command::new("/bin/sh");
        process
            .arg("-c")
            .arg("sleep 0.25 & exit 0")
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        let child = process.spawn().expect("spawn controlled test child");
        let mut helper = OpenHelperChild {
            child,
            termination_id: Arc::new(AtomicU64::new(id)),
        };
        let wait_task = tokio::spawn(async move { helper.wait().await });

        tokio::time::timeout(Duration::from_secs(1), async {
            loop {
                let registered = active_helper_terminations()
                    .lock()
                    .unwrap()
                    .contains_key(&id);
                if !registered {
                    break;
                }
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("wait should unregister before output drain completes");
        assert!(
            !wait_task.is_finished(),
            "output drain should still be pending"
        );

        terminate_active_foundation_helpers();
        assert!(!signalled_after_reap.load(Ordering::SeqCst));
        assert_eq!(wait_task.await.unwrap().unwrap(), Some(0));
    }
}
