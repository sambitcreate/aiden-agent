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

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;

use aiden_agent::ToolCancellation;
use aiden_core::appearance::{create_default_appearance_config, AppearanceConfig, Mode};
use aiden_core::{
    meta_of, AgentStep, AgentStepStatus, Attachment, Chat, ChatMessage, ChatMeta, ChatRole,
    GenerationThinkingLevel, GenerationTimeline, GenerationTimelineStatus,
};
use aiden_data::chat_store::{AppendMessageMeta, ChatMessageInput, ChatStoreInput};
use aiden_data::now_millis;
use aiden_data::portable_config::{Workspace, WorkspacePermission};
use aiden_data::usage_store::{UsageRequestRecord, UsageRequestStatus};
use gpui::{AppContext as _, Context, EventEmitter, Task};
use gpui_tokio_bridge::{JoinError, Tokio};
use tokio::sync::mpsc;

use crate::approvals::approval_bridge::{ApprovalBridge, ApprovalDecision};
use crate::approvals::queue::{
    clear_approvals, decide_approval, enqueue_approval, queue_head, PendingApproval,
};
use crate::services::appearance::{
    appearance_from_settings, appearance_to_settings, apply_appearance, resolve_scheme,
    SETTINGS_APPEARANCE_KEY,
};
use crate::services::mcp_tools::McpStreamContext;
use crate::services::provider_kit::{
    chat_history_to_messages, configured_provider_supports_images, drive_stream_with_web_key,
    merge_codex_configured_provider, resolve_api_key, resolve_thinking_control,
    CodingStreamContext, ConfiguredProvider, ModelSelection, StreamMsg, ThinkingControlSnapshot,
    TurnSnapshot, WebSearchStreamContext, WorkspacePromptContext,
};
use crate::services::stores::Stores;
use crate::services::stream::chat_usage_record;

/// The persisted-selection settings key (`settings.json`).
const MODEL_SELECTION_KEY: &str = "modelSelection";

/// Live state of one generation (one assistant turn).
#[derive(Debug, Clone)]
pub struct GenerationState {
    pub chat_id: String,
    pub counter: u64,
    pub text: String,
    pub thinking: String,
    pub thinking_active: bool,
    pub thinking_expanded: bool,
    pub complete: bool,
    pub error: Option<String>,
    pub model: Option<String>,
    /// Provider identity captured when the generation starts. Selection can
    /// change only after settlement, but persistence and usage remain pinned
    /// defensively to the request that actually ran.
    pub provider_id: String,
    pub provider_label: String,
    pub provider_is_local: bool,
    pub cancellation: ToolCancellation,
    /// Live activity timeline (thinking/tool steps). Mirrored from the driver's
    /// `TimelineProjector` and persisted with the assistant message on settle.
    pub timeline: Option<GenerationTimeline>,
}

/// A lightweight owned snapshot of everything the shell renders for the active
/// chat (cloned from the service so render helpers never hold a borrow across
/// `cx.listener` closures).
#[derive(Debug, Clone, Default)]
pub struct ChatSnapshot {
    /// Shared render projection: attachment bodies are cloned only when the
    /// transcript changes, never for each streaming flush/re-render.
    pub messages: Arc<Vec<ChatMessage>>,
    pub generation: Option<GenerationState>,
    pub selection: Option<ModelSelection>,
    pub has_providers: bool,
    pub has_key_for_selection: bool,
    pub approval: Option<PendingApproval>,
    pub deciding_approval: bool,
    pub ready_for_send: bool,
    pub pending_send: bool,
    pub assistant_persisting: bool,
    pub supports_images: Option<bool>,
    pub thinking: Option<ThinkingControlSnapshot>,
    pub thinking_saving: bool,
    pub thinking_error: Option<String>,
}

/// Foreground events whose handling needs the app window (notably clearing the
/// exact composer draft only after its user message is durable).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ChatServiceEvent {
    UserMessagePersisted { operation: u64, chat_id: String },
    ActiveChatChanged { chat_id: Option<String> },
}

pub struct ChatService {
    stores: Stores,

    /// Provider catalog from the portable config.
    pub providers: Vec<ConfiguredProvider>,
    /// Current provider + model for new turns.
    pub selection: Option<ModelSelection>,
    /// Foreground mirror of settings used by the composer. Store I/O remains
    /// on the background executor.
    settings: serde_json::Map<String, serde_json::Value>,
    thinking_saving: bool,
    thinking_operation: u64,
    thinking_error: Option<String>,
    /// Intent revisions fence detached catalog reads and selection writes so
    /// a slow older operation cannot replace a newer model choice on disk or
    /// pair a refreshed provider list with stale settings.
    selection_operation: Arc<AtomicU64>,
    provider_refresh_operation: u64,
    /// Sidebar list (store order: newest-updated first).
    pub chat_list: Vec<ChatMeta>,
    pub search_query: String,
    pub active_chat_id: Option<String>,
    pub active_chat: Option<Chat>,
    render_messages: Arc<Vec<ChatMessage>>,
    pub active_error: Option<String>,
    pub appearance: AppearanceConfig,
    /// Generation for the *active* chat (only one stream at a time).
    pub generation: Option<GenerationState>,
    /// Per-chat intent counters: incrementing invalidates in-flight streams.
    generations: HashMap<String, u64>,
    pub(crate) booted: bool,

    /// The active workspace (name/path chip, git repo root, terminal cwd, and
    /// agent sandbox root).
    pub workspace: Option<Workspace>,
    /// All persisted workspaces (the picker's "recent" list).
    pub workspaces: Vec<Workspace>,
    /// Admission gates keep the visible workspace and the active chat's
    /// persisted workspace owner in lockstep across background store I/O.
    creating_chat: bool,
    workspace_change_pending: bool,
    loading_chat: bool,
    /// A send is admitted only once, then waits for the user message to be
    /// durable before a provider driver can start.
    pending_send: bool,
    send_operation: u64,
    assistant_persisting: bool,
    assistant_persist_operation: u64,

    /// Normal-chat mutation approvals share the same bridge/card contract as
    /// the Assistant panel, but remain scoped to this chat service.
    approval_bridge: Arc<ApprovalBridge>,
    approvals: Vec<PendingApproval>,
    deciding_approval_id: Option<String>,
    decision_tx: mpsc::UnboundedSender<(String, ApprovalDecision)>,

    _stream_task: Option<Task<anyhow::Result<()>>>,
    _driver: Option<Task<Result<(), JoinError>>>,
    _decision_watcher: Option<Task<anyhow::Result<()>>>,
}

impl EventEmitter<ChatServiceEvent> for ChatService {}

