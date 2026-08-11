//! App-owned Computer Use authority.
//!
//! This is the sole production seam for the global gate, chat-local opt-in,
//! readiness probes, and generation/session cancellation. Construction is
//! deliberately inert: helper resolution, TCC checks, and permission prompts
//! happen only through explicit status/request calls.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use aiden_computer_use::{
    ChatComputerUseMutationGate, ComputerUseApprovalDecision, ComputerUseApprovalDescriptor,
    ComputerUseApprovalFacts, ComputerUseApprovalGate, ComputerUseApprovalRequest,
    ComputerUseApprovalWaiter, ComputerUseController, ComputerUseDriver, ComputerUseExecutionError,
    ComputerUseExecutionResult, ComputerUseGenerationGate, ComputerUseSettingsCoordinator,
    ComputerUseSettingsDependencies, ComputerUseSettingsError, ComputerUseStatus,
    ComputerUseStatusDependencies, ComputerUseStatusService, ComputerUseStatusState,
};
use aiden_data::chat_store::ChatStore;
use aiden_data::config_store::ConfigStore;
use futures::future::BoxFuture;
use serde_json::Value;
use tokio_util::sync::CancellationToken;

pub const COMPUTER_USE_ENABLED_KEY: &str = "computerUseEnabled";

/// Proof that a permission request originates at an explicit user action.
/// Status reads do not need this token because they can never prompt.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ComputerUseUserInitiated {
    _explicit: (),
}

impl ComputerUseUserInitiated {
    pub fn explicit() -> Self {
        Self { _explicit: () }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ComputerUseGenerationIdentity {
    pub generation_id: String,
    pub chat_id: String,
    pub workspace_id: Option<String>,
    pub provider_id: String,
}

#[derive(Clone)]
pub struct ComputerUseGenerationLease {
    pub identity: ComputerUseGenerationIdentity,
    pub gate_revision: u64,
    cancellation: CancellationToken,
}

impl ComputerUseGenerationLease {
    pub fn cancellation(&self) -> CancellationToken {
        self.cancellation.clone()
    }

    #[cfg(test)]
    pub fn is_cancelled(&self) -> bool {
        self.cancellation.is_cancelled()
    }
}

#[derive(Debug, thiserror::Error)]
pub enum ComputerUseAuthorityError {
    #[error("Computer Use is disabled globally.")]
    GloballyDisabled,
    #[error("Computer Use is disabled for this chat.")]
    ChatDisabled,
    #[error("Computer Use is not ready. {0}")]
    NotReady(String),
    #[error("Computer Use changed while this response was starting.")]
    StaleGeneration,
    #[error("Computer Use is already changing for this chat.")]
    ChatMutationBusy,
    #[error(transparent)]
    Settings(#[from] ComputerUseSettingsError),
    #[error("Computer Use could not start its pinned helper. {0}")]
    Controller(String),
    #[error("{0}")]
    Store(String),
}

/// Object-safe generation controller boundary. The raw model arguments never
/// leave the background runtime through this interface.
pub trait ComputerUseControllerPort: Send + 'static {
    fn target_revision(&self) -> u64;
    fn approval_for<'a>(
        &'a mut self,
        args: &'a Value,
    ) -> BoxFuture<'a, Result<Option<ComputerUseApprovalDescriptor>, ComputerUseExecutionError>>;
    fn authorize(
        &mut self,
        tool_call_id: &str,
        args: &Value,
        approval: &ComputerUseApprovalDescriptor,
    ) -> Result<(), ComputerUseExecutionError>;
    fn execute<'a>(
        &'a mut self,
        tool_call_id: &'a str,
        args: &'a Value,
    ) -> BoxFuture<'a, Result<ComputerUseExecutionResult, ComputerUseExecutionError>>;
    fn close<'a>(&'a mut self) -> BoxFuture<'a, ()>;
}

impl<D: ComputerUseDriver> ComputerUseControllerPort for ComputerUseController<D> {
    fn target_revision(&self) -> u64 {
        self.target_revision()
    }

    fn approval_for<'a>(
        &'a mut self,
        args: &'a Value,
    ) -> BoxFuture<'a, Result<Option<ComputerUseApprovalDescriptor>, ComputerUseExecutionError>>
    {
        Box::pin(self.approval_for(args))
    }

    fn authorize(
        &mut self,
        tool_call_id: &str,
        args: &Value,
        approval: &ComputerUseApprovalDescriptor,
    ) -> Result<(), ComputerUseExecutionError> {
        self.authorize(tool_call_id, args, approval)
    }

    fn execute<'a>(
        &'a mut self,
        tool_call_id: &'a str,
        args: &'a Value,
    ) -> BoxFuture<'a, Result<ComputerUseExecutionResult, ComputerUseExecutionError>> {
        Box::pin(self.execute(tool_call_id, args))
    }

    fn close<'a>(&'a mut self) -> BoxFuture<'a, ()> {
        Box::pin(self.close())
    }
}

pub trait ComputerUseControllerFactory: Send + Sync + 'static {
    fn create(
        &self,
        generation_id: String,
        supports_images: bool,
        cancellation: CancellationToken,
    ) -> BoxFuture<'static, Result<Box<dyn ComputerUseControllerPort>, String>>;

    fn shutdown(&self) -> BoxFuture<'static, ()> {
        Box::pin(async {})
    }
}

#[cfg(test)]
struct UnavailableControllerFactory;

#[cfg(test)]
impl ComputerUseControllerFactory for UnavailableControllerFactory {
    fn create(
        &self,
        _generation_id: String,
        _supports_images: bool,
        _cancellation: CancellationToken,
    ) -> BoxFuture<'static, Result<Box<dyn ComputerUseControllerPort>, String>> {
        Box::pin(async { Err("The Computer Use runtime is unavailable.".into()) })
    }
}

struct ActiveGeneration {
    identity: ComputerUseGenerationIdentity,
    cancellation: CancellationToken,
}

struct ComputerUseRuntime {
    global_enabled: AtomicBool,
    gate: Mutex<ComputerUseGenerationGate>,
    gate_revision: AtomicU64,
    chat_revisions: Mutex<HashMap<String, u64>>,
    active: Mutex<HashMap<String, ActiveGeneration>>,
    chat_mutations: Mutex<ChatComputerUseMutationGate>,
}

impl ComputerUseRuntime {
    fn new(global_enabled: bool) -> Self {
        Self {
            global_enabled: AtomicBool::new(global_enabled),
            gate: Mutex::new(ComputerUseGenerationGate::new()),
            gate_revision: AtomicU64::new(0),
            chat_revisions: Mutex::new(HashMap::new()),
            active: Mutex::new(HashMap::new()),
            chat_mutations: Mutex::new(ChatComputerUseMutationGate::new()),
        }
    }

    fn set_global_enabled(&self, enabled: bool) {
        self.global_enabled.store(enabled, Ordering::Release);
        if !enabled {
            self.invalidate_generation_gate();
            self.cancel_where(|_| true);
        }
    }

