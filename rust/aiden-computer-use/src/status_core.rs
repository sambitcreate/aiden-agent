//! Computer Use readiness/permission service (port of
//! `main/services/computer-use/status-core.ts`): the cached, revision-gated
//! readiness probe with one authenticated helper per probe.

use std::collections::{HashMap, HashSet};
use std::panic::AssertUnwindSafe;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex as StdMutex};

use futures::future::BoxFuture;
use futures::FutureExt;
use serde_json::{Map, Value};
use tokio::sync::Notify;
use tokio::time::{timeout, Duration};
use tokio_util::sync::CancellationToken;

use crate::contract::{
    CuaDriverError, CUA_DRIVER_TCC_HOST_BUNDLE_ID, CUA_DRIVER_TOOL_SCHEMA, CUA_DRIVER_VERSION,
};

pub const REQUIRED_HEALTH_CHECKS: &[&str] =
    &["binary_version", "platform_supported", "session_active"];
const DEFAULT_CACHE_MS: u64 = 10_000;
const PROBE_TIMEOUT_MS: u64 = 20_000;
const SHUTDOWN_GRACE_MS: u64 = 5_000;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ComputerUseStatusState {
    Disabled,
    Ready,
    PermissionRequired,
    ProductionBuildRequired,
    Unsupported,
    Unavailable,
    Incompatible,
    Error,
}

impl ComputerUseStatusState {
    pub fn as_str(self) -> &'static str {
        match self {
            ComputerUseStatusState::Disabled => "disabled",
            ComputerUseStatusState::Ready => "ready",
            ComputerUseStatusState::PermissionRequired => "permission_required",
            ComputerUseStatusState::ProductionBuildRequired => "production_build_required",
            ComputerUseStatusState::Unsupported => "unsupported",
            ComputerUseStatusState::Unavailable => "unavailable",
            ComputerUseStatusState::Incompatible => "incompatible",
            ComputerUseStatusState::Error => "error",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ComputerUsePermissions {
    pub accessibility: Option<bool>,
    pub screen_recording: Option<bool>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ComputerUseStatus {
    pub enabled: bool,
    pub beta: bool,
    pub state: ComputerUseStatusState,
    pub detail: String,
    pub ready: bool,
    pub available: bool,
    pub retryable: bool,
    pub can_request_permissions: bool,
    pub driver_version: Option<String>,
    pub permissions: ComputerUsePermissions,
}

/// Options for a status probe tool call.
#[derive(Debug, Clone, Default)]
pub struct StatusCallOptions {
    pub signal: Option<CancellationToken>,
    pub timeout_ms: Option<u64>,
}

/// The session surface the status service probes.
pub trait ComputerUseStatusSession: Send {
    fn call_tool(
        &self,
        name: &str,
        args: Value,
        options: &StatusCallOptions,
    ) -> BoxFuture<'static, Result<Value, CuaDriverError>>;
    fn close(&self) -> BoxFuture<'static, ()> {
        Box::pin(async {})
    }
}

/// The host surface the status service drives.
pub trait ComputerUseStatusHost: Send {
    fn create_session(
        &self,
        signal: &CancellationToken,
    ) -> BoxFuture<'static, Result<Box<dyn ComputerUseStatusSession>, CuaDriverError>>;
    fn shutdown(&self) -> BoxFuture<'static, ()> {
        Box::pin(async {})
    }
}

/// The seam between the service and the rest of the app (port of
/// `ComputerUseStatusDependencies`).
pub trait ComputerUseStatusDependencies: Send + Sync + 'static {
    fn is_enabled(&self) -> BoxFuture<'static, bool>;
    fn create_host(
        &self,
        signal: CancellationToken,
    ) -> BoxFuture<'static, Result<Box<dyn ComputerUseStatusHost>, CuaDriverError>>;
    /// Wall-clock milliseconds (like `Date.now`), used for the status cache.
    fn now(&self) -> u64 {
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|duration| duration.as_millis() as u64)
            .unwrap_or(0)
    }
}

fn disabled_status() -> ComputerUseStatus {
    ComputerUseStatus {
        enabled: false,
        beta: true,
        state: ComputerUseStatusState::Disabled,
        detail: "Turn on the Computer Use beta to make it available in individual chats.".into(),
        ready: false,
        available: false,
        retryable: false,
        can_request_permissions: false,
        driver_version: None,
        permissions: ComputerUsePermissions {
            accessibility: None,
            screen_recording: None,
        },
    }
}

fn fixed_error_status(error: &CuaDriverError) -> ComputerUseStatus {
    let base = || ComputerUseStatus {
        enabled: true,
        beta: true,
        state: ComputerUseStatusState::Error,
        detail: String::new(),
        ready: false,
        available: false,
        retryable: false,
        can_request_permissions: false,
        driver_version: None,
        permissions: ComputerUsePermissions {
            accessibility: None,
            screen_recording: None,
        },
    };
    match error.code {
        "unsupported_platform" => ComputerUseStatus {
            state: ComputerUseStatusState::Unsupported,
            detail: "Aiden Computer Use currently requires macOS 14.4 or newer.".into(),
            ..base()
        },
        "host_identity_invalid" | "bridge_identity_invalid" => ComputerUseStatus {
            state: ComputerUseStatusState::ProductionBuildRequired,
            detail: "Computer Use requires a signed packaged build of Aiden.".into(),
            ..base()
        },
        "driver_integrity_failed"
        | "invalid_driver_path"
        | "identity_verification_failed"
        | "incompatible_driver"
        | "invalid_tools" => ComputerUseStatus {
            state: ComputerUseStatusState::Incompatible,
            detail: "The bundled Computer Use helper failed its compatibility or integrity check."
                .into(),
            ..base()
        },
        "driver_missing" => ComputerUseStatus {
            state: ComputerUseStatusState::Unavailable,
            detail: "The pinned Computer Use helper is unavailable in this Aiden build.".into(),
            ..base()
        },
        _ => ComputerUseStatus {
            state: ComputerUseStatusState::Error,
            detail: "Aiden could not check Computer Use readiness. Try again.".into(),
            retryable: true,
            ..base()
        },
    }
}

fn structured_tool_result<'a>(
    value: &'a Value,
    tool_name: &str,
) -> Result<&'a Map<String, Value>, CuaDriverError> {
    let object = value.as_object().ok_or_else(|| {
        CuaDriverError::new(
            "incompatible_driver",
            format!("cua-driver returned an invalid {tool_name} result."),
        )
    })?;
    if object
        .get("isError")
        .and_then(Value::as_bool)
        .unwrap_or(false)
    {
        return Err(CuaDriverError::new(
            "incompatible_driver",
            format!("cua-driver returned an invalid {tool_name} result."),
        ));
    }
    object
        .get("structuredContent")
        .and_then(Value::as_object)
        .ok_or_else(|| {
            CuaDriverError::new(
                "incompatible_driver",
                format!("cua-driver returned no structured {tool_name} result."),
            )
        })
}

