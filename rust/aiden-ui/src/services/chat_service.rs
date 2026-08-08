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
use std::sync::Arc;

use aiden_core::appearance::{create_default_appearance_config, AppearanceConfig, Mode};
use aiden_core::{meta_of, Chat, ChatMessage, ChatMeta, ChatRole, GenerationTimeline};
use aiden_data::chat_store::{AppendMessageMeta, ChatMessageInput, ChatStoreInput};
use aiden_data::now_millis;
use aiden_data::portable_config::{Workspace, WorkspacePermission};
use aiden_data::usage_store::{UsageRequestRecord, UsageRequestStatus};
use gpui::{AppContext as _, Context, Task};
use gpui_tokio_bridge::{JoinError, Tokio};
use tokio::sync::mpsc;

use crate::services::appearance::{
    appearance_from_settings, appearance_to_settings, apply_appearance, resolve_scheme,
    SETTINGS_APPEARANCE_KEY,
};
use crate::services::mcp_tools::McpStreamContext;
use crate::services::provider_kit::{
    chat_history_to_messages, drive_stream, enrich_provider, load_capabilities, resolve_api_key,
    ConfiguredProvider, ModelSelection, StreamMsg, TurnSnapshot,
};
use crate::services::stores::Stores;
use crate::services::stream::{chat_usage_record, message_content, zero_usage};

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
    /// Live activity timeline (thinking/tool steps). Mirrored from the driver's
    /// `TimelineProjector` and persisted with the assistant message on settle.
    pub timeline: Option<GenerationTimeline>,
}

/// A lightweight owned snapshot of everything the shell renders for the active
/// chat (cloned from the service so render helpers never hold a borrow across
/// `cx.listener` closures).
#[derive(Debug, Clone, Default)]
pub struct ChatSnapshot {
    pub messages: Vec<ChatMessage>,
    pub generation: Option<GenerationState>,
    pub selection: Option<ModelSelection>,
    pub has_providers: bool,
    pub has_key_for_selection: bool,
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

    _stream_task: Option<Task<anyhow::Result<()>>>,
    _driver: Option<Task<Result<(), JoinError>>>,
}