    fn invalidate_generation_gate(&self) {
        let mut gate = self.gate.lock().unwrap();
        gate.close();
        self.gate_revision.store(gate.snapshot(), Ordering::Release);
    }

    fn bump_chat_revision(&self, chat_id: &str) -> u64 {
        let mut revisions = self.chat_revisions.lock().unwrap();
        let revision = revisions.entry(chat_id.to_string()).or_default();
        *revision = revision.saturating_add(1);
        *revision
    }

    fn chat_snapshot(&self, chat_id: &str) -> u64 {
        self.chat_revisions
            .lock()
            .unwrap()
            .get(chat_id)
            .copied()
            .unwrap_or(0)
    }

    fn chat_is_current(&self, chat_id: &str, revision: u64) -> bool {
        self.chat_snapshot(chat_id) == revision
    }

    fn cancel_where(&self, predicate: impl Fn(&ComputerUseGenerationIdentity) -> bool) {
        let mut active = self.active.lock().unwrap();
        active.retain(|_, generation| {
            if predicate(&generation.identity) {
                generation.cancellation.cancel();
                false
            } else {
                true
            }
        });
    }

    fn has_active_chat(&self, chat_id: &str) -> bool {
        self.active
            .lock()
            .unwrap()
            .values()
            .any(|generation| generation.identity.chat_id == chat_id)
    }

    fn snapshot(&self) -> u64 {
        self.gate_revision.load(Ordering::Acquire)
    }

    fn is_current(&self, revision: u64) -> bool {
        self.gate.lock().unwrap().is_current(revision)
    }
}

struct SettingsDependencies {
    config: Arc<ConfigStore>,
    status: Arc<ComputerUseStatusService>,
    runtime: Arc<ComputerUseRuntime>,
    approvals: Arc<ComputerUseApprovalGate>,
}

impl ComputerUseSettingsDependencies for SettingsDependencies {
    fn read_persisted(&self) -> BoxFuture<'static, bool> {
        let config = Arc::clone(&self.config);
        Box::pin(async move { persisted_global_enabled(&config) })
    }

    fn persist(
        &self,
        enabled: bool,
        is_current: Arc<dyn Fn() -> bool + Send + Sync>,
    ) -> BoxFuture<'static, Result<(), ComputerUseSettingsError>> {
        let config = Arc::clone(&self.config);
        Box::pin(async move {
            let mut patch = serde_json::Map::new();
            patch.insert(COMPUTER_USE_ENABLED_KEY.into(), enabled.into());
            config
                .set_settings(&patch, &move || is_current())
                .map(|_| ())
                .map_err(|error| ComputerUseSettingsError::Persist(anyhow::anyhow!(error)))
        })
    }

    fn set_runtime_enabled(&self, enabled: bool) {
        self.runtime.set_global_enabled(enabled);
        self.status.set_runtime_enabled(enabled);
        if !enabled {
            self.approvals.cancel_all();
        }
    }

    fn cancel_computer_use_generations(&self) {
        self.runtime.cancel_where(|_| true);
    }
}

pub struct ComputerUseAuthority {
    #[cfg(test)]
    config: Arc<ConfigStore>,
    chats: Arc<ChatStore>,
    runtime: Arc<ComputerUseRuntime>,
    status: Arc<ComputerUseStatusService>,
    settings: Arc<ComputerUseSettingsCoordinator>,
    approvals: Arc<ComputerUseApprovalGate>,
    controller_factory: Arc<dyn ComputerUseControllerFactory>,
}

impl ComputerUseAuthority {
    #[cfg(test)]
    pub fn new(
        config: Arc<ConfigStore>,
        chats: Arc<ChatStore>,
        status_dependencies: Arc<dyn ComputerUseStatusDependencies>,
    ) -> Arc<Self> {
        Self::new_with_controller_factory(
            config,
            chats,
            status_dependencies,
            Arc::new(UnavailableControllerFactory),
        )
    }

    pub fn new_with_controller_factory(
        config: Arc<ConfigStore>,
        chats: Arc<ChatStore>,
        status_dependencies: Arc<dyn ComputerUseStatusDependencies>,
        controller_factory: Arc<dyn ComputerUseControllerFactory>,
    ) -> Arc<Self> {
        let enabled = persisted_global_enabled(&config);
        let runtime = Arc::new(ComputerUseRuntime::new(enabled));
        let status = Arc::new(ComputerUseStatusService::new(status_dependencies));
        let approvals = Arc::new(ComputerUseApprovalGate::new());
        status.set_runtime_enabled(enabled);
        let settings = Arc::new(ComputerUseSettingsCoordinator::new(Arc::new(
            SettingsDependencies {
                config: Arc::clone(&config),
                status: Arc::clone(&status),
                runtime: Arc::clone(&runtime),
                approvals: Arc::clone(&approvals),
            },
        )));
        Arc::new(Self {
            #[cfg(test)]
            config,
            chats,
            runtime,
            status,
            settings,
            approvals,
            controller_factory,
        })
    }

    pub fn global_enabled(&self) -> bool {
        self.runtime.global_enabled.load(Ordering::Acquire)
    }

    pub fn generation_snapshot(&self) -> u64 {
        self.runtime.snapshot()
    }

    #[cfg(test)]
    pub fn approval_gate(&self) -> Arc<ComputerUseApprovalGate> {
        Arc::clone(&self.approvals)
    }

    pub fn decide_approval(
        &self,
        approval_id: &str,
        decision: ComputerUseApprovalDecision,
    ) -> bool {
        self.approvals.decide(approval_id, decision)
    }

    pub async fn status(
        &self,
        force: bool,
        cancellation: Option<&CancellationToken>,
    ) -> Result<ComputerUseStatus, aiden_computer_use::CuaDriverError> {
        self.status.status(force, cancellation).await
    }

    /// The only permission-prompting entrypoint. Rendering, construction, and
    /// ordinary status reads never call it.
    pub async fn request_permissions(
        &self,
        _initiated: ComputerUseUserInitiated,
        cancellation: Option<&CancellationToken>,
    ) -> Result<ComputerUseStatus, aiden_computer_use::CuaDriverError> {
        self.status.request_permissions(cancellation).await
    }

    pub async fn set_global_enabled(
        &self,
        enabled: bool,
        is_current: Arc<dyn Fn() -> bool + Send + Sync>,
    ) -> Result<ComputerUseStatus, ComputerUseAuthorityError> {
        self.settings
            .set_enabled(enabled, Arc::clone(&is_current))
            .await?;
        let status = self
            .status(true, None)
            .await
            .map_err(|error| ComputerUseAuthorityError::NotReady(error.to_string()))?;
        if enabled
            && !matches!(
                status.state,
                ComputerUseStatusState::Ready | ComputerUseStatusState::PermissionRequired
            )
        {
            // Enabling remains provisional until the pinned helper proves its
            // schema, identity, and platform. Make the fail-closed rollback
            // durable before reporting the incompatibility.
            self.settings.set_enabled(false, is_current).await?;
            return Err(ComputerUseAuthorityError::NotReady(status.detail));
        }
        Ok(status)
    }