impl ChatService {
    pub fn new(stores: Stores, cx: &mut Context<Self>) -> Self {
        let appearance = create_default_appearance_config();
        let (decision_tx, mut decision_rx) =
            mpsc::unbounded_channel::<(String, ApprovalDecision)>();
        let mut this = Self {
            stores,
            providers: Vec::new(),
            selection: None,
            settings: serde_json::Map::new(),
            thinking_saving: false,
            thinking_operation: 0,
            thinking_error: None,
            selection_operation: Arc::new(AtomicU64::new(0)),
            provider_refresh_operation: 0,
            chat_list: Vec::new(),
            search_query: String::new(),
            active_chat_id: None,
            active_chat: None,
            render_messages: Arc::new(Vec::new()),
            active_error: None,
            appearance,
            generation: None,
            generations: HashMap::new(),
            booted: false,
            workspace: None,
            workspaces: Vec::new(),
            creating_chat: false,
            workspace_change_pending: false,
            loading_chat: false,
            pending_send: false,
            send_operation: 0,
            assistant_persisting: false,
            assistant_persist_operation: 0,
            approval_bridge: Arc::new(ApprovalBridge::new()),
            approvals: Vec::new(),
            deciding_approval_id: None,
            decision_tx,
            _stream_task: None,
            _driver: None,
            _decision_watcher: None,
        };
        this._decision_watcher = Some(cx.spawn(async move |this, cx| -> anyhow::Result<()> {
            while let Some((approval_id, decision)) = decision_rx.recv().await {
                this.update(cx, |this, cx| {
                    this.decide_approval(&approval_id, decision, cx)
                })?;
            }
            Ok(())
        }));
        this
    }

    // =======================================================================
    // Boot
    // =======================================================================