fn readiness_status(
    health: &Map<String, Value>,
    permissions: &Map<String, Value>,
) -> Result<ComputerUseStatus, CuaDriverError> {
    let empty_checks = Vec::new();
    let health_checks = health
        .get("checks")
        .and_then(Value::as_array)
        .unwrap_or(&empty_checks);
    let mut health_by_name: HashMap<&str, &str> = HashMap::new();
    for entry in health_checks {
        let Some(object) = entry.as_object() else {
            continue;
        };
        let (Some(name), Some(status)) = (
            object.get("name").and_then(Value::as_str),
            object.get("status").and_then(Value::as_str),
        ) else {
            continue;
        };
        health_by_name.insert(name, status);
    }
    let healthy = health.get("overall").and_then(Value::as_str) == Some("ok")
        && health.get("platform").and_then(Value::as_str) == Some("darwin")
        && health.get("schema_version").and_then(Value::as_str) == Some(CUA_DRIVER_TOOL_SCHEMA)
        && health.get("driver_version").and_then(Value::as_str) == Some(CUA_DRIVER_VERSION)
        && REQUIRED_HEALTH_CHECKS
            .iter()
            .all(|name| health_by_name.get(name) == Some(&"pass"));
    if !healthy {
        return Err(CuaDriverError::new(
            "incompatible_driver",
            "cua-driver health did not match Aiden's pinned contract.",
        ));
    }

    let accessibility = permissions.get("accessibility").and_then(Value::as_bool);
    let screen_recording_preflight = permissions.get("screen_recording").and_then(Value::as_bool);
    let screen_recording_capturable = permissions
        .get("screen_recording_capturable")
        .and_then(Value::as_bool);
    let source = permissions.get("source").and_then(Value::as_object);
    let source_valid = source.is_some_and(|source| {
        source.get("attribution").and_then(Value::as_str) == Some("host")
            && source.get("embedded").and_then(Value::as_bool) == Some(true)
            && source.get("host_bundle_id").and_then(Value::as_str)
                == Some(CUA_DRIVER_TCC_HOST_BUNDLE_ID)
            && source.get("disclaim_env").and_then(Value::as_bool) == Some(false)
    });
    if accessibility.is_none()
        || screen_recording_preflight.is_none()
        || screen_recording_capturable.is_none()
        || !source_valid
    {
        return Err(CuaDriverError::new(
            "incompatible_driver",
            "cua-driver returned an invalid permission report.",
        ));
    }
    // ScreenCaptureKit is the live capability probe. The cheaper TCC preflight
    // can be stale or answer for the wrong responsible process.
    let screen_recording = screen_recording_capturable.unwrap_or(false);
    let accessibility = accessibility.unwrap_or(false);

    if accessibility && screen_recording {
        return Ok(ComputerUseStatus {
            enabled: true,
            beta: true,
            state: ComputerUseStatusState::Ready,
            detail: "Accessibility and Screen Recording are available to Aiden Computer Use."
                .into(),
            ready: true,
            available: true,
            retryable: false,
            can_request_permissions: false,
            driver_version: Some(CUA_DRIVER_VERSION.into()),
            permissions: ComputerUsePermissions {
                accessibility: Some(accessibility),
                screen_recording: Some(screen_recording),
            },
        });
    }

    let mut missing: Vec<&str> = Vec::new();
    if !accessibility {
        missing.push("Accessibility");
    }
    if !screen_recording {
        missing.push("Screen Recording");
    }
    let detail = format!(
        "{} permission{} required.",
        missing.join(" and "),
        if missing.len() == 1 { " is" } else { "s are" }
    );
    Ok(ComputerUseStatus {
        enabled: true,
        beta: true,
        state: ComputerUseStatusState::PermissionRequired,
        detail,
        ready: false,
        available: true,
        retryable: true,
        can_request_permissions: true,
        driver_version: Some(CUA_DRIVER_VERSION.into()),
        permissions: ComputerUsePermissions {
            accessibility: Some(accessibility),
            screen_recording: Some(screen_recording),
        },
    })
}

fn request_cancelled_error() -> CuaDriverError {
    CuaDriverError::cancelled("Computer Use readiness request was cancelled.")
}