    pub async fn set_chat_enabled(
        &self,
        chat_id: &str,
        enabled: bool,
        is_current: Arc<dyn Fn() -> bool + Send + Sync>,
    ) -> Result<(), ComputerUseAuthorityError> {
        // A disable must always be admitted so it can act as a kill switch.
        // An enable cannot change the chat contract under an active session.
        let generation_busy = enabled && self.runtime.has_active_chat(chat_id);
        let lease = self
            .runtime
            .chat_mutations
            .lock()
            .unwrap()
            .try_begin(chat_id, generation_busy)
            .ok_or(ComputerUseAuthorityError::ChatMutationBusy)?;
        let activation_revision = self.runtime.snapshot();
        if !enabled {
            // Per-chat disable is the same kill switch as global disable: the
            // live controller is cancelled before a durable write can yield.
            self.runtime.bump_chat_revision(chat_id);
            self.runtime
                .cancel_where(|identity| identity.chat_id == chat_id);
        } else {
            if !self.global_enabled() {
                return Err(ComputerUseAuthorityError::GloballyDisabled);
            }
            let status = self
                .status(false, None)
                .await
                .map_err(|error| ComputerUseAuthorityError::NotReady(error.to_string()))?;
            if !status.ready {
                return Err(ComputerUseAuthorityError::NotReady(status.detail));
            }
            if !self.runtime.is_current(activation_revision) || !self.global_enabled() {
                return Err(ComputerUseAuthorityError::StaleGeneration);
            }
        }
        let chat_id = chat_id.to_string();
        let rollback_chat_id = chat_id.clone();
        let chats = Arc::clone(&self.chats);
        let runtime = Arc::clone(&self.runtime);
        let store_predicate = Arc::clone(&is_current);
        let result = tokio::task::spawn_blocking(move || {
            chats
                .set_computer_use_enabled(&chat_id, enabled, &move || {
                    store_predicate()
                        && (!enabled
                            || (runtime.global_enabled.load(Ordering::Acquire)
                                && runtime.is_current(activation_revision)))
                })
                .map(|_| ())
                .map_err(|error| ComputerUseAuthorityError::Store(error.to_string()))
        })
        .await
        .map_err(|_| {
            ComputerUseAuthorityError::Store("Computer Use save was interrupted.".into())
        })?;
        result?;
        if enabled
            && (!is_current()
                || !self.global_enabled()
                || !self.runtime.is_current(activation_revision))
        {
            let chats = Arc::clone(&self.chats);
            tokio::task::spawn_blocking(move || {
                chats.set_computer_use_enabled(&rollback_chat_id, false, &|| true)
            })
            .await
            .map_err(|_| {
                ComputerUseAuthorityError::Store("Computer Use rollback was interrupted.".into())
            })?
            .map_err(|error| ComputerUseAuthorityError::Store(error.to_string()))?;
            return Err(ComputerUseAuthorityError::StaleGeneration);
        }
        lease.release();
        Ok(())
    }

    /// Admit a generation only after an authority-owned, non-prompting
    /// readiness check. Callers cannot inject or reuse a synthetic status.
    pub async fn admit_generation(
        &self,
        identity: ComputerUseGenerationIdentity,
        gate_revision: u64,
        cancellation: Option<&CancellationToken>,
    ) -> Result<ComputerUseGenerationLease, ComputerUseAuthorityError> {
        if !self.global_enabled() {
            return Err(ComputerUseAuthorityError::GloballyDisabled);
        }
        if !self.runtime.is_current(gate_revision) {
            return Err(ComputerUseAuthorityError::StaleGeneration);
        }
        let chat_revision = self.runtime.chat_snapshot(&identity.chat_id);
        let chats = Arc::clone(&self.chats);
        let chat_id = identity.chat_id.clone();
        let chat = tokio::task::spawn_blocking(move || chats.get(&chat_id))
            .await
            .map_err(|_| {
                ComputerUseAuthorityError::Store("Computer Use chat read was interrupted.".into())
            })?
            .map_err(|error| ComputerUseAuthorityError::Store(error.to_string()))?
            .ok_or(ComputerUseAuthorityError::ChatDisabled)?;
        if chat.computer_use_enabled != Some(true) {
            return Err(ComputerUseAuthorityError::ChatDisabled);
        }
        if chat.workspace_id != identity.workspace_id
            || chat.provider_id.as_deref() != Some(identity.provider_id.as_str())
        {
            return Err(ComputerUseAuthorityError::StaleGeneration);
        }
        let status = self
            .status(false, cancellation)
            .await
            .map_err(|error| ComputerUseAuthorityError::NotReady(error.to_string()))?;
        if !self
            .runtime
            .chat_is_current(&identity.chat_id, chat_revision)
        {
            return Err(ComputerUseAuthorityError::StaleGeneration);
        }
        self.admit_ready_generation(
            identity,
            gate_revision,
            chat_revision,
            &status,
            cancellation.cloned().unwrap_or_default(),
        )
    }

    pub async fn activate_generation(
        self: &Arc<Self>,
        identity: ComputerUseGenerationIdentity,
        gate_revision: u64,
        supports_images: bool,
        cancellation: Option<&CancellationToken>,
    ) -> Result<ActiveComputerUseGeneration, ComputerUseAuthorityError> {
        let lease = self
            .admit_generation(identity, gate_revision, cancellation)
            .await?;
        let controller = self
            .controller_factory
            .create(
                lease.identity.generation_id.clone(),
                supports_images,
                lease.cancellation(),
            )
            .await
            .map_err(ComputerUseAuthorityError::Controller);
        match controller {
            Ok(controller) => Ok(ActiveComputerUseGeneration {
                authority: Arc::clone(self),
                lease,
                controller: Some(controller),
            }),
            Err(error) => {
                self.finish_generation(&lease.identity.generation_id);
                lease.cancellation.cancel();
                Err(error)
            }
        }
    }

    fn admit_ready_generation(
        &self,
        identity: ComputerUseGenerationIdentity,
        gate_revision: u64,
        chat_revision: u64,
        status: &ComputerUseStatus,
        cancellation: CancellationToken,
    ) -> Result<ComputerUseGenerationLease, ComputerUseAuthorityError> {
        if !status.ready || status.state != ComputerUseStatusState::Ready {
            return Err(ComputerUseAuthorityError::NotReady(status.detail.clone()));
        }
        if cancellation.is_cancelled() || !self.runtime.is_current(gate_revision) {
            return Err(ComputerUseAuthorityError::StaleGeneration);
        }
        let lease = ComputerUseGenerationLease {
            identity: identity.clone(),
            gate_revision,
            cancellation: cancellation.clone(),
        };
        self.runtime.active.lock().unwrap().insert(
            identity.generation_id.clone(),
            ActiveGeneration {
                identity,
                cancellation,
            },
        );
        if !self.runtime.is_current(gate_revision)
            || !self
                .runtime
                .chat_is_current(&lease.identity.chat_id, chat_revision)
            || !self.global_enabled()
            || lease.cancellation.is_cancelled()
        {
            lease.cancellation.cancel();
            self.finish_generation(&lease.identity.generation_id);
            return Err(ComputerUseAuthorityError::StaleGeneration);
        }
        Ok(lease)
    }

