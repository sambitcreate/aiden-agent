//! The chat service: the entity that owns the chat list, the active chat,
//! provider/model selection, appearance, and per-chat generation state.
//!
//! All durable store I/O runs on the background executor (`cx.background_spawn`
//! inside `cx.spawn` foreground continuations); the GPUI foreground thread only
//! ever mutates the in-memory state mirrored here. Streaming events arrive
//! over a tokio channel from [`crate::services::provider_kit::drive_stream`]
//! and are applied by a foreground watcher task. A per-chat generation counter
//! invalidates stale streams when the user switches chats or presses stop
//! (mirroring the renderer's intent-invalidation refs).

use std::collections::{HashMap, VecDeque};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;

use crate::services::subagents::{
    SubagentMcpMutationApprovalRequest, SubagentMcpMutationDecision,
    SubagentMcpReadApprovalRequest, SubagentMcpReadDecision, SubagentShellApprovalRequest,
    SubagentShellDecision, SubagentWorkspaceWriteApprovalRequest, SubagentWorkspaceWriteDecision,
};
use aiden_computer_use::{
    ComputerUseApprovalDecision, ComputerUseApprovalRequest, FoundationModelsCancellationToken,
};
use aiden_core::appearance::{AppearanceConfig, Mode};
use aiden_core::chat_title::FoundationModelsConnectionStatus;
use aiden_core::chat_title::{
    build_chat_title_prompt, can_replace_generated_chat_title, resolve_chat_title_route,
    sanitize_generated_chat_title, ChatTitleInput, ChatTitleProviderId, ChatTitleRoute,
};
use aiden_core::subagent_runs::SubagentRunSnapshotV1;
use aiden_core::{
    meta_of, Chat, ChatMessage, ChatMeta, ChatRole, GenerationTimeline, Message, SkillProvenance,
    SkillProvenanceSource, UserContent, UserMessage,
};
use aiden_data::chat_store::{
    derive_chat_title_seed, AppendMessageMeta, ChatMessageInput, ChatStoreInput,
};
use aiden_data::now_millis;
use aiden_data::portable_config::{Workspace, WorkspacePermission};
use aiden_data::usage_store::{
    UsageCostStatus, UsageRequestRecord, UsageRequestSource, UsageRequestStatus,
};
use aiden_mac::appearance::AppearanceEvent;
use aiden_providers::catalog;
use aiden_providers::live_discovery::{self, DiscoveryOptions, RuntimeKind};
use aiden_providers::{StreamOptions, StreamRequest};
use futures::StreamExt;
use gpui::{AppContext as _, Context, Task, Timer};
use gpui_tokio_bridge::{JoinError, Tokio};
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;

use crate::chat::slash::SkillInvocationSelection;
use crate::services::appearance::{
    appearance_from_settings, appearance_to_settings, apply_appearance, resolve_scheme,
    AidenSystemAccessibility, SETTINGS_APPEARANCE_KEY,
};
use crate::services::appearance_coordinator::{
    AppearanceCoordinator, AppearanceFailure, AppearanceOperationKind, AppearanceSaveState,
    NativeAppearanceIntent,
};
use crate::services::computer_use::ComputerUseGenerationIdentity;
use crate::services::mcp_tools::McpStreamContext;
use crate::services::native_appearance::{
    NativeAppearance, NativeBootRestore, PreparedNativeAppearance,
};
use crate::services::provider_availability::require_available_selection;
use crate::services::provider_kit::{
    chat_history_to_messages, configured_codex_provider, drive_stream, enrich_provider,
    load_capabilities, resolve_runtime_api_key, ComputerUseStreamContext, ConfiguredProvider,
    ModelSelection, StreamMsg, TurnSnapshot,
};
use crate::services::skill_tools::{
    resolve_skill_invocation, stream_context_for_mode, ResolvedSkillInvocation, SkillCatalogSource,
    SkillInvocationResolutionError, SkillRuntimeMode,
};
use crate::services::stores::Stores;
use crate::services::stream::{chat_usage_record, message_content};

/// The persisted-selection settings key (`settings.json`).
const MODEL_SELECTION_KEY: &str = "modelSelection";

/// Total bound for the boot-time local-runtime model discovery (5s), so an
/// offline local server can never delay the provider catalog.
const BOOT_DISCOVERY_TOTAL_TIMEOUT_MS: u64 = 5_000;

/// Tool-free system prompt for the background first-turn title request.
const TITLE_SYSTEM_PROMPT: &str =
    "You are a helpful assistant that summarizes chat conversations into short, concise titles.";
const TITLE_REQUEST_TIMEOUT_MS: u64 = 15_000;

fn computer_use_model_capabilities(
    provider: &ConfiguredProvider,
    selection: &ModelSelection,
) -> Option<bool> {
    let metadata = provider.model_metadata.get(&selection.model)?;
    (metadata.tool_call == Some(true)).then_some(metadata.vision == Some(true))
}

/// Fail closed only for explicitly non-vision metadata. Unknown metadata
/// follows the Electron policy: the provider receives the request and may
/// advertise/validate vision dynamically.
fn image_submission_error(
    provider: &ConfiguredProvider,
    selection: &ModelSelection,
    attachments: &[aiden_core::Attachment],
) -> Option<&'static str> {
    let has_images = attachments
        .iter()
        .any(|attachment| attachment.kind == aiden_core::AttachmentKind::Image);
    let vision = provider
        .model_metadata
        .get(&selection.model)
        .and_then(|metadata| metadata.vision);
    (has_images && vision == Some(false))
        .then_some("Switch to a vision-capable model before sending these images.")
}

fn configured_title_provider(
    settings: &serde_json::Map<String, serde_json::Value>,
) -> ChatTitleProviderId {
    settings
        .get("chatTitleProviderId")
        .and_then(serde_json::Value::as_str)
        .and_then(ChatTitleProviderId::from_str)
        .unwrap_or(ChatTitleProviderId::Automatic)
}

#[derive(Debug, Clone, PartialEq)]
enum TitleExecution {
    SeedOnly,
    AppleFoundationModels,
    ChatModel {
        provider: Box<ConfiguredProvider>,
        selection: ModelSelection,
    },
}

fn resolve_title_execution(
    policy: ChatTitleProviderId,
    foundation_status: Option<&FoundationModelsConnectionStatus>,
    providers: &[ConfiguredProvider],
    selection: Option<&ModelSelection>,
) -> TitleExecution {
    match resolve_chat_title_route(policy, foundation_status) {
        ChatTitleRoute::SeedOnly => TitleExecution::SeedOnly,
        ChatTitleRoute::AppleFoundationModels => TitleExecution::AppleFoundationModels,
        ChatTitleRoute::ChatModel => {
            let Some(selection) = selection else {
                return TitleExecution::SeedOnly;
            };
            let Ok(provider) = require_available_selection(providers, selection) else {
                return TitleExecution::SeedOnly;
            };
            if provider.needs_key && !provider.has_key {
                return TitleExecution::SeedOnly;
            }
            TitleExecution::ChatModel {
                provider: Box::new(provider),
                selection: selection.clone(),
            }
        }
    }
}

fn title_request_status(cancelled: bool, succeeded: bool) -> UsageRequestStatus {
    if cancelled {
        UsageRequestStatus::Cancelled
    } else if succeeded {
        UsageRequestStatus::Completed
    } else {
        UsageRequestStatus::Failed
    }
}

fn title_error_is_timeout(message: &str) -> bool {
    let message = message.to_ascii_lowercase();
    message.contains("timeout") || message.contains("timed out")
}

fn codex_status_refresh_required(provider_id: Option<&str>) -> bool {
    provider_id == Some(aiden_providers::codex::OPENAI_CODEX_PROVIDER_ID)
}

fn foundation_title_result_status(
    cancel: &FoundationModelsCancellationToken,
    result: &Result<String, aiden_computer_use::FoundationModelsConnectionError>,
) -> UsageRequestStatus {
    if result
        .as_ref()
        .is_err_and(|error| title_error_is_timeout(&error.code))
    {
        cancel.cancel();
    }
    title_request_status(cancel.is_cancelled(), result.is_ok())
}

fn chat_title_stream_error_status(
    cancel: &FoundationModelsCancellationToken,
    error: &aiden_providers::ProviderError,
) -> UsageRequestStatus {
    if title_error_is_timeout(&error.to_string()) {
        cancel.cancel();
        UsageRequestStatus::Cancelled
    } else {
        UsageRequestStatus::Failed
    }
}

fn title_usage_record(
    provider_id: &str,
    provider_label: &str,
    model_id: &str,
    status: UsageRequestStatus,
    local: bool,
    usage: Option<&aiden_core::Usage>,
) -> UsageRequestRecord {
    if let Some(usage) = usage {
        let mut record = chat_usage_record(
            usage,
            provider_id,
            provider_label,
            model_id,
            model_id,
            local,
            status,
            now_millis(),
        );
        record.source = UsageRequestSource::ChatTitle;
        return record;
    }
    UsageRequestRecord {
        timestamp: None,
        source: UsageRequestSource::ChatTitle,
        provider_id: provider_id.to_string(),
        provider_label: provider_label.to_string(),
        model_id: model_id.to_string(),
        model_label: model_id.to_string(),
        local,
        status,
        tokens: None,
        cost_status: if local {
            UsageCostStatus::NotApplicable
        } else {
            UsageCostStatus::Unavailable
        },
        cost_usd: None,
    }
}

fn cancel_title_tasks(cancellations: &HashMap<String, (u64, FoundationModelsCancellationToken)>) {
    for (_, cancel) in cancellations.values() {
        cancel.cancel();
    }
}

/// Live state of one generation (one assistant turn).
#[derive(Debug, Clone)]
pub struct GenerationState {
    pub chat_id: String,
    pub counter: u64,
    /// Immutable provider identity captured when this request started. This
    /// must not be inferred from the mutable picker selection at settlement.
    pub provider_id: String,
    pub text: String,
    pub thinking: String,
    pub thinking_active: bool,
    pub thinking_expanded: bool,
    pub complete: bool,
    pub error: Option<String>,
    /// Whether the transcript error belongs to a persisted user turn and may
    /// safely invoke `retry_last`. Admission failures leave the exact draft in
    /// the composer, so their error card must never retry an older turn.
    pub error_retryable: bool,
    pub model: Option<String>,
    /// Live activity timeline (thinking/tool steps). Mirrored from the driver's
    /// `TimelineProjector` and persisted with the assistant message on settle.
    pub timeline: Option<GenerationTimeline>,
}

pub(crate) fn enqueue_subagent_write_request(
    queue: &mut VecDeque<SubagentWorkspaceWriteApprovalRequest>,
    generation: Option<&GenerationState>,
    request: SubagentWorkspaceWriteApprovalRequest,
    now: u64,
) -> Result<bool, Box<SubagentWorkspaceWriteApprovalRequest>> {
    let exact_generation = generation.is_some_and(|generation| {
        generation.chat_id == request.chat_id
            && format!("{}:{}", generation.chat_id, generation.counter) == request.generation_id
            && !generation.complete
            && request.expires_at > now
    });
    if !exact_generation {
        return Err(Box::new(request));
    }
    if queue
        .iter()
        .any(|pending| pending.approval_id == request.approval_id)
    {
        return Ok(false);
    }
    queue.push_back(request);
    Ok(true)
}

pub(crate) fn remove_subagent_write_request(
    queue: &mut VecDeque<SubagentWorkspaceWriteApprovalRequest>,
    deciding: &mut Option<String>,
    approval_id: &str,
) -> bool {
    let prior = queue.len();
    queue.retain(|request| request.approval_id != approval_id);
    if deciding.as_deref() == Some(approval_id) {
        *deciding = None;
    }
    queue.len() != prior
}

pub(crate) fn subagent_write_decision_is_current(
    queue: &VecDeque<SubagentWorkspaceWriteApprovalRequest>,
    deciding: Option<&str>,
    approval_id: &str,
    now: u64,
) -> bool {
    deciding.is_none()
        && queue
            .front()
            .is_some_and(|request| request.approval_id == approval_id && request.expires_at > now)
}

pub(crate) fn enqueue_subagent_shell_request(
    queue: &mut VecDeque<SubagentShellApprovalRequest>,
    generation: Option<&GenerationState>,
    request: SubagentShellApprovalRequest,
    now: u64,
) -> Result<bool, Box<SubagentShellApprovalRequest>> {
    let exact_generation = generation.is_some_and(|generation| {
        generation.chat_id == request.chat_id
            && format!("{}:{}", generation.chat_id, generation.counter) == request.generation_id
            && !generation.complete
            && request.expires_at > now
    });
    if !exact_generation {
        return Err(Box::new(request));
    }
    if queue
        .iter()
        .any(|pending| pending.approval_id == request.approval_id)
    {
        return Ok(false);
    }
    queue.push_back(request);
    Ok(true)
}

pub(crate) fn remove_subagent_shell_request(
    queue: &mut VecDeque<SubagentShellApprovalRequest>,
    deciding: &mut Option<String>,
    approval_id: &str,
) -> bool {
    let prior = queue.len();
    queue.retain(|request| request.approval_id != approval_id);
    if deciding.as_deref() == Some(approval_id) {
        *deciding = None;
    }
    queue.len() != prior
}

pub(crate) fn subagent_shell_decision_is_current(
    queue: &VecDeque<SubagentShellApprovalRequest>,
    deciding: Option<&str>,
    approval_id: &str,
    now: u64,
) -> bool {
    deciding.is_none()
        && queue
            .front()
            .is_some_and(|request| request.approval_id == approval_id && request.expires_at > now)
}

pub(crate) fn enqueue_subagent_mcp_read_request(
    queue: &mut VecDeque<SubagentMcpReadApprovalRequest>,
    generation: Option<&GenerationState>,
    request: SubagentMcpReadApprovalRequest,
    now: u64,
) -> Result<bool, Box<SubagentMcpReadApprovalRequest>> {
    let exact_generation = generation.is_some_and(|generation| {
        generation.chat_id == request.chat_id
            && format!("{}:{}", generation.chat_id, generation.counter) == request.generation_id
            && !generation.complete
            && request.expires_at > now
    });
    if !exact_generation {
        return Err(Box::new(request));
    }
    if queue
        .iter()
        .any(|pending| pending.approval_id == request.approval_id)
    {
        return Ok(false);
    }
    queue.push_back(request);
    Ok(true)
}

pub(crate) fn remove_subagent_mcp_read_request(
    queue: &mut VecDeque<SubagentMcpReadApprovalRequest>,
    deciding: &mut Option<String>,
    approval_id: &str,
) -> bool {
    let prior = queue.len();
    queue.retain(|request| request.approval_id != approval_id);
    if deciding.as_deref() == Some(approval_id) {
        *deciding = None;
    }
    queue.len() != prior
}

pub(crate) fn subagent_mcp_read_decision_is_current(
    queue: &VecDeque<SubagentMcpReadApprovalRequest>,
    deciding: Option<&str>,
    approval_id: &str,
    now: u64,
) -> bool {
    deciding.is_none()
        && queue
            .front()
            .is_some_and(|request| request.approval_id == approval_id && request.expires_at > now)
}

pub(crate) fn enqueue_subagent_mcp_mutation_request(
    queue: &mut VecDeque<SubagentMcpMutationApprovalRequest>,
    generation: Option<&GenerationState>,
    request: SubagentMcpMutationApprovalRequest,
    now: u64,
) -> Result<bool, Box<SubagentMcpMutationApprovalRequest>> {
    let exact_generation = generation.is_some_and(|generation| {
        generation.chat_id == request.chat_id
            && format!("{}:{}", generation.chat_id, generation.counter) == request.generation_id
            && !generation.complete
            && request.expires_at > now
    });
    if !exact_generation {
        return Err(Box::new(request));
    }
    if queue
        .iter()
        .any(|pending| pending.approval_id == request.approval_id)
    {
        return Ok(false);
    }
    queue.push_back(request);
    Ok(true)
}

pub(crate) fn remove_subagent_mcp_mutation_request(
    queue: &mut VecDeque<SubagentMcpMutationApprovalRequest>,
    deciding: &mut Option<String>,
    approval_id: &str,
) -> bool {
    let prior = queue.len();
    queue.retain(|request| request.approval_id != approval_id);
    if deciding.as_deref() == Some(approval_id) {
        *deciding = None;
    }
    queue.len() != prior
}

pub(crate) fn subagent_mcp_mutation_decision_is_current(
    queue: &VecDeque<SubagentMcpMutationApprovalRequest>,
    deciding: Option<&str>,
    approval_id: &str,
    now: u64,
) -> bool {
    deciding.is_none()
        && queue
            .front()
            .is_some_and(|request| request.approval_id == approval_id && request.expires_at > now)
}

/// The only presentation/arbitration order for foreground subagent effects.
/// The typed queues below retain each effect's authority payload; this tiny
/// ledger prevents one effect type from jumping ahead of another.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum SubagentApprovalKind {
    ComputerUse,
    WorkspaceWrite,
    Shell,
    McpRead,
    McpMutation,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct SubagentApprovalOrderEntry {
    approval_id: String,
    kind: SubagentApprovalKind,
}

#[derive(Debug, Clone)]
pub(crate) enum ActiveSubagentApproval {
    ComputerUse(ComputerUseApprovalRequest),
    WorkspaceWrite(SubagentWorkspaceWriteApprovalRequest),
    Shell(SubagentShellApprovalRequest),
    McpRead(SubagentMcpReadApprovalRequest),
    McpMutation(SubagentMcpMutationApprovalRequest),
}

impl ActiveSubagentApproval {
    pub(crate) fn approval_id(&self) -> &str {
        match self {
            Self::ComputerUse(request) => &request.approval_id,
            Self::WorkspaceWrite(request) => &request.approval_id,
            Self::Shell(request) => &request.approval_id,
            Self::McpRead(request) => &request.approval_id,
            Self::McpMutation(request) => &request.approval_id,
        }
    }
}

pub(crate) fn push_subagent_approval_order(
    order: &mut VecDeque<SubagentApprovalOrderEntry>,
    approval_id: &str,
    kind: SubagentApprovalKind,
) {
    if !order.iter().any(|entry| entry.approval_id == approval_id) {
        order.push_back(SubagentApprovalOrderEntry {
            approval_id: approval_id.to_string(),
            kind,
        });
    }
}

pub(crate) fn remove_subagent_approval_order(
    order: &mut VecDeque<SubagentApprovalOrderEntry>,
    approval_id: &str,
) {
    order.retain(|entry| entry.approval_id != approval_id);
}

pub(crate) fn subagent_approval_order_is_head(
    order: &VecDeque<SubagentApprovalOrderEntry>,
    kind: SubagentApprovalKind,
    approval_id: &str,
) -> bool {
    order
        .front()
        .is_some_and(|entry| entry.kind == kind && entry.approval_id == approval_id)
}

/// A lightweight owned snapshot of everything the shell renders for the active
/// chat (cloned from the service so render helpers never hold a borrow across
/// `cx.listener` closures).
#[derive(Debug, Clone, Default)]
pub struct ChatSnapshot {
    pub messages: Vec<ChatMessage>,
    pub generation: Option<GenerationState>,
    /// Memory-only foreground child projections for the exact active
    /// generation. The service obtains these from the authority cache;
    /// transcript rendering never reads the persisted run store.
    pub live_subagents: Vec<SubagentRunSnapshotV1>,
    pub selection: Option<ModelSelection>,
    pub has_providers: bool,
    pub has_key_for_selection: bool,
}