fn throw_if_cancelled(signal: &Option<CancellationToken>) -> Result<(), CuaDriverError> {
    if signal.as_ref().is_some_and(|token| token.is_cancelled()) {
        return Err(request_cancelled_error());
    }
    Ok(())
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ProbeKind {
    Status,
    Permission,
}

/// A completed or in-flight probe shared between concurrent callers.
struct InFlight {
    revision: u64,
    kind: ProbeKind,
    controller: CancellationToken,
    result: StdMutex<Option<ComputerUseStatus>>,
    completion: Notify,
}

struct CachedStatus {
    expires_at: u64,
    status: ComputerUseStatus,
}

#[derive(Default)]
struct StatusShutdownCompletion {
    finished: StdMutex<bool>,
    completion: Notify,
}

impl StatusShutdownCompletion {
    async fn wait(&self) {
        loop {
            let mut completed = Box::pin(self.completion.notified());
            completed.as_mut().enable();
            if *self.finished.lock().unwrap() {
                return;
            }
            completed.await;
        }
    }

    fn finish(&self) {
        *self.finished.lock().unwrap() = true;
        self.completion.notify_waiters();
    }
}

#[derive(Default)]
struct ProbeAdmissionState {
    closed: bool,
    in_flight: Option<Arc<InFlight>>,
    controllers: HashSet<CancellationToken>,
    shutdown: Option<Arc<StatusShutdownCompletion>>,
}

/// Readiness/permission probing with a short cache and one authenticated
/// helper per probe.
#[derive(Clone)]
pub struct ComputerUseStatusService {
    cached: Arc<StdMutex<Option<CachedStatus>>>,
    admission: Arc<StdMutex<ProbeAdmissionState>>,
    revision: Arc<AtomicU64>,
    runtime_enabled: Arc<StdMutex<Option<bool>>>,
    closed: Arc<AtomicBool>,
    signal_forwarders: Arc<AtomicU64>,
    cache_ms: u64,
    dependencies: Arc<dyn ComputerUseStatusDependencies>,
    #[cfg(test)]
    worker_start_gate: Arc<tokio::sync::Mutex<Option<tokio::sync::oneshot::Receiver<()>>>>,
}

impl ComputerUseStatusService {
    pub fn new(dependencies: Arc<dyn ComputerUseStatusDependencies>) -> Self {
        Self::with_cache(dependencies, DEFAULT_CACHE_MS)
    }

    pub fn with_cache(dependencies: Arc<dyn ComputerUseStatusDependencies>, cache_ms: u64) -> Self {
        Self {
            cached: Arc::new(StdMutex::new(None)),
            admission: Arc::new(StdMutex::new(ProbeAdmissionState::default())),
            revision: Arc::new(AtomicU64::new(0)),
            runtime_enabled: Arc::new(StdMutex::new(None)),
            closed: Arc::new(AtomicBool::new(false)),
            signal_forwarders: Arc::new(AtomicU64::new(0)),
            cache_ms,
            dependencies,
            #[cfg(test)]
            worker_start_gate: Arc::new(tokio::sync::Mutex::new(None)),
        }
    }

    pub fn invalidate(&self) {
        let admission = self.admission.lock().unwrap();
        *self.cached.lock().unwrap() = None;
        self.revision.fetch_add(1, Ordering::SeqCst);
        for controller in &admission.controllers {
            controller.cancel();
        }
    }

    /// Apply the live gate before a persistence transition can yield.
    pub fn set_runtime_enabled(&self, enabled: bool) {
        let admission = self.admission.lock().unwrap();
        if admission.closed {
            return;
        }
        *self.runtime_enabled.lock().unwrap() = Some(enabled);
        *self.cached.lock().unwrap() = None;
        self.revision.fetch_add(1, Ordering::SeqCst);
        for controller in &admission.controllers {
            controller.cancel();
        }
    }

    async fn enabled_at_revision(&self, revision: u64) -> Option<bool> {
        if self.closed.load(Ordering::SeqCst) {
            return Some(false);
        }
        if let Some(runtime) = *self.runtime_enabled.lock().unwrap() {
            return if revision == self.revision.load(Ordering::SeqCst) {
                Some(runtime)
            } else {
                None
            };
        }
        let persisted = self.dependencies.is_enabled().await;
        if self.closed.load(Ordering::SeqCst) {
            return Some(false);
        }
        if revision != self.revision.load(Ordering::SeqCst) {
            return None;
        }
        Some(self.runtime_enabled.lock().unwrap().unwrap_or(persisted))
    }

    pub async fn status(
        &self,
        force: bool,
        signal: Option<&CancellationToken>,
    ) -> Result<ComputerUseStatus, CuaDriverError> {
        loop {
            throw_if_cancelled(&signal.cloned())?;
            if self.closed.load(Ordering::SeqCst) {
                return Ok(fixed_error_status(&CuaDriverError::new(
                    "host_closed",
                    "closed",
                )));
            }
            let revision = self.revision.load(Ordering::SeqCst);
            let enabled = self.enabled_at_revision(revision).await;
            throw_if_cancelled(&signal.cloned())?;
            let Some(enabled) = enabled else {
                continue;
            };
            if !enabled {
                return Ok(disabled_status());
            }

            let now = self.dependencies.now();
            if !force {
                if let Some(cached) = self.cached.lock().unwrap().as_ref() {
                    if cached.expires_at > now {
                        return Ok(cached.status.clone());
                    }
                }
            }

            let claim = {
                let mut admission = self.admission.lock().unwrap();
                if admission.closed {
                    None
                } else if let Some(existing) = admission.in_flight.as_ref() {
                    Some((Arc::clone(existing), false))
                } else {
                    let controller = CancellationToken::new();
                    let probe = Arc::new(InFlight {
                        revision,
                        kind: ProbeKind::Status,
                        controller: controller.clone(),
                        result: StdMutex::new(None),
                        completion: Notify::new(),
                    });
                    admission.controllers.insert(controller);
                    admission.in_flight = Some(Arc::clone(&probe));
                    Some((probe, true))
                }
            };
            let Some((probe_in_flight, claimed)) = claim else {
                return Ok(fixed_error_status(&CuaDriverError::new(
                    "host_closed",
                    "closed",
                )));
            };
            if claimed {
                self.spawn_probe_worker(Arc::clone(&probe_in_flight), signal.cloned());
            }
            let result = self.await_in_flight(&probe_in_flight, signal).await?;
            if probe_in_flight.kind != ProbeKind::Status || probe_in_flight.revision != revision {
                continue;
            }
            throw_if_cancelled(&signal.cloned())?;
            if revision != self.revision.load(Ordering::SeqCst) {
                continue;
            }
            let still_enabled = self.enabled_at_revision(revision).await;
            throw_if_cancelled(&signal.cloned())?;
            let Some(still_enabled) = still_enabled else {
                continue;
            };
            if !still_enabled {
                return Ok(disabled_status());
            }
            *self.cached.lock().unwrap() = Some(CachedStatus {
                status: result.clone(),
                expires_at: self.dependencies.now() + self.cache_ms,
            });
            return Ok(result);
        }
    }

    pub async fn request_permissions(
        &self,
        signal: Option<&CancellationToken>,
    ) -> Result<ComputerUseStatus, CuaDriverError> {
        throw_if_cancelled(&signal.cloned())?;
        {
            let admission = self.admission.lock().unwrap();
            if admission.in_flight.as_ref().map(|value| value.kind) != Some(ProbeKind::Permission) {
                *self.cached.lock().unwrap() = None;
                self.revision.fetch_add(1, Ordering::SeqCst);
                for controller in &admission.controllers {
                    controller.cancel();
                }
            }
        }
        loop {
            throw_if_cancelled(&signal.cloned())?;
            if self.closed.load(Ordering::SeqCst) {
                return Ok(fixed_error_status(&CuaDriverError::new(
                    "host_closed",
                    "closed",
                )));
            }
            let revision = self.revision.load(Ordering::SeqCst);
            let enabled = self.enabled_at_revision(revision).await;
            throw_if_cancelled(&signal.cloned())?;
            let Some(enabled) = enabled else {
                continue;
            };
            if !enabled {
                return Ok(disabled_status());
            }

            let claim = {
                let mut admission = self.admission.lock().unwrap();
                if admission.closed {
                    None
                } else if let Some(existing) = admission.in_flight.as_ref() {
                    Some((Arc::clone(existing), false))
                } else {
                    let controller = CancellationToken::new();
                    let probe = Arc::new(InFlight {
                        revision,
                        kind: ProbeKind::Permission,
                        controller: controller.clone(),
                        result: StdMutex::new(None),
                        completion: Notify::new(),
                    });
                    admission.controllers.insert(controller);
                    admission.in_flight = Some(Arc::clone(&probe));
                    Some((probe, true))
                }
            };
            let Some((probe_in_flight, claimed)) = claim else {
                return Ok(fixed_error_status(&CuaDriverError::new(
                    "host_closed",
                    "closed",
                )));
            };
            if claimed {
                self.spawn_probe_worker(Arc::clone(&probe_in_flight), signal.cloned());
            }
            let result = self.await_in_flight(&probe_in_flight, signal).await?;
            if probe_in_flight.kind != ProbeKind::Permission || probe_in_flight.revision != revision
            {
                continue;
            }
            throw_if_cancelled(&signal.cloned())?;
            if revision != self.revision.load(Ordering::SeqCst) {
                continue;
            }
            let still_enabled = self.enabled_at_revision(revision).await;
            throw_if_cancelled(&signal.cloned())?;
            let Some(still_enabled) = still_enabled else {
                continue;
            };
            if !still_enabled {
                return Ok(disabled_status());
            }
            *self.cached.lock().unwrap() = Some(CachedStatus {
                status: result.clone(),
                expires_at: self.dependencies.now() + self.cache_ms,
            });
            return Ok(result);
        }
    }

    fn spawn_probe_worker(&self, in_flight: Arc<InFlight>, signal: Option<CancellationToken>) {
        let service = <ComputerUseStatusService as Clone>::clone(self);
        tokio::spawn(async move {
            #[cfg(test)]
            {
                let gate = service.worker_start_gate.lock().await.take();
                if let Some(gate) = gate {
                    let _ = gate.await;
                }
            }
            let outcome = AssertUnwindSafe(async {
                match in_flight.kind {
                    ProbeKind::Status => {
                        service
                            .probe(false, signal.as_ref(), &in_flight.controller)
                            .await
                    }
                    ProbeKind::Permission => {
                        service
                            .prompt_and_recheck(
                                in_flight.revision,
                                signal.as_ref(),
                                &in_flight.controller,
                            )
                            .await
                    }
                }
            })
            .catch_unwind()
            .await
            .unwrap_or_else(|_| {
                fixed_error_status(&CuaDriverError::new(
                    "status_probe_failed",
                    "Computer Use readiness probe failed.",
                ))
            });

            let mut admission = service.admission.lock().unwrap();
            if admission
                .in_flight
                .as_ref()
                .is_some_and(|value| Arc::ptr_eq(value, &in_flight))
            {
                admission.in_flight = None;
            }
            admission.controllers.remove(&in_flight.controller);
            drop(admission);
            *in_flight.result.lock().unwrap() = Some(outcome);
            in_flight.completion.notify_waiters();
        });
    }

    async fn await_in_flight(
        &self,
        existing: &Arc<InFlight>,
        signal: Option<&CancellationToken>,
    ) -> Result<ComputerUseStatus, CuaDriverError> {
        loop {
            let mut completed = Box::pin(existing.completion.notified());
            completed.as_mut().enable();
            if let Some(result) = existing.result.lock().unwrap().clone() {
                return Ok(result);
            }
            if let Some(signal) = signal {
                if signal.is_cancelled() {
                    return Err(request_cancelled_error());
                }
            }
            tokio::select! {
                _ = &mut completed => {}
                _ = async {
                    match signal {
                        Some(token) => token.cancelled().await,
                        None => std::future::pending::<()>().await,
                    }
                } => return Err(request_cancelled_error()),
            }
        }
    }

    async fn prompt_and_recheck(
        &self,
        revision: u64,
        signal: Option<&CancellationToken>,
        controller: &CancellationToken,
    ) -> ComputerUseStatus {
        let prompted = self.probe(true, signal, controller).await;
        if revision != self.revision.load(Ordering::SeqCst) || self.closed.load(Ordering::SeqCst) {
            return prompted;
        }
        let enabled = self.enabled_at_revision(revision).await;
        if enabled != Some(true) || !prompted.available {
            return if enabled == Some(false) {
                disabled_status()
            } else {
                prompted
            };
        }
        // The embedded child can retain a stale TCC answer. probe() has already
        // shut down its host before this fresh helper is constructed.
        self.probe(false, signal, controller).await
    }

    pub async fn shutdown(&self) {
        let completion = {
            let mut admission = self.admission.lock().unwrap();
            if let Some(existing) = admission.shutdown.as_ref() {
                Arc::clone(existing)
            } else {
                admission.closed = true;
                self.closed.store(true, Ordering::SeqCst);
                *self.cached.lock().unwrap() = None;
                self.revision.fetch_add(1, Ordering::SeqCst);
                for controller in &admission.controllers {
                    controller.cancel();
                }
                let pending = admission.in_flight.clone();
                let completion = Arc::new(StatusShutdownCompletion::default());
                let completion_for_task = Arc::clone(&completion);
                tokio::spawn(async move {
                    if let Some(existing) = pending {
                        loop {
                            let mut completed = Box::pin(existing.completion.notified());
                            completed.as_mut().enable();
                            if existing.result.lock().unwrap().is_some() {
                                break;
                            }
                            completed.await;
                        }
                    }
                    completion_for_task.finish();
                });
                admission.shutdown = Some(Arc::clone(&completion));
                completion
            }
        };
        completion.wait().await;
    }

    async fn probe(
        &self,
        prompt: bool,
        signal: Option<&CancellationToken>,
        controller: &CancellationToken,
    ) -> ComputerUseStatus {
        if signal.as_ref().is_some_and(|token| token.is_cancelled()) {
            return fixed_error_status(&request_cancelled_error());
        }
        if controller.is_cancelled() {
            return fixed_error_status(&request_cancelled_error());
        }
        let controller = controller.clone();
        let mut signal_forward_task = None;
        if let Some(signal) = signal {
            if signal.is_cancelled() {
                controller.cancel();
            } else {
                let signal = signal.clone();
                let controller = controller.clone();
                self.signal_forwarders.fetch_add(1, Ordering::SeqCst);
                let forwarders = Arc::clone(&self.signal_forwarders);
                let guard = SignalForwarderGuard(forwarders);
                signal_forward_task = Some(tokio::spawn(async move {
                    let _guard = guard;
                    signal.cancelled().await;
                    controller.cancel();
                }));
            }
        }
        let controller_for_timeout = controller.clone();
        let timeout_task = tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(PROBE_TIMEOUT_MS)).await;
            controller_for_timeout.cancel();
        });

        let mut host: Option<Box<dyn ComputerUseStatusHost>> = None;
        let outcome = AssertUnwindSafe(async {
            let created = self.dependencies.create_host(controller.clone()).await;
            let host_value = match created {
                Ok(host) => host,
                Err(error) => return fixed_error_status(&error),
            };
            host = Some(host_value);
            let session = match host.as_ref().unwrap().create_session(&controller).await {
                Ok(session) => session,
                Err(error) => return fixed_error_status(&error),
            };
            let options = StatusCallOptions {
                signal: Some(controller.clone()),
                timeout_ms: None,
            };
            let health = match session
                .call_tool(
                    "health_report",
                    serde_json::json!({ "include": REQUIRED_HEALTH_CHECKS }),
                    &options,
                )
                .await
            {
                Ok(result) => result,
                Err(error) => return fixed_error_status(&error),
            };
            let health = match structured_tool_result(&health, "health report") {
                Ok(health) => health,
                Err(error) => return fixed_error_status(&error),
            };
            let permissions = match session
                .call_tool(
                    "check_permissions",
                    serde_json::json!({ "prompt": prompt }),
                    &options,
                )
                .await
            {
                Ok(result) => result,
                Err(error) => return fixed_error_status(&error),
            };
            let permissions = match structured_tool_result(&permissions, "permission") {
                Ok(permissions) => permissions,
                Err(error) => return fixed_error_status(&error),
            };
            match readiness_status(health, permissions) {
                Ok(status) => status,
                Err(error) => fixed_error_status(&error),
            }
        })
        .catch_unwind()
        .await;

        timeout_task.abort();
        let _ = timeout_task.await;
        if let Some(signal_forward_task) = signal_forward_task {
            signal_forward_task.abort();
            let _ = signal_forward_task.await;
        }
        if let Some(host) = host {
            let shutdown = AssertUnwindSafe(async move { host.shutdown().await }).catch_unwind();
            let _ = timeout(Duration::from_millis(SHUTDOWN_GRACE_MS), shutdown).await;
        }
        outcome.unwrap_or_else(|_| {
            fixed_error_status(&CuaDriverError::new(
                "status_probe_failed",
                "Computer Use readiness probe failed.",
            ))
        })
    }
}