    pub fn finish_generation(&self, generation_id: &str) {
        self.runtime.active.lock().unwrap().remove(generation_id);
        self.approvals.cancel_generation(generation_id);
    }

    pub fn cancel_for_chat(&self, chat_id: &str) {
        self.runtime.bump_chat_revision(chat_id);
        self.approvals.cancel_all();
        self.runtime
            .cancel_where(|identity| identity.chat_id == chat_id);
    }

    pub fn cancel_for_workspace(&self, workspace_id: Option<&str>) {
        self.runtime.invalidate_generation_gate();
        self.approvals.cancel_all();
        self.runtime
            .cancel_where(|identity| identity.workspace_id.as_deref() != workspace_id);
    }

    pub fn cancel_for_provider(&self, provider_id: &str) {
        self.runtime.invalidate_generation_gate();
        self.approvals.cancel_all();
        self.runtime
            .cancel_where(|identity| identity.provider_id != provider_id);
    }

    pub async fn shutdown(&self) -> Result<(), ComputerUseAuthorityError> {
        self.runtime.set_global_enabled(false);
        self.approvals.cancel_all();
        // A process quit is itself an authoritative global disable. Admit it
        // through the settings coordinator so a plain quit (without a prior
        // UI toggle) cannot leave `computerUseEnabled=true` on disk.
        let disable = self.settings.set_enabled(false, Arc::new(|| true)).await;
        let drained = self.settings.shutdown().await;
        disable.map_err(ComputerUseAuthorityError::from)?;
        drained.map_err(ComputerUseAuthorityError::from)?;
        self.status.shutdown().await;
        self.controller_factory.shutdown().await;
        Ok(())
    }

    /// Reopen the settings coordinator when a quit attempt was cancelled
    /// before irreversible app teardown. The runtime remains fail-closed
    /// until the next explicit settings operation enables it again.
    pub fn resume_after_cancelled_shutdown(&self) {
        self.settings.resume_after_cancelled_shutdown();
    }

    #[cfg(test)]
    pub fn config(&self) -> &Arc<ConfigStore> {
        &self.config
    }
}

pub struct ActiveComputerUseGeneration {
    authority: Arc<ComputerUseAuthority>,
    lease: ComputerUseGenerationLease,
    controller: Option<Box<dyn ComputerUseControllerPort>>,
}

impl ActiveComputerUseGeneration {
    pub fn cancellation(&self) -> CancellationToken {
        self.lease.cancellation()
    }

    pub fn target_revision(&self) -> u64 {
        self.controller
            .as_ref()
            .map_or(0, |controller| controller.target_revision())
    }

    pub async fn approval_for(
        &mut self,
        args: &Value,
    ) -> Result<Option<ComputerUseApprovalDescriptor>, ComputerUseExecutionError> {
        self.controller
            .as_mut()
            .ok_or(ComputerUseExecutionError::Cancelled)?
            .approval_for(args)
            .await
    }

    /// Publish only the renderer-safe approval projection. Raw arguments and
    /// the prepared ledger grant remain generation-owned in this service.
    pub fn begin_approval(
        &self,
        tool_call_id: &str,
        approval: &ComputerUseApprovalDescriptor,
    ) -> Result<(ComputerUseApprovalRequest, ComputerUseApprovalWaiter), ComputerUseExecutionError>
    {
        let target_pid = u32::try_from(approval.target.pid)
            .map_err(|_| ComputerUseExecutionError::UnsupportedShape)?;
        let target_window_id = u64::try_from(approval.target.window_id)
            .map_err(|_| ComputerUseExecutionError::UnsupportedShape)?;
        Ok(self.authority.approvals.begin(&ComputerUseApprovalFacts {
            generation_id: &self.lease.identity.generation_id,
            tool_call_id,
            summary: &approval.summary,
            target_pid,
            target_window_id,
            app: approval.app.as_deref(),
            title: approval.title.as_deref(),
            generation_revision: self.lease.gate_revision,
            target_revision: self.target_revision(),
        }))
    }

    pub fn authorize(
        &mut self,
        tool_call_id: &str,
        args: &Value,
        approval: &ComputerUseApprovalDescriptor,
    ) -> Result<(), ComputerUseExecutionError> {
        self.controller
            .as_mut()
            .ok_or(ComputerUseExecutionError::Cancelled)?
            .authorize(tool_call_id, args, approval)
    }

    pub async fn execute(
        &mut self,
        tool_call_id: &str,
        args: &Value,
    ) -> Result<ComputerUseExecutionResult, ComputerUseExecutionError> {
        self.controller
            .as_mut()
            .ok_or(ComputerUseExecutionError::Cancelled)?
            .execute(tool_call_id, args)
            .await
    }
}

impl Drop for ActiveComputerUseGeneration {
    fn drop(&mut self) {
        self.lease.cancellation.cancel();
        if let Some(mut controller) = self.controller.take() {
            if let Ok(runtime) = tokio::runtime::Handle::try_current() {
                runtime.spawn(async move {
                    controller.close().await;
                });
            }
        }
        self.authority
            .finish_generation(&self.lease.identity.generation_id);
    }
}

fn persisted_global_enabled(config: &ConfigStore) -> bool {
    config
        .get_settings()
        .unwrap_or_default()
        .get(COMPUTER_USE_ENABLED_KEY)
        .and_then(serde_json::Value::as_bool)
        .unwrap_or(false)
}

#[cfg(target_os = "macos")]
pub fn production_status_dependencies(
    config: Arc<ConfigStore>,
) -> Arc<dyn ComputerUseStatusDependencies> {
    Arc::new(ProductionStatusDependencies { config })
}

#[cfg(target_os = "macos")]
pub fn production_controller_factory() -> Arc<dyn ComputerUseControllerFactory> {
    Arc::new(ProductionControllerFactory::default())
}

#[cfg(target_os = "macos")]
#[derive(Default)]
struct ProductionControllerFactory {
    host: Arc<tokio::sync::Mutex<Option<Arc<aiden_computer_use::host::CuaDriverHost>>>>,
}

#[cfg(target_os = "macos")]
impl ComputerUseControllerFactory for ProductionControllerFactory {
    fn create(
        &self,
        generation_id: String,
        supports_images: bool,
        cancellation: CancellationToken,
    ) -> BoxFuture<'static, Result<Box<dyn ComputerUseControllerPort>, String>> {
        let host = Arc::clone(&self.host);
        Box::pin(async move {
            let runtime_host = {
                let mut slot = host.lock().await;
                if let Some(host) = slot.as_ref() {
                    Arc::clone(host)
                } else {
                    let created = create_production_host(cancellation.clone())
                        .await
                        .map_err(|error| error.to_string())?;
                    *slot = Some(Arc::clone(&created));
                    created
                }
            };
            let controller = aiden_computer_use::create_computer_use_controller(
                generation_id,
                supports_images,
                cancellation,
                runtime_host,
            )
            .await
            .map_err(|error| error.to_string())?;
            Ok(Box::new(controller) as Box<dyn ComputerUseControllerPort>)
        })
    }

    fn shutdown(&self) -> BoxFuture<'static, ()> {
        let host = Arc::clone(&self.host);
        Box::pin(async move {
            if let Some(host) = host.lock().await.take() {
                host.shutdown().await;
            }
        })
    }
}