/// Exact identity of a composer submission that crossed the durable user-turn
/// boundary. The counter alone is scoped to a chat, so UI admission must carry
/// both values to prevent a late completion from another chat clearing a newer
/// draft with the same counter.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct ChatSubmissionIdentity {
    pub chat_id: String,
    pub counter: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ChatSubmissionOutcome {
    Admitted,
    Rejected,
    /// The store could not establish whether the exact turn committed (for
    /// example, a post-rename durability error). The composer remains locked
    /// rather than risking a duplicate turn on retry.
    Unknown,
}

#[derive(Default)]
struct SubmissionAdmissionLedger(HashMap<ChatSubmissionIdentity, ChatSubmissionOutcome>);

#[derive(Default)]
struct UncertainSubmissionRegistry(
    HashMap<
        ChatSubmissionIdentity,
        (
            ChatMessage,
            ModelSelection,
            ConfiguredProvider,
            Option<ResolvedSkillInvocation>,
        ),
    >,
);

impl UncertainSubmissionRegistry {
    fn take(
        &mut self,
        identity: &ChatSubmissionIdentity,
    ) -> Option<(
        ChatMessage,
        ModelSelection,
        ConfiguredProvider,
        Option<ResolvedSkillInvocation>,
    )> {
        self.0.remove(identity)
    }

    fn restore(
        &mut self,
        identity: ChatSubmissionIdentity,
        record: (
            ChatMessage,
            ModelSelection,
            ConfiguredProvider,
            Option<ResolvedSkillInvocation>,
        ),
    ) {
        self.0.insert(identity, record);
    }
}

impl SubmissionAdmissionLedger {
    fn admit(&mut self, submission: ChatSubmissionIdentity) {
        self.0.insert(submission, ChatSubmissionOutcome::Admitted);
    }

    fn resolve(&mut self, submission: ChatSubmissionIdentity, outcome: ChatSubmissionOutcome) {
        self.0.insert(submission, outcome);
    }

    fn take(&mut self, submission: &ChatSubmissionIdentity) -> Option<ChatSubmissionOutcome> {
        self.0.remove(submission)
    }
}

pub struct ChatService {
    stores: Stores,

    /// Provider catalog from the portable config.
    pub providers: Vec<ConfiguredProvider>,
    /// The models.dev capability catalog (`resources/model-capabilities.json`,
    /// built by `npm run models:refresh`). Loaded once at boot on the
    /// background executor; `None` when the file is absent (dev checkouts) —
    /// the builtin snapshot and conservative limits remain the fallback.
    /// Build-time-only data: this never contacts models.dev.
    pub capabilities: Option<Arc<aiden_providers::model_capabilities::ModelCapabilitiesCatalog>>,
    /// Current provider + model for new turns.
    pub selection: Option<ModelSelection>,
    /// Sidebar list (store order: newest-updated first).
    pub chat_list: Vec<ChatMeta>,
    pub search_query: String,
    pub active_chat_id: Option<String>,
    pub active_chat: Option<Chat>,
    pub active_error: Option<String>,
    /// Caller-owned identity retained while a first-chat create is being
    /// reconciled after an ambiguous durability result.
    pending_new_chat_id: Option<String>,
    pub appearance: AppearanceConfig,
    appearance_coordinator: AppearanceCoordinator,
    appearance_write_revision: Arc<AtomicU64>,
    appearance_debounce_revision: Arc<AtomicU64>,
    native_appearance: NativeAppearance,
    native_boot_restore: Option<NativeBootRestore>,
    system_high_contrast: bool,
    system_reduced_motion: bool,
    native_restore_completed: bool,
    native_observer_started: bool,
    native_poll_started: bool,
    pi_provider_watch_started: bool,
    /// Generation for the *active* chat (only one stream at a time).
    pub generation: Option<GenerationState>,
    /// Counter whose user turn has crossed the durable append/rebranch boundary.
    /// Admissions are retained until their owning composer consumes them. A
    /// last-value slot loses a successful completion when another (possibly
    /// stale) background completion publishes before the UI receives a frame.
    submission_outcomes: SubmissionAdmissionLedger,
    uncertain_submissions: UncertainSubmissionRegistry,
    /// Per-chat intent counters: incrementing invalidates in-flight streams.
    generations: HashMap<String, u64>,
    pub(crate) booted: bool,

    /// The active workspace (name/path chip, git repo root, terminal cwd, and
    /// agent sandbox root).
    pub workspace: Option<Workspace>,
    /// All persisted workspaces (the picker's "recent" list).
    pub workspaces: Vec<Workspace>,

    _stream_task: Option<Task<anyhow::Result<()>>>,
    _driver: Option<Task<Result<(), JoinError>>>,
    /// The shared stop flag for the in-flight generation. `drive_stream`
    /// polls it between rounds, on the flush cadence, and during tool
    /// execution; [`ChatService::stop_generation`] sets it and the driver
    /// aborts the provider stream (the token is replaced per generation, so a
    /// stale flag never leaks into the next turn).
    cancel_token: Option<Arc<AtomicBool>>,
    computer_use_cancellation: Option<CancellationToken>,
    pending_computer_use_approval: Option<ComputerUseApprovalRequest>,
    computer_use_approval_deciding: bool,
    pending_subagent_write_approvals: VecDeque<SubagentWorkspaceWriteApprovalRequest>,
    subagent_write_approval_deciding: Option<String>,
    subagent_write_approval_error: Option<String>,
    pending_subagent_shell_approvals: VecDeque<SubagentShellApprovalRequest>,
    subagent_shell_approval_deciding: Option<String>,
    subagent_shell_approval_error: Option<String>,
    pending_subagent_mcp_read_approvals: VecDeque<SubagentMcpReadApprovalRequest>,
    subagent_mcp_read_approval_deciding: Option<String>,
    subagent_mcp_read_approval_error: Option<String>,
    pending_subagent_mcp_mutation_approvals: VecDeque<SubagentMcpMutationApprovalRequest>,
    subagent_mcp_mutation_approval_deciding: Option<String>,
    subagent_mcp_mutation_approval_error: Option<String>,
    pending_subagent_approval_order: VecDeque<SubagentApprovalOrderEntry>,
    computer_use_chat_saving: bool,
    computer_use_chat_error: Option<String>,
    computer_use_chat_revision: Arc<AtomicU64>,
    title_revision: u64,
    title_cancellations: HashMap<String, (u64, FoundationModelsCancellationToken)>,
}

fn skill_selection_fence_error(
    selection: &SkillInvocationSelection,
    live_workspace_identity: Option<&str>,
    live_permission: WorkspacePermission,
) -> Option<&'static str> {
    let lease_is_unbound =
        selection.workspace_identity.is_none() && selection.workspace_permission.is_none();
    if (lease_is_unbound && live_workspace_identity.is_some())
        || (!lease_is_unbound
            && (selection.workspace_identity.as_deref() != live_workspace_identity
                || selection.workspace_permission != Some(live_permission)))
    {
        Some("The selected skill is stale; choose it again before sending.")
    } else {
        None
    }
}

impl ChatService {
    pub fn new(
        stores: Stores,
        initial_appearance: AppearanceConfig,
        prepared_native: PreparedNativeAppearance,
        cx: &mut Context<Self>,
    ) -> Self {
        let appearance = initial_appearance;
        let initial_effective = prepared_accessibility(prepared_native.restored);
        let native_restore_completed = prepared_native.restored.is_some();
        let appearance_write_revision = stores.appearance_intent_revision.clone();
        let _ = cx;
        Self {
            stores,
            providers: Vec::new(),
            capabilities: None,
            selection: None,
            chat_list: Vec::new(),
            search_query: String::new(),
            active_chat_id: None,
            active_chat: None,
            active_error: None,
            pending_new_chat_id: None,
            appearance: appearance.clone(),
            appearance_coordinator: AppearanceCoordinator::new(appearance),
            appearance_write_revision,
            appearance_debounce_revision: Arc::new(AtomicU64::new(0)),
            native_appearance: prepared_native.native,
            native_boot_restore: prepared_native.restored,
            system_high_contrast: initial_effective.high_contrast,
            system_reduced_motion: initial_effective.reduce_motion,
            native_restore_completed,
            native_observer_started: false,
            native_poll_started: false,
            pi_provider_watch_started: false,
            generation: None,
            submission_outcomes: SubmissionAdmissionLedger::default(),
            uncertain_submissions: UncertainSubmissionRegistry::default(),
            generations: HashMap::new(),
            booted: false,
            workspace: None,
            workspaces: Vec::new(),
            _stream_task: None,
            _driver: None,
            cancel_token: None,
            computer_use_cancellation: None,
            pending_computer_use_approval: None,
            computer_use_approval_deciding: false,
            pending_subagent_write_approvals: VecDeque::new(),
            subagent_write_approval_deciding: None,
            subagent_write_approval_error: None,
            pending_subagent_shell_approvals: VecDeque::new(),
            subagent_shell_approval_deciding: None,
            subagent_shell_approval_error: None,
            pending_subagent_mcp_read_approvals: VecDeque::new(),
            subagent_mcp_read_approval_deciding: None,
            subagent_mcp_read_approval_error: None,
            pending_subagent_mcp_mutation_approvals: VecDeque::new(),
            subagent_mcp_mutation_approval_deciding: None,
            subagent_mcp_mutation_approval_error: None,
            pending_subagent_approval_order: VecDeque::new(),
            computer_use_chat_saving: false,
            computer_use_chat_error: None,
            computer_use_chat_revision: Arc::new(AtomicU64::new(0)),
            title_revision: 0,
            title_cancellations: HashMap::new(),
        }
    }

    // =======================================================================
    // Boot
    // =======================================================================

    /// Load chats + provider catalog + settings from the stores (background)
    /// and populate the in-memory state. The models.dev capability catalog is
    /// loaded here too and used to enrich the provider model lists; a missing
    /// file (dev checkouts) logs and falls back to the builtin snapshot.
    pub fn boot(&mut self, cx: &mut Context<Self>) {
        if !self.pi_provider_watch_started {
            self.pi_provider_watch_started = true;
            let mut changed = self.stores.pi_providers.subscribe();
            cx.spawn(async move |this, cx| {
                while changed.changed().await.is_ok() {
                    if this
                        .update(cx, |this, cx| this.refresh_providers(cx))
                        .is_err()
                    {
                        break;
                    }
                }
            })
            .detach();
        }
        let stores = self.stores.clone();
        cx.spawn(async move |this, cx| {
            let (chats, providers, settings, appearance, workspaces, capabilities) = cx
                .background_spawn(async move {
                    let chats = stores.chat.list(None).unwrap_or_default();
                    let capabilities = load_capabilities();
                    let mut providers: Vec<ConfiguredProvider> = stores
                        .config
                        .list_providers()
                        .map(|list| {
                            list.iter()
                                .map(ConfiguredProvider::from)
                                .map(|provider| match &capabilities {
                                    Some(catalog) => enrich_provider(provider, catalog),
                                    None => provider,
                                })
                                .collect()
                        })
                        .unwrap_or_default();
                    if let Some(codex) = configured_codex_provider(stores.codex_auth.as_ref()) {
                        providers.push(codex);
                    }
                    providers.extend(stores.pi_providers.configured_providers());
                    let settings = stores.config.get_settings().unwrap_or_default();
                    let appearance = appearance_from_settings(&settings);
                    let workspaces = stores.config.list_workspaces().unwrap_or_default();
                    (
                        chats,
                        providers,
                        settings,
                        appearance,
                        workspaces,
                        capabilities,
                    )
                })
                .await;
            this.update(cx, |this, cx| {
                this.chat_list = chats;
                this.providers = providers;
                this.capabilities = capabilities;
                // The launch path already synchronously loaded and painted
                // this value. Re-reading it here only covers an external edit
                // made while the catalog was loading.
                this.appearance = appearance.clone();
                this.appearance_coordinator = AppearanceCoordinator::new(appearance);
                this.restore_native_appearance(cx);
                this.selection = this.resolve_selection(&settings);
                this.workspaces = workspaces;
                // The most recently used workspace is the active one (the TS
                // keeps this in localStorage; `updatedAt` is the port's proxy).
                this.workspace = this.workspaces.iter().max_by_key(|w| w.updated_at).cloned();
                this.booted = true;
                // Background discovery for local `custom:` providers: the
                // picker picks up running local models when it settles.
                this.merge_local_runtime_models(cx);
                cx.notify();
            })
            .ok();
        })
        .detach();
    }

    /// Resolve the persisted model selection, falling back to the first
    /// configured provider's default (or first) model.
    fn resolve_selection(
        &self,
        settings: &serde_json::Map<String, serde_json::Value>,
    ) -> Option<ModelSelection> {
        if let Some(value) = settings.get(MODEL_SELECTION_KEY) {
            if let Some(selection) = ModelSelection::from_settings(value) {
                if require_available_selection(&self.providers, &selection).is_ok() {
                    return Some(selection);
                }
            }
        }
        let provider = self.providers.first()?;
        let model = provider
            .default_model
            .clone()
            .or_else(|| provider.models.first().cloned())?;
        Some(ModelSelection {
            provider_id: provider.id.clone(),
            model,
        })
    }

    /// The provider currently selected (or whose model is selected).
    pub fn selected_provider(&self) -> Option<&ConfiguredProvider> {
        let id = self.selection.as_ref()?.provider_id.as_str();
        self.providers.iter().find(|provider| provider.id == id)
    }

    /// Re-read the provider catalog (+ persisted selection) from the config
    /// store. Used by the command palette's "Refresh provider catalogs" and
    /// any future settings-driven catalog invalidation. Re-enriches against
    /// the already-loaded capability catalog.
    pub fn refresh_providers(&mut self, cx: &mut Context<Self>) {
        let stores = self.stores.clone();
        let capabilities = self.capabilities.clone();
        cx.spawn(async move |this, cx| {
            let (providers, settings) = cx
                .background_spawn(async move {
                    let mut providers: Vec<ConfiguredProvider> = stores
                        .config
                        .list_providers()
                        .map(|list| {
                            list.iter()
                                .map(ConfiguredProvider::from)
                                .map(|provider| match &capabilities {
                                    Some(catalog) => enrich_provider(provider, catalog),
                                    None => provider,
                                })
                                .collect()
                        })
                        .unwrap_or_default();
                    if let Some(codex) = configured_codex_provider(stores.codex_auth.as_ref()) {
                        providers.push(codex);
                    }
                    providers.extend(stores.pi_providers.configured_providers());
                    let settings = stores.config.get_settings().unwrap_or_default();
                    (providers, settings)
                })
                .await;
            this.update(cx, |this, cx| {
                this.providers = providers;
                this.selection = this.resolve_selection(&settings);
                this.merge_local_runtime_models(cx);
                cx.notify();
            })
            .ok();
        })
        .detach();
    }

    /// Fold live models from running local servers into the provider catalog:
    /// for every `custom:` provider with a loopback URL, ask the running
    /// server (Ollama `/api/tags`, LM Studio `/v1/models`, or the OpenAI
    /// shape) which models it serves and merge them into the provider's model
    /// list (deduped, user-added models preserved). Runs on the tokio bridge
    /// concurrently with a 5s total bound; failures are logged quietly and the
    /// in-place update lands whenever the discovery settles, so an offline
    /// server never blocks boot. Call after `this.providers` is populated.
    fn merge_local_runtime_models(&self, cx: &mut Context<Self>) {
        let candidates: Vec<(String, String, RuntimeKind)> = self
            .providers
            .iter()
            .filter(|provider| {
                catalog::is_custom_provider_id(&provider.id)
                    && catalog::is_loopback_provider_base_url(Some(&provider.base_url))
            })
            .map(|provider| {
                (
                    provider.id.clone(),
                    provider.base_url.clone(),
                    live_discovery::runtime_kind_for_provider(&provider.id, &provider.base_url),
                )
            })
            .collect();
        if candidates.is_empty() {
            return;
        }
        let task = Tokio::spawn(cx, async move {
            futures::future::join_all(candidates.into_iter().map(
                |(provider_id, base_url, runtime)| async move {
                    let options = DiscoveryOptions {
                        total_timeout: Duration::from_millis(BOOT_DISCOVERY_TOTAL_TIMEOUT_MS),
                        ..Default::default()
                    };
                    let result =
                        live_discovery::discover_models_with_options(&base_url, runtime, &options)
                            .await;
                    (provider_id, result)
                },
            ))
            .await
        });
        cx.spawn(async move |this, cx| {
            let Ok(discoveries) = task.await else {
                return;
            };
            this.update(cx, |this, cx| {
                for (provider_id, result) in discoveries {
                    let Some(provider) = this
                        .providers
                        .iter_mut()
                        .find(|provider| provider.id == provider_id)
                    else {
                        continue;
                    };
                    match result {
                        Ok(models) => {
                            let before = provider.models.len();
                            provider.models =
                                live_discovery::merge_discovered_models(&provider.models, &models);
                            if provider.models.len() > before {
                                tracing::debug!(
                                    provider = %provider_id,
                                    added = provider.models.len() - before,
                                    "discovered live models from local runtime"
                                );
                            }
                        }
                        Err(error) => {
                            tracing::debug!(
                                provider = %provider_id,
                                error = %error,
                                "local runtime model discovery failed"
                            );
                        }
                    }
                }
                cx.notify();
            })
            .ok();
        })
        .detach();
    }

    // =======================================================================
    // Workspaces
    // =======================================================================

    /// The active workspace's folder (terminal cwd / git repo root / sandbox).
    #[allow(dead_code)] // pending workspace-picker wiring (workspace owner)
    pub fn workspace_folder(&self) -> Option<PathBuf> {
        self.workspace
            .as_ref()
            .and_then(|workspace| workspace.folder_path.as_ref())
            .map(PathBuf::from)
    }

    /// Switch to a known workspace; the recency bump persists on the background.
    #[allow(dead_code)] // pending workspace-picker wiring (workspace owner)
    pub fn select_workspace(&mut self, id: &str, cx: &mut Context<Self>) {
        let Some(workspace) = self.workspaces.iter().find(|w| w.id == id).cloned() else {
            return;
        };
        if self.workspace.as_ref().map(|w| w.id.as_str()) == Some(id) {
            return;
        }
        if let Some(previous) = self.workspace.as_ref() {
            self.stores.subagents.cancel_workspace(&previous.id);
        }
        self.workspace = Some(workspace.clone());
        self.stores
            .computer_use
            .cancel_for_workspace(Some(&workspace.id));
        self.persist_workspace(workspace, cx);
        cx.notify();
    }

    /// Create (or refresh) a workspace from a folder chosen in the OS panel and
    /// make it active. Mirrors the TS `saveWorkspaceForFolder` (realpath, must
    /// be a directory, name = basename, permission `ask`).
    #[allow(dead_code)] // pending workspace-picker wiring (workspace owner)
    pub fn add_workspace_from_folder(&mut self, folder: &std::path::Path, cx: &mut Context<Self>) {
        let stores = self.stores.clone();
        let folder = folder.to_path_buf();
        cx.spawn(async move |this, cx| {
            let created = cx
                .background_spawn(async move {
                    let canonical = std::fs::canonicalize(&folder).ok()?;
                    if !canonical.is_dir() {
                        return None;
                    }
                    let name = canonical
                        .file_name()
                        .map(|name| name.to_string_lossy().into_owned())
                        .filter(|name| !name.trim().is_empty())
                        .unwrap_or_else(|| "Workspace".to_string());
                    let now = aiden_data::now_millis();
                    let workspace = Workspace {
                        id: aiden_data::chat_store::new_uuid_like(),
                        name,
                        folder_path: Some(canonical.display().to_string()),
                        permission: WorkspacePermission::Ask,
                        managed_worktree: None,
                        created_at: now,
                        updated_at: now,
                    };
                    stores.config.save_workspace(&workspace).ok()
                })
                .await;
            this.update(cx, |this, cx| {
                if let Some(saved) = created {
                    if let Some(index) = this.workspaces.iter().position(|w| w.id == saved.id) {
                        this.workspaces[index] = saved.clone();
                    } else {
                        this.workspaces.push(saved.clone());
                    }
                    this.workspace = Some(saved);
                    cx.notify();
                }
            })
            .ok();
        })
        .detach();
    }