impl ChatService {
    pub fn new(stores: Stores, cx: &mut Context<Self>) -> Self {
        let appearance = create_default_appearance_config();
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
            appearance,
            generation: None,
            generations: HashMap::new(),
            booted: false,
            workspace: None,
            workspaces: Vec::new(),
            _stream_task: None,
            _driver: None,
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
        let stores = self.stores.clone();
        cx.spawn(async move |this, cx| {
            let (chats, providers, settings, appearance, workspaces, capabilities) = cx
                .background_spawn(async move {
                    let chats = stores.chat.list(None).unwrap_or_default();
                    let capabilities = load_capabilities();
                    let providers = stores
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
                this.appearance = appearance;
                this.selection = this.resolve_selection(&settings);
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
        self.providers
            .iter()
            .any(|provider| provider.id == selection.provider_id)
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
                    let providers = stores
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
                    let settings = stores.config.get_settings().unwrap_or_default();
                    (providers, settings)
                })
                .await;
            this.update(cx, |this, cx| {
                this.providers = providers;
                this.selection = this.resolve_selection(&settings);
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
        self.workspace = Some(workspace.clone());
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
        self.selection = Some(next.clone());
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
        ChatSnapshot {
            messages: self
                .active_chat
                .as_ref()
                .map(|chat| chat.messages.clone())
                .unwrap_or_default(),
            generation: self.generation.clone(),
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

    pub fn send_message(&mut self, text: &str, cx: &mut Context<Self>) {
        let text = text.trim().to_string();
        if text.is_empty() || self.generation_active() {
            return;
        }
        let Some(selection) = self.selection.clone() else {
            self.active_error = Some("Select a provider and model to start chatting.".into());
            cx.notify();
            return;
        };
        let Some(provider) = self.selected_provider().cloned() else {
            self.active_error = Some("The selected provider is no longer configured.".into());
            cx.notify();
            return;
        };
        if provider.needs_key && !provider.has_key {
            self.active_error = Some(format!(
                "No API key set for {}. Add one in Settings → Providers.",
                provider.label
            ));
            cx.notify();
            return;
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
                    chat_id
                }
                Err(error) => {
                    self.active_error = Some(format!("Couldn't create the chat: {error}"));
                    cx.notify();
                    return;
                }
            },
        };

        let counter = self.bump_generation(&chat_id);
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
            timeline: None,
        });
        cx.notify();

        // Append the user message in memory, then persist on the background.
        let user_message = ChatMessage {
            id: format!("user-{counter}"),
            role: ChatRole::User,
            content: text.clone(),
            created_at: now_millis(),
            model: None,
            reasoning: None,
            attachments: None,
            timeline: None,
            subagents: None,
        };
        if let Some(chat) = self.active_chat.as_mut() {
            chat.messages.push(user_message.clone());
            chat.updated_at = user_message.created_at;
            chat.provider_id = Some(selection.provider_id.clone());
            chat.model = Some(selection.model.clone());
        }
        self.persist_user_message(&chat_id, &user_message, &selection, cx);

        // Build the turn snapshot (includes the message just appended).
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
        let snapshot = TurnSnapshot {
            provider: provider.clone(),
            selection: selection.clone(),
            messages,
            catalog: self.capabilities.clone(),
            mcp: self.mcp_context(),
        };

        // Keychain lookup happens inside the tokio driver (background thread).
        let keys = self.stores.keys.clone();
        let (tx, rx) = mpsc::unbounded_channel::<StreamMsg>();
        let driver = Tokio::spawn(cx, async move {
            let api_key = resolve_api_key(&keys, &snapshot.provider);
            drive_stream(snapshot, api_key, tx).await;
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
        let text = self
            .active_chat
            .as_ref()
            .and_then(|chat| {
                chat.messages
                    .iter()
                    .rev()
                    .find(|message| message.role == ChatRole::User)
            })
            .map(|message| message.content.clone());
        if let Some(text) = text {
            self.send_message(&text, cx);
        }
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
        self._stream_task = None;
        self._driver = None;
        cx.notify();
    }

    /// Cancel the in-flight generation without touching the current chat
    /// (used when switching chats / creating a new chat / deleting).
    fn cancel_generation(&mut self, cx: &mut Context<Self>) {
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
            StreamMsg::Done {
                message,
                full_text,
                full_thinking,
                usage,
            } => {
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
                cx.notify();
            }
            StreamMsg::Error {
                message,
                partial_text,
                partial_thinking,
                ..
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
                self.record_usage(
                    self.build_usage_record(&zero_usage(), UsageRequestStatus::Failed),
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

    /// Watcher cleanup when the stream channel closes without a terminal event
    /// (e.g. the driver was aborted mid-flight).
    fn on_stream_closed(&mut self, chat_id: &str, counter: u64, cx: &mut Context<Self>) {
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
                }
            }
            cx.notify();
        }
    }

    // -----------------------------------------------------------------------
    // Persistence helpers (background writes)
    // -----------------------------------------------------------------------

    fn persist_user_message(
        &self,
        chat_id: &str,
        message: &ChatMessage,
        selection: &ModelSelection,
        cx: &mut Context<Self>,
    ) {
        let stores = self.stores.clone();
        let chat_id = chat_id.to_string();
        let content = message.content.clone();
        let created_at = message.created_at;
        let provider_id = selection.provider_id.clone();
        let model = selection.model.clone();
        cx.spawn(async move |this, cx| {
            let result = cx
                .background_spawn(async move {
                    let input = ChatMessageInput {
                        id: None,
                        role: ChatRole::User,
                        content,
                        model: None,
                        reasoning: None,
                        attachments: None,
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
                    stores.chat.append_message(&chat_id, input, Some(meta)).ok()
                })
                .await;
            if result.is_some() {
                this.update(cx, |this, cx| {
                    this.refresh_chat_list(cx);
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
                        subagents: None,
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
}