#[cfg(target_os = "macos")]
struct ProductionStatusDependencies {
    config: Arc<ConfigStore>,
}

#[cfg(target_os = "macos")]
impl ComputerUseStatusDependencies for ProductionStatusDependencies {
    fn is_enabled(&self) -> BoxFuture<'static, bool> {
        let config = Arc::clone(&self.config);
        Box::pin(async move { persisted_global_enabled(&config) })
    }

    fn create_host(
        &self,
        signal: CancellationToken,
    ) -> BoxFuture<
        'static,
        Result<
            Box<dyn aiden_computer_use::status_core::ComputerUseStatusHost>,
            aiden_computer_use::CuaDriverError,
        >,
    > {
        Box::pin(async move {
            let host = create_production_host(signal).await?;
            Ok(Box::new(StatusHostAdapter(host)) as Box<_>)
        })
    }
}

#[cfg(target_os = "macos")]
async fn create_production_host(
    signal: CancellationToken,
) -> Result<Arc<aiden_computer_use::host::CuaDriverHost>, aiden_computer_use::CuaDriverError> {
    let paths = production_driver_paths()?;
    let installation =
        aiden_computer_use::binary::resolve_cua_driver_installation(&paths, Some(&signal)).await?;
    Ok(Arc::new(aiden_computer_use::host::CuaDriverHost::new(
        aiden_computer_use::host::CuaDriverHostOptions {
            invocation: installation.invocation,
            base_env: None,
            temp_root: None,
            startup_timeout_ms: None,
            broker: aiden_computer_use::host::BrokerOptions {
                app_path: installation.broker_app_path,
            },
            direct_broker: None,
        },
    )))
}

#[cfg(target_os = "macos")]
struct StatusHostAdapter(Arc<aiden_computer_use::host::CuaDriverHost>);

#[cfg(target_os = "macos")]
impl aiden_computer_use::status_core::ComputerUseStatusHost for StatusHostAdapter {
    fn create_session(
        &self,
        signal: &CancellationToken,
    ) -> BoxFuture<
        'static,
        Result<
            Box<dyn aiden_computer_use::status_core::ComputerUseStatusSession>,
            aiden_computer_use::CuaDriverError,
        >,
    > {
        let host = Arc::clone(&self.0);
        let signal = signal.clone();
        Box::pin(async move {
            let session = host.create_session(Some(&signal)).await?;
            Ok(Box::new(StatusSessionAdapter(session)) as Box<_>)
        })
    }

    fn shutdown(&self) -> BoxFuture<'static, ()> {
        let host = Arc::clone(&self.0);
        Box::pin(async move { host.shutdown().await })
    }
}

#[cfg(target_os = "macos")]
struct StatusSessionAdapter(Arc<aiden_computer_use::CuaDriverSession>);

#[cfg(target_os = "macos")]
impl aiden_computer_use::status_core::ComputerUseStatusSession for StatusSessionAdapter {
    fn call_tool(
        &self,
        name: &str,
        args: serde_json::Value,
        options: &aiden_computer_use::status_core::StatusCallOptions,
    ) -> BoxFuture<'static, Result<serde_json::Value, aiden_computer_use::CuaDriverError>> {
        let session = Arc::clone(&self.0);
        let name = name.to_string();
        let options = aiden_computer_use::CuaDriverCallOptions {
            signal: options.signal.clone(),
            timeout_ms: options.timeout_ms,
        };
        Box::pin(async move { session.call_tool(&name, args, &options).await })
    }

    fn close(&self) -> BoxFuture<'static, ()> {
        let session = Arc::clone(&self.0);
        Box::pin(async move { session.close().await })
    }
}