    /// Bump `updatedAt` through the config store so the picker's recency order
    /// and the next boot's active-workspace selection follow the selection.
    #[allow(dead_code)] // pending workspace-picker wiring (workspace owner)
    fn persist_workspace(&self, workspace: Workspace, cx: &mut Context<Self>) {
        let stores = self.stores.clone();
        cx.spawn(async move |_, cx| {
            let _ = cx
                .background_spawn(async move { stores.config.save_workspace(&workspace).ok() })
                .await;
        })
        .detach();
    }

    // =======================================================================
    // Sidebar state
    // =======================================================================

    pub fn filtered_chats(&self) -> Vec<&ChatMeta> {
        let query = self.search_query.trim().to_lowercase();
        self.chat_list
            .iter()
            .filter(|meta| query.is_empty() || meta.title.to_lowercase().contains(&query))
            .collect()
    }

    pub fn set_search_query(&mut self, query: &str, cx: &mut Context<Self>) {
        self.search_query = query.to_string();
        cx.notify();
    }

    // =======================================================================
    // Chat lifecycle
    // =======================================================================

    /// Create a new chat in the store and select it.
    pub fn new_chat(&mut self, cx: &mut Context<Self>) {
        self.cancel_generation(cx);
        let stores = self.stores.clone();
        let provider_id = self
            .selection
            .as_ref()
            .map(|selection| selection.provider_id.clone());
        let model = self
            .selection
            .as_ref()
            .map(|selection| selection.model.clone());
        let workspace_id = self
            .workspace
            .as_ref()
            .map(|workspace| workspace.id.clone());
        cx.spawn(async move |this, cx| {
            let created = cx
                .background_spawn(async move {
                    stores
                        .chat
                        .create(ChatStoreInput {
                            title: None,
                            workspace_id: workspace_id.as_deref(),
                            provider_id: provider_id.as_deref(),
                            model: model.as_deref(),
                        })
                        .ok()
                })
                .await;
            if let Some(chat) = created {
                this.update(cx, |this, cx| {
                    this.active_chat_id = Some(chat.id.clone());
                    this.active_chat = Some(chat);
                    this.active_error = None;
                    this.refresh_chat_list(cx);
                    cx.notify();
                })
                .ok();
            }
        })
        .detach();
    }

    /// Select a chat, cancelling any in-flight generation (intent bump).
    pub fn select_chat(&mut self, id: &str, cx: &mut Context<Self>) {
        if self.active_chat_id.as_deref() == Some(id) {
            return;
        }
        self.cancel_generation(cx);
        self.active_chat_id = Some(id.to_string());
        self.active_chat = None;
        self.active_error = None;
        cx.notify();
        self.load_chat(id, cx);
    }

    fn load_chat(&self, id: &str, cx: &mut Context<Self>) {
        let stores = self.stores.clone();
        let id = id.to_string();
        cx.spawn(async move |this, cx| {
            let task_id = id.clone();
            let chat = cx
                .background_spawn(async move { stores.chat.get(&task_id).ok().flatten() })
                .await;
            this.update(cx, |this, cx| {
                if this.active_chat_id.as_deref() == Some(id.as_str()) {
                    this.active_chat = chat;
                    if this.active_chat.is_none() {
                        this.active_error = Some("This chat could not be read from disk.".into());
                    }
                }
                cx.notify();
            })
            .ok();
        })
        .detach();
    }

    pub fn delete_chat(&mut self, id: &str, cx: &mut Context<Self>) {
        let was_active = self.active_chat_id.as_deref() == Some(id);
        // Cancel any in-flight generation for the chat being deleted — even
        // when it is not the active chat — so the provider stops billing and a
        // stale stream watcher cannot re-append to a removed chat (TS
        // `llmClient.cancelChat`). Partial content is NOT persisted: the chat
        // is about to be removed with it.
        let generating_this_chat = self
            .generation
            .as_ref()
            .is_some_and(|generation| generation.chat_id == id);
        if was_active || generating_this_chat {
            self.stores.subagents.cancel_chat(id);
            if let Some(token) = &self.cancel_token {
                token.store(true, Ordering::Relaxed);
            }
            if let Some(token) = self.computer_use_cancellation.take() {
                token.cancel();
            }
            self.stores.computer_use.cancel_for_chat(id);
            self.pending_computer_use_approval = None;
            self.computer_use_approval_deciding = false;
            self.clear_subagent_write_approvals();
            // Bump the per-chat intent counter so the in-flight watcher stops
            // draining immediately (its `generation_matches` check fails once
            // `generation` is cleared below).
            if let Some(counter) = self.generations.get_mut(id) {
                *counter += 1;
            }
            self._stream_task = None;
            self._driver = None;
            self.generation = None;
        }
        let stores = self.stores.clone();
        let id = id.to_string();
        cx.spawn(async move |this, cx| {
            let task_id = id.clone();
            // Cross-store deletion mirroring TS `chats:remove`: subagent runs
            // first (the run store preflights, removes the chat's runs, and
            // tombstones a pending-deletion marker), then the chat record,
            // then — once both stores are durable — clear the marker. Failures
            // are logged (the service has no per-delete error surface); the
            // pending marker machinery keeps a crash-interrupted delete
            // recoverable at the next startup reconciliation.
            cx.background_spawn(async move {
                if let Some(runs) = &stores.runs {
                    if let Err(error) = runs.dispatcher.delete_chat(&task_id) {
                        tracing::warn!(
                            "could not delete subagent history for chat {task_id}: {error}"
                        );
                    }
                }
                let removed = stores.chat.remove(&task_id).ok();
                if let Some(runs) = &stores.runs {
                    if let Err(error) = runs.dispatcher.complete_chat_deletion(&task_id) {
                        tracing::warn!("could not complete chat deletion for {task_id}: {error}");
                    }
                }
                removed
            })
            .await;
            this.update(cx, |this, cx| {
                this.chat_list.retain(|meta| meta.id != id);
                if this.active_chat_id.as_deref() == Some(id.as_str()) {
                    this.active_chat_id = None;
                    this.active_chat = None;
                    // Don't strand the user on an empty pane with a populated
                    // sidebar: fall back to the most recent remaining chat.
                    if let Some(next) = next_chat_after_delete(&this.chat_list) {
                        let next_id = next.id.clone();
                        this.active_chat_id = Some(next_id.clone());
                        this.load_chat(&next_id, cx);
                    }
                }
                cx.notify();
            })
            .ok();
        })
        .detach();
    }

    fn refresh_chat_list(&self, cx: &mut Context<Self>) {
        let stores = self.stores.clone();
        cx.spawn(async move |this, cx| {
            let list = cx
                .background_spawn(async move { stores.chat.list(None).unwrap_or_default() })
                .await;
            this.update(cx, |this, cx| {
                this.chat_list = list;
                cx.notify();
            })
            .ok();
        })
        .detach();
    }

    // =======================================================================
    // Model selection
    // =======================================================================

    pub fn select_model(&mut self, provider_id: &str, model: &str, cx: &mut Context<Self>) {
        let Some(provider) = self
            .providers
            .iter()
            .find(|provider| provider.id == provider_id)
        else {
            return;
        };
        let next = ModelSelection {
            provider_id: provider.id.clone(),
            model: model.to_string(),
        };
        if self.selection.as_ref() == Some(&next) {
            return;
        }
        if let Some(previous) = self.selection.as_ref() {
            self.stores.subagents.cancel_provider(&previous.provider_id);
        }
        self.selection = Some(next.clone());
        self.stores
            .computer_use
            .cancel_for_provider(&next.provider_id);
        self.persist_selection(&next, cx);
        cx.notify();
    }

    fn persist_selection(&self, selection: &ModelSelection, cx: &mut Context<Self>) {
        let stores = self.stores.clone();
        let value = selection.to_settings();
        cx.spawn(async move |_, cx| {
            let _ = cx
                .background_spawn(async move {
                    let mut patch = serde_json::Map::new();
                    patch.insert(MODEL_SELECTION_KEY.to_string(), value);
                    let _ = stores.config.set_settings(&patch, &|| true);
                })
                .await;
        })
        .detach();
    }

    // =======================================================================
    // Appearance
    // =======================================================================

    pub fn set_appearance_mode(&mut self, mode: Mode, cx: &mut Context<Self>) {
        if self.appearance.mode == mode {
            return;
        }
        let mut appearance = self.appearance.clone();
        appearance.mode = mode;
        self.set_appearance_config(appearance, true, cx);
    }

    /// The only live appearance mutation path. Settings and command surfaces
    /// both route here so preview, GPUI theme application, persistence,
    /// failure, and stale-completion fencing share one coordinator.
    pub fn set_appearance_config(
        &mut self,
        appearance: AppearanceConfig,
        apply_native: bool,
        cx: &mut Context<Self>,
    ) {
        if self.appearance == appearance {
            return;
        }
        let native_changed = NativeAppearanceIntent::from(&self.appearance)
            != NativeAppearanceIntent::from(&appearance);
        self.appearance_coordinator.preview(appearance.clone());
        // One process-wide appearance intent fences every store publication,
        // including previews that later fail native application.
        self.next_appearance_intent();
        self.appearance = appearance;
        if self.native_appearance.is_supported() && (apply_native || native_changed) {
            let operation = self.appearance_coordinator.begin_native_apply();
            self.next_appearance_intent();
            match self
                .native_appearance
                .apply(operation.intent.mode, operation.intent.dock_icon)
            {
                Ok(()) => {
                    self.appearance_coordinator
                        .complete_native_apply(operation.revision, Ok(()));
                    self.apply_appearance(cx);
                }
                Err(message) => {
                    self.appearance_coordinator.complete_native_apply(
                        operation.revision,
                        Err(AppearanceFailure::retryable(
                            AppearanceOperationKind::NativeApply,
                            message,
                        )),
                    );
                    self.appearance = self.appearance_coordinator.effective().clone();
                    self.apply_appearance(cx);
                    cx.notify();
                    return;
                }
            }
        }
        // Most preferences have no native side effect, but every safe
        // mutation must still update the live GPUI projection immediately.
        self.apply_appearance(cx);
        self.schedule_appearance_persist(cx);
        cx.notify();
    }

    pub fn appearance_save_failure(&self) -> Option<&str> {
        match self.appearance_coordinator.save_state() {
            AppearanceSaveState::Failed { failure, .. } => Some(failure.message.as_str()),
            _ => None,
        }
    }

    pub fn appearance_native_failure(&self) -> Option<&str> {
        match self.appearance_coordinator.native_state() {
            crate::services::appearance_coordinator::NativeAppearanceState::Failed {
                failure,
                ..
            } => Some(&failure.message),
            _ => None,
        }
    }

    pub fn appearance_for_editing(&self) -> &AppearanceConfig {
        self.appearance_coordinator.editing()
    }

    pub fn native_appearance_supported(&self) -> bool {
        self.native_appearance.is_supported()
    }

    /// The current OS accessibility snapshot, kept alongside the persisted
    /// preference so secondary windows can make the same System decision.
    pub fn system_reduced_motion(&self) -> bool {
        self.system_reduced_motion
    }

    pub fn retry_native_appearance(&mut self, cx: &mut Context<Self>) {
        let Some(operation) = self.appearance_coordinator.retry_native_apply() else {
            return;
        };
        self.next_appearance_intent();
        match self
            .native_appearance
            .apply(operation.intent.mode, operation.intent.dock_icon)
        {
            Ok(()) => {
                self.appearance_coordinator
                    .complete_native_apply(operation.revision, Ok(()));
                self.appearance = self.appearance_coordinator.effective().clone();
                self.apply_appearance(cx);
                self.schedule_appearance_persist(cx);
            }
            Err(message) => {
                self.appearance_coordinator.complete_native_apply(
                    operation.revision,
                    Err(AppearanceFailure::retryable(
                        AppearanceOperationKind::NativeApply,
                        message,
                    )),
                );
                self.appearance = self.appearance_coordinator.effective().clone();
                self.apply_appearance(cx);
            }
        }
        cx.notify();
    }

    pub fn retry_appearance_save(&mut self, cx: &mut Context<Self>) {
        if matches!(
            self.appearance_coordinator.save_state(),
            AppearanceSaveState::Failed { failure, .. } if failure.retryable
        ) {
            self.persist_appearance(cx);
            cx.notify();
        }
    }

    /// Flush the newest preview immediately. The app lifecycle calls this at
    /// shutdown; settings can use it before leaving the surface.
    pub fn flush_appearance_save(&mut self, cx: &mut Context<Self>) {
        self.appearance_debounce_revision
            .fetch_add(1, Ordering::AcqRel);
        if !matches!(
            self.appearance_coordinator.save_state(),
            AppearanceSaveState::Saving(_)
        ) {
            self.persist_appearance(cx);
        }
    }

    /// Last-chance quit barrier. `DataStore::set_settings` is its atomic local
    /// write, so doing it synchronously here ensures the current appearance
    /// intent is durably published before GPUI tears down its executors.
    /// Existing async writes are fenced first and cannot publish afterward.
    pub fn flush_appearance_save_before_quit(&mut self) {
        self.next_appearance_intent();
        let mut patch = serde_json::Map::new();
        patch.insert(
            SETTINGS_APPEARANCE_KEY.to_string(),
            appearance_to_settings(&self.appearance),
        );
        if let Err(error) = self.stores.config.set_settings(&patch, &|| true) {
            tracing::error!("could not flush Appearance before quit: {error}");
        }
    }

    fn next_appearance_intent(&self) -> u64 {
        claim_appearance_intent(&self.appearance_write_revision)
    }

    pub fn apply_appearance(&self, cx: &mut Context<Self>) {
        cx.set_global(AidenSystemAccessibility {
            high_contrast: self.system_high_contrast,
            reduced_motion: self.system_reduced_motion,
        });
        let scheme = resolve_scheme(self.appearance.mode, cx.window_appearance());
        let high_contrast = crate::services::appearance::current_system_high_contrast(cx);
        apply_appearance(
            cx,
            &self.appearance,
            scheme,
            high_contrast,
            self.system_reduced_motion,
        );
    }

    fn restore_native_appearance(&mut self, cx: &mut Context<Self>) {
        if !self.native_appearance.is_supported() {
            return;
        }
        if let Some(restored) = self.native_boot_restore.take() {
            self.native_restore_completed = true;
            if self.appearance.dock_icon != restored.dock_icon {
                self.appearance.dock_icon = restored.dock_icon;
                self.appearance_coordinator = AppearanceCoordinator::new(self.appearance.clone());
                self.schedule_appearance_persist(cx);
            }
            self.system_high_contrast = restored.effective.high_contrast;
            self.system_reduced_motion = restored.effective.reduce_motion;
            self.apply_appearance(cx);
            self.native_observer_started = self.native_appearance.ensure_observation().is_ok();
            self.start_native_appearance_poll(cx);
            return;
        }
        if self.native_restore_completed {
            self.native_observer_started = self.native_appearance.ensure_observation().is_ok();
            self.start_native_appearance_poll(cx);
            return;
        }
        match self
            .native_appearance
            .restore_at_boot(self.appearance.mode, self.appearance.dock_icon)
        {
            Ok(restored) => {
                self.native_restore_completed = true;
                // Observation is deliberately independent from restore. A
                // registration failure leaves the restored native state valid
                // and `poll_native_appearance_events` retries later.
                self.native_observer_started = self.native_appearance.ensure_observation().is_ok();
                if self.appearance.dock_icon != restored.dock_icon {
                    // The native boundary fell back to the stable Aiden icon.
                    // Persist the confirmed selection so Settings never shows
                    // a Dock icon that the process could not actually apply.
                    self.appearance.dock_icon = restored.dock_icon;
                    self.appearance_coordinator =
                        AppearanceCoordinator::new(self.appearance.clone());
                    self.schedule_appearance_persist(cx);
                }
                self.system_high_contrast = restored.effective.high_contrast;
                self.system_reduced_motion = restored.effective.reduce_motion;
                self.apply_appearance(cx);
            }
            Err(message) => {
                let operation = self.appearance_coordinator.begin_native_apply();
                self.appearance_coordinator.complete_native_apply(
                    operation.revision,
                    Err(AppearanceFailure::retryable(
                        AppearanceOperationKind::NativeApply,
                        message,
                    )),
                );
                self.appearance = self.appearance_coordinator.effective().clone();
            }
        }
        // Accessibility notifications originate in AppKit. Polling the small
        // channel on GPUI's foreground executor keeps entity mutation and
        // theme application main-thread confined; the weak entity ends this
        // task when the app shuts down.
        self.start_native_appearance_poll(cx);
    }

    fn start_native_appearance_poll(&mut self, cx: &mut Context<Self>) {
        if self.native_poll_started {
            return;
        }
        self.native_poll_started = true;
        cx.spawn(async move |this, cx| loop {
            cx.background_executor()
                .timer(Duration::from_millis(150))
                .await;
            if this
                .update(cx, |this, cx| this.poll_native_appearance_events(cx))
                .is_err()
            {
                break;
            }
        })
        .detach();
    }

    pub fn poll_native_appearance_events(&mut self, cx: &mut Context<Self>) {
        if native_restore_retry_needed(
            self.native_restore_completed,
            self.native_appearance.is_supported(),
        ) {
            if let Ok(restored) = self
                .native_appearance
                .restore_at_boot(self.appearance.mode, self.appearance.dock_icon)
            {
                self.native_restore_completed = true;
                let recovery = self.appearance_coordinator.begin_native_apply();
                self.appearance_coordinator
                    .complete_native_apply(recovery.revision, Ok(()));
                self.appearance = self.appearance_coordinator.effective().clone();
                self.system_high_contrast = restored.effective.high_contrast;
                self.system_reduced_motion = restored.effective.reduce_motion;
                if self.appearance.dock_icon != restored.dock_icon {
                    self.appearance.dock_icon = restored.dock_icon;
                    self.appearance_coordinator =
                        AppearanceCoordinator::new(self.appearance.clone());
                    self.schedule_appearance_persist(cx);
                }
                self.apply_appearance(cx);
                cx.notify();
            }
        }
        if native_observer_retry_needed(
            self.native_observer_started,
            self.native_appearance.is_supported(),
        ) {
            self.native_observer_started = self.native_appearance.ensure_observation().is_ok();
        }
        let events = self.native_appearance.take_events();
        let mut changed = false;
        for event in events {
            match event {
                AppearanceEvent::EffectiveChanged(effective) => {
                    changed |= self.system_high_contrast != effective.high_contrast
                        || self.system_reduced_motion != effective.reduce_motion;
                    self.system_high_contrast = effective.high_contrast;
                    self.system_reduced_motion = effective.reduce_motion;
                }
                AppearanceEvent::AccessibilityChanged(options) => {
                    changed |= self.system_high_contrast != options.high_contrast
                        || self.system_reduced_motion != options.reduce_motion;
                    self.system_high_contrast = options.high_contrast;
                    self.system_reduced_motion = options.reduce_motion;
                }
            }
        }
        if changed {
            self.apply_appearance(cx);
            cx.notify();
        }
    }