struct SignalForwarderGuard(Arc<AtomicU64>);

impl Drop for SignalForwarderGuard {
    fn drop(&mut self) {
        self.0.fetch_sub(1, Ordering::SeqCst);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::sync::atomic::AtomicU64;

    fn tool_result(structured: serde_json::Value) -> Value {
        json!({
            "content": [{ "type": "text", "text": "status" }],
            "structuredContent": structured,
        })
    }

    fn health(overrides: serde_json::Value) -> Value {
        let mut base = json!({
            "overall": "ok",
            "platform": "darwin",
            "schema_version": "1",
            "driver_version": "0.8.3",
            "checks": [
                { "name": "binary_version", "status": "pass" },
                { "name": "platform_supported", "status": "pass" },
                { "name": "session_active", "status": "pass" },
            ],
        });
        if let Some(record) = overrides.as_object() {
            for (key, value) in record {
                base[key] = value.clone();
            }
        }
        base
    }

    fn permissions(
        accessibility: bool,
        screen_recording: bool,
        overrides: serde_json::Value,
    ) -> Value {
        let mut base = json!({
            "accessibility": accessibility,
            "screen_recording": screen_recording,
            "screen_recording_capturable": screen_recording,
            "source": {
                "attribution": "host",
                "embedded": true,
                "host_bundle_id": CUA_DRIVER_TCC_HOST_BUNDLE_ID,
                "disclaim_env": false,
            },
        });
        if let Some(record) = overrides.as_object() {
            for (key, value) in record {
                base[key] = value.clone();
            }
        }
        base
    }

    struct FakeSession {
        calls: Arc<StdMutex<Vec<(String, Value)>>>,
        handler: Arc<dyn Fn(&str, &Value) -> Value + Send + Sync>,
    }

    impl ComputerUseStatusSession for FakeSession {
        fn call_tool(
            &self,
            name: &str,
            args: Value,
            _options: &StatusCallOptions,
        ) -> BoxFuture<'static, Result<Value, CuaDriverError>> {
            let calls = Arc::clone(&self.calls);
            let name = name.to_string();
            let handler = Arc::clone(&self.handler);
            Box::pin(async move {
                calls.lock().unwrap().push((name.clone(), args.clone()));
                Ok(handler(&name, &args))
            })
        }
    }