#[cfg(target_os = "macos")]
fn production_driver_paths(
) -> Result<aiden_computer_use::binary::CuaDriverPathOptions, aiden_computer_use::CuaDriverError> {
    let executable = std::env::current_exe().map_err(|_| {
        aiden_computer_use::CuaDriverError::new(
            "driver_missing",
            "Aiden could not resolve its Computer Use helper.",
        )
    })?;
    let executable_parent = executable
        .parent()
        .unwrap_or_else(|| std::path::Path::new("/"));
    let packaged = executable_parent.ends_with("Contents/MacOS");
    let resources_path = if packaged {
        executable_parent
            .parent()
            .map(|contents| contents.join("Resources"))
            .unwrap_or_else(|| PathBuf::from("/invalid"))
    } else {
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .and_then(std::path::Path::parent)
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from("/invalid"))
    };
    Ok(aiden_computer_use::binary::CuaDriverPathOptions {
        app_path: resources_path.clone(),
        is_packaged: packaged,
        platform: "darwin".into(),
        resources_path,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use aiden_computer_use::status_core::{
        ComputerUseStatusHost, ComputerUseStatusSession, StatusCallOptions,
    };
    use aiden_data::chat_store::{create_chat_store, ChatStoreDurability, ChatStoreInput};
    use aiden_data::portable_config::{create_portable_config_stores, PortableConfigTestHooks};
    use aiden_data::secret_map::{ProviderKeysStore, SecretCipher, SecretCipherError};
    use std::sync::atomic::AtomicUsize;

    struct TestController {
        authorized: Arc<AtomicUsize>,
        executed: Arc<AtomicUsize>,
        closed: Arc<AtomicUsize>,
    }

    impl ComputerUseControllerPort for TestController {
        fn target_revision(&self) -> u64 {
            11
        }

        fn approval_for<'a>(
            &'a mut self,
            _args: &'a Value,
        ) -> BoxFuture<'a, Result<Option<ComputerUseApprovalDescriptor>, ComputerUseExecutionError>>
        {
            Box::pin(async {
                Ok(Some(ComputerUseApprovalDescriptor {
                    summary: "Click the selected control".into(),
                    target: aiden_computer_use::ComputerUseBoundTarget {
                        pid: 42,
                        window_id: 7,
                    },
                    app: Some("Notes".into()),
                    title: Some("Draft".into()),
                    grant: aiden_computer_use::ComputerUseGrantPrepared {
                        target_revision: 11,
                        fingerprint: "test-only-fingerprint".into(),
                        bound_target: None,
                    },
                }))
            })
        }

        fn authorize(
            &mut self,
            _tool_call_id: &str,
            _args: &Value,
            _approval: &ComputerUseApprovalDescriptor,
        ) -> Result<(), ComputerUseExecutionError> {
            self.authorized.fetch_add(1, Ordering::SeqCst);
            Ok(())
        }

        fn execute<'a>(
            &'a mut self,
            _tool_call_id: &'a str,
            _args: &'a Value,
        ) -> BoxFuture<'a, Result<ComputerUseExecutionResult, ComputerUseExecutionError>> {
            self.executed.fetch_add(1, Ordering::SeqCst);
            Box::pin(async {
                Ok(ComputerUseExecutionResult {
                    content: vec![aiden_computer_use::ComputerUseResultContent::Text(
                        "done".into(),
                    )],
                    details: serde_json::json!({ "action": "click" }),
                })
            })
        }

        fn close<'a>(&'a mut self) -> BoxFuture<'a, ()> {
            self.closed.fetch_add(1, Ordering::SeqCst);
            Box::pin(async {})
        }
    }

    struct TestControllerFactory {
        authorized: Arc<AtomicUsize>,
        executed: Arc<AtomicUsize>,
        closed: Arc<AtomicUsize>,
    }

    impl ComputerUseControllerFactory for TestControllerFactory {
        fn create(
            &self,
            _generation_id: String,
            _supports_images: bool,
            _cancellation: CancellationToken,
        ) -> BoxFuture<'static, Result<Box<dyn ComputerUseControllerPort>, String>> {
            let controller = TestController {
                authorized: Arc::clone(&self.authorized),
                executed: Arc::clone(&self.executed),
                closed: Arc::clone(&self.closed),
            };
            Box::pin(async move { Ok(Box::new(controller) as Box<_>) })
        }
    }

    #[derive(Default)]
    struct TestCipher;

    impl SecretCipher for TestCipher {
        fn is_encryption_available(&self) -> bool {
            true
        }

        fn encrypt_string(
            &self,
            _account: &str,
            plaintext: &str,
        ) -> Result<Vec<u8>, SecretCipherError> {
            Ok(plaintext.as_bytes().to_vec())
        }

        fn decrypt_string(
            &self,
            _account: &str,
            ciphertext: &[u8],
        ) -> Result<String, SecretCipherError> {
            String::from_utf8(ciphertext.to_vec())
                .map_err(|_| SecretCipherError::UnrecognizedFormat)
        }
    }

    #[derive(Clone, Copy)]
    enum TestStatus {
        Ready,
        Missing,
    }

    struct TestStatusSession {
        permission_prompts: Arc<AtomicUsize>,
    }

    impl ComputerUseStatusSession for TestStatusSession {
        fn call_tool(
            &self,
            name: &str,
            args: serde_json::Value,
            _options: &StatusCallOptions,
        ) -> BoxFuture<'static, Result<serde_json::Value, aiden_computer_use::CuaDriverError>>
        {
            if name == "check_permissions"
                && args.get("prompt").and_then(serde_json::Value::as_bool) == Some(true)
            {
                self.permission_prompts.fetch_add(1, Ordering::SeqCst);
            }
            let result = if name == "health_report" {
                serde_json::json!({
                    "content": [{ "type": "text", "text": "healthy" }],
                    "structuredContent": {
                        "overall": "ok",
                        "platform": "darwin",
                        "schema_version": aiden_computer_use::CUA_DRIVER_TOOL_SCHEMA,
                        "driver_version": aiden_computer_use::CUA_DRIVER_VERSION,
                        "checks": [
                            { "name": "binary_version", "status": "pass" },
                            { "name": "platform_supported", "status": "pass" },
                            { "name": "session_active", "status": "pass" }
                        ]
                    }
                })
            } else {
                serde_json::json!({
                    "content": [{ "type": "text", "text": "ready" }],
                    "structuredContent": {
                        "accessibility": true,
                        "screen_recording": true,
                        "screen_recording_capturable": true,
                        "source": {
                            "attribution": "host",
                            "embedded": true,
                            "host_bundle_id": aiden_computer_use::CUA_DRIVER_TCC_HOST_BUNDLE_ID,
                            "disclaim_env": false
                        }
                    }
                })
            };
            Box::pin(async move { Ok(result) })
        }
    }

    struct TestStatusHost {
        permission_prompts: Arc<AtomicUsize>,
    }

    impl ComputerUseStatusHost for TestStatusHost {
        fn create_session(
            &self,
            _signal: &CancellationToken,
        ) -> BoxFuture<
            'static,
            Result<Box<dyn ComputerUseStatusSession>, aiden_computer_use::CuaDriverError>,
        > {
            let permission_prompts = Arc::clone(&self.permission_prompts);
            Box::pin(
                async move { Ok(Box::new(TestStatusSession { permission_prompts }) as Box<_>) },
            )
        }
    }

    struct TestStatusDependencies {
        enabled: bool,
        status: TestStatus,
        host_creations: Arc<AtomicUsize>,
        permission_prompts: Arc<AtomicUsize>,
    }

    impl ComputerUseStatusDependencies for TestStatusDependencies {
        fn is_enabled(&self) -> BoxFuture<'static, bool> {
            let enabled = self.enabled;
            Box::pin(async move { enabled })
        }

        fn create_host(
            &self,
            _signal: CancellationToken,
        ) -> BoxFuture<
            'static,
            Result<Box<dyn ComputerUseStatusHost>, aiden_computer_use::CuaDriverError>,
        > {
            self.host_creations.fetch_add(1, Ordering::SeqCst);
            let status = self.status;
            let permission_prompts = Arc::clone(&self.permission_prompts);
            Box::pin(async move {
                match status {
                    TestStatus::Ready => {
                        Ok(Box::new(TestStatusHost { permission_prompts }) as Box<_>)
                    }
                    TestStatus::Missing => Err(aiden_computer_use::CuaDriverError::new(
                        "driver_missing",
                        "test",
                    )),
                }
            })
        }
    }

    fn authority(
        enabled: bool,
        status: TestStatus,
        host_creations: Arc<AtomicUsize>,
    ) -> (
        Arc<ComputerUseAuthority>,
        tempfile::TempDir,
        Arc<AtomicUsize>,
    ) {
        let directory = tempfile::tempdir().unwrap();
        let keys = Arc::new(ProviderKeysStore::new(
            directory.path().join("keys"),
            "computer-use-authority-test",
            Arc::new(TestCipher),
        ));
        let config = Arc::new(ConfigStore::new(
            create_portable_config_stores(
                directory.path().join("portable"),
                Some(directory.path().join("local")),
                PortableConfigTestHooks::default(),
            ),
            Arc::new(crate::services::stores::StoreSecretsPort::new(keys)),
            None,
        ));
        let mut patch = serde_json::Map::new();
        patch.insert(COMPUTER_USE_ENABLED_KEY.into(), enabled.into());
        config.set_settings(&patch, &|| true).unwrap();
        let chats_path = directory.path().join("chats");
        std::fs::create_dir_all(&chats_path).unwrap();
        let chats = Arc::new(create_chat_store(
            Box::new({
                let path = chats_path;
                move || path.clone()
            }),
            None,
            ChatStoreDurability::default(),
        ));
        let permission_prompts = Arc::new(AtomicUsize::new(0));
        let authority = ComputerUseAuthority::new(
            config,
            chats,
            Arc::new(TestStatusDependencies {
                enabled,
                status,
                host_creations,
                permission_prompts: Arc::clone(&permission_prompts),
            }),
        );
        (authority, directory, permission_prompts)
    }

    fn authority_with_controller(
        factory: Arc<dyn ComputerUseControllerFactory>,
    ) -> (Arc<ComputerUseAuthority>, tempfile::TempDir) {
        let directory = tempfile::tempdir().unwrap();
        let keys = Arc::new(ProviderKeysStore::new(
            directory.path().join("keys"),
            "computer-use-controller-test",
            Arc::new(TestCipher),
        ));
        let config = Arc::new(ConfigStore::new(
            create_portable_config_stores(
                directory.path().join("portable"),
                Some(directory.path().join("local")),
                PortableConfigTestHooks::default(),
            ),
            Arc::new(crate::services::stores::StoreSecretsPort::new(keys)),
            None,
        ));
        config
            .set_settings(
                &serde_json::Map::from_iter([(COMPUTER_USE_ENABLED_KEY.into(), true.into())]),
                &|| true,
            )
            .unwrap();
        let chats_path = directory.path().join("chats");
        std::fs::create_dir_all(&chats_path).unwrap();
        let chats = Arc::new(create_chat_store(
            Box::new({
                let path = chats_path;
                move || path.clone()
            }),
            None,
            ChatStoreDurability::default(),
        ));
        let authority = ComputerUseAuthority::new_with_controller_factory(
            config,
            chats,
            Arc::new(TestStatusDependencies {
                enabled: true,
                status: TestStatus::Ready,
                host_creations: Arc::new(AtomicUsize::new(0)),
                permission_prompts: Arc::new(AtomicUsize::new(0)),
            }),
            factory,
        );
        (authority, directory)
    }

    fn create_chat(authority: &ComputerUseAuthority) -> aiden_core::Chat {
        authority
            .chats
            .create(ChatStoreInput {
                workspace_id: Some("workspace"),
                provider_id: Some("provider"),
                ..ChatStoreInput::default()
            })
            .unwrap()
    }

    fn opt_in_chat(authority: &ComputerUseAuthority) -> aiden_core::Chat {
        let chat = create_chat(authority);
        authority
            .chats
            .set_computer_use_enabled(&chat.id, true, &|| true)
            .unwrap()
    }

    fn identity(generation_id: &str, chat: &aiden_core::Chat) -> ComputerUseGenerationIdentity {
        ComputerUseGenerationIdentity {
            generation_id: generation_id.into(),
            chat_id: chat.id.clone(),
            workspace_id: chat.workspace_id.clone(),
            provider_id: chat.provider_id.clone().unwrap(),
        }
    }

    fn ready_status() -> ComputerUseStatus {
        ComputerUseStatus {
            enabled: true,
            beta: true,
            state: ComputerUseStatusState::Ready,
            detail: "ready".into(),
            ready: true,
            available: true,
            retryable: false,
            can_request_permissions: false,
            driver_version: Some(aiden_computer_use::CUA_DRIVER_VERSION.into()),
            permissions: aiden_computer_use::status_core::ComputerUsePermissions {
                accessibility: Some(true),
                screen_recording: Some(true),
            },
        }
    }

    #[tokio::test]
    async fn construction_and_exact_status_reads_do_not_create_a_helper_when_disabled() {
        let creations = Arc::new(AtomicUsize::new(0));
        let (authority, _directory, _prompts) =
            authority(false, TestStatus::Missing, Arc::clone(&creations));

        assert!(!authority.global_enabled());
        let status = authority.status(false, None).await.unwrap();
        assert_eq!(status.state, ComputerUseStatusState::Disabled);
        assert_eq!(creations.load(Ordering::SeqCst), 0);
    }

    #[tokio::test]
    async fn status_never_prompts_and_permission_request_requires_explicit_intent() {
        let creations = Arc::new(AtomicUsize::new(0));
        let (authority, _directory, prompts) =
            authority(true, TestStatus::Ready, Arc::clone(&creations));

        assert!(authority.status(true, None).await.unwrap().ready);
        assert_eq!(prompts.load(Ordering::SeqCst), 0);

        let status = authority
            .request_permissions(ComputerUseUserInitiated::explicit(), None)
            .await
            .unwrap();
        assert!(status.ready);
        assert_eq!(prompts.load(Ordering::SeqCst), 1);
        assert!(creations.load(Ordering::SeqCst) >= 2);
    }

    #[tokio::test]
    async fn tool_admission_requires_both_gates_exact_readiness_and_current_revision() {
        let creations = Arc::new(AtomicUsize::new(0));
        let (authority, _directory, _prompts) =
            authority(true, TestStatus::Ready, Arc::clone(&creations));
        let revision = authority.generation_snapshot();
        let chat = create_chat(&authority);

        assert!(matches!(
            authority
                .admit_generation(identity("g", &chat), revision, None)
                .await,
            Err(ComputerUseAuthorityError::ChatDisabled)
        ));
        let chat = authority
            .chats
            .set_computer_use_enabled(&chat.id, true, &|| true)
            .unwrap();
        let lease = authority
            .admit_generation(identity("g", &chat), revision, None)
            .await
            .unwrap();
        assert!(!lease.is_cancelled());
        assert_eq!(creations.load(Ordering::SeqCst), 1);
        authority.runtime.set_global_enabled(false);
        assert!(matches!(
            authority
                .admit_generation(identity("g2", &chat), revision, None)
                .await,
            Err(ComputerUseAuthorityError::GloballyDisabled)
        ));
    }

    #[tokio::test]
    async fn global_disable_cancels_active_generations_and_becomes_durable() {
        let creations = Arc::new(AtomicUsize::new(0));
        let (authority, _directory, _prompts) = authority(true, TestStatus::Ready, creations);
        let chat = opt_in_chat(&authority);
        let lease = authority
            .admit_generation(
                identity("generation", &chat),
                authority.generation_snapshot(),
                None,
            )
            .await
            .unwrap();

        let status = authority
            .set_global_enabled(false, Arc::new(|| true))
            .await
            .unwrap();

        assert!(lease.is_cancelled());
        assert!(!authority.global_enabled());
        assert_eq!(status.state, ComputerUseStatusState::Disabled);
        assert!(!persisted_global_enabled(authority.config()));
    }

    #[tokio::test]
    async fn shutdown_persists_global_disable_before_teardown() {
        let (authority, _directory, _prompts) =
            authority(true, TestStatus::Ready, Arc::new(AtomicUsize::new(0)));
        assert!(persisted_global_enabled(authority.config()));

        authority.shutdown().await.unwrap();

        assert!(!authority.global_enabled());
        assert!(!persisted_global_enabled(authority.config()));
    }

    #[tokio::test]
    async fn failed_shutdown_can_reopen_the_settings_coordinator_for_retry() {
        let (authority, directory, _prompts) =
            authority(true, TestStatus::Ready, Arc::new(AtomicUsize::new(0)));
        let settings_root = directory.path().join("local");
        std::fs::remove_dir_all(&settings_root).unwrap();
        std::fs::write(&settings_root, b"blocked").unwrap();

        assert!(authority.shutdown().await.is_err());
        authority.resume_after_cancelled_shutdown();

        std::fs::remove_file(&settings_root).unwrap();
        std::fs::create_dir_all(&settings_root).unwrap();

        authority
            .set_global_enabled(true, Arc::new(|| true))
            .await
            .unwrap();
        assert!(authority.global_enabled());
        assert!(persisted_global_enabled(authority.config()));
    }

    #[tokio::test]
    async fn global_disable_cancels_pending_allow_once_before_publication() {
        let creations = Arc::new(AtomicUsize::new(0));
        let (authority, _directory, _prompts) = authority(true, TestStatus::Ready, creations);
        let gate = authority.approval_gate();
        let (request, waiter) = gate.begin(&aiden_computer_use::ComputerUseApprovalFacts {
            generation_id: "generation",
            tool_call_id: "tool",
            summary: "Click element 1",
            target_pid: 1,
            target_window_id: 2,
            app: None,
            title: None,
            generation_revision: authority.generation_snapshot(),
            target_revision: 0,
        });

        authority
            .set_global_enabled(false, Arc::new(|| true))
            .await
            .unwrap();

        assert_eq!(
            waiter.wait(&CancellationToken::new()).await,
            Err(aiden_computer_use::ComputerUseApprovalError::Cancelled)
        );
        assert!(!authority
            .decide_approval(&request.approval_id, ComputerUseApprovalDecision::AllowOnce));
    }

    #[tokio::test]
    async fn workspace_chat_and_provider_changes_cancel_only_mismatched_sessions() {
        let creations = Arc::new(AtomicUsize::new(0));
        let (authority, _directory, _prompts) = authority(true, TestStatus::Ready, creations);
        let current_chat = opt_in_chat(&authority);
        let other_chat = opt_in_chat(&authority);
        let current = authority
            .admit_generation(
                identity("current", &current_chat),
                authority.generation_snapshot(),
                None,
            )
            .await
            .unwrap();
        let other = authority
            .admit_generation(
                identity("other", &other_chat),
                authority.generation_snapshot(),
                None,
            )
            .await
            .unwrap();

        authority.cancel_for_chat(&other_chat.id);

        assert!(!current.is_cancelled());
        assert!(other.is_cancelled());
    }

    #[tokio::test]
    async fn incompatible_or_missing_helper_rolls_back_global_enable() {
        let creations = Arc::new(AtomicUsize::new(0));
        let (authority, _directory, _prompts) =
            authority(false, TestStatus::Missing, Arc::clone(&creations));

        assert!(matches!(
            authority.set_global_enabled(true, Arc::new(|| true)).await,
            Err(ComputerUseAuthorityError::NotReady(_))
        ));

        assert!(!authority.global_enabled());
        assert!(!persisted_global_enabled(authority.config()));
        assert_eq!(creations.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn late_ready_result_cannot_publish_after_chat_disable_revision() {
        let creations = Arc::new(AtomicUsize::new(0));
        let (authority, _directory, _prompts) = authority(true, TestStatus::Ready, creations);
        let chat = opt_in_chat(&authority);
        let chat_revision = authority.runtime.chat_snapshot(&chat.id);

        authority.runtime.bump_chat_revision(&chat.id);
        let result = authority.admit_ready_generation(
            identity("late", &chat),
            authority.generation_snapshot(),
            chat_revision,
            &ready_status(),
            CancellationToken::new(),
        );

        assert!(matches!(
            result,
            Err(ComputerUseAuthorityError::StaleGeneration)
        ));
        assert!(!authority
            .runtime
            .active
            .lock()
            .unwrap()
            .contains_key("late"));
    }

    #[test]
    fn cancelled_generation_cannot_publish_after_ready_probe() {
        let (authority, _directory, _prompts) =
            authority(true, TestStatus::Ready, Arc::new(AtomicUsize::new(0)));
        let chat = opt_in_chat(&authority);
        let cancellation = CancellationToken::new();
        cancellation.cancel();
        let result = authority.admit_ready_generation(
            identity("cancelled", &chat),
            authority.generation_snapshot(),
            authority.runtime.chat_snapshot(&chat.id),
            &ready_status(),
            cancellation,
        );
        assert!(matches!(
            result,
            Err(ComputerUseAuthorityError::StaleGeneration)
        ));
        assert!(!authority
            .runtime
            .active
            .lock()
            .unwrap()
            .contains_key("cancelled"));
    }

    #[tokio::test]
    async fn chat_disable_cancels_before_durable_publication() {
        let creations = Arc::new(AtomicUsize::new(0));
        let (authority, _directory, _prompts) = authority(true, TestStatus::Ready, creations);
        let chat = create_chat(&authority);
        authority
            .set_chat_enabled(&chat.id, true, Arc::new(|| true))
            .await
            .unwrap();
        let chat = authority.chats.get(&chat.id).unwrap().unwrap();
        let lease = authority
            .admit_generation(
                identity("generation", &chat),
                authority.generation_snapshot(),
                None,
            )
            .await
            .unwrap();

        authority
            .set_chat_enabled(&chat.id, false, Arc::new(|| true))
            .await
            .unwrap();

        assert!(lease.is_cancelled());
        assert_eq!(
            authority
                .chats
                .get(&chat.id)
                .unwrap()
                .unwrap()
                .computer_use_enabled,
            Some(false)
        );
    }

    #[tokio::test]
    async fn active_controller_keeps_grant_private_and_closes_after_exact_one_use_decision() {
        let authorized = Arc::new(AtomicUsize::new(0));
        let executed = Arc::new(AtomicUsize::new(0));
        let closed = Arc::new(AtomicUsize::new(0));
        let (authority, _directory) = authority_with_controller(Arc::new(TestControllerFactory {
            authorized: Arc::clone(&authorized),
            executed: Arc::clone(&executed),
            closed: Arc::clone(&closed),
        }));
        let chat = opt_in_chat(&authority);
        let mut active = authority
            .activate_generation(
                identity("generation", &chat),
                authority.generation_snapshot(),
                true,
                None,
            )
            .await
            .unwrap();
        let args = serde_json::json!({ "action": "click", "element": 1 });
        let descriptor = active.approval_for(&args).await.unwrap().unwrap();
        let (request, waiter) = active.begin_approval("tool-call", &descriptor).unwrap();
        let renderer = serde_json::to_value(&request).unwrap();
        assert!(renderer.get("args").is_none());
        assert!(renderer.get("grant").is_none());
        assert_eq!(request.target_pid, 42);
        assert_eq!(request.target_window_id, 7);
        assert!(
            authority.decide_approval(&request.approval_id, ComputerUseApprovalDecision::AllowOnce)
        );
        assert!(!authority
            .decide_approval(&request.approval_id, ComputerUseApprovalDecision::AllowOnce));
        waiter.wait(&active.cancellation()).await.unwrap();
        active.authorize("tool-call", &args, &descriptor).unwrap();
        active.execute("tool-call", &args).await.unwrap();
        assert_eq!(authorized.load(Ordering::SeqCst), 1);
        assert_eq!(executed.load(Ordering::SeqCst), 1);

        drop(active);
        tokio::task::yield_now().await;
        assert_eq!(closed.load(Ordering::SeqCst), 1);
    }
}