    fn persist_appearance(&mut self, cx: &mut Context<Self>) {
        let stores = self.stores.clone();
        let operation = self.appearance_coordinator.begin_save();
        let revision = operation.revision;
        let publication = self.next_appearance_intent();
        let current_revision = self.appearance_write_revision.clone();
        let value = appearance_to_settings(&operation.appearance);
        cx.spawn(async move |this, cx| {
            let result = cx
                .background_spawn(async move {
                    let mut patch = serde_json::Map::new();
                    patch.insert(SETTINGS_APPEARANCE_KEY.to_string(), value);
                    stores
                        .config
                        .set_settings(&patch, &|| {
                            appearance_intent_is_current(&current_revision, publication)
                        })
                        .map(|_| ())
                })
                .await;
            this.update(cx, |this, cx| {
                let result = result.map_err(|error| {
                    AppearanceFailure::retryable(
                        AppearanceOperationKind::Save,
                        format!("Aiden couldn’t save Appearance: {error}"),
                    )
                });
                let disposition = this.appearance_coordinator.complete_save(revision, result);
                this.appearance = this.appearance_coordinator.effective().clone();
                // A user may edit while the previous JSON write is in flight.
                // Once that write settles, publish the newest retained intent
                // rather than leaving it merely Dirty until another gesture.
                if disposition
                    == crate::services::appearance_coordinator::CompletionDisposition::Applied
                    && matches!(
                        this.appearance_coordinator.save_state(),
                        AppearanceSaveState::Dirty
                    )
                {
                    this.schedule_appearance_persist(cx);
                }
                cx.notify();
            })
            .ok();
        })
        .detach();
    }

    fn schedule_appearance_persist(&mut self, cx: &mut Context<Self>) {
        let scheduled = self
            .appearance_debounce_revision
            .fetch_add(1, Ordering::AcqRel)
            + 1;
        let revision = self.appearance_debounce_revision.clone();
        cx.spawn(async move |this, cx| {
            cx.background_executor()
                .timer(Duration::from_millis(220))
                .await;
            if revision.load(Ordering::Acquire) != scheduled {
                return;
            }
            let _ = this.update(cx, |this, cx| {
                if revision.load(Ordering::Acquire) == scheduled {
                    this.persist_appearance(cx);
                }
            });
        })
        .detach();
    }

    // =======================================================================
    // Generation
    // =======================================================================

    pub fn generation_active(&self) -> bool {
        self.generation
            .as_ref()
            .is_some_and(|generation| !generation.complete)
    }

    /// Consume exactly one completed durable admission. This is intentionally
    /// keyed by the full chat/counter identity, not by whichever task happened
    /// to finish last.
    pub fn take_submission_outcome(
        &mut self,
        submission: &ChatSubmissionIdentity,
    ) -> Option<ChatSubmissionOutcome> {
        self.submission_outcomes.take(submission)
    }

    /// Re-check an indeterminate durable write after the user explicitly
    /// reopens the chat. Until this resolves, the composer keeps its exact
    /// draft locked so a retry cannot duplicate a turn.
    pub fn reconcile_unknown_submission(
        &mut self,
        submission: &ChatSubmissionIdentity,
        cx: &mut Context<Self>,
    ) {
        // Take ownership before spawning so repeated reopen commands cannot
        // race multiple recoveries into duplicate provider starts.
        let Some((message, selection, provider, skill_invocation)) =
            self.uncertain_submissions.take(submission)
        else {
            return;
        };
        let retry_message = message.clone();
        let identity = submission.clone();
        let reconciliation_identity = identity.clone();
        let stores = self.stores.clone();
        cx.spawn(async move |this, cx| {
            let result = cx
                .background_spawn(async move {
                    stores
                        .chat
                        .reconcile_submission(&reconciliation_identity.chat_id, &message)
                })
                .await;
            this.update(cx, |this, cx| {
                let outcome = match &result {
                    Ok(Some(_)) => ChatSubmissionOutcome::Admitted,
                    Ok(None) => ChatSubmissionOutcome::Rejected,
                    Err(_) => ChatSubmissionOutcome::Unknown,
                };
                this.submission_outcomes.resolve(identity.clone(), outcome);
                if outcome == ChatSubmissionOutcome::Unknown {
                    this.uncertain_submissions.restore(
                        identity.clone(),
                        (
                            retry_message,
                            selection.clone(),
                            provider.clone(),
                            skill_invocation.clone(),
                        ),
                    );
                }
                if let Ok(Some(chat)) = result {
                    if this.active_chat_id.as_deref() == Some(identity.chat_id.as_str()) {
                        this.active_chat = Some(chat.clone());
                    }
                    if this.active_chat_id.as_deref() == Some(identity.chat_id.as_str())
                        && this.selection.as_ref() == Some(&selection)
                        && this.generation_matches(&identity.chat_id, identity.counter)
                        && this.generation_active()
                    {
                        if let Some(generation) = this.generation.as_mut() {
                            generation.error = None;
                        }
                        this.start_generation(
                            identity.chat_id.clone(),
                            selection,
                            provider,
                            chat,
                            skill_invocation,
                            cx,
                        );
                    }
                }
                if outcome == ChatSubmissionOutcome::Rejected
                    && this.generation_matches(&identity.chat_id, identity.counter)
                {
                    if let Some(generation) = this.generation.as_mut() {
                        generation.complete = true;
                        generation.error =
                            Some("The message could not be saved, so it was not sent.".into());
                    }
                }
                cx.notify();
            })
            .ok();
        })
        .detach();
    }

    fn bump_generation(&mut self, chat_id: &str) -> u64 {
        let counter = self.generations.get(chat_id).copied().unwrap_or(0) + 1;
        self.generations.insert(chat_id.to_string(), counter);
        counter
    }

    /// Whether the in-flight watcher should keep draining messages for this
    /// generation. Counter bumps (a new turn) and chat switches invalidate
    /// stale streams; a stopped generation keeps matching until the driver
    /// settles with its terminal `Cancelled` event so partial content and
    /// usage are recorded.
    fn generation_matches(&self, chat_id: &str, counter: u64) -> bool {
        self.generation.as_ref().is_some_and(|generation| {
            generation.chat_id == chat_id && generation.counter == counter
        })
    }

    /// The snapshot the shell renders for the active chat.
    pub fn snapshot(&self) -> ChatSnapshot {
        let provider = self.selected_provider();
        let generation = self.generation.clone();
        let live_subagents = generation
            .as_ref()
            .filter(|generation| !generation.complete)
            .map(|generation| {
                self.stores.subagents.live_snapshots_for_generation(
                    &format!("{}:{}", generation.chat_id, generation.counter),
                    &generation.chat_id,
                )
            })
            .unwrap_or_default();
        ChatSnapshot {
            messages: self
                .active_chat
                .as_ref()
                .map(|chat| chat.messages.clone())
                .unwrap_or_default(),
            generation,
            live_subagents,
            selection: self.selection.clone(),
            has_providers: !self.providers.is_empty(),
            has_key_for_selection: provider
                .is_some_and(|provider| !provider.needs_key || provider.has_key),
        }
    }

    // -----------------------------------------------------------------------
    // Send / stop / stream application
    // -----------------------------------------------------------------------

    /// The MCP tool wiring for one turn: present only when the portable config
    /// has enabled servers. The keychain is only touched on the background
    /// driver thread via the injected preset-key resolver.
    fn mcp_context(&self) -> Option<McpStreamContext> {
        let enabled: Vec<aiden_data::portable_config::McpServer> = self
            .stores
            .config
            .list_mcp_servers()
            .unwrap_or_default()
            .into_iter()
            .filter(|server| server.enabled)
            .collect();
        if enabled.is_empty() {
            return None;
        }
        let authority = self.stores.mcp_mutation.clone();
        let key_servers = enabled.clone();
        Some(McpStreamContext {
            manager: self.stores.mcp.clone(),
            authority: Some(self.stores.mcp_mutation.clone()),
            servers: enabled,
            preset_key: Some(Arc::new(move |server_id| {
                let server = key_servers.iter().find(|server| server.id == server_id)?;
                authority.bound_preset_key(server).ok().flatten()
            })),
        })
    }

    fn resolve_skill_selection(
        &self,
        selection: &SkillInvocationSelection,
    ) -> Result<ResolvedSkillInvocation, String> {
        let live_workspace_identity = self
            .workspace
            .as_ref()
            .map(|workspace| workspace.id.as_str());
        let live_permission = self
            .workspace
            .as_ref()
            .map(|workspace| workspace.permission)
            .unwrap_or(WorkspacePermission::None);
        if let Some(error) =
            skill_selection_fence_error(selection, live_workspace_identity, live_permission)
        {
            return Err(error.into());
        }
        let context = stream_context_for_mode(
            SkillRuntimeMode::Chat,
            self.stores.config.clone(),
            self.workspace
                .as_ref()
                .and_then(|workspace| workspace.folder_path.as_deref())
                .map(PathBuf::from),
            live_permission,
        )
        .ok_or_else(|| "Skills are unavailable for this chat.".to_string())?;
        let cancel = AtomicBool::new(false);
        resolve_skill_invocation(
            &context,
            &selection.id,
            &selection.name,
            selection.source,
            &selection.revision,
            &cancel,
        )
        .map_err(|error| match error {
            SkillInvocationResolutionError::Missing => {
                "The selected skill is no longer available; choose it again before sending."
                    .to_string()
            }
            SkillInvocationResolutionError::Stale => {
                "The selected skill changed; choose it again before sending.".to_string()
            }
        })
    }