    struct FakeHost {
        calls: Arc<StdMutex<Vec<(String, Value)>>>,
        handler: Arc<dyn Fn(&str, &Value) -> Value + Send + Sync>,
        on_shutdown: Option<Arc<dyn Fn() + Send + Sync>>,
    }

    impl ComputerUseStatusHost for FakeHost {
        fn create_session(
            &self,
            _signal: &CancellationToken,
        ) -> BoxFuture<'static, Result<Box<dyn ComputerUseStatusSession>, CuaDriverError>> {
            let session = FakeSession {
                calls: Arc::clone(&self.calls),
                handler: Arc::clone(&self.handler),
            };
            Box::pin(async { Ok(Box::new(session) as Box<dyn ComputerUseStatusSession>) })
        }
        fn shutdown(&self) -> BoxFuture<'static, ()> {
            let on_shutdown = self.on_shutdown.clone();
            Box::pin(async move {
                if let Some(on_shutdown) = on_shutdown {
                    on_shutdown();
                }
            })
        }
    }

    struct FakeDeps {
        enabled: Arc<StdMutex<bool>>,
        hosts: Arc<AtomicU64>,
        host_factory: Arc<dyn Fn() -> Box<dyn ComputerUseStatusHost> + Send + Sync>,
    }

    impl FakeDeps {
        fn new(
            enabled: bool,
            host_factory: Arc<dyn Fn() -> Box<dyn ComputerUseStatusHost> + Send + Sync>,
        ) -> Self {
            Self {
                enabled: Arc::new(StdMutex::new(enabled)),
                hosts: Arc::new(AtomicU64::new(0)),
                host_factory,
            }
        }
    }

    impl ComputerUseStatusDependencies for FakeDeps {
        fn is_enabled(&self) -> BoxFuture<'static, bool> {
            let enabled = Arc::clone(&self.enabled);
            Box::pin(async move { *enabled.lock().unwrap() })
        }
        fn create_host(
            &self,
            _signal: CancellationToken,
        ) -> BoxFuture<'static, Result<Box<dyn ComputerUseStatusHost>, CuaDriverError>> {
            self.hosts.fetch_add(1, Ordering::SeqCst);
            let host = (self.host_factory)();
            Box::pin(async { Ok(host) })
        }
        fn now(&self) -> u64 {
            1_000
        }
    }

    fn ready_host() -> Arc<dyn Fn() -> Box<dyn ComputerUseStatusHost> + Send + Sync> {
        let calls = Arc::new(StdMutex::new(Vec::new()));
        let handler: Arc<dyn Fn(&str, &Value) -> Value + Send + Sync> = Arc::new(|name, _| {
            if name == "health_report" {
                tool_result(health(json!({})))
            } else {
                tool_result(permissions(true, true, json!({})))
            }
        });
        Arc::new(move || {
            Box::new(FakeHost {
                calls: Arc::clone(&calls),
                handler: Arc::clone(&handler),
                on_shutdown: None,
            })
        })
    }

    #[tokio::test]
    async fn keeps_the_disabled_beta_inert_without_constructing_a_privileged_host() {
        let deps = Arc::new(FakeDeps::new(
            false,
            Arc::new(|| {
                panic!("must not run");
            }),
        ));
        let service = ComputerUseStatusService::new(deps.clone());
        let status = service.status(false, None).await.unwrap();
        assert_eq!(status.state, ComputerUseStatusState::Disabled);
        assert!(!status.ready);
        assert_eq!(deps.hosts.load(Ordering::SeqCst), 0);
    }

    #[tokio::test]
    async fn accepts_only_the_pinned_healthy_driver_with_both_permissions() {
        let calls = Arc::new(StdMutex::new(Vec::new()));
        let handler: Arc<dyn Fn(&str, &Value) -> Value + Send + Sync> = Arc::new(|name, _| {
            if name == "health_report" {
                tool_result(health(json!({})))
            } else {
                tool_result(permissions(true, true, json!({})))
            }
        });
        let factory_calls = Arc::clone(&calls);
        let factory_handler = Arc::clone(&handler);
        let shutdowns = Arc::new(AtomicU64::new(0));
        let shutdown_counter = Arc::clone(&shutdowns);
        let host_factory: Arc<dyn Fn() -> Box<dyn ComputerUseStatusHost> + Send + Sync> =
            Arc::new(move || {
                let counter = Arc::clone(&shutdown_counter);
                Box::new(FakeHost {
                    calls: Arc::clone(&factory_calls),
                    handler: Arc::clone(&factory_handler),
                    on_shutdown: Some(Arc::new(move || {
                        counter.fetch_add(1, Ordering::SeqCst);
                    })),
                })
            });
        let deps = Arc::new(FakeDeps::new(true, host_factory));
        let service = ComputerUseStatusService::new(deps.clone());

        let first = service.status(false, None).await.unwrap();
        let second = service.status(false, None).await.unwrap();
        let cached = service.status(false, None).await.unwrap();
        assert_eq!(first.state, ComputerUseStatusState::Ready);
        assert!(first.ready);
        assert_eq!(first.driver_version.as_deref(), Some("0.8.3"));
        assert_eq!(cached, first);
        assert_eq!(second, first);
        assert_eq!(deps.hosts.load(Ordering::SeqCst), 1);
        assert_eq!(shutdowns.load(Ordering::SeqCst), 1);
        let recorded = calls.lock().unwrap().clone();
        assert_eq!(recorded.len(), 2);
        assert_eq!(recorded[0].0, "health_report");
        assert_eq!(
            recorded[0].1,
            json!({ "include": ["binary_version", "platform_supported", "session_active"] })
        );
        assert_eq!(recorded[1].0, "check_permissions");
        assert_eq!(recorded[1].1, json!({ "prompt": false }));
    }

    #[tokio::test]
    async fn a_completed_probe_reaps_its_caller_signal_forwarder() {
        let deps = Arc::new(FakeDeps::new(true, ready_host()));
        let service = ComputerUseStatusService::new(deps);
        let caller = CancellationToken::new();

        let status = service.status(false, Some(&caller)).await.unwrap();
        assert_eq!(status.state, ComputerUseStatusState::Ready);
        assert_eq!(service.signal_forwarders.load(Ordering::SeqCst), 0);

        caller.cancel();
        tokio::task::yield_now().await;
        assert_eq!(service.signal_forwarders.load(Ordering::SeqCst), 0);
    }

    #[tokio::test]
    async fn reports_exact_missing_permissions_and_prompts_only_on_an_explicit_request() {
        let calls = Arc::new(StdMutex::new(Vec::new()));
        let accessibility = Arc::new(StdMutex::new(false));
        let accessibility_holder = Arc::clone(&accessibility);
        let calls_holder = Arc::clone(&calls);
        let handler: Arc<dyn Fn(&str, &Value) -> Value + Send + Sync> =
            Arc::new(move |name, args| {
                if name == "health_report" {
                    return tool_result(health(json!({})));
                }
                if args.get("prompt").and_then(Value::as_bool) == Some(true) {
                    *accessibility_holder.lock().unwrap() = true;
                }
                let granted = *accessibility_holder.lock().unwrap();
                let _ = Arc::clone(&calls_holder);
                tool_result(permissions(granted, false, json!({})))
            });
        let factory_calls = Arc::clone(&calls);
        let factory_handler = Arc::clone(&handler);
        let host_factory: Arc<dyn Fn() -> Box<dyn ComputerUseStatusHost> + Send + Sync> =
            Arc::new(move || {
                Box::new(FakeHost {
                    calls: Arc::clone(&factory_calls),
                    handler: Arc::clone(&factory_handler),
                    on_shutdown: None,
                })
            });
        let deps = Arc::new(FakeDeps::new(true, host_factory));
        let service = ComputerUseStatusService::new(deps.clone());

        let initial = service.status(false, None).await.unwrap();
        assert_eq!(initial.state, ComputerUseStatusState::PermissionRequired);
        assert!(initial.can_request_permissions);
        assert_eq!(initial.permissions.accessibility, Some(false));
        assert!(initial
            .detail
            .contains("Accessibility and Screen Recording permissions are required"));

        let requested = service.request_permissions(None).await.unwrap();
        assert_eq!(requested.state, ComputerUseStatusState::PermissionRequired);
        assert_eq!(requested.permissions.accessibility, Some(true));
        assert_eq!(requested.permissions.screen_recording, Some(false));
        let prompts: Vec<Option<bool>> = calls
            .lock()
            .unwrap()
            .iter()
            .filter(|(name, _)| name == "check_permissions")
            .map(|(_, args)| args.get("prompt").and_then(Value::as_bool))
            .collect();
        assert_eq!(prompts, vec![Some(false), Some(true), Some(false)]);
    }

    #[tokio::test]
    async fn requires_the_live_screencapturekit_capability_rather_than_a_stale_preflight() {
        let handler: Arc<dyn Fn(&str, &Value) -> Value + Send + Sync> = Arc::new(|name, _| {
            if name == "health_report" {
                tool_result(health(json!({})))
            } else {
                tool_result(permissions(
                    true,
                    true,
                    json!({ "screen_recording_capturable": false }),
                ))
            }
        });
        let host_factory: Arc<dyn Fn() -> Box<dyn ComputerUseStatusHost> + Send + Sync> =
            Arc::new(move || {
                Box::new(FakeHost {
                    calls: Arc::new(StdMutex::new(Vec::new())),
                    handler: Arc::clone(&handler),
                    on_shutdown: None,
                })
            });
        let deps = Arc::new(FakeDeps::new(true, host_factory));
        let service = ComputerUseStatusService::new(deps.clone());
        let status = service.status(false, None).await.unwrap();
        assert_eq!(status.state, ComputerUseStatusState::PermissionRequired);
        assert!(!status.ready);
        assert_eq!(status.permissions.screen_recording, Some(false));
    }

    #[tokio::test]
    async fn rejects_a_permission_report_not_attributed_to_the_pinned_embedded_host() {
        let handler: Arc<dyn Fn(&str, &Value) -> Value + Send + Sync> = Arc::new(|name, _| {
            if name == "health_report" {
                tool_result(health(json!({})))
            } else {
                tool_result(permissions(
                    true,
                    true,
                    json!({
                        "source": {
                            "attribution": "caller",
                            "embedded": false,
                            "host_bundle_id": "com.example.other",
                            "disclaim_env": false,
                        }
                    }),
                ))
            }
        });
        let host_factory: Arc<dyn Fn() -> Box<dyn ComputerUseStatusHost> + Send + Sync> =
            Arc::new(move || {
                Box::new(FakeHost {
                    calls: Arc::new(StdMutex::new(Vec::new())),
                    handler: Arc::clone(&handler),
                    on_shutdown: None,
                })
            });
        let deps = Arc::new(FakeDeps::new(true, host_factory));
        let service = ComputerUseStatusService::new(deps.clone());
        assert_eq!(
            service.status(false, None).await.unwrap().state,
            ComputerUseStatusState::Incompatible
        );
    }

    #[tokio::test]
    async fn fails_closed_when_health_payloads_drift() {
        let handler: Arc<dyn Fn(&str, &Value) -> Value + Send + Sync> = Arc::new(|name, _| {
            if name == "health_report" {
                tool_result(health(json!({ "driver_version": "0.8.4" })))
            } else {
                tool_result(permissions(true, true, json!({})))
            }
        });
        let host_factory: Arc<dyn Fn() -> Box<dyn ComputerUseStatusHost> + Send + Sync> =
            Arc::new(move || {
                Box::new(FakeHost {
                    calls: Arc::new(StdMutex::new(Vec::new())),
                    handler: Arc::clone(&handler),
                    on_shutdown: None,
                })
            });
        let deps = Arc::new(FakeDeps::new(true, host_factory));
        let service = ComputerUseStatusService::new(deps.clone());
        let status = service.status(false, None).await.unwrap();
        assert_eq!(status.state, ComputerUseStatusState::Incompatible);
        assert!(!status.ready);
        assert!(!status.retryable);
    }
    #[tokio::test]
    async fn a_delayed_enabled_snapshot_cannot_launch_a_probe_after_gate_invalidation() {
        struct BlockedDeps {
            release: Arc<tokio::sync::Mutex<Option<tokio::sync::oneshot::Receiver<bool>>>>,
            hosts: Arc<AtomicU64>,
        }
        impl ComputerUseStatusDependencies for BlockedDeps {
            fn is_enabled(&self) -> BoxFuture<'static, bool> {
                let release = Arc::clone(&self.release);
                Box::pin(async move {
                    let receiver = { release.lock().await.take() };
                    match receiver {
                        Some(receiver) => receiver.await.unwrap(),
                        None => true,
                    }
                })
            }
            fn create_host(
                &self,
                _signal: CancellationToken,
            ) -> BoxFuture<'static, Result<Box<dyn ComputerUseStatusHost>, CuaDriverError>>
            {
                let factory = ready_host();
                self.hosts.fetch_add(1, Ordering::SeqCst);
                Box::pin(async move { Ok(factory()) })
            }
            fn now(&self) -> u64 {
                1_000
            }
        }
        let (sender, receiver) = tokio::sync::oneshot::channel();
        let deps = Arc::new(BlockedDeps {
            release: Arc::new(tokio::sync::Mutex::new(Some(receiver))),
            hosts: Arc::new(AtomicU64::new(0)),
        });
        let service = ComputerUseStatusService::new(deps.clone());
        let stale = service.status(false, None);
        tokio::task::yield_now().await;
        service.set_runtime_enabled(false);
        sender.send(true).unwrap();
        let status = stale.await.unwrap();
        assert_eq!(status.state, ComputerUseStatusState::Disabled);
        assert_eq!(deps.hosts.load(Ordering::SeqCst), 0);
    }

    #[tokio::test]
    async fn shutdown_aborts_and_awaits_a_probe_owned_helper_without_permitting_relaunch() {
        struct HangingHost;
        impl ComputerUseStatusHost for HangingHost {
            fn create_session(
                &self,
                signal: &CancellationToken,
            ) -> BoxFuture<'static, Result<Box<dyn ComputerUseStatusSession>, CuaDriverError>>
            {
                let signal = signal.clone();
                Box::pin(async move {
                    signal.cancelled().await;
                    Err(CuaDriverError::cancelled("cancelled"))
                })
            }
        }
        struct HangingDeps {
            hosts: Arc<AtomicU64>,
        }
        impl ComputerUseStatusDependencies for HangingDeps {
            fn is_enabled(&self) -> BoxFuture<'static, bool> {
                Box::pin(async { true })
            }
            fn create_host(
                &self,
                _signal: CancellationToken,
            ) -> BoxFuture<'static, Result<Box<dyn ComputerUseStatusHost>, CuaDriverError>>
            {
                self.hosts.fetch_add(1, Ordering::SeqCst);
                Box::pin(async { Ok(Box::new(HangingHost) as Box<dyn ComputerUseStatusHost>) })
            }
            fn now(&self) -> u64 {
                1_000
            }
        }
        let deps = Arc::new(HangingDeps {
            hosts: Arc::new(AtomicU64::new(0)),
        });
        let service = ComputerUseStatusService::new(deps.clone());
        let probing = service.status(false, None);
        tokio::pin!(probing);
        // Drive the probe to its hanging createSession before shutdown.
        tokio::select! {
            _ = &mut probing => {}
            _ = tokio::time::sleep(Duration::from_millis(10)) => {}
        }
        service.shutdown().await;
        let status = probing.await.unwrap();
        assert_eq!(deps.hosts.load(Ordering::SeqCst), 1);
        assert_eq!(status.state, ComputerUseStatusState::Error);
        assert_eq!(
            service.status(false, None).await.unwrap().state,
            ComputerUseStatusState::Error
        );
        assert_eq!(deps.hosts.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn caller_cancellation_rejects_permission_prompting_without_relaunching_a_helper() {
        struct HangingCallSession;
        impl ComputerUseStatusSession for HangingCallSession {
            fn call_tool(
                &self,
                _name: &str,
                _args: Value,
                options: &StatusCallOptions,
            ) -> BoxFuture<'static, Result<Value, CuaDriverError>> {
                let signal = options.signal.clone();
                Box::pin(async move {
                    match signal {
                        Some(signal) => {
                            signal.cancelled().await;
                            Err(CuaDriverError::cancelled("document replaced"))
                        }
                        None => Err(CuaDriverError::cancelled("cancelled")),
                    }
                })
            }
        }
        struct PromptHost;
        impl ComputerUseStatusHost for PromptHost {
            fn create_session(
                &self,
                _signal: &CancellationToken,
            ) -> BoxFuture<'static, Result<Box<dyn ComputerUseStatusSession>, CuaDriverError>>
            {
                Box::pin(async {
                    Ok(Box::new(HangingCallSession) as Box<dyn ComputerUseStatusSession>)
                })
            }
        }
        struct PromptDeps {
            hosts: Arc<AtomicU64>,
        }
        impl ComputerUseStatusDependencies for PromptDeps {
            fn is_enabled(&self) -> BoxFuture<'static, bool> {
                Box::pin(async { true })
            }
            fn create_host(
                &self,
                _signal: CancellationToken,
            ) -> BoxFuture<'static, Result<Box<dyn ComputerUseStatusHost>, CuaDriverError>>
            {
                self.hosts.fetch_add(1, Ordering::SeqCst);
                Box::pin(async { Ok(Box::new(PromptHost) as Box<dyn ComputerUseStatusHost>) })
            }
            fn now(&self) -> u64 {
                1_000
            }
        }
        let deps = Arc::new(PromptDeps {
            hosts: Arc::new(AtomicU64::new(0)),
        });
        let service = ComputerUseStatusService::new(deps.clone());
        let caller = CancellationToken::new();
        let request = service.request_permissions(Some(&caller));
        tokio::pin!(request);
        // Drive the permission probe to its hanging call before cancelling.
        tokio::select! {
            _ = &mut request => {}
            _ = tokio::time::sleep(Duration::from_millis(10)) => {}
        }
        caller.cancel();
        let error = request.await.unwrap_err();
        assert!(error.message.contains("cancelled"));
        assert_eq!(deps.hosts.load(Ordering::SeqCst), 1);
    }

    struct CancelBlockingSession {
        started: Arc<tokio::sync::Semaphore>,
    }

    impl ComputerUseStatusSession for CancelBlockingSession {
        fn call_tool(
            &self,
            _name: &str,
            _args: Value,
            options: &StatusCallOptions,
        ) -> BoxFuture<'static, Result<Value, CuaDriverError>> {
            let started = Arc::clone(&self.started);
            let signal = options.signal.clone().expect("probe signal");
            Box::pin(async move {
                started.add_permits(1);
                signal.cancelled().await;
                Err(CuaDriverError::cancelled("probe cancelled"))
            })
        }
    }

    struct CancelBlockingHost {
        started: Arc<tokio::sync::Semaphore>,
        shutdowns: Arc<AtomicU64>,
    }

    impl ComputerUseStatusHost for CancelBlockingHost {
        fn create_session(
            &self,
            _signal: &CancellationToken,
        ) -> BoxFuture<'static, Result<Box<dyn ComputerUseStatusSession>, CuaDriverError>> {
            let session = CancelBlockingSession {
                started: Arc::clone(&self.started),
            };
            Box::pin(async move { Ok(Box::new(session) as Box<dyn ComputerUseStatusSession>) })
        }

        fn shutdown(&self) -> BoxFuture<'static, ()> {
            let shutdowns = Arc::clone(&self.shutdowns);
            Box::pin(async move {
                shutdowns.fetch_add(1, Ordering::SeqCst);
            })
        }
    }

    struct CancelBlockingDeps {
        started: Arc<tokio::sync::Semaphore>,
        hosts: Arc<AtomicU64>,
        shutdowns: Arc<AtomicU64>,
    }

    impl ComputerUseStatusDependencies for CancelBlockingDeps {
        fn is_enabled(&self) -> BoxFuture<'static, bool> {
            Box::pin(async { true })
        }

        fn create_host(
            &self,
            _signal: CancellationToken,
        ) -> BoxFuture<'static, Result<Box<dyn ComputerUseStatusHost>, CuaDriverError>> {
            self.hosts.fetch_add(1, Ordering::SeqCst);
            let host = CancelBlockingHost {
                started: Arc::clone(&self.started),
                shutdowns: Arc::clone(&self.shutdowns),
            };
            Box::pin(async move { Ok(Box::new(host) as Box<dyn ComputerUseStatusHost>) })
        }
    }

    async fn dropped_first_probe_caller_is_cleanup_safe(permission: bool) {
        let started = Arc::new(tokio::sync::Semaphore::new(0));
        let deps = Arc::new(CancelBlockingDeps {
            started: Arc::clone(&started),
            hosts: Arc::new(AtomicU64::new(0)),
            shutdowns: Arc::new(AtomicU64::new(0)),
        });
        let service = Arc::new(ComputerUseStatusService::new(deps.clone()));
        let caller = CancellationToken::new();
        let first_service = Arc::clone(&service);
        let first_signal = caller.clone();
        let first = tokio::spawn(async move {
            if permission {
                first_service.request_permissions(Some(&first_signal)).await
            } else {
                first_service.status(true, Some(&first_signal)).await
            }
        });
        started.acquire().await.unwrap().forget();
        first.abort();
        let _ = first.await;

        let second_service = Arc::clone(&service);
        let second = tokio::spawn(async move {
            if permission {
                second_service.request_permissions(None).await
            } else {
                second_service.status(true, None).await
            }
        });
        tokio::task::yield_now().await;
        tokio::time::timeout(Duration::from_secs(1), service.shutdown())
            .await
            .expect("shutdown must join the detached probe worker");
        let status = tokio::time::timeout(Duration::from_secs(1), second)
            .await
            .expect("later caller must not hang")
            .unwrap()
            .unwrap();

        assert_eq!(status.state, ComputerUseStatusState::Error);
        assert_eq!(deps.hosts.load(Ordering::SeqCst), 1);
        assert_eq!(deps.shutdowns.load(Ordering::SeqCst), 1);
        assert_eq!(service.signal_forwarders.load(Ordering::SeqCst), 0);
        let admission = service.admission.lock().unwrap();
        assert!(admission.controllers.is_empty());
        assert!(admission.in_flight.is_none());
    }

    #[tokio::test]
    async fn dropping_the_first_status_caller_cannot_orphan_the_shared_probe() {
        dropped_first_probe_caller_is_cleanup_safe(false).await;
    }

    #[tokio::test]
    async fn dropping_the_first_permission_caller_cannot_orphan_the_shared_probe() {
        dropped_first_probe_caller_is_cleanup_safe(true).await;
    }

    #[tokio::test]
    async fn a_panicking_host_still_publishes_and_shuts_down_exactly_once() {
        struct PanicHost {
            shutdowns: Arc<AtomicU64>,
        }
        impl ComputerUseStatusHost for PanicHost {
            fn create_session(
                &self,
                _signal: &CancellationToken,
            ) -> BoxFuture<'static, Result<Box<dyn ComputerUseStatusSession>, CuaDriverError>>
            {
                panic!("injected host panic")
            }

            fn shutdown(&self) -> BoxFuture<'static, ()> {
                let shutdowns = Arc::clone(&self.shutdowns);
                Box::pin(async move {
                    shutdowns.fetch_add(1, Ordering::SeqCst);
                })
            }
        }
        struct PanicDeps {
            shutdowns: Arc<AtomicU64>,
        }
        impl ComputerUseStatusDependencies for PanicDeps {
            fn is_enabled(&self) -> BoxFuture<'static, bool> {
                Box::pin(async { true })
            }

            fn create_host(
                &self,
                _signal: CancellationToken,
            ) -> BoxFuture<'static, Result<Box<dyn ComputerUseStatusHost>, CuaDriverError>>
            {
                let host = PanicHost {
                    shutdowns: Arc::clone(&self.shutdowns),
                };
                Box::pin(async move { Ok(Box::new(host) as Box<dyn ComputerUseStatusHost>) })
            }
        }

        let shutdowns = Arc::new(AtomicU64::new(0));
        let service = ComputerUseStatusService::new(Arc::new(PanicDeps {
            shutdowns: Arc::clone(&shutdowns),
        }));
        let caller = CancellationToken::new();
        let status =
            tokio::time::timeout(Duration::from_secs(1), service.status(true, Some(&caller)))
                .await
                .expect("panic must be published")
                .unwrap();

        assert_eq!(status.state, ComputerUseStatusState::Error);
        assert_eq!(shutdowns.load(Ordering::SeqCst), 1);
        assert_eq!(service.signal_forwarders.load(Ordering::SeqCst), 0);
        let admission = service.admission.lock().unwrap();
        assert!(admission.controllers.is_empty());
        assert!(admission.in_flight.is_none());
    }

    #[tokio::test]
    async fn sequential_shallow_clone_shutdowns_share_completed_state() {
        let service = ComputerUseStatusService::new(Arc::new(FakeDeps::new(false, ready_host())));
        let clone = service.clone();

        service.shutdown().await;
        let first_completion = service
            .admission
            .lock()
            .unwrap()
            .shutdown
            .clone()
            .expect("shutdown completion");
        clone.shutdown().await;
        let second_completion = clone
            .admission
            .lock()
            .unwrap()
            .shutdown
            .clone()
            .expect("shutdown completion");

        assert!(Arc::ptr_eq(&first_completion, &second_completion));
        assert!(*first_completion.finished.lock().unwrap());
    }

    #[tokio::test]
    async fn concurrent_shallow_clone_shutdowns_share_one_completion() {
        let service = ComputerUseStatusService::new(Arc::new(FakeDeps::new(false, ready_host())));
        let first = service.clone();
        let second = service.clone();

        tokio::time::timeout(Duration::from_secs(1), async move {
            tokio::join!(first.shutdown(), second.shutdown());
        })
        .await
        .expect("concurrent shutdowns must complete");

        let admission = service.admission.lock().unwrap();
        assert!(admission.closed);
        assert!(*admission
            .shutdown
            .as_ref()
            .expect("shutdown completion")
            .finished
            .lock()
            .unwrap());
    }

    #[tokio::test]
    async fn shutdown_seals_a_caller_blocked_before_probe_claim() {
        struct PreClaimDeps {
            read_started: Arc<tokio::sync::Semaphore>,
            read_release: Arc<tokio::sync::Mutex<Option<tokio::sync::oneshot::Receiver<()>>>>,
            hosts: Arc<AtomicU64>,
        }
        impl ComputerUseStatusDependencies for PreClaimDeps {
            fn is_enabled(&self) -> BoxFuture<'static, bool> {
                let read_started = Arc::clone(&self.read_started);
                let read_release = Arc::clone(&self.read_release);
                Box::pin(async move {
                    read_started.add_permits(1);
                    if let Some(release) = read_release.lock().await.take() {
                        let _ = release.await;
                    }
                    true
                })
            }

            fn create_host(
                &self,
                _signal: CancellationToken,
            ) -> BoxFuture<'static, Result<Box<dyn ComputerUseStatusHost>, CuaDriverError>>
            {
                self.hosts.fetch_add(1, Ordering::SeqCst);
                let factory = ready_host();
                Box::pin(async move { Ok(factory()) })
            }
        }

        let (release, blocked) = tokio::sync::oneshot::channel();
        let started = Arc::new(tokio::sync::Semaphore::new(0));
        let hosts = Arc::new(AtomicU64::new(0));
        let service = Arc::new(ComputerUseStatusService::new(Arc::new(PreClaimDeps {
            read_started: Arc::clone(&started),
            read_release: Arc::new(tokio::sync::Mutex::new(Some(blocked))),
            hosts: Arc::clone(&hosts),
        })));
        let status_service = Arc::clone(&service);
        let status = tokio::spawn(async move { status_service.status(true, None).await });
        started.acquire().await.unwrap().forget();

        tokio::time::timeout(Duration::from_secs(1), service.shutdown())
            .await
            .expect("shutdown must not wait for an unclaimed probe");
        release.send(()).unwrap();
        let _ = tokio::time::timeout(Duration::from_secs(1), status)
            .await
            .expect("pre-claim caller must complete")
            .unwrap()
            .unwrap();

        assert_eq!(hosts.load(Ordering::SeqCst), 0);
        let admission = service.admission.lock().unwrap();
        assert!(admission.closed);
        assert!(admission.controllers.is_empty());
        assert!(admission.in_flight.is_none());
    }

    #[tokio::test]
    async fn shutdown_cancels_a_claim_reserved_before_worker_launch() {
        let deps = Arc::new(FakeDeps::new(true, ready_host()));
        let service = Arc::new(ComputerUseStatusService::new(deps.clone()));
        let (release, blocked) = tokio::sync::oneshot::channel();
        *service.worker_start_gate.lock().await = Some(blocked);
        let status_service = Arc::clone(&service);
        let status = tokio::spawn(async move { status_service.status(true, None).await });
        loop {
            if service.admission.lock().unwrap().in_flight.is_some() {
                break;
            }
            tokio::task::yield_now().await;
        }

        let shutdown_service = Arc::clone(&service);
        let shutdown = tokio::spawn(async move { shutdown_service.shutdown().await });
        loop {
            if service.closed.load(Ordering::SeqCst) {
                break;
            }
            tokio::task::yield_now().await;
        }
        assert_eq!(deps.hosts.load(Ordering::SeqCst), 0);
        release.send(()).unwrap();
        tokio::time::timeout(Duration::from_secs(1), shutdown)
            .await
            .expect("shutdown must join the pre-cancelled worker")
            .unwrap();
        let _ = tokio::time::timeout(Duration::from_secs(1), status)
            .await
            .expect("claiming caller must complete")
            .unwrap()
            .unwrap();

        assert_eq!(deps.hosts.load(Ordering::SeqCst), 0);
        let admission = service.admission.lock().unwrap();
        assert!(admission.controllers.is_empty());
        assert!(admission.in_flight.is_none());
    }
}