    /// Load chats + provider catalog + settings from the stores (background)
    /// and populate the in-memory state.
    pub fn boot(&mut self, cx: &mut Context<Self>) {
        let stores = self.stores.clone();
        cx.spawn(async move |this, cx| {
            let (chats, providers, settings, appearance, workspaces) = cx
                .background_spawn(async move {
                    let chats = stores.chat.list(None).unwrap_or_default();
                    let providers = stores
                        .config
                        .list_providers()
                        .map(|list| {
                            list.iter()
                                .map(ConfiguredProvider::from)
                                .collect::<Vec<_>>()
                        })
                        .unwrap_or_default();
                    let providers = merge_codex_configured_provider(
                        providers,
                        &stores.codex_auth.provider_snapshot(),
                    );
                    let settings = stores.config.get_settings().unwrap_or_default();
                    let appearance = appearance_from_settings(&settings);
                    let workspaces = stores.config.list_workspaces().unwrap_or_default();
                    (chats, providers, settings, appearance, workspaces)
                })
                .await;
            this.update(cx, |this, cx| {
                this.chat_list = chats;
                this.providers = providers;
                this.appearance = appearance;
                this.selection = this.resolve_selection(&settings);
                this.settings = settings;
                this.workspaces = workspaces;
                // The most recently used workspace is the active one (the TS
                // keeps this in localStorage; `updatedAt` is the port's proxy).
                this.workspace = this.workspaces.iter().max_by_key(|w| w.updated_at).cloned();
                this.booted = true;
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
                if self.provider_offers(&selection) {
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

    fn provider_offers(&self, selection: &ModelSelection) -> bool {
        self.providers.iter().any(|provider| {
            provider.id == selection.provider_id && provider.offers_model(&selection.model)
        })
    }

    /// The provider currently selected (or whose model is selected).
    pub fn selected_provider(&self) -> Option<&ConfiguredProvider> {
        let id = self.selection.as_ref()?.provider_id.as_str();
        self.providers.iter().find(|provider| provider.id == id)
    }

    /// Re-read the provider catalog (+ persisted selection) from the config
    /// store. Used by the command palette's "Refresh provider catalogs" and
    /// any future settings-driven catalog invalidation.
    pub fn refresh_providers(&mut self, cx: &mut Context<Self>) {
        self.provider_refresh_operation = self.provider_refresh_operation.wrapping_add(1);
        let refresh_operation = self.provider_refresh_operation;
        let thinking_operation = self.thinking_operation;
        let selection_operation = self.selection_operation.load(Ordering::Acquire);
        let selection_revision = self.selection_operation.clone();
        let stores = self.stores.clone();
        cx.spawn(async move |this, cx| {
            let (providers, settings) = cx
                .background_spawn(async move {
                    let providers = stores
                        .config
                        .list_providers()
                        .map(|list| {
                            list.iter()
                                .map(ConfiguredProvider::from)
                                .collect::<Vec<_>>()
                        })
                        .unwrap_or_default();
                    let providers = merge_codex_configured_provider(
                        providers,
                        &stores.codex_auth.provider_snapshot(),
                    );
                    let settings = stores.config.get_settings().unwrap_or_default();
                    (providers, settings)
                })
                .await;
            this.update(cx, |this, cx| {
                if this.provider_refresh_operation != refresh_operation
                    || this.thinking_operation != thinking_operation
                    || selection_revision.load(Ordering::Acquire) != selection_operation
                {
                    return;
                }
                // Apply the catalog, matching selection, and preference map as
                // one snapshot. A half-applied refresh can otherwise display
                // a model that the new provider catalog does not offer.
                this.providers = providers;
                this.selection = this.resolve_selection(&settings);
                this.settings = settings;
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
        // Keep the header, terminal cwd, and approval target pinned to the
        // generation's authorized workspace until the turn settles.
        if self.generation_active()
            || self.pending_send
            || self.creating_chat
            || self.workspace_change_pending
        {
            return;
        }
        let Some(workspace) = self.workspaces.iter().find(|w| w.id == id).cloned() else {
            return;
        };
        if self.workspace.as_ref().map(|w| w.id.as_str()) == Some(id) {
            return;
        }
        self.workspace_change_pending = true;
        self.apply_workspace_change(workspace, cx);
    }

    /// Create (or refresh) a workspace from a folder chosen in the OS panel and
    /// make it active. Mirrors the TS `saveWorkspaceForFolder` (realpath, must
    /// be a directory, name = basename, permission `ask`).
    #[allow(dead_code)] // pending workspace-picker wiring (workspace owner)
    pub fn add_workspace_from_folder(&mut self, folder: &std::path::Path, cx: &mut Context<Self>) {
        if self.generation_active()
            || self.pending_send
            || self.creating_chat
            || self.workspace_change_pending
        {
            return;
        }
        self.workspace_change_pending = true;
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
                // A generation may have started while the native picker or
                // canonicalization was pending. Do not move its visible and
                // terminal workspace out from under the authorization fence.
                if this.generation_active() {
                    this.workspace_change_pending = false;
                    return;
                }
                if let Some(saved) = created {
                    if let Some(index) = this.workspaces.iter().position(|w| w.id == saved.id) {
                        this.workspaces[index] = saved.clone();
                    } else {
                        this.workspaces.push(saved.clone());
                    }
                    this.apply_workspace_change(saved, cx);
                } else {
                    this.workspace_change_pending = false;
                    this.active_error =
                        Some("That folder could not be opened as a workspace.".into());
                    cx.notify();
                }
            })
            .ok();
        })
        .detach();
    }

    /// Apply a workspace choice without ever letting the header/terminal
    /// diverge from the active chat's persisted authorization owner.
    fn apply_workspace_change(&mut self, workspace: Workspace, cx: &mut Context<Self>) {
        match workspace_change_plan(self.active_chat.as_ref()) {
            WorkspaceChangePlan::Direct => {
                self.workspace = Some(workspace.clone());
                self.workspace_change_pending = false;
                self.active_error = None;
                self.persist_workspace(workspace, cx);
                cx.notify();
            }
            WorkspaceChangePlan::RejectNonempty => {
                self.workspace_change_pending = false;
                self.active_error = Some(
                    "Start a new chat before switching this conversation to another workspace."
                        .into(),
                );
                cx.notify();
            }
            WorkspaceChangePlan::MoveEmpty { chat_id } => {
                let stores = self.stores.clone();
                let workspace_id = workspace.id.clone();
                cx.spawn(async move |this, cx| {
                    let task_chat_id = chat_id.clone();
                    let updated = cx
                        .background_spawn(async move {
                            stores
                                .chat
                                .move_empty_chat_to_workspace(&task_chat_id, &workspace_id)
                        })
                        .await;
                    this.update(cx, |this, cx| {
                        this.workspace_change_pending = false;
                        if this.generation_active()
                            || this.active_chat_id.as_deref() != Some(chat_id.as_str())
                        {
                            return;
                        }
                        match updated {
                            Ok(updated) => {
                                this.active_chat = Some(updated);
                                this.sync_render_messages();
                                this.workspace = Some(workspace.clone());
                                this.active_error = None;
                                this.persist_workspace(workspace, cx);
                                this.refresh_chat_list(cx);
                            }
                            Err(error) => {
                                this.active_error =
                                    Some(format!("The workspace could not be changed: {error}"));
                            }
                        }
                        cx.notify();
                    })?;
                    Ok::<(), anyhow::Error>(())
                })
                .detach();
            }
        }
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
        if self.creating_chat || self.workspace_change_pending || self.pending_send {
            return;
        }
        self.cancel_generation(cx);
        self.creating_chat = true;
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
            this.update(cx, |this, cx| {
                this.creating_chat = false;
                this.loading_chat = false;
                if let Some(chat) = created {
                    this.active_chat_id = Some(chat.id.clone());
                    this.active_chat = Some(chat);
                    this.sync_render_messages();
                    this.active_error = None;
                    cx.emit(ChatServiceEvent::ActiveChatChanged {
                        chat_id: this.active_chat_id.clone(),
                    });
                    this.refresh_chat_list(cx);
                } else {
                    this.active_error = Some("Couldn't create a new chat.".into());
                }
                cx.notify();
            })
            .ok();
        })
        .detach();
    }

    /// Select a chat, cancelling any in-flight generation (intent bump).
    pub fn select_chat(&mut self, id: &str, cx: &mut Context<Self>) {
        if self.creating_chat || self.pending_send {
            return;
        }
        if self.active_chat_id.as_deref() == Some(id) {
            return;
        }
        self.cancel_generation(cx);
        self.active_chat_id = Some(id.to_string());
        self.active_chat = None;
        self.loading_chat = true;
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
                    this.loading_chat = false;
                    this.active_chat = chat;
                    this.sync_render_messages();
                    this.workspace = this
                        .active_chat
                        .as_ref()
                        .and_then(|chat| chat.workspace_id.as_deref())
                        .and_then(|workspace_id| {
                            this.workspaces
                                .iter()
                                .find(|workspace| workspace.id == workspace_id)
                        })
                        .cloned();
                    if this.active_chat.is_none() {
                        this.active_error = Some("This chat could not be read from disk.".into());
                    } else {
                        cx.emit(ChatServiceEvent::ActiveChatChanged {
                            chat_id: Some(id.clone()),
                        });
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
        if was_active && self.pending_send {
            return;
        }
        if was_active {
            self.cancel_generation(cx);
        }
        let stores = self.stores.clone();
        let id = id.to_string();
        cx.spawn(async move |this, cx| {
            let task_id = id.clone();
            cx.background_spawn(async move { stores.chat.remove(&task_id).ok() })
                .await;
            this.update(cx, |this, cx| {
                this.chat_list.retain(|meta| meta.id != id);
                if this.active_chat_id.as_deref() == Some(id.as_str()) {
                    this.active_chat_id = None;
                    this.active_chat = None;
                    this.sync_render_messages();
                    this.loading_chat = false;
                    // Don't strand the user on an empty pane with a populated
                    // sidebar: fall back to the most recent remaining chat.
                    if let Some(next) = next_chat_after_delete(&this.chat_list) {
                        let next_id = next.id.clone();
                        this.active_chat_id = Some(next_id.clone());
                        this.loading_chat = true;
                        this.load_chat(&next_id, cx);
                    } else {
                        cx.emit(ChatServiceEvent::ActiveChatChanged { chat_id: None });
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
        if self.generation_active() || self.pending_send || self.thinking_saving {
            return;
        }
        let Some(provider) = self
            .providers
            .iter()
            .find(|provider| provider.id == provider_id)
        else {
            return;
        };
        if !provider.offers_model(model) {
            return;
        }
        let next = ModelSelection {
            provider_id: provider.id.clone(),
            model: model.to_string(),
        };
        if self.selection.as_ref() == Some(&next) {
            return;
        }
        self.selection = Some(next.clone());
        self.thinking_error = None;
        let operation = self.selection_operation.fetch_add(1, Ordering::AcqRel) + 1;
        self.persist_selection(&next, operation, cx);
        cx.notify();
    }

    fn persist_selection(
        &self,
        selection: &ModelSelection,
        operation: u64,
        cx: &mut Context<Self>,
    ) {
        let stores = self.stores.clone();
        let revision = self.selection_operation.clone();
        let value = selection.to_settings();
        cx.spawn(async move |_, cx| {
            let _ = cx
                .background_spawn(async move {
                    let mut patch = serde_json::Map::new();
                    patch.insert(MODEL_SELECTION_KEY.to_string(), value);
                    let _ = stores
                        .config
                        .set_settings(&patch, &|| revision.load(Ordering::Acquire) == operation);
                })
                .await;
        })
        .detach();
    }

    pub fn set_thinking_level(&mut self, level: GenerationThinkingLevel, cx: &mut Context<Self>) {
        if self.generation_active() || self.pending_send || self.thinking_saving || !self.booted {
            return;
        }
        let Some(selection) = self.selection.clone() else {
            return;
        };
        let Some(provider) = self.selected_provider() else {
            return;
        };
        let Some(control) = resolve_thinking_control(provider, &selection, &self.settings) else {
            return;
        };
        if control.level == level || !control.levels.contains(&level) {
            return;
        }

        self.thinking_saving = true;
        self.thinking_error = None;
        self.thinking_operation = self.thinking_operation.wrapping_add(1);
        let operation = self.thinking_operation;
        let stores = self.stores.clone();
        cx.spawn(async move |this, cx| {
            let provider_id = selection.provider_id.clone();
            let model = selection.model.clone();
            let result = cx
                .background_spawn(async move {
                    match provider_id.as_str() {
                        aiden_providers::google::GOOGLE_PROVIDER_ID => stores
                            .config
                            .set_google_thinking_level(&model, level.as_str()),
                        aiden_providers::codex::OPENAI_CODEX_PROVIDER_ID => stores
                            .config
                            .set_codex_thinking_level(&model, level.as_str()),
                        aiden_providers::builtin::ANTHROPIC_PROVIDER_ID => stores
                            .config
                            .set_anthropic_thinking_level(&model, level.as_str()),
                        _ => return None,
                    }
                    .ok()
                })
                .await;
            this.update(cx, |this, cx| {
                if this.thinking_operation != operation {
                    return;
                }
                this.thinking_operation = operation.wrapping_add(1);
                this.thinking_saving = false;
                if let Some(settings) = result {
                    this.settings = settings;
                } else {
                    this.thinking_error = Some(
                        match selection.provider_id.as_str() {
                            aiden_providers::google::GOOGLE_PROVIDER_ID => {
                                "Couldn't save the Gemini thinking level."
                            }
                            aiden_providers::codex::OPENAI_CODEX_PROVIDER_ID => {
                                "Couldn't save the Codex thinking level."
                            }
                            _ => "Couldn't save the Claude thinking level.",
                        }
                        .to_string(),
                    );
                }
                cx.notify();
            })
            .ok();
        })
        .detach();
        cx.notify();
    }

    // =======================================================================
    // Appearance
    // =======================================================================

    pub fn set_appearance_mode(&mut self, mode: Mode, cx: &mut Context<Self>) {
        if self.appearance.mode == mode {
            return;
        }
        self.appearance.mode = mode;
        self.apply_appearance(cx);
        self.persist_appearance(cx);
        cx.notify();
    }

    pub fn apply_appearance(&self, cx: &mut Context<Self>) {
        let scheme = resolve_scheme(self.appearance.mode, cx.window_appearance());
        apply_appearance(cx, &self.appearance, scheme);
    }

    fn persist_appearance(&self, cx: &mut Context<Self>) {
        let stores = self.stores.clone();
        let value = appearance_to_settings(&self.appearance);
        cx.spawn(async move |_, cx| {
            let _ = cx
                .background_spawn(async move {
                    let mut patch = serde_json::Map::new();
                    patch.insert(SETTINGS_APPEARANCE_KEY.to_string(), value);
                    let _ = stores.config.set_settings(&patch, &|| true);
                })
                .await;
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

    fn sync_render_messages(&mut self) {
        self.render_messages = Arc::new(
            self.active_chat
                .as_ref()
                .map(|chat| chat.messages.clone())
                .unwrap_or_default(),
        );
    }

    fn bump_generation(&mut self, chat_id: &str) -> u64 {
        let counter = self.generations.get(chat_id).copied().unwrap_or(0) + 1;
        self.generations.insert(chat_id.to_string(), counter);
        counter
    }

    fn generation_matches(&self, chat_id: &str, counter: u64) -> bool {
        self.generation.as_ref().is_some_and(|generation| {
            generation.chat_id == chat_id && generation.counter == counter && !generation.complete
        })
    }

    /// The snapshot the shell renders for the active chat.
    pub fn snapshot(&self) -> ChatSnapshot {
        let provider = self.selected_provider();
        let thinking = provider.and_then(|provider| {
            self.selection
                .as_ref()
                .and_then(|selection| resolve_thinking_control(provider, selection, &self.settings))
        });
        ChatSnapshot {
            messages: self.render_messages.clone(),
            generation: self.generation.clone(),
            selection: self.selection.clone(),
            has_providers: !self.providers.is_empty(),
            has_key_for_selection: provider
                .is_some_and(|provider| !provider.needs_key || provider.has_key),
            approval: queue_head(&self.approvals).cloned(),
            deciding_approval: self.deciding_approval_id.is_some(),
            ready_for_send: !self.loading_chat
                && !self.creating_chat
                && !self.workspace_change_pending
                && !self.pending_send
                && !self.assistant_persisting
                && !self.thinking_saving
                && self.active_chat_id.as_deref()
                    == self.active_chat.as_ref().map(|chat| chat.id.as_str()),
            pending_send: self.pending_send,
            assistant_persisting: self.assistant_persisting,
            supports_images: provider
                .zip(self.selection.as_ref())
                .map(|(provider, selection)| {
                    configured_provider_supports_images(provider, &selection.model)
                }),
            thinking,
            thinking_saving: self.thinking_saving,
            thinking_error: self.thinking_error.clone(),
        }
    }

    pub fn approval_decision_sender(&self) -> mpsc::UnboundedSender<(String, ApprovalDecision)> {
        self.decision_tx.clone()
    }

    pub fn decide_approval(
        &mut self,
        approval_id: &str,
        decision: ApprovalDecision,
        cx: &mut Context<Self>,
    ) {
        if self.deciding_approval_id.is_some() {
            return;
        }
        self.deciding_approval_id = Some(approval_id.to_string());
        self.approval_bridge.decide(approval_id, decision);
        let (approvals, _) = decide_approval(std::mem::take(&mut self.approvals), approval_id);
        self.approvals = approvals;
        self.deciding_approval_id = None;
        cx.notify();
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
        let keys = self.stores.keys.clone();
        Some(McpStreamContext {
            manager: self.stores.mcp.clone(),
            servers: enabled,
            preset_key: Some(Arc::new(move |server_id| {
                keys.get(&aiden_mcp::preset_secret_id(server_id))
                    .ok()
                    .flatten()
            })),
        })
    }

    /// Resolve the exact workspace persisted on the active chat. Never grant
    /// tools from the mutable workspace picker to a chat that belongs to a
    /// different workspace.
    fn generation_workspace(&self) -> Option<&Workspace> {
        let workspace_id = self.active_chat.as_ref()?.workspace_id.as_deref()?;
        workspace_for_chat(&self.workspaces, Some(workspace_id))
    }

    fn coding_context(&self, cancellation: ToolCancellation) -> Option<CodingStreamContext> {
        let workspace = self.generation_workspace()?;
        let root = workspace.folder_path.as_ref()?;
        if workspace.permission == WorkspacePermission::None {
            return None;
        }
        Some(CodingStreamContext {
            root: PathBuf::from(root),
            permission: workspace.permission,
            managed_branch: workspace
                .managed_worktree
                .as_ref()
                .map(|worktree| worktree.branch.clone()),
            approval: self.approval_bridge.clone(),
            cancellation,
        })
    }

    fn skill_context(&self) -> Vec<aiden_data::portable_config::Skill> {
        self.stores
            .config
            .list_skills()
            .unwrap_or_default()
            .into_iter()
            .filter(|skill| skill.enabled)
            .collect()
    }

    fn workspace_prompt_context(&self) -> WorkspacePromptContext {
        let workspace = self.generation_workspace();
        WorkspacePromptContext {
            root: workspace
                .and_then(|workspace| workspace.folder_path.as_ref())
                .map(PathBuf::from),
            permission: workspace
                .map(|workspace| workspace.permission)
                .unwrap_or(WorkspacePermission::None),
            managed_branch: workspace
                .and_then(|workspace| workspace.managed_worktree.as_ref())
                .map(|worktree| worktree.branch.clone()),
        }
    }

    /// Admit a user turn and persist it before any provider request starts.
    /// The returned operation identifies the exact composer draft that may be
    /// cleared once [`ChatServiceEvent::UserMessagePersisted`] is emitted.
    pub fn send_message(
        &mut self,
        text: &str,
        attachments: Vec<Attachment>,
        cx: &mut Context<Self>,
    ) -> Option<u64> {
        if self.creating_chat
            || self.workspace_change_pending
            || self.loading_chat
            || self.pending_send
            || self.thinking_saving
            || self.active_chat_id.as_deref()
                != self.active_chat.as_ref().map(|chat| chat.id.as_str())
        {
            return None;
        }
        let text = text.trim().to_string();
        if (text.is_empty() && attachments.is_empty()) || self.generation_active() {
            return None;
        }
        let Some(selection) = self.selection.clone() else {
            self.active_error = Some("Select a provider and model to start chatting.".into());
            cx.notify();
            return None;
        };
        let Some(provider) = self.selected_provider().cloned() else {
            self.active_error = Some("The selected provider is no longer configured.".into());
            cx.notify();
            return None;
        };
        if !provider.offers_model(&selection.model) {
            self.active_error = Some(
                "The selected model is no longer offered by this provider. Pick another model."
                    .into(),
            );
            cx.notify();
            return None;
        }
        if provider.needs_key && !provider.has_key {
            self.active_error = Some(format!(
                "No API key set for {}. Add one in Settings → Providers.",
                provider.label
            ));
            cx.notify();
            return None;
        }

        // Ensure a persisted chat exists (one-time synchronous create on first
        // send; message persistence below always runs on the background).
        let chat_id = match self.active_chat_id.clone() {
            Some(id) => id,
            None => match self.stores.chat.create(ChatStoreInput {
                title: None,
                workspace_id: self.workspace.as_ref().map(|w| w.id.as_str()),
                provider_id: Some(&selection.provider_id),
                model: Some(&selection.model),
            }) {
                Ok(chat) => {
                    let meta = meta_of(&chat);
                    self.chat_list.insert(0, meta);
                    let chat_id = chat.id.clone();
                    self.active_chat_id = Some(chat_id.clone());
                    self.active_chat = Some(chat);
                    self.sync_render_messages();
                    chat_id
                }
                Err(error) => {
                    self.active_error = Some(format!("Couldn't create the chat: {error}"));
                    cx.notify();
                    return None;
                }
            },
        };

        let expected_workspace_id = self
            .active_chat
            .as_ref()
            .filter(|chat| chat.id == chat_id)
            .map(|chat| {
                chat.workspace_id
                    .as_deref()
                    .unwrap_or("default")
                    .to_string()
            });
        let created_at = now_millis();
        self.send_operation = self.send_operation.wrapping_add(1);
        let operation = self.send_operation;
        self.pending_send = true;
        self.active_error = None;
        cx.notify();

        let stores = self.stores.clone();
        let task_chat_id = chat_id.clone();
        let task_selection = selection.clone();
        cx.spawn(async move |this, cx| {
            let result = cx
                .background_spawn(async move {
                    let input = ChatMessageInput {
                        id: None,
                        role: ChatRole::User,
                        content: text,
                        model: None,
                        reasoning: None,
                        attachments: (!attachments.is_empty()).then_some(attachments),
                        timeline: None,
                        subagents: None,
                        created_at: Some(created_at),
                    };
                    let meta = AppendMessageMeta {
                        provider_id: Some(&task_selection.provider_id),
                        model: Some(&task_selection.model),
                        auto_title: true,
                        expected_workspace_id: expected_workspace_id.as_deref(),
                    };
                    stores
                        .chat
                        .append_message(&task_chat_id, input, Some(meta))
                        .map_err(|error| error.to_string())
                })
                .await;
            this.update(cx, |this, cx| {
                if this.send_operation != operation {
                    return;
                }
                this.pending_send = false;
                match result {
                    Ok(chat) => {
                        cx.emit(ChatServiceEvent::UserMessagePersisted {
                            operation,
                            chat_id: chat_id.clone(),
                        });
                        this.refresh_chat_list(cx);
                        // Navigation after admission intentionally abandons the
                        // generation while retaining the durable user turn.
                        if this.active_chat_id.as_deref() != Some(chat_id.as_str())
                            || this.generation_active()
                        {
                            cx.notify();
                            return;
                        }
                        this.active_chat = Some(chat);
                        this.sync_render_messages();
                        this.start_generation(chat_id, selection, provider, cx);
                    }
                    Err(error) => {
                        this.active_error = Some(format!(
                            "Couldn't save the message; your draft was kept: {error}"
                        ));
                        cx.notify();
                    }
                }
            })
            .ok();
        })
        .detach();

        Some(operation)
    }

    fn start_generation(
        &mut self,
        chat_id: String,
        selection: ModelSelection,
        provider: ConfiguredProvider,
        cx: &mut Context<Self>,
    ) {
        if self.active_chat_id.as_deref() != Some(chat_id.as_str()) || self.generation_active() {
            return;
        }

        let counter = self.bump_generation(&chat_id);
        let cancellation = ToolCancellation::new();
        self.approval_bridge.cancel_all();
        self.approvals = clear_approvals(std::mem::take(&mut self.approvals));
        self.deciding_approval_id = None;
        self.active_error = None;
        self.generation = Some(GenerationState {
            chat_id: chat_id.clone(),
            counter,
            text: String::new(),
            thinking: String::new(),
            thinking_active: false,
            thinking_expanded: false,
            complete: false,
            error: None,
            model: Some(selection.model.clone()),
            provider_id: provider.id.clone(),
            provider_label: provider.label.clone(),
            provider_is_local: !provider.needs_key,
            cancellation: cancellation.clone(),
            timeline: None,
        });
        cx.notify();

        // Build the turn snapshot from the store-returned authoritative chat.
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
            configured_provider_supports_images(&provider, &selection.model),
        );
        let skills = self.skill_context();
        let thinking_level = resolve_thinking_control(&provider, &selection, &self.settings)
            .map(|control| control.level)
            .unwrap_or(GenerationThinkingLevel::Off);
        let mut snapshot = TurnSnapshot {
            provider: provider.clone(),
            selection: selection.clone(),
            thinking_level,
            session_id: chat_id.clone(),
            messages,
            system_prompt: None,
            mcp: self.mcp_context(),
            // The capability is staged on the driver below. This avoids any
            // config/keychain I/O on the GPUI foreground and keeps the
            // portable enable bit synchronized with the machine-local key.
            web_search: None,
            coding: self.coding_context(cancellation),
            skills,
            prompt: self.workspace_prompt_context(),
        };

        // Keychain lookup happens inside the tokio driver (background thread).
        let stores = self.stores.clone();
        let (tx, rx) = mpsc::unbounded_channel::<StreamMsg>();
        let driver = Tokio::spawn(cx, async move {
            let api_key = resolve_api_key(&stores.keys, &snapshot.provider);
            let web_search_api_key = {
                let _guard = stores
                    .web_search_state
                    .lock()
                    .unwrap_or_else(std::sync::PoisonError::into_inner);
                let enabled = stores
                    .config
                    .get_settings()
                    .ok()
                    .and_then(|settings| {
                        settings
                            .get("exaEnabled")
                            .and_then(serde_json::Value::as_bool)
                    })
                    .unwrap_or(false);
                enabled
                    .then(|| {
                        stores
                            .keys
                            .get(aiden_providers::web_search::EXA_KEY_ID)
                            .ok()
                            .flatten()
                    })
                    .flatten()
            };
            if web_search_api_key.is_some() {
                snapshot.web_search = Some(WebSearchStreamContext {
                    client: stores.web_search.clone(),
                });
            }
            drive_stream_with_web_key(
                snapshot,
                api_key,
                web_search_api_key,
                stores.codex_auth.clone(),
                tx,
            )
            .await;
        });

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

    /// Re-send the last user message (error-banner retry).
    pub fn retry_last(&mut self, cx: &mut Context<Self>) {
        if self.pending_send || self.assistant_persisting || self.generation_active() {
            return;
        }
        let Some(chat) = self.active_chat.as_ref() else {
            return;
        };
        if !chat
            .messages
            .iter()
            .any(|message| message.role == ChatRole::User)
        {
            return;
        }
        let chat_id = chat.id.clone();
        let failed_partial_id = failed_partial_for_retry(chat, self.generation.as_ref());
        let Some(selection) = self.selection.clone() else {
            return;
        };
        let Some(provider) = self.selected_provider().cloned() else {
            return;
        };
        if !provider.offers_model(&selection.model) || (provider.needs_key && !provider.has_key) {
            return;
        }
        // Retry starts a new assistant generation from the already-durable
        // transcript. Re-appending the user turn would duplicate attachment
        // bodies on disk and in every later provider context.
        let Some(failed_partial_id) = failed_partial_id else {
            self.start_generation(chat_id, selection, provider, cx);
            return;
        };

        self.pending_send = true;
        self.send_operation = self.send_operation.wrapping_add(1);
        let operation = self.send_operation;
        let stores = self.stores.clone();
        let task_chat_id = chat_id.clone();
        cx.notify();
        cx.spawn(async move |this, cx| {
            let result = cx
                .background_spawn(async move {
                    stores
                        .chat
                        .remove_message(&task_chat_id, &failed_partial_id)
                        .map_err(|error| error.to_string())
                })
                .await;
            this.update(cx, |this, cx| {
                if this.send_operation != operation {
                    return;
                }
                this.pending_send = false;
                match result {
                    Ok(chat) if this.active_chat_id.as_deref() == Some(chat_id.as_str()) => {
                        this.active_chat = Some(chat);
                        this.sync_render_messages();
                        this.start_generation(chat_id, selection, provider, cx);
                    }
                    Ok(_) => cx.notify(),
                    Err(error) => {
                        this.active_error = Some(format!(
                            "Couldn't prepare the retry; the failed partial was kept: {error}"
                        ));
                        cx.notify();
                    }
                }
            })
            .ok();
        })
        .detach();
    }

    pub fn stop_generation(&mut self, cx: &mut Context<Self>) {
        if let Some(chat_id) = self.generation.as_ref().map(|g| g.chat_id.clone()) {
            self.bump_generation(&chat_id);
        }
        let mut partial = None;
        if let Some(generation) = self.generation.as_mut() {
            if !generation.complete {
                generation.complete = true;
                generation.thinking_active = false;
                generation.error = None;
                generation.timeline = generation.timeline.take().map(cancel_generation_timeline);
                if should_persist_partial(
                    &generation.text,
                    &generation.thinking,
                    generation.timeline.as_ref(),
                ) {
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
        self._stream_task = None;
        self._driver = None;
        self.clear_generation_approvals();
        cx.notify();
    }

    /// Cancel the in-flight generation without touching the current chat
    /// (used when switching chats / creating a new chat / deleting).
    fn cancel_generation(&mut self, cx: &mut Context<Self>) {
        if let Some(generation) = self.generation.as_mut() {
            generation.timeline = generation.timeline.take().map(cancel_generation_timeline);
        }
        let partial = self.generation.as_ref().and_then(|generation| {
            if generation.complete {
                return None;
            }
            should_persist_partial(
                &generation.text,
                &generation.thinking,
                generation.timeline.as_ref(),
            )
            .then(|| {
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
        self.clear_generation_approvals();
        self.generation = None;
        cx.notify();
    }

    fn clear_generation_approvals(&mut self) {
        if let Some(generation) = &self.generation {
            generation.cancellation.cancel();
        }
        self.approval_bridge.cancel_all();
        self.approvals = clear_approvals(std::mem::take(&mut self.approvals));
        self.deciding_approval_id = None;
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
            StreamMsg::ApprovalRequired { details } => {
                if let Some(prompt) = PendingApproval::from_details(&details) {
                    self.approvals = enqueue_approval(std::mem::take(&mut self.approvals), prompt);
                }
                cx.notify();
            }
            StreamMsg::Done {
                message,
                full_text,
                full_thinking,
                usage,
            } => {
                let model = message.model.clone();
                let timeline = self
                    .generation
                    .as_ref()
                    .and_then(|generation| generation.timeline.clone());
                if let Some(generation) = self.generation.as_mut() {
                    generation.text = full_text.clone();
                    generation.thinking = full_thinking.clone();
                    generation.thinking_active = false;
                    generation.complete = true;
                    generation.error = None;
                }
                self.persist_assistant(
                    &chat_id,
                    &full_text,
                    &full_thinking,
                    Some(&model),
                    Some(&message),
                    timeline,
                    cx,
                );
                self.record_usage(
                    self.build_usage_record(&usage, UsageRequestStatus::Completed),
                    cx,
                );
                self.clear_generation_approvals();
                cx.notify();
            }
            StreamMsg::Error {
                message,
                partial_text,
                partial_thinking,
                usage,
            } => {
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
                }
                if should_persist_partial(&partial_text, &partial_thinking, timeline.as_ref()) {
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
                self.record_usage(
                    self.build_usage_record(&usage, UsageRequestStatus::Failed),
                    cx,
                );
                self.clear_generation_approvals();
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
        let generation = self.generation.as_ref();
        let provider_id = generation
            .map(|generation| generation.provider_id.as_str())
            .unwrap_or("unknown");
        let provider_label = generation
            .map(|generation| generation.provider_label.as_str())
            .unwrap_or("Unknown");
        let model = generation
            .and_then(|generation| generation.model.clone())
            .unwrap_or_else(|| "unknown".to_string());
        chat_usage_record(
            usage,
            provider_id,
            provider_label,
            &model,
            &model,
            generation.is_some_and(|generation| generation.provider_is_local),
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

    /// Watcher cleanup when the stream channel closes without a terminal event
    /// (e.g. the driver was aborted mid-flight).
    fn on_stream_closed(&mut self, chat_id: &str, counter: u64, cx: &mut Context<Self>) {
        let current = self.generation.as_ref().is_some_and(|generation| {
            generation.chat_id == chat_id && generation.counter == counter
        });
        self._stream_task = None;
        self._driver = None;
        if current {
            let mut partial = None;
            if let Some(generation) = self.generation.as_mut() {
                if !generation.complete {
                    generation.complete = true;
                    generation.thinking_active = false;
                    generation.error = Some("Generation stopped unexpectedly.".into());
                    generation.timeline =
                        generation.timeline.take().map(cancel_generation_timeline);
                    if should_persist_partial(
                        &generation.text,
                        &generation.thinking,
                        generation.timeline.as_ref(),
                    ) {
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
            self.clear_generation_approvals();
            cx.notify();
        }
    }

    // -----------------------------------------------------------------------
    // Persistence helpers (background writes)
    // -----------------------------------------------------------------------

    #[allow(clippy::too_many_arguments)]
    fn persist_assistant(
        &mut self,
        chat_id: &str,
        text: &str,
        thinking: &str,
        model: Option<&str>,
        final_message: Option<&aiden_core::AssistantMessage>,
        timeline: Option<GenerationTimeline>,
        cx: &mut Context<Self>,
    ) {
        let stores = self.stores.clone();
        let chat_id = chat_id.to_string();
        let text = text.to_string();
        let thinking = thinking.to_string();
        let model = model.map(str::to_string);
        let provider = self
            .generation
            .as_ref()
            .filter(|generation| generation.chat_id == chat_id)
            .map(|generation| generation.provider_id.clone());
        let expected_workspace_id = self
            .active_chat
            .as_ref()
            .filter(|chat| chat.id == chat_id)
            .map(|chat| {
                chat.workspace_id
                    .as_deref()
                    .unwrap_or("default")
                    .to_string()
            });
        let created_at = now_millis();
        let id = final_message
            .and_then(|message| message.response_id.clone())
            .unwrap_or_else(aiden_data::chat_store::new_uuid_like);
        let timestamp = final_message.map_or(created_at, |message| message.timestamp);
        let persisted_reasoning = (!thinking.trim().is_empty()).then_some(thinking.clone());
        let timeline_value = timeline
            .as_ref()
            .and_then(|timeline| serde_json::to_value(timeline).ok());

        // Make the terminal assistant turn part of in-memory history before
        // writing. The composer remains briefly fenced until this exact append
        // settles, preserving durable turn order and making retry removal race-free.
        if let Some(chat) = self.active_chat.as_mut().filter(|chat| chat.id == chat_id) {
            if !chat.messages.iter().any(|message| message.id == id) {
                chat.messages.push(ChatMessage {
                    id: id.clone(),
                    role: ChatRole::Assistant,
                    content: text.clone(),
                    created_at: timestamp,
                    model: model.clone(),
                    reasoning: persisted_reasoning.clone(),
                    attachments: None,
                    timeline: timeline.clone(),
                    subagents: None,
                });
                chat.updated_at = timestamp;
                chat.provider_id = provider.clone();
                chat.model = model.clone();
            }
        }
        self.sync_render_messages();
        self.assistant_persist_operation = self.assistant_persist_operation.wrapping_add(1);
        let persist_operation = self.assistant_persist_operation;
        self.assistant_persisting = true;
        cx.spawn(async move |this, cx| {
            let task_chat_id = chat_id.clone();
            let persisted = cx
                .background_spawn(async move {
                    let input = ChatMessageInput {
                        id: Some(id),
                        role: ChatRole::Assistant,
                        content: text,
                        model: model.clone(),
                        reasoning: persisted_reasoning,
                        attachments: None,
                        timeline: timeline_value,
                        subagents: None,
                        created_at: Some(timestamp),
                    };
                    let meta = AppendMessageMeta {
                        provider_id: provider.as_deref(),
                        model: model.as_deref(),
                        auto_title: false,
                        expected_workspace_id: expected_workspace_id.as_deref(),
                    };
                    stores
                        .chat
                        .append_message(&task_chat_id, input, Some(meta))
                        .is_ok()
                })
                .await;
            this.update(cx, |this, cx| {
                if this.assistant_persist_operation == persist_operation {
                    this.assistant_persisting = false;
                }
                if !persisted && this.active_chat_id.as_deref() == Some(chat_id.as_str()) {
                    this.active_error = Some("The assistant message could not be saved.".into());
                }
                this.refresh_chat_list(cx);
                cx.notify();
            })
            .ok();
        })
        .detach();
    }
}

fn failed_partial_for_retry(chat: &Chat, generation: Option<&GenerationState>) -> Option<String> {
    let generation = generation.filter(|generation| generation.error.is_some())?;
    let last_user = chat
        .messages
        .iter()
        .rposition(|message| message.role == ChatRole::User)?;
    chat.messages
        .iter()
        .skip(last_user + 1)
        .rev()
        .find(|message| message.role == ChatRole::Assistant && message.content == generation.text)
        .map(|message| message.id.clone())
}

fn workspace_for_chat<'a>(
    workspaces: &'a [Workspace],
    workspace_id: Option<&str>,
) -> Option<&'a Workspace> {
    let workspace_id = workspace_id?;
    workspaces
        .iter()
        .find(|workspace| workspace.id == workspace_id)
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum WorkspaceChangePlan {
    Direct,
    MoveEmpty { chat_id: String },
    RejectNonempty,
}

fn workspace_change_plan(active_chat: Option<&Chat>) -> WorkspaceChangePlan {
    match active_chat {
        None => WorkspaceChangePlan::Direct,
        Some(chat) if chat.messages.is_empty() => WorkspaceChangePlan::MoveEmpty {
            chat_id: chat.id.clone(),
        },
        Some(_) => WorkspaceChangePlan::RejectNonempty,
    }
}

fn cancel_generation_timeline(mut timeline: GenerationTimeline) -> GenerationTimeline {
    let now = now_millis();
    timeline.status = GenerationTimelineStatus::Cancelled;
    timeline.finished_at = Some(now);
    for step in &mut timeline.steps {
        match step {
            AgentStep::Tool(tool)
                if matches!(
                    tool.status,
                    AgentStepStatus::Pending
                        | AgentStepStatus::AwaitingApproval
                        | AgentStepStatus::Running
                ) =>
            {
                tool.status = AgentStepStatus::Cancelled;
                tool.updated_at = now;
                tool.finished_at = Some(now);
            }
            AgentStep::Thinking(thinking) if thinking.finished_at.is_none() => {
                thinking.updated_at = now;
                thinking.finished_at = Some(now);
                thinking.duration_ms = Some(now.saturating_sub(thinking.started_at));
            }
            _ => {}
        }
    }
    timeline
}

fn should_persist_partial(
    text: &str,
    thinking: &str,
    timeline: Option<&GenerationTimeline>,
) -> bool {
    !text.trim().is_empty()
        || !thinking.trim().is_empty()
        || timeline.is_some_and(|timeline| !timeline.steps.is_empty())
}

/// The chat the sidebar selects after the active chat is deleted: the most
/// recent remaining chat (the list is newest-updated first), or none when the
/// list is now empty. Pure so the fallback behavior is unit-testable.
pub fn next_chat_after_delete(remaining: &[ChatMeta]) -> Option<&ChatMeta> {
    remaining.first()
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

    fn chat_with_message_count(id: &str, count: usize) -> Chat {
        Chat {
            id: id.into(),
            title: id.into(),
            workspace_id: Some("alpha".into()),
            provider_id: None,
            model: None,
            created_at: 1,
            updated_at: 1,
            computer_use_enabled: None,
            messages: (0..count)
                .map(|index| ChatMessage {
                    id: format!("m-{index}"),
                    role: ChatRole::User,
                    content: "hello".into(),
                    created_at: index as u64 + 1,
                    model: None,
                    reasoning: None,
                    attachments: None,
                    timeline: None,
                    subagents: None,
                })
                .collect(),
        }
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

    #[test]
    fn generation_workspace_is_bound_to_the_chat_identity() {
        let workspace = |id: &str, permission| Workspace {
            id: id.into(),
            name: id.into(),
            folder_path: Some(format!("/tmp/{id}")),
            permission,
            managed_worktree: None,
            created_at: 1,
            updated_at: 1,
        };
        let workspaces = vec![
            workspace("alpha", WorkspacePermission::Ask),
            workspace("beta", WorkspacePermission::Full),
        ];

        assert_eq!(
            workspace_for_chat(&workspaces, Some("alpha")).map(|item| item.id.as_str()),
            Some("alpha")
        );
        assert!(workspace_for_chat(&workspaces, Some("missing")).is_none());
        assert!(workspace_for_chat(&workspaces, None).is_none());
    }

    #[test]
    fn workspace_picker_moves_only_an_untouched_chat() {
        assert_eq!(workspace_change_plan(None), WorkspaceChangePlan::Direct);
        assert_eq!(
            workspace_change_plan(Some(&chat_with_message_count("empty", 0))),
            WorkspaceChangePlan::MoveEmpty {
                chat_id: "empty".into()
            }
        );
        assert_eq!(
            workspace_change_plan(Some(&chat_with_message_count("used", 1))),
            WorkspaceChangePlan::RejectNonempty
        );
    }

    #[test]
    fn cancellation_terminalizes_active_timeline_steps() {
        let timeline = GenerationTimeline {
            version: aiden_core::GENERATION_TIMELINE_VERSION,
            generation_id: "g".into(),
            status: GenerationTimelineStatus::Running,
            started_at: 1,
            finished_at: None,
            steps: vec![AgentStep::Tool(aiden_core::AgentToolStep {
                id: "tool-1".into(),
                order: 0,
                tool_call_id: "tool-1".into(),
                tool_name: "write_file".into(),
                label: "Write file".into(),
                status: AgentStepStatus::AwaitingApproval,
                started_at: 1,
                updated_at: 1,
                finished_at: None,
                target: Some("notes.txt".into()),
                detail: None,
            })],
            claim_check: None,
        };
        let cancelled = cancel_generation_timeline(timeline);
        assert_eq!(cancelled.status, GenerationTimelineStatus::Cancelled);
        assert!(cancelled.finished_at.is_some());
        assert!(matches!(
            cancelled.steps.first(),
            Some(AgentStep::Tool(tool))
                if tool.status == AgentStepStatus::Cancelled && tool.finished_at.is_some()
        ));
        assert!(should_persist_partial("", "", Some(&cancelled)));
        assert!(should_persist_partial("", "thinking", None));
        let mut empty = cancelled.clone();
        empty.steps.clear();
        assert!(!should_persist_partial("", "", Some(&empty)));
        assert!(!should_persist_partial("", "", None));
    }

    #[test]
    fn retry_targets_only_the_failed_partial_after_the_last_user_turn() {
        let mut chat = chat_with_message_count("chat", 1);
        chat.messages.push(ChatMessage {
            id: "failed-partial".into(),
            role: ChatRole::Assistant,
            content: "half an answer".into(),
            created_at: 2,
            model: Some("model".into()),
            reasoning: None,
            attachments: None,
            timeline: None,
            subagents: None,
        });
        let generation = GenerationState {
            chat_id: chat.id.clone(),
            counter: 1,
            text: "half an answer".into(),
            thinking: String::new(),
            thinking_active: false,
            thinking_expanded: false,
            complete: true,
            error: Some("network failed".into()),
            model: Some("model".into()),
            provider_id: "provider".into(),
            provider_label: "Provider".into(),
            provider_is_local: false,
            cancellation: ToolCancellation::new(),
            timeline: None,
        };

        assert_eq!(
            failed_partial_for_retry(&chat, Some(&generation)).as_deref(),
            Some("failed-partial")
        );
        let mut successful = generation.clone();
        successful.error = None;
        assert_eq!(failed_partial_for_retry(&chat, Some(&successful)), None);
    }
}