    /// Send with attachments and optional edit target (rebranch).
    #[expect(
        dead_code,
        reason = "legacy non-skill callers retain the simple send seam"
    )]
    pub fn send_message_with(
        &mut self,
        text: &str,
        attachments: Vec<aiden_core::Attachment>,
        editing_message_id: Option<String>,
        cx: &mut Context<Self>,
    ) -> Option<ChatSubmissionIdentity> {
        self.send_message_with_skill(text, attachments, editing_message_id, None, cx)
    }

    /// Send one draft, resolving an optional opaque slash skill lease against
    /// the fresh authoritative registry before creating/appending a chat.
    /// Resolution failures leave the caller's exact draft untouched.
    pub fn send_message_with_skill(
        &mut self,
        text: &str,
        attachments: Vec<aiden_core::Attachment>,
        editing_message_id: Option<String>,
        skill_selection: Option<SkillInvocationSelection>,
        cx: &mut Context<Self>,
    ) -> Option<ChatSubmissionIdentity> {
        let text = text.trim().to_string();
        if (text.is_empty() && attachments.is_empty()) || self.generation_active() {
            return None;
        }
        let Some(selection) = self.selection.clone() else {
            self.active_error = Some("Select a provider and model to start chatting.".into());
            cx.notify();
            return None;
        };
        let provider = match require_available_selection(&self.providers, &selection) {
            Ok(provider) => provider,
            Err(error) => {
                self.active_error = Some(error.to_string());
                cx.notify();
                return None;
            }
        };
        if provider.needs_key && !provider.has_key {
            self.active_error = Some(format!(
                "No API key set for {}. Add one in Settings → Providers.",
                provider.label
            ));
            cx.notify();
            return None;
        }
        if let Some(error) = image_submission_error(&provider, &selection, &attachments) {
            self.active_error = Some(error.into());
            cx.notify();
            return None;
        }

        let skill_invocation = match skill_selection.as_ref() {
            Some(selection) => match self.resolve_skill_selection(selection) {
                Ok(invocation) => Some(invocation),
                Err(error) => {
                    self.active_error = Some(error);
                    cx.notify();
                    return None;
                }
            },
            None => None,
        };

        // Ensure a persisted chat exists (one-time synchronous create on first
        // send; message persistence below always runs on the background).
        let chat_id = match self.active_chat_id.clone() {
            Some(id) => id,
            None => {
                let requested_id = self
                    .pending_new_chat_id
                    .get_or_insert_with(aiden_data::chat_store::new_uuid_like)
                    .clone();
                match self.stores.chat.create_with_id(
                    &requested_id,
                    ChatStoreInput {
                        title: None,
                        workspace_id: self.workspace.as_ref().map(|w| w.id.as_str()),
                        provider_id: Some(&selection.provider_id),
                        model: Some(&selection.model),
                    },
                ) {
                    Ok(chat) => {
                        self.pending_new_chat_id = None;
                        let meta = meta_of(&chat);
                        self.chat_list.insert(0, meta);
                        let chat_id = chat.id.clone();
                        self.active_chat_id = Some(chat_id.clone());
                        self.active_chat = Some(chat);
                        chat_id
                    }
                    Err(error) => match self.stores.chat.get(&requested_id) {
                        Ok(Some(chat)) => {
                            // The payload was durable despite a post-rename error;
                            // reuse this exact chat rather than creating another.
                            self.pending_new_chat_id = None;
                            let meta = meta_of(&chat);
                            self.chat_list.insert(0, meta);
                            let chat_id = chat.id.clone();
                            self.active_chat_id = Some(chat_id.clone());
                            self.active_chat = Some(chat);
                            chat_id
                        }
                        Ok(None) => {
                            self.active_error = Some(format!("Couldn't create the chat: {error}"));
                            cx.notify();
                            return None;
                        }
                        Err(_) => {
                            self.active_error = Some("Aiden could not determine whether the new chat was created. Retry to reconcile this chat before starting another.".into());
                            cx.notify();
                            return None;
                        }
                    },
                }
            }
        };

        let rebranch_keep = editing_message_id.as_ref().and_then(|edit_id| {
            self.active_chat
                .as_ref()?
                .messages
                .iter()
                .position(|message| &message.id == edit_id)
        });

        let counter = self.bump_generation(&chat_id);
        self.active_error = None;
        self.generation = Some(GenerationState {
            chat_id: chat_id.clone(),
            counter,
            provider_id: selection.provider_id.clone(),
            text: String::new(),
            thinking: String::new(),
            thinking_active: false,
            thinking_expanded: false,
            complete: false,
            error: None,
            error_retryable: false,
            model: Some(selection.model.clone()),
            timeline: None,
        });
        cx.notify();

        // The user turn becomes visible only after its append/rebranch commits.
        let user_message = ChatMessage {
            id: format!("user-{}", aiden_data::chat_store::new_uuid_like()),
            role: ChatRole::User,
            content: text.clone(),
            created_at: now_millis(),
            model: None,
            reasoning: None,
            attachments: if attachments.is_empty() {
                None
            } else {
                Some(attachments.clone())
            },
            skill_provenance: skill_invocation
                .as_ref()
                .map(skill_provenance_from_invocation),
            timeline: None,
            subagents: None,
        };
        self.persist_user_message_and_start(
            &chat_id,
            counter,
            &user_message,
            selection,
            provider,
            rebranch_keep,
            skill_invocation,
            cx,
        );
        Some(ChatSubmissionIdentity { chat_id, counter })
    }

    /// Drive one generation against the CURRENT in-memory history of `chat_id`
    /// (which must end with a user message). Shared by `send_message` (appends
    /// the user turn first) and `retry_last` (retracts the failed assistant
    /// turn first, then re-sends the existing last user turn).
    fn computer_use_context(
        &self,
        chat_id: &str,
        counter: u64,
        selection: &ModelSelection,
        provider: &ConfiguredProvider,
        cancellation: CancellationToken,
    ) -> Option<ComputerUseStreamContext> {
        let chat = self
            .active_chat
            .as_ref()
            .filter(|chat| chat.id == chat_id && chat.computer_use_enabled == Some(true))?;
        let workspace = self.workspace.as_ref().filter(|workspace| {
            workspace.folder_path.is_some() && workspace.permission != WorkspacePermission::None
        })?;
        if chat.workspace_id.as_deref() != Some(workspace.id.as_str())
            || chat.provider_id.as_deref() != Some(selection.provider_id.as_str())
            || !self.stores.computer_use.global_enabled()
        {
            return None;
        }
        let supports_images = computer_use_model_capabilities(provider, selection)?;
        Some(ComputerUseStreamContext {
            authority: Arc::clone(&self.stores.computer_use),
            identity: ComputerUseGenerationIdentity {
                generation_id: format!("{chat_id}:{counter}"),
                chat_id: chat_id.to_string(),
                workspace_id: Some(workspace.id.clone()),
                provider_id: selection.provider_id.clone(),
            },
            gate_revision: self.stores.computer_use.generation_snapshot(),
            supports_images,
            cancellation,
        })
    }

    pub fn pending_computer_use_approval(&self) -> Option<&ComputerUseApprovalRequest> {
        match self.pending_subagent_approval_order.front() {
            Some(entry) if entry.kind == SubagentApprovalKind::ComputerUse => self
                .pending_computer_use_approval
                .as_ref()
                .filter(|request| request.approval_id == entry.approval_id),
            _ => None,
        }
    }

    pub fn computer_use_approval_deciding(&self) -> bool {
        self.pending_computer_use_approval().is_some() && self.computer_use_approval_deciding
    }

    pub fn pending_subagent_write_approval(
        &self,
    ) -> Option<&SubagentWorkspaceWriteApprovalRequest> {
        match self.pending_subagent_approval_order.front() {
            Some(entry) if entry.kind == SubagentApprovalKind::WorkspaceWrite => self
                .pending_subagent_write_approvals
                .iter()
                .find(|request| request.approval_id == entry.approval_id),
            _ => None,
        }
    }

    pub fn subagent_write_approval_deciding(&self) -> bool {
        self.pending_subagent_write_approval()
            .is_some_and(|request| {
                self.subagent_write_approval_deciding.as_deref()
                    == Some(request.approval_id.as_str())
            })
    }

    pub fn subagent_write_approval_error(&self) -> Option<&str> {
        self.subagent_write_approval_error.as_deref()
    }

    pub fn decide_subagent_write_approval(
        &mut self,
        approval_id: &str,
        decision: SubagentWorkspaceWriteDecision,
        cx: &mut Context<Self>,
    ) -> bool {
        let matches = subagent_approval_order_is_head(
            &self.pending_subagent_approval_order,
            SubagentApprovalKind::WorkspaceWrite,
            approval_id,
        ) && subagent_write_decision_is_current(
            &self.pending_subagent_write_approvals,
            self.subagent_write_approval_deciding.as_deref(),
            approval_id,
            now_millis(),
        );
        let decided = matches
            && self
                .stores
                .subagents
                .decide_workspace_write_approval(approval_id, decision);
        if decided {
            self.subagent_write_approval_deciding = Some(approval_id.to_string());
            self.subagent_write_approval_error = None;
            cx.notify();
        } else if matches {
            self.subagent_write_approval_error =
                Some("This approval is no longer current. The file was not changed.".into());
            cx.notify();
        }
        decided
    }

    fn clear_subagent_write_approvals(&mut self) {
        self.pending_subagent_write_approvals.clear();
        self.subagent_write_approval_deciding = None;
        self.subagent_write_approval_error = None;
        self.clear_subagent_shell_approvals();
        self.clear_subagent_mcp_read_approvals();
        self.clear_subagent_mcp_mutation_approvals();
        self.pending_subagent_approval_order.clear();
    }

    pub fn pending_subagent_shell_approval(&self) -> Option<&SubagentShellApprovalRequest> {
        match self.pending_subagent_approval_order.front() {
            Some(entry) if entry.kind == SubagentApprovalKind::Shell => self
                .pending_subagent_shell_approvals
                .iter()
                .find(|request| request.approval_id == entry.approval_id),
            _ => None,
        }
    }

    pub fn subagent_shell_approval_deciding(&self) -> bool {
        self.pending_subagent_shell_approval()
            .is_some_and(|request| {
                self.subagent_shell_approval_deciding.as_deref()
                    == Some(request.approval_id.as_str())
            })
    }

    pub fn subagent_shell_approval_error(&self) -> Option<&str> {
        self.subagent_shell_approval_error.as_deref()
    }

    pub fn decide_subagent_shell_approval(
        &mut self,
        approval_id: &str,
        decision: SubagentShellDecision,
        cx: &mut Context<Self>,
    ) -> bool {
        let matches = subagent_approval_order_is_head(
            &self.pending_subagent_approval_order,
            SubagentApprovalKind::Shell,
            approval_id,
        ) && subagent_shell_decision_is_current(
            &self.pending_subagent_shell_approvals,
            self.subagent_shell_approval_deciding.as_deref(),
            approval_id,
            now_millis(),
        );
        let decided = matches
            && self
                .stores
                .subagents
                .decide_shell_approval(approval_id, decision);
        if decided {
            self.subagent_shell_approval_deciding = Some(approval_id.to_string());
            self.subagent_shell_approval_error = None;
            cx.notify();
        } else if matches {
            self.subagent_shell_approval_error =
                Some("This approval is no longer current. The command was not run.".into());
            cx.notify();
        }
        decided
    }

    fn clear_subagent_shell_approvals(&mut self) {
        self.pending_subagent_shell_approvals.clear();
        self.subagent_shell_approval_deciding = None;
        self.subagent_shell_approval_error = None;
    }

    pub fn pending_subagent_mcp_read_approval(&self) -> Option<&SubagentMcpReadApprovalRequest> {
        match self.pending_subagent_approval_order.front() {
            Some(entry) if entry.kind == SubagentApprovalKind::McpRead => self
                .pending_subagent_mcp_read_approvals
                .iter()
                .find(|request| request.approval_id == entry.approval_id),
            _ => None,
        }
    }

    pub fn subagent_mcp_read_approval_deciding(&self) -> bool {
        self.pending_subagent_mcp_read_approval()
            .is_some_and(|request| {
                self.subagent_mcp_read_approval_deciding.as_deref()
                    == Some(request.approval_id.as_str())
            })
    }

    pub fn subagent_mcp_read_approval_error(&self) -> Option<&str> {
        self.subagent_mcp_read_approval_error.as_deref()
    }

    pub fn decide_subagent_mcp_read_approval(
        &mut self,
        approval_id: &str,
        decision: SubagentMcpReadDecision,
        cx: &mut Context<Self>,
    ) -> bool {
        let matches = subagent_approval_order_is_head(
            &self.pending_subagent_approval_order,
            SubagentApprovalKind::McpRead,
            approval_id,
        ) && subagent_mcp_read_decision_is_current(
            &self.pending_subagent_mcp_read_approvals,
            self.subagent_mcp_read_approval_deciding.as_deref(),
            approval_id,
            now_millis(),
        );
        let decided = matches
            && self
                .stores
                .subagents
                .decide_mcp_read_approval(approval_id, decision);
        if decided {
            self.subagent_mcp_read_approval_deciding = Some(approval_id.to_string());
            self.subagent_mcp_read_approval_error = None;
            cx.notify();
        } else if matches {
            self.subagent_mcp_read_approval_error =
                Some("This approval is no longer current. The MCP call was not sent.".into());
            cx.notify();
        }
        decided
    }

    fn clear_subagent_mcp_read_approvals(&mut self) {
        self.pending_subagent_mcp_read_approvals.clear();
        self.subagent_mcp_read_approval_deciding = None;
        self.subagent_mcp_read_approval_error = None;
    }

    pub fn pending_subagent_mcp_mutation_approval(
        &self,
    ) -> Option<&SubagentMcpMutationApprovalRequest> {
        match self.pending_subagent_approval_order.front() {
            Some(entry) if entry.kind == SubagentApprovalKind::McpMutation => self
                .pending_subagent_mcp_mutation_approvals
                .iter()
                .find(|request| request.approval_id == entry.approval_id),
            _ => None,
        }
    }

    pub fn subagent_mcp_mutation_approval_deciding(&self) -> bool {
        self.pending_subagent_mcp_mutation_approval()
            .is_some_and(|request| {
                self.subagent_mcp_mutation_approval_deciding.as_deref()
                    == Some(request.approval_id.as_str())
            })
    }

    pub fn subagent_mcp_mutation_approval_error(&self) -> Option<&str> {
        self.subagent_mcp_mutation_approval_error.as_deref()
    }

    pub fn decide_subagent_mcp_mutation_approval(
        &mut self,
        approval_id: &str,
        decision: SubagentMcpMutationDecision,
        cx: &mut Context<Self>,
    ) -> bool {
        let matches = subagent_approval_order_is_head(
            &self.pending_subagent_approval_order,
            SubagentApprovalKind::McpMutation,
            approval_id,
        ) && subagent_mcp_mutation_decision_is_current(
            &self.pending_subagent_mcp_mutation_approvals,
            self.subagent_mcp_mutation_approval_deciding.as_deref(),
            approval_id,
            now_millis(),
        );
        let decided = matches
            && self
                .stores
                .subagents
                .decide_mcp_mutation_approval(approval_id, decision);
        if decided {
            self.subagent_mcp_mutation_approval_deciding = Some(approval_id.to_string());
            self.subagent_mcp_mutation_approval_error = None;
            cx.notify();
        } else if matches {
            self.subagent_mcp_mutation_approval_error =
                Some("This approval is no longer current. The MCP mutation was not sent.".into());
            cx.notify();
        }
        decided
    }

    fn clear_subagent_mcp_mutation_approvals(&mut self) {
        self.pending_subagent_mcp_mutation_approvals.clear();
        self.subagent_mcp_mutation_approval_deciding = None;
        self.subagent_mcp_mutation_approval_error = None;
    }

    pub(crate) fn active_subagent_approval(&self) -> Option<ActiveSubagentApproval> {
        match self.pending_subagent_approval_order.front()? {
            SubagentApprovalOrderEntry {
                kind: SubagentApprovalKind::ComputerUse,
                approval_id,
            } => self
                .pending_computer_use_approval
                .as_ref()
                .filter(|request| request.approval_id == *approval_id)
                .cloned()
                .map(ActiveSubagentApproval::ComputerUse),
            SubagentApprovalOrderEntry {
                kind: SubagentApprovalKind::WorkspaceWrite,
                approval_id,
            } => self
                .pending_subagent_write_approvals
                .iter()
                .find(|request| request.approval_id == *approval_id)
                .cloned()
                .map(ActiveSubagentApproval::WorkspaceWrite),
            SubagentApprovalOrderEntry {
                kind: SubagentApprovalKind::Shell,
                approval_id,
            } => self
                .pending_subagent_shell_approvals
                .iter()
                .find(|request| request.approval_id == *approval_id)
                .cloned()
                .map(ActiveSubagentApproval::Shell),
            SubagentApprovalOrderEntry {
                kind: SubagentApprovalKind::McpRead,
                approval_id,
            } => self
                .pending_subagent_mcp_read_approvals
                .iter()
                .find(|request| request.approval_id == *approval_id)
                .cloned()
                .map(ActiveSubagentApproval::McpRead),
            SubagentApprovalOrderEntry {
                kind: SubagentApprovalKind::McpMutation,
                approval_id,
            } => self
                .pending_subagent_mcp_mutation_approvals
                .iter()
                .find(|request| request.approval_id == *approval_id)
                .cloned()
                .map(ActiveSubagentApproval::McpMutation),
        }
    }

    pub fn computer_use_chat_saving(&self) -> bool {
        self.computer_use_chat_saving
    }

    pub fn computer_use_chat_error(&self) -> Option<&str> {
        self.computer_use_chat_error.as_deref()
    }

    pub fn set_active_chat_computer_use(&mut self, enabled: bool, cx: &mut Context<Self>) {
        if self.computer_use_chat_saving || self.generation_active() {
            return;
        }
        let Some(chat_id) = self.active_chat_id.clone() else {
            return;
        };
        if self
            .active_chat
            .as_ref()
            .is_some_and(|chat| chat.computer_use_enabled == Some(enabled))
        {
            return;
        }
        let revision = self
            .computer_use_chat_revision
            .fetch_add(1, Ordering::AcqRel)
            .saturating_add(1);
        let revisions = Arc::clone(&self.computer_use_chat_revision);
        let authority = Arc::clone(&self.stores.computer_use);
        self.computer_use_chat_saving = true;
        self.computer_use_chat_error = None;
        cx.notify();
        let current: Arc<dyn Fn() -> bool + Send + Sync> =
            Arc::new(move || revisions.load(Ordering::Acquire) == revision);
        let task = Tokio::spawn(cx, async move {
            authority
                .set_chat_enabled(&chat_id, enabled, current)
                .await
                .map(|_| chat_id)
        });
        cx.spawn(async move |this, cx| {
            let result = task.await;
            this.update(cx, |this, cx| {
                if this.computer_use_chat_revision.load(Ordering::Acquire) != revision {
                    return;
                }
                this.computer_use_chat_saving = false;
                match result {
                    Ok(Ok(chat_id)) if this.active_chat_id.as_deref() == Some(chat_id.as_str()) => {
                        if let Some(chat) = this.active_chat.as_mut() {
                            chat.computer_use_enabled = Some(enabled);
                        }
                        this.computer_use_chat_error = None;
                    }
                    Ok(Ok(_)) => {}
                    Ok(Err(error)) => this.computer_use_chat_error = Some(error.to_string()),
                    Err(_) => {
                        this.computer_use_chat_error =
                            Some("Computer Use save was interrupted.".into());
                    }
                }
                cx.notify();
            })
            .ok();
        })
        .detach();
    }

    pub fn decide_computer_use_approval(
        &mut self,
        approval_id: &str,
        decision: ComputerUseApprovalDecision,
        cx: &mut Context<Self>,
    ) -> bool {
        let matches = subagent_approval_order_is_head(
            &self.pending_subagent_approval_order,
            SubagentApprovalKind::ComputerUse,
            approval_id,
        ) && self
            .pending_computer_use_approval
            .as_ref()
            .is_some_and(|request| request.approval_id == approval_id);
        let decided = matches
            && self
                .stores
                .computer_use
                .decide_approval(approval_id, decision);
        if decided {
            self.computer_use_approval_deciding = true;
            cx.notify();
        }
        decided
    }

    fn start_generation(
        &mut self,
        chat_id: String,
        selection: ModelSelection,
        provider: ConfiguredProvider,
        persisted_chat: Chat,
        skill_invocation: Option<ResolvedSkillInvocation>,
        cx: &mut Context<Self>,
    ) {
        if persisted_chat.id != chat_id {
            self.active_error = Some("The saved conversation changed before generation.".into());
            cx.notify();
            return;
        }
        // The exact document returned by the successful store operation is
        // authoritative for both the parent request and immutable fork
        // capture. Never seed a child from optimistic UI history.
        self.active_chat = Some(persisted_chat.clone());
        let counter = self.bump_generation(&chat_id);
        self.active_error = None;
        self.generation = Some(GenerationState {
            chat_id: chat_id.clone(),
            counter,
            provider_id: selection.provider_id.clone(),
            text: String::new(),
            thinking: String::new(),
            thinking_active: false,
            thinking_expanded: false,
            complete: false,
            error: None,
            error_retryable: false,
            model: Some(selection.model.clone()),
            timeline: None,
        });
        cx.notify();

        // Build the turn snapshot from the (possibly just-appended / just
        // truncated) history.
        let history = self
            .active_chat
            .as_ref()
            .map(|chat| chat.messages.clone())
            .unwrap_or_default();
        let messages = chat_history_to_messages(
            &history,
            &selection.model,
            &selection.provider_id,
            provider.api_family(),
        );
        let computer_use_cancellation = CancellationToken::new();
        // One shared cancellation identity fences the parent provider stream
        // and every child admitted for this exact response.
        let cancel = Arc::new(AtomicBool::new(false));
        let computer_use = self.computer_use_context(
            &chat_id,
            counter,
            &selection,
            &provider,
            computer_use_cancellation.clone(),
        );
        let subagents = self
            .stores
            .subagents
            .admit_generation(
                format!("{chat_id}:{counter}"),
                chat_id.clone(),
                provider.clone(),
                selection.clone(),
                self.stores.config.clone(),
                self.stores.pi_providers.clone(),
                self.stores.codex_auth.clone(),
                self.workspace.clone(),
                Some(persisted_chat),
                cancel.clone(),
            )
            .ok();
        let snapshot = TurnSnapshot {
            provider: provider.clone(),
            selection: selection.clone(),
            messages,
            catalog: self.capabilities.clone(),
            mcp: self.mcp_context(),
            skills: stream_context_for_mode(
                SkillRuntimeMode::Chat,
                self.stores.config.clone(),
                self.workspace
                    .as_ref()
                    .and_then(|workspace| workspace.folder_path.as_deref())
                    .map(PathBuf::from),
                self.workspace
                    .as_ref()
                    .map(|workspace| workspace.permission)
                    .unwrap_or(WorkspacePermission::None),
            ),
            skill_invocation,
            computer_use,
            subagents,
            // Grounds the coding system prompt (folder path, permission
            // posture, tool list, safety language).
            workspace: self.workspace.clone(),
        };

        // A fresh stop flag per generation: the driver polls it and aborts the
        // provider stream when the user presses Stop.
        self.cancel_token = Some(cancel.clone());
        self.computer_use_cancellation = Some(computer_use_cancellation);
        self.pending_computer_use_approval = None;
        self.computer_use_approval_deciding = false;
        self.clear_subagent_write_approvals();

        // Keychain lookup happens inside the tokio driver (background thread).
        let config = self.stores.config.clone();
        let pi_providers = self.stores.pi_providers.clone();
        let codex_auth = self.stores.codex_auth.clone();
        let (tx, rx) = mpsc::unbounded_channel::<StreamMsg>();
        let driver = Tokio::spawn(cx, async move {
            let api_key = resolve_runtime_api_key(&config, &pi_providers, &snapshot.provider);
            drive_stream(snapshot, api_key, codex_auth, cancel, tx).await;
        });

        // Child lifecycle projections are published from tokio tasks, not the
        // parent stream channel. Poll only the authority's in-memory revision
        // while this exact generation is active so the GPUI transcript can
        // repaint live chips without a dispatcher/disk read on render.
        let live_authority = self.stores.subagents.clone();
        let live_chat_id = chat_id.clone();
        let live_counter = counter;
        cx.spawn(async move |this, cx| -> anyhow::Result<()> {
            let mut revision = live_authority.live_snapshot_revision();
            loop {
                Timer::after(Duration::from_millis(120)).await;
                let alive = this.read_with(cx, |this, _| {
                    this.generation_matches(&live_chat_id, live_counter) && this.generation_active()
                })?;
                if !alive {
                    break;
                }
                let next_revision = live_authority.live_snapshot_revision();
                if next_revision != revision {
                    revision = next_revision;
                    this.update(cx, |_this, cx| cx.notify())?;
                }
            }
            Ok(())
        })
        .detach();

        let watcher = cx.spawn(async move |this, cx| -> anyhow::Result<()> {
            let mut rx = rx;
            while let Some(msg) = rx.recv().await {
                let alive =
                    this.read_with(cx, |this, _| this.generation_matches(&chat_id, counter))?;
                if !alive {
                    break;
                }
                this.update(cx, |this, cx| this.apply_stream_msg(msg, cx))?;
            }
            let _ = this.update(cx, |this, cx| {
                this.on_stream_closed(&chat_id, counter, cx);
            });
            Ok(())
        });

        self._stream_task = Some(watcher);
        self._driver = Some(driver);
    }

    /// Re-send the last user message (error-banner retry). The failed assistant
    /// turn is retracted from the transcript BEFORE the re-send — in memory
    /// immediately, on disk before the generation starts — and the retry does
    /// NOT append a duplicate user message: the existing last user turn is
    /// replayed as-is, so the transcript never accumulates duplicate or
    /// hanging failed turns.
    pub fn retry_last(&mut self, cx: &mut Context<Self>) {
        if self.generation_active() {
            return;
        }
        let Some(chat_id) = self.active_chat_id.clone() else {
            return;
        };
        let Some(selection) = self.selection.clone() else {
            return;
        };
        let provider = match require_available_selection(&self.providers, &selection) {
            Ok(provider) => provider,
            Err(error) => {
                self.active_error = Some(error.to_string());
                cx.notify();
                return;
            }
        };
        if provider.needs_key && !provider.has_key {
            return;
        }

        // The last user message becomes the final transcript entry; everything
        // after it is the failed assistant turn being retracted.
        let Some(keep) = retry_keep_count(
            self.active_chat
                .as_ref()
                .map(|chat| chat.messages.as_slice())
                .unwrap_or_default(),
        ) else {
            return;
        };
        let truncating = self
            .active_chat
            .as_ref()
            .is_some_and(|chat| chat.messages.len() > keep);
        if truncating {
            if let Some(chat) = self.active_chat.as_mut() {
                truncate_failed_turn(&mut chat.messages);
            }
        }
        // Obtain the exact successfully persisted document before retrying.
        // Retractions publish first; unchanged retries still re-read the
        // canonical store instead of trusting mutable UI history.
        let stores = self.stores.clone();
        let expected_chat_id = chat_id.clone();
        let expected_selection = selection.clone();
        cx.spawn(async move |this, cx| {
            let operation_chat_id = chat_id.clone();
            let persisted_chat = cx
                .background_spawn(async move {
                    if truncating {
                        stores.chat.truncate_messages(&operation_chat_id, keep).ok()
                    } else {
                        stores.chat.get(&operation_chat_id).ok().flatten()
                    }
                })
                .await;
            this.update(cx, |this, cx| {
                if this.active_chat_id.as_deref() != Some(expected_chat_id.as_str())
                    || this.selection.as_ref() != Some(&expected_selection)
                    || this.generation_active()
                {
                    return;
                }
                if let Some(persisted_chat) = persisted_chat {
                    this.start_generation(
                        expected_chat_id,
                        selection,
                        provider,
                        persisted_chat,
                        None,
                        cx,
                    );
                } else {
                    this.active_error =
                        Some("The conversation could not be prepared for retry.".into());
                    cx.notify();
                }
            })
            .ok();
        })
        .detach();
    }

    /// Stop the in-flight generation: signal the background driver to abort
    /// the provider stream (it polls the shared flag), mark the generation
    /// complete so the UI returns to the send state immediately, and persist
    /// the partial content. The driver then settles with a terminal
    /// [`StreamMsg::Cancelled`] carrying whatever usage was captured, which
    /// the foreground records — the provider stops generating (and billing)
    /// instead of running to completion into a dead channel.
    pub fn stop_generation(&mut self, cx: &mut Context<Self>) {
        if let Some(generation) = &self.generation {
            self.stores
                .subagents
                .cancel_generation(&format!("{}:{}", generation.chat_id, generation.counter));
        }
        if let Some(token) = &self.cancel_token {
            token.store(true, Ordering::Relaxed);
        }
        if let Some(token) = self.computer_use_cancellation.take() {
            token.cancel();
        }
        if let Some(chat_id) = self.active_chat_id.as_deref() {
            self.stores.computer_use.cancel_for_chat(chat_id);
        }
        self.pending_computer_use_approval = None;
        self.computer_use_approval_deciding = false;
        self.clear_subagent_write_approvals();
        let mut partial = None;
        if let Some(generation) = self.generation.as_mut() {
            if !generation.complete {
                generation.complete = true;
                generation.thinking_active = false;
                generation.error = None;
                if !generation.text.trim().is_empty() {
                    partial = Some((
                        generation.chat_id.clone(),
                        generation.text.clone(),
                        generation.thinking.clone(),
                        generation.model.clone(),
                        generation.timeline.clone(),
                    ));
                }
            }
        }
        if let Some((chat_id, text, thinking, model, timeline)) = partial {
            self.persist_assistant(
                &chat_id,
                &text,
                &thinking,
                model.as_deref(),
                None,
                timeline,
                cx,
            );
        }
        // The watcher and driver stay alive: the driver settles with a
        // terminal `Cancelled` event (recording usage) and the watcher then
        // clears them via on_stream_closed.
        cx.notify();
    }

    /// Cancel the in-flight generation without touching the current chat
    /// (used when switching chats / creating a new chat / deleting). Also
    /// aborts the provider stream so the model stops generating in the
    /// background.
    fn cancel_generation(&mut self, cx: &mut Context<Self>) {
        self.computer_use_chat_revision
            .fetch_add(1, Ordering::AcqRel);
        self.computer_use_chat_saving = false;
        if let Some(generation) = &self.generation {
            self.stores
                .subagents
                .cancel_generation(&format!("{}:{}", generation.chat_id, generation.counter));
        }
        if let Some(token) = &self.cancel_token {
            token.store(true, Ordering::Relaxed);
        }
        if let Some(token) = self.computer_use_cancellation.take() {
            token.cancel();
        }
        if let Some(chat_id) = self.active_chat_id.as_deref() {
            self.stores.computer_use.cancel_for_chat(chat_id);
        }
        self.pending_computer_use_approval = None;
        self.computer_use_approval_deciding = false;
        self.clear_subagent_write_approvals();
        let partial = self.generation.as_ref().and_then(|generation| {
            if generation.complete {
                return None;
            }
            (!generation.text.trim().is_empty()).then(|| {
                (
                    generation.chat_id.clone(),
                    generation.text.clone(),
                    generation.thinking.clone(),
                    generation.model.clone(),
                    generation.timeline.clone(),
                )
            })
        });
        if let Some((chat_id, text, thinking, model, timeline)) = partial {
            self.persist_assistant(
                &chat_id,
                &text,
                &thinking,
                model.as_deref(),
                None,
                timeline,
                cx,
            );
        }
        self._stream_task = None;
        self._driver = None;
        self.generation = None;
        cx.notify();
    }

    fn apply_stream_msg(&mut self, msg: StreamMsg, cx: &mut Context<Self>) {
        let chat_id = self
            .generation
            .as_ref()
            .map(|generation| generation.chat_id.clone())
            .unwrap_or_default();
        match msg {
            StreamMsg::Flush {
                text,
                thinking,
                thinking_active,
            } => {
                if let Some(generation) = self.generation.as_mut() {
                    generation.text.push_str(&text);
                    generation.thinking.push_str(&thinking);
                    if let Some(active) = thinking_active {
                        generation.thinking_active = active;
                        if active {
                            generation.thinking_expanded = true;
                        }
                    }
                }
                cx.notify();
            }
            StreamMsg::Timeline { timeline } => {
                if let Some(generation) = self.generation.as_mut() {
                    generation.timeline = Some(*timeline);
                }
                cx.notify();
            }
            StreamMsg::ComputerUseApproval { request } => {
                remove_subagent_approval_order(
                    &mut self.pending_subagent_approval_order,
                    &request.approval_id,
                );
                push_subagent_approval_order(
                    &mut self.pending_subagent_approval_order,
                    &request.approval_id,
                    SubagentApprovalKind::ComputerUse,
                );
                self.pending_computer_use_approval = Some(request);
                self.computer_use_approval_deciding = false;
                cx.notify();
            }
            StreamMsg::ComputerUseApprovalCleared { approval_id } => {
                if self
                    .pending_computer_use_approval
                    .as_ref()
                    .is_some_and(|request| request.approval_id == approval_id)
                {
                    self.pending_computer_use_approval = None;
                    self.computer_use_approval_deciding = false;
                    remove_subagent_approval_order(
                        &mut self.pending_subagent_approval_order,
                        &approval_id,
                    );
                    cx.notify();
                }
            }
            StreamMsg::SubagentWorkspaceWriteApproval { request } => {
                let request = *request;
                let approval_id = request.approval_id.clone();
                match enqueue_subagent_write_request(
                    &mut self.pending_subagent_write_approvals,
                    self.generation.as_ref(),
                    request,
                    now_millis(),
                ) {
                    Ok(true) => {
                        push_subagent_approval_order(
                            &mut self.pending_subagent_approval_order,
                            &approval_id,
                            SubagentApprovalKind::WorkspaceWrite,
                        );
                        self.subagent_write_approval_error = None;
                        cx.notify();
                    }
                    Ok(false) => {}
                    Err(stale) => {
                        self.stores.subagents.decide_workspace_write_approval(
                            &stale.approval_id,
                            SubagentWorkspaceWriteDecision::Deny,
                        );
                    }
                }
            }
            StreamMsg::SubagentWorkspaceWriteApprovalCleared { approval_id } => {
                let changed = remove_subagent_write_request(
                    &mut self.pending_subagent_write_approvals,
                    &mut self.subagent_write_approval_deciding,
                    &approval_id,
                );
                remove_subagent_approval_order(
                    &mut self.pending_subagent_approval_order,
                    &approval_id,
                );
                self.subagent_write_approval_error = None;
                if changed {
                    cx.notify();
                }
            }
            StreamMsg::SubagentShellApproval { request } => {
                let request = *request;
                let approval_id = request.approval_id.clone();
                match enqueue_subagent_shell_request(
                    &mut self.pending_subagent_shell_approvals,
                    self.generation.as_ref(),
                    request,
                    now_millis(),
                ) {
                    Ok(true) => {
                        push_subagent_approval_order(
                            &mut self.pending_subagent_approval_order,
                            &approval_id,
                            SubagentApprovalKind::Shell,
                        );
                        self.subagent_shell_approval_error = None;
                        cx.notify();
                    }
                    Ok(false) => {}
                    Err(stale) => {
                        self.stores
                            .subagents
                            .decide_shell_approval(&stale.approval_id, SubagentShellDecision::Deny);
                    }
                }
            }
            StreamMsg::SubagentShellApprovalCleared { approval_id } => {
                let changed = remove_subagent_shell_request(
                    &mut self.pending_subagent_shell_approvals,
                    &mut self.subagent_shell_approval_deciding,
                    &approval_id,
                );
                remove_subagent_approval_order(
                    &mut self.pending_subagent_approval_order,
                    &approval_id,
                );
                self.subagent_shell_approval_error = None;
                if changed {
                    cx.notify();
                }
            }
            StreamMsg::SubagentMcpReadApproval { request } => {
                let request = *request;
                let approval_id = request.approval_id.clone();
                match enqueue_subagent_mcp_read_request(
                    &mut self.pending_subagent_mcp_read_approvals,
                    self.generation.as_ref(),
                    request,
                    now_millis(),
                ) {
                    Ok(true) => {
                        push_subagent_approval_order(
                            &mut self.pending_subagent_approval_order,
                            &approval_id,
                            SubagentApprovalKind::McpRead,
                        );
                        self.subagent_mcp_read_approval_error = None;
                        cx.notify();
                    }
                    Ok(false) => {}
                    Err(stale) => {
                        self.stores.subagents.decide_mcp_read_approval(
                            &stale.approval_id,
                            SubagentMcpReadDecision::Deny,
                        );
                    }
                }
            }
            StreamMsg::SubagentMcpReadApprovalCleared { approval_id } => {
                let changed = remove_subagent_mcp_read_request(
                    &mut self.pending_subagent_mcp_read_approvals,
                    &mut self.subagent_mcp_read_approval_deciding,
                    &approval_id,
                );
                remove_subagent_approval_order(
                    &mut self.pending_subagent_approval_order,
                    &approval_id,
                );
                self.subagent_mcp_read_approval_error = None;
                if changed {
                    cx.notify();
                }
            }
            StreamMsg::SubagentMcpMutationApproval { request } => {
                let request = *request;
                let approval_id = request.approval_id.clone();
                match enqueue_subagent_mcp_mutation_request(
                    &mut self.pending_subagent_mcp_mutation_approvals,
                    self.generation.as_ref(),
                    request,
                    now_millis(),
                ) {
                    Ok(true) => {
                        push_subagent_approval_order(
                            &mut self.pending_subagent_approval_order,
                            &approval_id,
                            SubagentApprovalKind::McpMutation,
                        );
                        self.subagent_mcp_mutation_approval_error = None;
                        cx.notify();
                    }
                    Ok(false) => {}
                    Err(stale) => {
                        self.stores.subagents.decide_mcp_mutation_approval(
                            &stale.approval_id,
                            SubagentMcpMutationDecision::Deny,
                        );
                    }
                }
            }
            StreamMsg::SubagentMcpMutationApprovalCleared { approval_id } => {
                let changed = remove_subagent_mcp_mutation_request(
                    &mut self.pending_subagent_mcp_mutation_approvals,
                    &mut self.subagent_mcp_mutation_approval_deciding,
                    &approval_id,
                );
                remove_subagent_approval_order(
                    &mut self.pending_subagent_approval_order,
                    &approval_id,
                );
                self.subagent_mcp_mutation_approval_error = None;
                if changed {
                    cx.notify();
                }
            }
            StreamMsg::Done {
                message,
                full_text,
                full_thinking,
                usage,
            } => {
                if let Some(generation) = &self.generation {
                    self.stores.subagents.finish_generation(&format!(
                        "{}:{}",
                        generation.chat_id, generation.counter
                    ));
                }
                self.pending_computer_use_approval = None;
                self.computer_use_approval_deciding = false;
                self.clear_subagent_write_approvals();
                let model = message.model.clone();
                let (final_text, final_thinking) = message_content(&message);
                let timeline = self
                    .generation
                    .as_ref()
                    .and_then(|generation| generation.timeline.clone());
                if let Some(generation) = self.generation.as_mut() {
                    generation.text = full_text;
                    generation.thinking = full_thinking;
                    generation.thinking_active = false;
                    generation.complete = true;
                    generation.error = None;
                }
                self.persist_assistant(
                    &chat_id,
                    &final_text,
                    &final_thinking,
                    Some(&model),
                    Some(&message),
                    timeline,
                    cx,
                );
                self.record_usage(
                    self.build_usage_record(&usage, UsageRequestStatus::Completed),
                    cx,
                );
                // After the first assistant response in a fresh chat, ask the
                // same provider to summarize the exchange into a short title.
                self.maybe_generate_first_turn_title(&chat_id, cx);
                cx.notify();
            }
            StreamMsg::Error {
                message,
                partial_text,
                partial_thinking,
                usage,
            } => {
                if let Some(generation) = &self.generation {
                    self.stores.subagents.cancel_generation(&format!(
                        "{}:{}",
                        generation.chat_id, generation.counter
                    ));
                }
                self.pending_computer_use_approval = None;
                self.computer_use_approval_deciding = false;
                self.clear_subagent_write_approvals();
                let codex_needs_attention = codex_status_refresh_required(
                    self.generation
                        .as_ref()
                        .map(|generation| generation.provider_id.as_str()),
                );
                let model = self
                    .generation
                    .as_ref()
                    .and_then(|generation| generation.model.clone());
                let timeline = self
                    .generation
                    .as_ref()
                    .and_then(|generation| generation.timeline.clone());
                if let Some(generation) = self.generation.as_mut() {
                    generation.text = partial_text.clone();
                    generation.thinking = partial_thinking.clone();
                    generation.thinking_active = false;
                    generation.complete = true;
                    generation.error = Some(message.clone());
                    generation.error_retryable = true;
                }
                if !partial_text.trim().is_empty() {
                    self.persist_assistant(
                        &chat_id,
                        &partial_text,
                        &partial_thinking,
                        model.as_deref(),
                        None,
                        timeline,
                        cx,
                    );
                }
                // Record whatever usage the completed tool rounds captured —
                // never zeroed, so consumed input tokens are not lost on error.
                self.record_usage(
                    self.build_usage_record(&usage, UsageRequestStatus::Failed),
                    cx,
                );
                if codex_needs_attention {
                    self.refresh_providers(cx);
                }
                cx.notify();
            }
            StreamMsg::Cancelled {
                partial_text,
                partial_thinking,
                usage,
            } => {
                if let Some(generation) = &self.generation {
                    self.stores.subagents.cancel_generation(&format!(
                        "{}:{}",
                        generation.chat_id, generation.counter
                    ));
                }
                self.pending_computer_use_approval = None;
                self.computer_use_approval_deciding = false;
                self.clear_subagent_write_approvals();
                if let Some(generation) = self.generation.as_mut() {
                    generation.text = partial_text;
                    generation.thinking = partial_thinking;
                    generation.thinking_active = false;
                    generation.complete = true;
                    generation.error = None;
                }
                // The partial content was already persisted synchronously by
                // stop_generation; this terminal only records the usage the
                // driver captured before the abort.
                self.record_usage(
                    self.build_usage_record(&usage, UsageRequestStatus::Cancelled),
                    cx,
                );
                cx.notify();
            }
        }
    }

    /// The privacy-safe aggregate record for the just-settled generation,
    /// keyed to the selected provider/model (usage is recorded even when the
    /// provider reported no tokens — the request itself still counts).
    fn build_usage_record(
        &self,
        usage: &aiden_core::Usage,
        status: UsageRequestStatus,
    ) -> UsageRequestRecord {
        let provider = self.selected_provider();
        let provider_id = self
            .selection
            .as_ref()
            .map(|selection| selection.provider_id.as_str())
            .unwrap_or("unknown");
        let model = self
            .generation
            .as_ref()
            .and_then(|generation| generation.model.clone())
            .unwrap_or_else(|| {
                self.selection
                    .as_ref()
                    .map(|selection| selection.model.clone())
                    .unwrap_or_else(|| "unknown".to_string())
            });
        chat_usage_record(
            usage,
            provider_id,
            provider
                .map(|provider| provider.label.as_str())
                .unwrap_or("Unknown"),
            &model,
            &model,
            provider.is_some_and(|provider| !provider.needs_key),
            status,
            now_millis(),
        )
    }

    /// Append one usage record to the machine-local `usage.json` (background
    /// write; failures are logged, never surfaced).
    fn record_usage(&self, record: UsageRequestRecord, cx: &mut Context<Self>) {
        let stores = self.stores.clone();
        cx.spawn(async move |_, cx| {
            let _ = cx
                .background_spawn(async move { stores.usage.record(&record) })
                .await;
        })
        .detach();
    }

    /// After the FIRST assistant response in a fresh chat, ask the same
    /// provider to summarize the first exchange into a short title (mirrors
    /// `chat-title.ts` `generateFirstTurnTitle`). Runs fully on the background
    /// executor and never fails the turn: a provider error, a timeout, or an
    /// unsanitizable response silently keeps the seed already applied on the
    /// first user message (the first ~50 chars fallback). A manual rename
    /// always wins — the store's CAS rename only replaces the untouched seed.
    fn maybe_generate_first_turn_title(&mut self, chat_id: &str, cx: &mut Context<Self>) {
        self.title_revision = self.title_revision.wrapping_add(1);
        let title_revision = self.title_revision;
        let title_cancel = FoundationModelsCancellationToken::new();
        if let Some((_, previous)) = self
            .title_cancellations
            .insert(chat_id.to_string(), (title_revision, title_cancel.clone()))
        {
            previous.cancel();
        }
        let selection = self.selection.clone();
        let providers = self.providers.clone();
        let stores = self.stores.clone();
        let chat_id = chat_id.to_string();
        // The background read/rename closure moves its own copy; the outer
        // `chat_id` stays for the foreground refresh below.
        let chat_id_for_read = chat_id.clone();
        cx.spawn(async move |this, cx| {
            let applied = cx
                .background_spawn(async move {
                    // Only a brand-new chat (exactly one user turn) whose title
                    // is still the default or its seed is renamed by the model.
                    let chat = stores.chat.get(&chat_id_for_read).ok().flatten()?;
                    let user_turns = chat
                        .messages
                        .iter()
                        .filter(|message| message.role == ChatRole::User)
                        .count();
                    if user_turns != 1 {
                        return None;
                    }
                    let first_user = chat
                        .messages
                        .iter()
                        .find(|message| message.role == ChatRole::User)?;
                    // The store's own seed derivation guarantees `seed` equals
                    // the title the first user message was stamped with.
                    let seed = derive_chat_title_seed(first_user);
                    if !can_replace_generated_chat_title(&chat.title, &seed) {
                        return None;
                    }
                    let input = ChatTitleInput {
                        content: first_user.content.clone(),
                        attachments: first_user.attachments.clone(),
                    };
                    let prompt = build_chat_title_prompt(&input);
                    let settings = stores.config.get_settings().unwrap_or_default();
                    let title_provider = configured_title_provider(&settings);
                    let foundation_status = if title_provider == ChatTitleProviderId::ChatModel {
                        None
                    } else {
                        stores.foundation_models.status(false).await
                    };
                    let execution = resolve_title_execution(
                        title_provider,
                        foundation_status.as_ref(),
                        &providers,
                        selection.as_ref(),
                    );
                    match execution {
                        TitleExecution::SeedOnly => None,
                        TitleExecution::AppleFoundationModels => {
                            let result = tokio::time::timeout(
                                Duration::from_millis(TITLE_REQUEST_TIMEOUT_MS),
                                stores
                                    .foundation_models
                                    .generate_title(&prompt, Some(&title_cancel)),
                            )
                            .await;
                            let result = match result {
                                Ok(result) => result,
                                Err(_) => {
                                    title_cancel.cancel();
                                    Err(aiden_computer_use::FoundationModelsConnectionError::retryable(
                                        "timeout",
                                        "Apple Foundation Models title generation timed out.",
                                    ))
                                }
                            };
                            let status =
                                foundation_title_result_status(&title_cancel, &result);
                            let _ = stores.usage.record(&title_usage_record(
                                "apple-foundation-models",
                                "Apple Foundation Models",
                                "apple-foundation-model",
                                status,
                                true,
                                None,
                            ));
                            let title = sanitize_generated_chat_title(&result.ok()?)?;
                            stores
                                .chat
                                .replace_auto_title(&chat_id_for_read, &seed, &title)
                                .ok()
                                .flatten()
                        }
                        TitleExecution::ChatModel {
                            provider,
                            selection,
                        } => {
                            let api_key = resolve_runtime_api_key(
                                &stores.config,
                                &stores.pi_providers,
                                &provider,
                            );
                            let request = StreamRequest {
                                provider_id: selection.provider_id.clone(),
                                api: provider.api_family(),
                                model: selection.model.clone(),
                                base_url: provider.base_url.clone(),
                                messages: vec![Message::User(UserMessage {
                                    content: UserContent::Text(prompt),
                                    timestamp: aiden_data::now_millis(),
                                })],
                                system_prompt: Some(TITLE_SYSTEM_PROMPT.to_string()),
                                max_tokens: Some(32),
                                ..Default::default()
                            };
                            let transport =
                                provider.transport_with_codex_auth(stores.codex_auth.clone());
                            let stream = transport.stream_simple(
                                &request,
                                &StreamOptions {
                                    api_key,
                                    timeout_ms: Some(TITLE_REQUEST_TIMEOUT_MS),
                                    ..Default::default()
                                },
                            );
                            let Ok(mut stream) = stream else {
                                let _ = stores.usage.record(&title_usage_record(
                                    &provider.id,
                                    &provider.label,
                                    &selection.model,
                                    UsageRequestStatus::Failed,
                                    false,
                                    None,
                                ));
                                return None;
                            };
                            let mut text = String::new();
                            let deadline = tokio::time::sleep(Duration::from_millis(
                                TITLE_REQUEST_TIMEOUT_MS,
                            ));
                            tokio::pin!(deadline);
                            let mut status = UsageRequestStatus::Failed;
                            let mut completed_usage = None;
                            loop {
                                let event = tokio::select! {
                                    () = title_cancel.cancelled() => {
                                        status = UsageRequestStatus::Cancelled;
                                        None
                                    }
                                    () = &mut deadline => {
                                        title_cancel.cancel();
                                        status = UsageRequestStatus::Cancelled;
                                        None
                                    }
                                    event = stream.next() => event,
                                };
                                let Some(event) = event else { break; };
                                match event {
                                    Ok(aiden_core::AssistantMessageEvent::TextDelta {
                                        delta,
                                        ..
                                    }) => {
                                        text.push_str(&delta);
                                    }
                                    Ok(aiden_core::AssistantMessageEvent::Done {
                                        message, ..
                                    }) => {
                                        completed_usage = Some(message.usage);
                                        text = message_content(&message).0;
                                        status = UsageRequestStatus::Completed;
                                        break;
                                    }
                                    Ok(_) => break,
                                    Err(error) => {
                                        status = chat_title_stream_error_status(
                                            &title_cancel,
                                            &error,
                                        );
                                        break;
                                    }
                                }
                            }
                            let _ = stores.usage.record(&title_usage_record(
                                &provider.id,
                                &provider.label,
                                &selection.model,
                                status,
                                false,
                                completed_usage.as_ref(),
                            ));
                            let title = sanitize_generated_chat_title(&text)?;
                            stores
                                .chat
                                .replace_auto_title(&chat_id_for_read, &seed, &title)
                                .ok()
                                .flatten()
                        }
                    }
                })
                .await;
            if let Some(updated) = applied {
                this.update(cx, |this, cx| {
                    if this.active_chat_id.as_deref() == Some(chat_id.as_str()) {
                        this.active_chat = Some(updated);
                    }
                    this.refresh_chat_list(cx);
                    cx.notify();
                })
                .ok();
            }
            this.update(cx, |this, _| {
                if this
                    .title_cancellations
                    .get(&chat_id)
                    .is_some_and(|(revision, _)| *revision == title_revision)
                {
                    this.title_cancellations.remove(&chat_id);
                }
            })
            .ok();
        })
        .detach();
    }

    /// Watcher cleanup when the stream channel closes without a terminal event
    /// (e.g. the driver was aborted mid-flight).
    fn on_stream_closed(&mut self, chat_id: &str, counter: u64, cx: &mut Context<Self>) {
        self.stores
            .subagents
            .finish_generation(&format!("{chat_id}:{counter}"));
        let current = self.generation.as_ref().is_some_and(|generation| {
            generation.chat_id == chat_id && generation.counter == counter
        });
        self._stream_task = None;
        self._driver = None;
        if current {
            if let Some(generation) = self.generation.as_mut() {
                if !generation.complete {
                    generation.complete = true;
                    generation.error = Some("Generation stopped.".into());
                    generation.error_retryable = true;
                }
            }
            cx.notify();
        }
    }

    /// Explicit shutdown path used before the GPUI executor is torn down.
    pub(crate) fn dispose(&mut self, cx: &mut Context<Self>) {
        self.flush_appearance_save_before_quit();
        if self.generation_active() {
            self.stop_generation(cx);
        }
        cancel_title_tasks(&self.title_cancellations);
        self.title_cancellations.clear();
        self.stores.subagents.shutdown();
    }

    // -----------------------------------------------------------------------
    // Persistence helpers (background writes)
    // -----------------------------------------------------------------------

    #[expect(
        clippy::too_many_arguments,
        reason = "the durable admission captures one immutable turn plus its stream identity"
    )]
    fn persist_user_message_and_start(
        &mut self,
        chat_id: &str,
        counter: u64,
        message: &ChatMessage,
        selection: ModelSelection,
        provider: ConfiguredProvider,
        rebranch_keep: Option<usize>,
        skill_invocation: Option<ResolvedSkillInvocation>,
        cx: &mut Context<Self>,
    ) {
        let stores = self.stores.clone();
        let chat_id = chat_id.to_string();
        let content = message.content.clone();
        let created_at = message.created_at;
        let attachments = message.attachments.clone();
        let provider_id = selection.provider_id.clone();
        let model = selection.model.clone();
        let expected_chat_id = chat_id.clone();
        let expected_message = message.clone();
        let input_message = expected_message.clone();
        let reconciliation_message = expected_message.clone();
        let expected_skill_invocation = skill_invocation.clone();
        let skill_provenance = skill_invocation
            .as_ref()
            .map(skill_provenance_from_invocation);
        cx.spawn(async move |this, cx| {
            let result = cx
                .background_spawn(async move {
                    let input = ChatMessageInput {
                        id: Some(input_message.id.clone()),
                        role: ChatRole::User,
                        content,
                        model: None,
                        reasoning: None,
                        attachments,
                        timeline: None,
                        subagents: None,
                        created_at: Some(created_at),
                    };
                    let meta = AppendMessageMeta {
                        provider_id: Some(&provider_id),
                        model: Some(&model),
                        auto_title: true,
                        expected_workspace_id: None,
                    };
                    let operation = match rebranch_keep {
                        Some(keep) => stores.chat.replace_tail_and_append_message_with_skill_provenance(
                            &chat_id,
                            keep,
                            input,
                            skill_provenance,
                            Some(meta),
                        ),
                        None => stores.chat.append_message_with_skill_provenance(
                            &chat_id,
                            input,
                            skill_provenance,
                            Some(meta),
                        ),
                    };
                    match operation {
                        Ok(chat) => Ok(Some(chat)),
                        Err(_) => stores
                            .chat
                            .reconcile_submission(&chat_id, &reconciliation_message),
                    }
                })
                .await;
            if let Ok(Some(persisted_chat)) = result {
                this.update(cx, |this, cx| {
                    this.refresh_chat_list(cx);
                    this.submission_outcomes.admit(ChatSubmissionIdentity {
                        chat_id: expected_chat_id.clone(),
                        counter,
                    });
                    if this.active_chat_id.as_deref() == Some(expected_chat_id.as_str()) {
                        this.active_chat = Some(persisted_chat.clone());
                    }
                    if this.active_chat_id.as_deref() == Some(expected_chat_id.as_str())
                        && this.selection.as_ref() == Some(&selection)
                        && this.generation_matches(&expected_chat_id, counter)
                        && this.generation_active()
                    {
                        this.start_generation(
                            expected_chat_id,
                            selection,
                            provider,
                            persisted_chat,
                            expected_skill_invocation.clone(),
                            cx,
                        );
                    } else {
                        cx.notify();
                    }
                })
                .ok();
            } else {
                this.update(cx, |this, cx| {
                    // Always settle the UI's exact pending draft, even when
                    // the user switched chats before this background write
                    // failed. Otherwise the next submit would stay locked.
                    let outcome = if matches!(result, Ok(None)) {
                        ChatSubmissionOutcome::Rejected
                    } else {
                        ChatSubmissionOutcome::Unknown
                    };
                    let identity = ChatSubmissionIdentity {
                        chat_id: expected_chat_id.clone(),
                        counter,
                    };
                    this.submission_outcomes.resolve(identity.clone(), outcome);
                    if outcome == ChatSubmissionOutcome::Unknown {
                        this.uncertain_submissions.restore(
                            identity,
                            (
                                expected_message.clone(),
                                selection.clone(),
                                provider.clone(),
                                expected_skill_invocation.clone(),
                            ),
                        );
                    }
                    if this.active_chat_id.as_deref() == Some(expected_chat_id.as_str()) {
                        this.active_error = Some(match outcome {
                            ChatSubmissionOutcome::Rejected => {
                                "The message could not be saved, so it was not sent.".into()
                            }
                            ChatSubmissionOutcome::Unknown => "Aiden could not determine whether the message was saved. Reopen the chat before retrying.".into(),
                            ChatSubmissionOutcome::Admitted => unreachable!(),
                        });
                        if outcome == ChatSubmissionOutcome::Rejected
                            && this.generation_matches(&expected_chat_id, counter)
                        {
                            if let Some(generation) = this.generation.as_mut() {
                                generation.complete = true;
                                generation.error = Some(
                                    "The message could not be saved, so it was not sent.".into(),
                                );
                            }
                        }
                        if outcome == ChatSubmissionOutcome::Unknown
                            && this.generation_matches(&expected_chat_id, counter)
                        {
                            if let Some(generation) = this.generation.as_mut() {
                                generation.error = Some(
                                    "Reopen this chat to verify the message before retrying."
                                        .into(),
                                );
                            }
                        }
                    }
                    // The root observes the service to settle an exact
                    // composer snapshot. A switched chat still needs this
                    // notification so its failed request cannot lock retry.
                    cx.notify();
                })
                .ok();
            }
        })
        .detach();
    }

    #[allow(clippy::too_many_arguments)]
    fn persist_assistant(
        &self,
        chat_id: &str,
        text: &str,
        thinking: &str,
        model: Option<&str>,
        final_message: Option<&aiden_core::AssistantMessage>,
        timeline: Option<GenerationTimeline>,
        cx: &mut Context<Self>,
    ) {
        // Child completion and canonical store publication happen before the
        // parent tool result settles. Resolve the exact generation reference
        // here, immediately before the assistant append—not when the user
        // message starts and not from mutable picker state.
        let subagents = self.generation.as_ref().and_then(|generation| {
            assistant_subagent_reference(&self.stores.subagents, generation, chat_id)
        });
        let stores = self.stores.clone();
        let chat_id = chat_id.to_string();
        let text = text.to_string();
        let thinking = thinking.to_string();
        let model = model.map(str::to_string);
        let provider = self.selected_provider().map(|provider| provider.id.clone());
        let created_at = now_millis();
        let id = final_message
            .and_then(|message| message.response_id.clone())
            .unwrap_or_else(aiden_data::chat_store::new_uuid_like);
        let timestamp = final_message.map_or(created_at, |message| message.timestamp);
        let timeline_value = timeline.and_then(|timeline| serde_json::to_value(&timeline).ok());
        cx.spawn(async move |this, cx| {
            let task_chat_id = chat_id.clone();
            let updated = cx
                .background_spawn(async move {
                    let input = ChatMessageInput {
                        id: Some(id),
                        role: ChatRole::Assistant,
                        content: text,
                        model: model.clone(),
                        reasoning: if thinking.trim().is_empty() {
                            None
                        } else {
                            Some(thinking)
                        },
                        attachments: None,
                        timeline: timeline_value,
                        subagents,
                        created_at: Some(timestamp),
                    };
                    let meta = AppendMessageMeta {
                        provider_id: provider.as_deref(),
                        model: model.as_deref(),
                        auto_title: false,
                        expected_workspace_id: None,
                    };
                    stores
                        .chat
                        .append_message(&task_chat_id, input, Some(meta))
                        .ok()
                })
                .await;
            this.update(cx, |this, cx| {
                if let Some(updated) = updated {
                    if this.active_chat_id.as_deref() == Some(chat_id.as_str()) {
                        this.active_chat = Some(updated);
                    }
                }
                this.refresh_chat_list(cx);
                cx.notify();
            })
            .ok();
        })
        .detach();
    }
}

/// Exact production helper used at assistant settlement. Keeping this small
/// makes the persistence boundary deterministic without requiring a GPUI
/// window in store-level regressions.
fn skill_provenance_from_invocation(invocation: &ResolvedSkillInvocation) -> SkillProvenance {
    let source = match invocation.source {
        SkillCatalogSource::Configured => SkillProvenanceSource::Configured,
        SkillCatalogSource::Workspace => SkillProvenanceSource::Workspace,
        SkillCatalogSource::Global => SkillProvenanceSource::Global,
    };
    SkillProvenance {
        id: invocation.id.clone(),
        name: invocation.name.clone(),
        source,
        revision: invocation.revision.clone(),
    }
}

pub(crate) fn assistant_subagent_reference(
    authority: &crate::services::subagents::SubagentAuthority,
    generation: &GenerationState,
    chat_id: &str,
) -> Option<serde_json::Value> {
    (generation.chat_id == chat_id).then(|| {
        authority.message_reference(
            &format!("{}:{}", generation.chat_id, generation.counter),
            chat_id,
        )
    })?
}

fn prepared_accessibility(
    restored: Option<NativeBootRestore>,
) -> aiden_mac::appearance::EffectiveAppearance {
    restored.map(|value| value.effective).unwrap_or_default()
}

fn native_restore_retry_needed(restored: bool, supported: bool) -> bool {
    supported && !restored
}

fn native_observer_retry_needed(started: bool, supported: bool) -> bool {
    supported && !started
}

fn claim_appearance_intent(sequence: &AtomicU64) -> u64 {
    sequence.fetch_add(1, Ordering::AcqRel).saturating_add(1)
}

fn appearance_intent_is_current(sequence: &AtomicU64, token: u64) -> bool {
    sequence.load(Ordering::Acquire) == token
}

impl Drop for ChatService {
    fn drop(&mut self) {
        if let Some(cancel) = &self.cancel_token {
            cancel.store(true, Ordering::SeqCst);
        }
        cancel_title_tasks(&self.title_cancellations);
        self.stores.subagents.shutdown();
    }
}

/// The chat the sidebar selects after the active chat is deleted: the most
/// recent remaining chat (the list is newest-updated first), or none when the
/// list is now empty. Pure so the fallback behavior is unit-testable.
pub fn next_chat_after_delete(remaining: &[ChatMeta]) -> Option<&ChatMeta> {
    remaining.first()
}

/// The transcript keep-count for an error-banner retry: the index after the
/// LAST user message. Everything at or beyond it is the failed assistant turn
/// and must be retracted before re-sending. `None` when there is no user
/// message to replay. Pure so the retry truncation is unit-testable.
pub fn retry_keep_count(messages: &[ChatMessage]) -> Option<usize> {
    messages
        .iter()
        .rposition(|message| message.role == ChatRole::User)
        .map(|index| index + 1)
}

/// Retract the failed assistant turn: drop every message after the last user
/// message. Returns the new length (the keep-count), or `None` when there is
/// no user message to keep. Pure so the retry truncation is unit-testable.
pub fn truncate_failed_turn(messages: &mut Vec<ChatMessage>) -> Option<usize> {
    let keep = retry_keep_count(messages)?;
    messages.truncate(keep);
    Some(keep)
}

/// Relative timestamp for the sidebar, mirroring the renderer's formatting.
pub fn relative_time(updated_at: u64, now: u64) -> String {
    let seconds = now.saturating_sub(updated_at) / 1000;
    match seconds {
        0..=59 => "Just now".to_string(),
        60..=3599 => format!("{}m ago", seconds / 60),
        3600..=86_399 => format!("{}h ago", seconds / 3600),
        86_400..=604_799 => format!("{}d ago", seconds / 86_400),
        _ => {
            // Fall back to a short date for anything older than a week.
            let ms = chrono::DateTime::from_timestamp_millis(updated_at as i64);
            ms.map(|date| date.format("%b %d").to_string())
                .unwrap_or_else(|| "Earlier".to_string())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn skill_selection_fence_rejects_workspace_and_permission_changes() {
        let selection = SkillInvocationSelection {
            id: "skillref_review".into(),
            name: "Review".into(),
            source: crate::services::skill_tools::SkillCatalogSource::Workspace,
            revision: "rev-1".into(),
            workspace_identity: Some("workspace-a".into()),
            workspace_permission: Some(WorkspacePermission::Ask),
        };
        assert!(skill_selection_fence_error(
            &selection,
            Some("workspace-a"),
            WorkspacePermission::Ask,
        )
        .is_none());
        assert!(skill_selection_fence_error(
            &selection,
            Some("workspace-b"),
            WorkspacePermission::Ask,
        )
        .is_some());
        assert!(skill_selection_fence_error(
            &selection,
            Some("workspace-a"),
            WorkspacePermission::None,
        )
        .is_some());
        let unbound = SkillInvocationSelection {
            workspace_identity: None,
            workspace_permission: None,
            ..selection
        };
        assert!(skill_selection_fence_error(
            &unbound,
            Some("workspace-a"),
            WorkspacePermission::Ask,
        )
        .is_some());
    }

    fn recovery_record() -> (
        ChatMessage,
        ModelSelection,
        ConfiguredProvider,
        Option<ResolvedSkillInvocation>,
    ) {
        (
            ChatMessage {
                id: "user-recovery".into(),
                role: ChatRole::User,
                content: "draft".into(),
                created_at: 1,
                model: None,
                reasoning: None,
                attachments: None,
                skill_provenance: None,
                timeline: None,
                subagents: None,
            },
            ModelSelection {
                provider_id: "provider".into(),
                model: "model".into(),
            },
            ConfiguredProvider {
                id: "provider".into(),
                label: "Provider".into(),
                kind: aiden_data::portable_config::ProviderKind::Openai,
                base_url: "https://example.test".into(),
                deployment: None,
                models: vec!["model".into()],
                default_model: None,
                model_metadata: HashMap::new(),
                catalog_models: Vec::new(),
                needs_key: false,
                has_key: true,
            },
            None,
        )
    }

    #[test]
    fn uncertain_recovery_registry_is_single_flight_and_retries_only_after_unknown() {
        let identity = ChatSubmissionIdentity {
            chat_id: "chat-a".into(),
            counter: 1,
        };
        let mut registry = UncertainSubmissionRegistry::default();
        registry.restore(identity.clone(), recovery_record());
        // Two rapid reopen requests share one recovery lease.
        let leased = registry.take(&identity).expect("first reopen leases it");
        assert!(registry.take(&identity).is_none());
        // Only another indeterminate result restores that lease.
        registry.restore(identity.clone(), leased);
        assert!(registry.take(&identity).is_some());
        assert!(registry.take(&identity).is_none());
    }

    #[test]
    fn delayed_admission_from_another_chat_cannot_consume_the_newer_draft() {
        let old = ChatSubmissionIdentity {
            chat_id: "chat-a".into(),
            counter: 1,
        };
        let newer = ChatSubmissionIdentity {
            chat_id: "chat-b".into(),
            counter: 1,
        };
        let mut ledger = SubmissionAdmissionLedger::default();
        // Force the completion order that used to overwrite a one-slot value:
        // B succeeds, A publishes late, then AppState synchronizes B.
        ledger.admit(newer.clone());
        ledger.admit(old.clone());
        assert_eq!(ledger.take(&newer), Some(ChatSubmissionOutcome::Admitted));
        assert_eq!(ledger.take(&old), Some(ChatSubmissionOutcome::Admitted));
        assert_eq!(ledger.take(&newer), None);
    }

    fn write_approval_request(
        approval_id: &str,
        generation_id: &str,
        expires_at: u64,
    ) -> SubagentWorkspaceWriteApprovalRequest {
        SubagentWorkspaceWriteApprovalRequest {
            approval_id: approval_id.into(),
            generation_id: generation_id.into(),
            chat_id: "chat-1".into(),
            run_id: "run-1".into(),
            child_id: "child-1".into(),
            tool_call_id: format!("call-{approval_id}"),
            authority_revision: 1,
            argument_digest: "a".repeat(64),
            effect_digest: "b".repeat(64),
            authority_digest: "c".repeat(64),
            expires_at,
            details: aiden_core::SubagentWorkspaceWriteApprovalDetails {
                operation: aiden_core::WorkspaceWriteOperation::Edit,
                child_label: "Writer".into(),
                path: "src/safe.rs".into(),
                workspace_label: "Workspace".into(),
                worktree_label: None,
                is_managed_worktree: false,
                pre_digest_prefix: Some("0123456789ab".into()),
                post_digest_prefix: "abcdef012345".into(),
                before_bytes: 10,
                after_bytes: 12,
                diff_preview: "-old\n+new".into(),
                diff_truncated: false,
                command_will_run: false,
                refuse_if_changed: true,
            },
        }
    }

    fn active_generation(counter: u64) -> GenerationState {
        GenerationState {
            chat_id: "chat-1".into(),
            counter,
            provider_id: "provider".into(),
            text: String::new(),
            thinking: String::new(),
            thinking_active: false,
            thinking_expanded: false,
            complete: false,
            error: None,
            error_retryable: false,
            model: Some("model".into()),
            timeline: None,
        }
    }

    fn mcp_read_approval_request(
        approval_id: &str,
        generation_id: &str,
        expires_at: u64,
    ) -> SubagentMcpReadApprovalRequest {
        SubagentMcpReadApprovalRequest {
            approval_id: approval_id.into(),
            generation_id: generation_id.into(),
            chat_id: "chat-1".into(),
            run_id: "run-1".into(),
            child_id: "child-1".into(),
            tool_call_id: format!("call-{approval_id}"),
            authority_revision: 1,
            expires_at,
            server_id: "linear".into(),
            tool_name: "get_issue".into(),
            canonical_arguments: r#"{"id":"ENG-1"}"#.into(),
        }
    }

    #[test]
    fn old_or_expired_subagent_write_request_never_enters_live_queue() {
        let mut queue = VecDeque::new();
        let current = active_generation(2);
        assert!(enqueue_subagent_write_request(
            &mut queue,
            Some(&current),
            write_approval_request("old", "chat-1:1", 10_000),
            100,
        )
        .is_err());
        assert!(enqueue_subagent_write_request(
            &mut queue,
            Some(&current),
            write_approval_request("expired", "chat-1:2", 100),
            100,
        )
        .is_err());
        assert!(queue.is_empty());
    }

    #[test]
    fn subagent_write_queue_replaces_front_and_rejects_stale_decision() {
        let current = active_generation(2);
        let mut queue = VecDeque::new();
        enqueue_subagent_write_request(
            &mut queue,
            Some(&current),
            write_approval_request("first", "chat-1:2", 10_000),
            100,
        )
        .unwrap();
        enqueue_subagent_write_request(
            &mut queue,
            Some(&current),
            write_approval_request("second", "chat-1:2", 10_000),
            100,
        )
        .unwrap();
        assert!(subagent_write_decision_is_current(
            &queue, None, "first", 100
        ));
        assert!(!subagent_write_decision_is_current(
            &queue, None, "second", 100
        ));
        let mut deciding = Some("first".to_string());
        assert!(remove_subagent_write_request(
            &mut queue,
            &mut deciding,
            "first"
        ));
        assert_eq!(deciding, None);
        assert_eq!(queue.front().unwrap().approval_id, "second");
        assert!(!subagent_write_decision_is_current(
            &queue, None, "first", 100
        ));
        assert!(subagent_write_decision_is_current(
            &queue, None, "second", 100
        ));
    }

    #[test]
    fn shared_subagent_order_preserves_cross_kind_arrival_and_makes_stale_decisions_inert() {
        let mut order = VecDeque::new();
        push_subagent_approval_order(&mut order, "shell-first", SubagentApprovalKind::Shell);
        push_subagent_approval_order(
            &mut order,
            "write-second",
            SubagentApprovalKind::WorkspaceWrite,
        );
        push_subagent_approval_order(&mut order, "mcp-third", SubagentApprovalKind::McpRead);
        assert!(subagent_approval_order_is_head(
            &order,
            SubagentApprovalKind::Shell,
            "shell-first"
        ));
        assert!(!subagent_approval_order_is_head(
            &order,
            SubagentApprovalKind::WorkspaceWrite,
            "write-second"
        ));
        remove_subagent_approval_order(&mut order, "shell-first");
        assert!(subagent_approval_order_is_head(
            &order,
            SubagentApprovalKind::WorkspaceWrite,
            "write-second"
        ));
        remove_subagent_approval_order(&mut order, "write-second");
        assert!(subagent_approval_order_is_head(
            &order,
            SubagentApprovalKind::McpRead,
            "mcp-third"
        ));

        let mut reverse = VecDeque::new();
        push_subagent_approval_order(
            &mut reverse,
            "write-first",
            SubagentApprovalKind::WorkspaceWrite,
        );
        push_subagent_approval_order(&mut reverse, "shell-second", SubagentApprovalKind::Shell);
        assert!(subagent_approval_order_is_head(
            &reverse,
            SubagentApprovalKind::WorkspaceWrite,
            "write-first"
        ));
        assert!(!subagent_approval_order_is_head(
            &reverse,
            SubagentApprovalKind::Shell,
            "shell-second"
        ));
    }

    #[test]
    fn mcp_read_queue_requires_exact_live_generation_expiry_and_head() {
        let current = active_generation(2);
        let mut queue = VecDeque::new();
        assert!(enqueue_subagent_mcp_read_request(
            &mut queue,
            Some(&current),
            mcp_read_approval_request("stale", "chat-1:1", 10_000),
            100,
        )
        .is_err());
        enqueue_subagent_mcp_read_request(
            &mut queue,
            Some(&current),
            mcp_read_approval_request("first", "chat-1:2", 10_000),
            100,
        )
        .unwrap();
        enqueue_subagent_mcp_read_request(
            &mut queue,
            Some(&current),
            mcp_read_approval_request("second", "chat-1:2", 10_000),
            100,
        )
        .unwrap();
        assert!(subagent_mcp_read_decision_is_current(
            &queue, None, "first", 100
        ));
        assert!(!subagent_mcp_read_decision_is_current(
            &queue, None, "second", 100
        ));
        let mut deciding = Some("first".into());
        assert!(remove_subagent_mcp_read_request(
            &mut queue,
            &mut deciding,
            "first"
        ));
        assert!(deciding.is_none());
        assert!(subagent_mcp_read_decision_is_current(
            &queue, None, "second", 100
        ));
    }

    #[test]
    fn prepared_accessibility_is_used_before_the_first_service_frame() {
        let effective = aiden_mac::appearance::EffectiveAppearance {
            dark: true,
            high_contrast: true,
            reduce_motion: true,
        };
        let restored = NativeBootRestore {
            effective,
            dock_icon: aiden_core::appearance::DockIcon::Aiden,
        };

        assert_eq!(prepared_accessibility(Some(restored)), effective);
    }

    #[test]
    fn failed_boot_restore_remains_retryable_until_success() {
        assert!(native_restore_retry_needed(false, true));
        assert!(!native_restore_retry_needed(true, true));
        assert!(!native_restore_retry_needed(false, false));
        assert!(native_observer_retry_needed(false, true));
        assert!(!native_observer_retry_needed(true, true));
        assert!(!native_observer_retry_needed(false, false));
    }

    #[test]
    fn delayed_old_window_save_cannot_publish_after_reopen_intent() {
        let process_sequence = Arc::new(AtomicU64::new(0));
        let old_window = process_sequence.clone();
        let reopened_window = process_sequence.clone();
        let old_save = claim_appearance_intent(&old_window);
        let new_save = claim_appearance_intent(&reopened_window);

        assert!(!appearance_intent_is_current(&old_window, old_save));
        assert!(appearance_intent_is_current(&reopened_window, new_save));
    }

    #[test]
    fn close_fence_invalidates_a_save_still_waiting_in_debounce() {
        let process_sequence = AtomicU64::new(0);
        let debounced_save = claim_appearance_intent(&process_sequence);
        let close_flush = claim_appearance_intent(&process_sequence);

        assert!(!appearance_intent_is_current(
            &process_sequence,
            debounced_save
        ));
        assert!(appearance_intent_is_current(&process_sequence, close_flush));
    }

    fn title_test_provider() -> ConfiguredProvider {
        ConfiguredProvider {
            id: "provider".to_string(),
            label: "Provider".to_string(),
            kind: aiden_data::portable_config::ProviderKind::Openai,
            base_url: "https://example.invalid".to_string(),
            deployment: None,
            models: vec!["model".to_string()],
            default_model: None,
            model_metadata: Default::default(),
            catalog_models: Vec::new(),
            needs_key: false,
            has_key: false,
        }
    }

    fn image_attachment() -> aiden_core::Attachment {
        aiden_core::Attachment {
            id: "image".into(),
            name: "image.png".into(),
            mime_type: "image/png".into(),
            kind: aiden_core::AttachmentKind::Image,
            size: 1,
            data: Some("eA==".into()),
            text: None,
        }
    }

    #[test]
    fn image_admission_rechecks_the_selected_model_and_allows_unknown_metadata() {
        let mut provider = title_test_provider();
        provider.models.push("vision".into());
        let nonvision = ModelSelection {
            provider_id: "provider".into(),
            model: "model".into(),
        };
        let vision = ModelSelection {
            provider_id: "provider".into(),
            model: "vision".into(),
        };
        let mut nonvision_metadata = aiden_data::portable_config::ProviderModelMetadata {
            source: aiden_data::portable_config::ProviderModelMetadataSource::Provider,
            name: None,
            r#type: None,
            vision: Some(false),
            tool_call: None,
            reasoning: None,
            thinking_levels: None,
            thinking_can_disable: None,
            context_length: None,
            parameter_count: None,
            format: None,
        };
        provider
            .model_metadata
            .insert("model".into(), nonvision_metadata.clone());
        assert!(image_submission_error(&provider, &nonvision, &[image_attachment()]).is_some());
        nonvision_metadata.vision = Some(true);
        provider
            .model_metadata
            .insert("vision".into(), nonvision_metadata);
        assert!(image_submission_error(&provider, &vision, &[image_attachment()]).is_none());
        provider.model_metadata.remove("model");
        assert!(image_submission_error(&provider, &nonvision, &[image_attachment()]).is_none());
    }

    #[test]
    fn computer_use_model_gate_is_explicit_and_fail_closed() {
        let selection = ModelSelection {
            provider_id: "provider".into(),
            model: "model".into(),
        };
        let mut provider = title_test_provider();
        assert_eq!(computer_use_model_capabilities(&provider, &selection), None);

        let mut metadata = aiden_data::portable_config::ProviderModelMetadata {
            source: aiden_data::portable_config::ProviderModelMetadataSource::Provider,
            name: None,
            r#type: None,
            vision: Some(true),
            tool_call: Some(false),
            reasoning: None,
            thinking_levels: None,
            thinking_can_disable: None,
            context_length: None,
            parameter_count: None,
            format: None,
        };
        provider
            .model_metadata
            .insert("model".into(), metadata.clone());
        assert_eq!(computer_use_model_capabilities(&provider, &selection), None);

        metadata.tool_call = Some(true);
        provider.model_metadata.insert("model".into(), metadata);
        assert_eq!(
            computer_use_model_capabilities(&provider, &selection),
            Some(true)
        );
    }

    fn foundation_status(
        state: aiden_core::chat_title::FoundationModelsConnectionState,
    ) -> FoundationModelsConnectionStatus {
        FoundationModelsConnectionStatus {
            id: "apple-foundation-models".to_string(),
            label: "Apple Foundation Models".to_string(),
            state,
            detail: "status".to_string(),
            local: true,
            title_only: true,
            retryable: false,
        }
    }

    #[test]
    fn title_execution_truth_table_checks_chat_selection_only_for_chat_route() {
        use aiden_core::chat_title::FoundationModelsConnectionState;

        let ready = foundation_status(FoundationModelsConnectionState::Ready);
        let unavailable = foundation_status(FoundationModelsConnectionState::Unavailable);
        let providers = vec![title_test_provider()];
        let selection = ModelSelection {
            provider_id: "provider".to_string(),
            model: "model".to_string(),
        };

        assert_eq!(
            resolve_title_execution(ChatTitleProviderId::Automatic, Some(&ready), &[], None,),
            TitleExecution::AppleFoundationModels
        );
        assert!(matches!(
            resolve_title_execution(
                ChatTitleProviderId::Automatic,
                Some(&unavailable),
                &providers,
                Some(&selection),
            ),
            TitleExecution::ChatModel { .. }
        ));
        assert_eq!(
            resolve_title_execution(
                ChatTitleProviderId::Automatic,
                Some(&unavailable),
                &[],
                None,
            ),
            TitleExecution::SeedOnly
        );
        assert_eq!(
            resolve_title_execution(
                ChatTitleProviderId::AppleFoundationModels,
                Some(&unavailable),
                &providers,
                Some(&selection),
            ),
            TitleExecution::SeedOnly
        );
        assert!(matches!(
            resolve_title_execution(
                ChatTitleProviderId::ChatModel,
                Some(&ready),
                &providers,
                Some(&selection),
            ),
            TitleExecution::ChatModel { .. }
        ));
    }

    #[test]
    fn title_task_disposal_cancels_every_owned_route_and_usage_keeps_title_source() {
        let apple = FoundationModelsCancellationToken::new();
        let chat = FoundationModelsCancellationToken::new();
        let cancellations = HashMap::from([
            ("apple".to_string(), (1, apple.clone())),
            ("chat".to_string(), (2, chat.clone())),
        ]);

        cancel_title_tasks(&cancellations);

        assert!(apple.is_cancelled());
        assert!(chat.is_cancelled());
        for status in [
            UsageRequestStatus::Completed,
            UsageRequestStatus::Failed,
            UsageRequestStatus::Cancelled,
        ] {
            let record = title_usage_record("provider", "Provider", "model", status, false, None);
            assert_eq!(record.source, UsageRequestSource::ChatTitle);
            assert_eq!(record.status, status);
        }
    }

    #[test]
    fn completed_chat_model_title_maps_done_usage_and_uses_canonical_timeout() {
        let usage = aiden_core::Usage {
            input: 19,
            output: 5,
            cache_read: 2,
            cache_write: 0,
            cache_write_1h: None,
            reasoning: Some(1),
            total_tokens: 26,
            cost: aiden_core::UsageCost {
                input: 0.001,
                output: 0.002,
                cache_read: 0.0,
                cache_write: 0.0,
                total: 0.003,
            },
        };
        let record = title_usage_record(
            "provider",
            "Provider",
            "model",
            UsageRequestStatus::Completed,
            false,
            Some(&usage),
        );

        assert_eq!(TITLE_REQUEST_TIMEOUT_MS, 15_000);
        assert_eq!(
            title_request_status(true, false),
            UsageRequestStatus::Cancelled
        );
        assert_eq!(record.source, UsageRequestSource::ChatTitle);
        assert_eq!(record.tokens.expect("reported token usage").total, 26);
        assert_eq!(record.cost_status, UsageCostStatus::Reported);
        assert_eq!(record.cost_usd, Some(0.003));
    }

    #[test]
    fn inner_apple_and_transport_timeouts_are_cancelled_even_before_owner_deadline() {
        let apple_cancel = FoundationModelsCancellationToken::new();
        let apple_timeout = Err(
            aiden_computer_use::FoundationModelsConnectionError::retryable(
                "timeout",
                "The helper timed out.",
            ),
        );
        assert_eq!(
            foundation_title_result_status(&apple_cancel, &apple_timeout),
            UsageRequestStatus::Cancelled
        );
        assert!(apple_cancel.is_cancelled());

        let chat_cancel = FoundationModelsCancellationToken::new();
        let transport_timeout =
            aiden_providers::ProviderError::Request("The provider request timed out.".to_string());
        assert_eq!(
            chat_title_stream_error_status(&chat_cancel, &transport_timeout),
            UsageRequestStatus::Cancelled
        );
        assert!(chat_cancel.is_cancelled());
    }

    #[test]
    fn request_time_auth_rejection_triggers_live_provider_catalog_refresh() {
        let in_flight_provider = aiden_providers::codex::OPENAI_CODEX_PROVIDER_ID;
        let newer_picker_selection = "anthropic";
        assert!(codex_status_refresh_required(Some(in_flight_provider)));
        assert!(!codex_status_refresh_required(Some(newer_picker_selection)));
    }

    #[test]
    fn relative_time_labels() {
        let now = 1_700_000_000_000;
        assert_eq!(relative_time(now, now), "Just now");
        assert_eq!(relative_time(now - 30_000, now), "Just now");
        assert_eq!(relative_time(now - 5 * 60_000, now), "5m ago");
        assert_eq!(relative_time(now - 3 * 3_600_000, now), "3h ago");
        assert_eq!(relative_time(now - 2 * 86_400_000, now), "2d ago");
        let older = relative_time(now - 30 * 86_400_000, now);
        assert!(!older.is_empty());
        assert_ne!(older, "Just now");
    }

    #[test]
    fn deleting_the_active_chat_falls_back_to_the_most_recent_remaining() {
        let chat = |id: &str, updated_at: u64| ChatMeta {
            id: id.to_string(),
            title: id.to_string(),
            workspace_id: None,
            provider_id: None,
            model: None,
            created_at: 1,
            updated_at,
        };
        let list = vec![chat("c1", 30), chat("c2", 20), chat("c3", 10)];

        // The head is what the sidebar picks after the active chat is gone.
        assert_eq!(
            next_chat_after_delete(&list).map(|chat| chat.id.as_str()),
            Some("c1")
        );

        // After retaining everything except the deleted chat, the fallback is
        // the new head — never None while chats remain.
        let after_delete: Vec<ChatMeta> = list.into_iter().filter(|chat| chat.id != "c1").collect();
        assert_eq!(
            next_chat_after_delete(&after_delete).map(|chat| chat.id.as_str()),
            Some("c2")
        );

        // An empty list means the empty pane state (no fallback, no panic).
        assert_eq!(next_chat_after_delete(&[]), None);
    }

    fn message(role: ChatRole, content: &str, created_at: u64) -> ChatMessage {
        ChatMessage {
            id: format!("m-{created_at}"),
            role,
            content: content.to_string(),
            created_at,
            model: None,
            reasoning: None,
            attachments: None,
            skill_provenance: None,
            timeline: None,
            subagents: None,
        }
    }

    #[test]
    fn retry_keep_count_is_the_index_after_the_last_user_message() {
        let messages = vec![
            message(ChatRole::User, "hello", 1),
            message(ChatRole::Assistant, "partial reply", 2),
        ];
        assert_eq!(retry_keep_count(&messages), Some(1));

        let multi = vec![
            message(ChatRole::User, "first", 1),
            message(ChatRole::Assistant, "earlier reply", 2),
            message(ChatRole::User, "second", 3),
            message(ChatRole::Assistant, "failed turn", 4),
        ];
        assert_eq!(retry_keep_count(&multi), Some(3));

        // No user message → nothing to replay.
        assert_eq!(retry_keep_count(&[]), None);
        assert_eq!(
            retry_keep_count(&[message(ChatRole::Assistant, "orphan", 1)]),
            None
        );
    }

    #[test]
    fn truncate_failed_turn_retracts_the_trailing_assistant_turn() {
        let mut messages = vec![
            message(ChatRole::User, "hello", 1),
            message(ChatRole::Assistant, "partial reply", 2),
        ];
        assert_eq!(truncate_failed_turn(&mut messages), Some(1));
        assert_eq!(messages.len(), 1);
        assert_eq!(messages[0].role, ChatRole::User);
        assert_eq!(messages[0].content, "hello");

        // A transcript ending on the user message is left untouched.
        let mut clean = vec![
            message(ChatRole::User, "hello", 1),
            message(ChatRole::Assistant, "complete reply", 2),
            message(ChatRole::User, "follow-up", 3),
        ];
        assert_eq!(truncate_failed_turn(&mut clean), Some(3));
        assert_eq!(clean.len(), 3);

        // Nothing to retract when no user message exists.
        let mut orphan = vec![message(ChatRole::Assistant, "orphan", 1)];
        assert_eq!(truncate_failed_turn(&mut orphan), None);
        assert_eq!(orphan.len(), 1);
    }

    #[test]
    fn title_provider_setting_defaults_unknown_values_to_automatic() {
        let mut settings = serde_json::Map::new();
        assert_eq!(
            configured_title_provider(&settings),
            ChatTitleProviderId::Automatic
        );
        settings.insert(
            "chatTitleProviderId".to_string(),
            serde_json::json!("future-provider"),
        );
        assert_eq!(
            configured_title_provider(&settings),
            ChatTitleProviderId::Automatic
        );
        settings.insert(
            "chatTitleProviderId".to_string(),
            serde_json::json!("chat-model"),
        );
        assert_eq!(
            configured_title_provider(&settings),
            ChatTitleProviderId::ChatModel
        );
    }
}
