//! The application shell: window root, title bar, view routing, and
//! orchestration of the sidebar + content area. All render helpers live on
//! `AppState` but are defined in per-surface modules (`shell::sidebar`,
//! `chat::chat_pane`, `chat::message_list`) so each file stays small.
//!
//! The shell owns the main-window panels (command palette, terminal drawer,
//! scheduled/usage/subagents, settings) as lazily created entities, and
//! routes the sidebar palette / gear / keyboard actions onto them.

use std::cell::RefCell;
use std::rc::Rc;
use std::sync::Arc;

use aiden_core::appearance::{Mode, ReduceMotion};
use futures::FutureExt;
use gpui::{
    actions, div, prelude::FluentBuilder as _, px, App, AppContext as _, Context, Entity,
    FontWeight, InteractiveElement as _, IntoElement, ParentElement as _, Render, ScrollHandle,
    Styled as _, Subscription, Window,
};
// macOS-only: the OS-global dictation hotkey registration (parity audit
// config §12) and the `global-hotkey` event receiver that routes presses
// into the pill coordinator.
#[cfg(target_os = "macos")]
use aiden_mac::hotkey::{GlobalHotkeyManager, MacHotkeyPort, ShortcutRegistrationPort as _};
#[cfg(target_os = "macos")]
use global_hotkey::{GlobalHotKeyEvent, HotKeyState};
use gpui_component::{
    h_flex,
    input::{InputEvent, InputState},
    select::{SelectEvent, SelectItem as _, SelectState},
    v_flex, ActiveTheme, IconName, WindowExt as _,
};

use crate::assistant::{AssistantPanel, AssistantPanelDeps, AssistantPanelEvent};
use crate::chat::composer::{decode_model_key, model_items, model_key, ModelItem};
use crate::panels::command_palette::{
    CommandPalette, CommandPaletteDeps, PaletteCommand, PaletteDataSource, PaletteProvider,
    RecentCommandsStore, SettingsRecentStore,
};
use crate::panels::scheduled_panel::{
    ScheduledPanel, ScheduledPanelDeps, ScheduledPanelEvent, ScheduledTaskSource,
    StoreScheduledSource,
};
use crate::panels::subagents_panel::{
    MemoryRunSource, SubagentRunSource, SubagentsPanel, SubagentsPanelDeps,
};
use crate::panels::terminal_drawer::{TerminalDeps, TerminalDrawer};
use crate::panels::usage_panel::{StoreUsageSource, UsageDataSource, UsagePanel, UsagePanelDeps};
use crate::pill::{
    open_pill_window, LiveAudioSource, PillCoordinator, PillCoordinatorDeps, PillDeps, PillView,
};
use crate::services::chat_service::ChatService;
use crate::services::provider_kit::ConfiguredProvider;
use crate::services::stores::Stores;
use crate::settings::{SettingsSection, SettingsServices, SettingsView};
use crate::workspace::{NotificationKind, Overlay, WorkspaceEvent, WorkspaceState};

actions!(
    aiden,
    [
        NewChat,
        Quit,
        TogglePalette,
        ToggleTerminal,
        TogglePill,
        OpenSettings,
        SearchChats,
        PreviousChat,
        NextChat,
        ChatJump1,
        ChatJump2,
        ChatJump3,
        ChatJump4,
        ChatJump5,
        ChatJump6,
        ChatJump7,
        ChatJump8,
        ChatJump9,
        OpenWorkspaceFolder,
        OpenInEditor,
        CloseWindow,
        ToggleSidebar,
        ToggleAssistant,
        ToggleSubagents,
        ToggleUsage,
        FocusComposer,
        SendMessage,
        SaveFile,
    ]
);

/// The main content area the shell routes to. Session-only: the last view is
/// never persisted.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum AppView {
    #[default]
    Chat,
    Assistant,
    Scheduled,
    Usage,
    Subagents,
    Settings,
}

impl AppView {
    pub const ALL: &'static [AppView] = &[
        AppView::Chat,
        AppView::Assistant,
        AppView::Scheduled,
        AppView::Subagents,
        AppView::Usage,
        AppView::Settings,
    ];

    pub fn label(self) -> &'static str {
        match self {
            AppView::Chat => "Chats",
            AppView::Assistant => "Assistant",
            AppView::Scheduled => "Scheduled",
            AppView::Usage => "Usage",
            AppView::Subagents => "Subagents",
            AppView::Settings => "Settings",
        }
    }

    pub fn icon(self) -> IconName {
        match self {
            AppView::Chat => IconName::BookOpen,
            AppView::Assistant => IconName::PanelBottom,
            AppView::Scheduled => IconName::Calendar,
            AppView::Usage => IconName::ChartPie,
            AppView::Subagents => IconName::Bot,
            AppView::Settings => IconName::Settings2,
        }
    }
}

/// Cycle the appearance mode forward (system → light → dark → system). Pure
/// so the palette's "Toggle appearance" command is unit-testable.
pub fn cycle_appearance_mode(mode: Mode) -> Mode {
    match mode {
        Mode::System => Mode::Light,
        Mode::Light => Mode::Dark,
        Mode::Dark => Mode::System,
    }
}

/// Map a palette settings destination id onto a settings section. `"usage"`
/// deliberately resolves to `None` — usage lives on its own panel.
pub fn settings_section_from_id(id: &str) -> Option<SettingsSection> {
    match id {
        "appearance" => Some(SettingsSection::Appearance),
        "providers" => Some(SettingsSection::Providers),
        "shortcuts" => Some(SettingsSection::Shortcuts),
        "mcp" => Some(SettingsSection::Mcp),
        "scheduled-tasks" => Some(SettingsSection::ScheduledTasks),
        "about" => Some(SettingsSection::About),
        _ => None,
    }
}

/// One configured provider as the palette renders it.
pub fn palette_provider(provider: &ConfiguredProvider) -> PaletteProvider {
    PaletteProvider {
        id: provider.id.clone(),
        label: provider.label.clone(),
        models: provider.models.clone(),
        needs_key: provider.needs_key,
        has_key: provider.has_key,
    }
}

/// The live data the command palette reads. The palette's `PaletteDataSource`
/// methods take no context, so the shell snapshots the chat service on every
/// palette open (see [`AppState::palette_source_snapshot`]).
#[derive(Debug, Clone, Default)]
pub(crate) struct PaletteSourceSnapshot {
    pub chats: Vec<aiden_core::ChatMeta>,
    pub providers: Vec<PaletteProvider>,
    pub selection: Option<(String, String)>,
    pub appearance: Option<Mode>,
}

/// `PaletteDataSource` over a [`PaletteSourceSnapshot`] (Send + Sync).
pub(crate) struct AppPaletteSource {
    snapshot: Arc<std::sync::Mutex<PaletteSourceSnapshot>>,
}

impl AppPaletteSource {
    pub fn new(snapshot: Arc<std::sync::Mutex<PaletteSourceSnapshot>>) -> Self {
        Self { snapshot }
    }
}

impl PaletteDataSource for AppPaletteSource {
    fn chats(&self) -> Vec<aiden_core::ChatMeta> {
        let guard = self.snapshot.lock();
        guard
            .map(|snapshot| snapshot.chats.clone())
            .unwrap_or_default()
    }

    fn providers(&self) -> Vec<PaletteProvider> {
        let guard = self.snapshot.lock();
        guard
            .map(|snapshot| snapshot.providers.clone())
            .unwrap_or_default()
    }

    fn selected(&self) -> Option<(String, String)> {
        let guard = self.snapshot.lock();
        guard.ok().and_then(|snapshot| snapshot.selection.clone())
    }

    fn appearance_mode(&self) -> Option<Mode> {
        let guard = self.snapshot.lock();
        guard.map(|snapshot| snapshot.appearance).unwrap_or(None)
    }
}

/// The pill window handle cache: re-invoking ⌘⇧D focuses the existing pill
/// instead of stacking windows.
static PILL_WINDOW: std::sync::Mutex<Option<gpui::WindowHandle<PillView>>> =
    std::sync::Mutex::new(None);

/// The wired dictation coordinator, reachable from the pill window's cancel
/// button and the bridge task (both constructed before `AppState` finishes).
static PILL_COORDINATOR: std::sync::OnceLock<Arc<PillCoordinator>> = std::sync::OnceLock::new();

// ===========================================================================
// Reduced motion (parity audit UI §7)
// ===========================================================================

/// Probe the macOS reduce-motion preference and cache it for the app
/// lifetime. Reads `defaults read com.apple.universalaccess reduceMotion`,
/// which prints `"1"` when Reduce Motion is enabled in System Settings →
/// Accessibility → Display. Any failure (key absent, `defaults` missing)
/// degrades to `false` — motion stays allowed — so a probe hiccup can never
/// disable animations behind the user's back.
pub(crate) fn system_reduced_motion() -> bool {
    static CACHED: std::sync::OnceLock<bool> = std::sync::OnceLock::new();
    *CACHED.get_or_init(|| {
        let probe = || {
            let output = std::process::Command::new("defaults")
                .args(["read", "com.apple.universalaccess", "reduceMotion"])
                .output()
                .ok()?;
            if !output.status.success() {
                return None;
            }
            Some(String::from_utf8_lossy(&output.stdout).contains('1'))
        };
        match probe() {
            Some(reduced) => {
                tracing::info!(reduced, "macOS reduce-motion preference");
                reduced
            }
            None => {
                tracing::debug!(
                    "macOS reduce-motion preference unavailable — defaulting to motion allowed"
                );
                false
            }
        }
    })
}

/// The effective reduced-motion decision for the main window: the persisted
/// `appearance.reduceMotion` override, or the OS probe when set to `System`.
/// This is the exact semantics of the pill's `MotionGate::allow` — kept as a
/// pure function here so the chat surface, the pill, and settings all agree.
pub(crate) fn motion_reduced(reduce_motion: ReduceMotion, system_reduced: bool) -> bool {
    match reduce_motion {
        ReduceMotion::On => true,
        ReduceMotion::Off => false,
        ReduceMotion::System => system_reduced,
    }
}

/// Window commands the dictation coordinator's injected deps send; the
/// foreground bridge task (spawned in [`AppState::new`]) performs them on the
/// GPUI main thread and replies.
enum PillCommand {
    /// Open (or focus) the pill window; reply `true` when newly created.
    Show {
        reply: tokio::sync::oneshot::Sender<bool>,
    },
    /// The coordinator hid the pill (GPUI has no hide API, so close it).
    Hide,
    /// App shutdown / coordinator dispose.
    Destroy,
    /// Forward a `dictation:state` payload into the pill view.
    Broadcast(aiden_core::dictation::DictationStatePayload),
}

/// The per-window root view.
pub struct AppState {
    pub(crate) service: Entity<ChatService>,
    /// The durable stores (Arc'd) for the lazily created panels + settings.
    pub(crate) stores: Stores,
    /// The active main content view (session-only, defaults to Chat).
    pub(crate) view: AppView,
    /// Multiline auto-growing composer input.
    pub(crate) composer_input: Entity<InputState>,
    /// Sidebar chat search input.
    pub(crate) search_input: Entity<InputState>,
    /// Model picker (created once; items sync with the provider catalog).
    pub(crate) model_select: Option<Entity<SelectState<Vec<ModelItem>>>>,
    model_select_dirty: bool,
    pub(crate) message_scroll: ScrollHandle,
    last_message_len: usize,
    last_catalog: Vec<String>,
    /// Last workspace id seen from the service (terminal cwd re-home on change).
    last_workspace_id: Option<String>,
    appearance_applied: bool,
    _subscriptions: Vec<Subscription>,

    /// The workspace context bar (chips + pickers) for the chat view.
    pub(crate) workspace_state: Entity<WorkspaceState>,

    // Lazily created surface entities (created on first navigation/toggle and
    // kept alive so their state — e.g. the terminal PTY — survives view
    // switches and drawer toggles).
    settings: Option<Entity<SettingsView>>,
    scheduled: Option<Entity<ScheduledPanel>>,
    usage: Option<Entity<UsagePanel>>,
    subagents: Option<Entity<SubagentsPanel>>,
    assistant: Option<Entity<AssistantPanel>>,
    terminal: Option<Entity<TerminalDrawer>>,
    palette: Option<Entity<CommandPalette>>,
    palette_source: Option<Arc<std::sync::Mutex<PaletteSourceSnapshot>>>,
    /// Whether the leading sidebar is shown (⌃⌘S / cmd-ctrl-s toggles it).
    sidebar_visible: bool,
}

impl AppState {
    pub fn new(stores: Stores, window: &mut Window, cx: &mut Context<Self>) -> Self {
        let service = cx.new(|cx| ChatService::new(stores.clone(), cx));
        service.update(cx, |service, cx| service.boot(cx));

        let composer_input = cx.new(|cx| {
            InputState::new(window, cx)
                .auto_grow(1, 8)
                .placeholder("Message Aiden…")
        });
        let search_input = cx.new(|cx| InputState::new(window, cx).placeholder("Search chats"));

        let mut this = Self {
            service,
            stores,
            view: AppView::default(),
            composer_input,
            search_input,
            model_select: None,
            model_select_dirty: true,
            message_scroll: ScrollHandle::new(),
            last_message_len: 0,
            last_catalog: Vec::new(),
            last_workspace_id: None,
            appearance_applied: false,
            _subscriptions: Vec::new(),
            workspace_state: cx.new(|cx| WorkspaceState::new(window, cx)),
            settings: None,
            scheduled: None,
            usage: None,
            subagents: None,
            assistant: None,
            terminal: None,
            palette: None,
            palette_source: None,
            sidebar_visible: true,
        };

        // Wire the dictation pill (coordinator + window bridge).
        wire_pill_coordinator(cx);

        // Start the scheduled-task runtime: a 30 s tick loop that evaluates
        // due tasks through the logging executor and records runs (real chat
        // execution lands with the scheduler-executor follow-up).
        {
            let scheduler = this.stores.scheduler.clone();
            gpui_tokio_bridge::Tokio::spawn(cx, async move {
                match scheduler.start().await {
                    Ok(()) => tracing::info!("scheduled-task runtime started"),
                    Err(error) => {
                        tracing::error!("scheduled-task runtime failed to start: {error}")
                    }
                }
            })
            .detach();
        }

        // Portable config watch: an external `~/.aiden/config.json` edit
        // (announced by the background poll thread) refreshes the provider
        // catalog. MCP servers are re-read per turn by the chat service and
        // reconnected when their fingerprint changed, so no extra work is
        // needed here beyond the provider refresh.
        {
            let mut config_changes = this.stores.subscribe_config_changes();
            cx.spawn(async move |this, cx| {
                while config_changes.changed().await.is_ok() {
                    let version = *config_changes.borrow();
                    if version == 0 {
                        // The initial channel value — not a real change.
                        continue;
                    }
                    let _ = this.update(cx, |this, cx| {
                        tracing::info!(
                            version,
                            "portable config externally changed — refreshing providers"
                        );
                        this.service
                            .update(cx, |service, cx| service.refresh_providers(cx));
                    });
                }
            })
            .detach();
        }

        // Composer: re-render on change; Enter (without shift) sends.
        this._subscriptions.push(cx.subscribe_in(
            &this.composer_input,
            window,
            |this, _source, event, window, cx| match event {
                InputEvent::Change => cx.notify(),
                InputEvent::PressEnter { secondary: false } => {
                    let text = this.composer_input.read(cx).value().to_string();
                    this.send_composer(&text, window, cx);
                }
                InputEvent::PressEnter { secondary: true }
                | InputEvent::Focus
                | InputEvent::Blur => {}
            },
        ));

        // Search: filter the sidebar list on change.
        this._subscriptions.push(cx.subscribe_in(
            &this.search_input,
            window,
            |this, _source, event, _window, cx| {
                if matches!(event, InputEvent::Change) {
                    let query = this.search_input.read(cx).value().to_string();
                    this.service.update(cx, |service, cx| {
                        service.set_search_query(&query, cx);
                    });
                }
            },
        ));

        // Model picker confirmations (the select is created lazily on first
        // render once the provider catalog has loaded).
        let model_select = this.model_select_entity(window, cx);
        this._subscriptions.push(cx.subscribe(
            &model_select,
            |this, _source, event: &SelectEvent<Vec<ModelItem>>, cx| {
                if let SelectEvent::Confirm(Some(key)) = event {
                    if let Some((provider_id, model)) = decode_model_key(key) {
                        this.service.update(cx, |service, cx| {
                            service.select_model(&provider_id, &model, cx);
                        });
                    }
                }
            },
        ));

        // Workspace bar events: route selections onto the chat service and
        // surface toasts (the workspace bar does its own git/editor work).
        this._subscriptions.push(cx.subscribe_in(
            &this.workspace_state,
            window,
            |this, _source, event: &WorkspaceEvent, window, cx| match event {
                WorkspaceEvent::SelectWorkspace { id } => {
                    this.service
                        .update(cx, |service, cx| service.select_workspace(id, cx));
                }
                WorkspaceEvent::AdoptFolder { folder } => {
                    this.service.update(cx, |service, cx| {
                        service.add_workspace_from_folder(folder, cx)
                    });
                }
                WorkspaceEvent::Notify { message, kind } => {
                    let notification = match kind {
                        NotificationKind::Info => {
                            gpui_component::notification::Notification::info(message.clone())
                        }
                        NotificationKind::Success => {
                            gpui_component::notification::Notification::success(message.clone())
                        }
                        NotificationKind::Warning => {
                            gpui_component::notification::Notification::warning(message.clone())
                        }
                        NotificationKind::Error => {
                            gpui_component::notification::Notification::error(message.clone())
                        }
                    };
                    window.push_notification(notification, cx);
                }
            },
        ));

        // Service changes: apply appearance once booted, sync the model picker
        // catalog, follow streaming output, and mirror workspace state.
        this._subscriptions
            .push(cx.observe(&this.service, |this, _service, cx| {
                this.sync_from_service(cx);
            }));

        // The chat view is the default view, so the workspace bar is visible
        // from startup (refresh + poll are gated on a folder being present).
        this.workspace_state.update(cx, |state, cx| {
            state.set_visible(true, cx);
        });

        this
    }

    /// Create (once) the model-picker select state. Needs a window, so it is
    /// called from `AppState::new` (which has one) and cached.
    fn model_select_entity(
        &mut self,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Entity<SelectState<Vec<ModelItem>>> {
        if let Some(state) = &self.model_select {
            return state.clone();
        }
        let providers = self.service.read(cx).providers.clone();
        let items = model_items(&providers);
        let selected = self
            .service
            .read(cx)
            .selection
            .as_ref()
            .and_then(|selection| {
                let key = model_key(&selection.provider_id, &selection.model);
                items
                    .iter()
                    .position(|item| item.value() == &key)
                    .map(|row| gpui_component::IndexPath::default().row(row))
            });
        let state = cx.new(|cx| SelectState::new(items, selected, window, cx));
        self.model_select = Some(state.clone());
        state
    }

    /// Central sync point driven by service notifications (no window access
    /// here — window-dependent work is deferred to render).
    fn sync_from_service(&mut self, cx: &mut Context<Self>) {
        let booted = self.service.read(cx).booted;
        if booted && !self.appearance_applied {
            self.appearance_applied = true;
            self.service
                .update(cx, |service, inner| service.apply_appearance(inner));
        }

        let service = self.service.read(cx);
        let catalog: Vec<String> = service
            .providers
            .iter()
            .map(|provider| {
                format!(
                    "{}:{}:{}",
                    provider.id,
                    provider.models.len(),
                    provider.has_key
                )
            })
            .collect();
        if catalog != self.last_catalog {
            self.last_catalog = catalog;
            self.model_select_dirty = true;
        }

        let message_len = service
            .active_chat
            .as_ref()
            .map_or(0, |chat| chat.messages.len());
        if message_len != self.last_message_len || service.generation_active() {
            self.last_message_len = message_len;
            self.message_scroll.scroll_to_bottom();
        }

        // Mirror the workspace list / active workspace into the bar (only a
        // folder change restarts the bar's git poll) and re-home an existing
        // terminal drawer when the workspace changes.
        let workspaces = service.workspaces.clone();
        let active_id = service
            .workspace
            .as_ref()
            .map(|workspace| workspace.id.clone());
        let folder = service.workspace_folder();
        let workspace_changed = active_id != self.last_workspace_id;
        if workspace_changed {
            self.last_workspace_id = active_id.clone();
        }
        if workspace_changed {
            if let Some(terminal) = &self.terminal {
                let cwd = folder.clone().unwrap_or_else(aiden_data::home_dir);
                terminal.update(cx, |terminal, cx| terminal.set_cwd(cwd, cx));
            }
        }
        self.workspace_state.update(cx, |state, cx| {
            state.set_mirror(workspaces, active_id, folder, cx);
        });
    }

    /// Apply the model-picker catalog + selection; called from render with
    /// window access, deferred until the current update completes.
    fn sync_model_select(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if !self.model_select_dirty {
            return;
        }
        self.model_select_dirty = false;
        let Some(select) = self.model_select.clone() else {
            return;
        };
        let providers = self.service.read(cx).providers.clone();
        let selection_key = self
            .service
            .read(cx)
            .selection
            .as_ref()
            .map(|selection| model_key(&selection.provider_id, &selection.model));
        let items = model_items(&providers);
        cx.defer_in(window, move |_this, window, cx| {
            select.update(cx, |state, cx| state.set_items(items, window, cx));
            if let Some(key) = selection_key {
                select.update(cx, |state, cx| state.set_selected_value(&key, window, cx));
            }
        });
    }

    /// Send the composer contents (Enter or the send button).
    pub fn send_composer(&mut self, text: &str, window: &mut Window, cx: &mut Context<Self>) {
        let text = text.trim().to_string();
        if text.is_empty() {
            return;
        }
        // Don't clear the input or attempt to send while a generation is
        // active — send_message_with would silently reject it and the user's
        // typed text would vanish. The Send button already becomes Stop.
        let is_active = self.service.read(cx).generation_active();
        if is_active {
            return;
        }

        self.composer_input
            .update(cx, |input, inner| input.set_value("", window, inner));

        // Read staged attachments + edit target from the global draft.
        let (attachments, editing_message_id) = {
            let draft = cx.default_global::<crate::chat::composer::ComposerDraft>();
            let atts = draft.attachments.clone();
            let edit = draft.editing_message_id.take();
            (atts, edit)
        };

        self.service.update(cx, |service, cx| {
            service.send_message_with(&text, attachments, editing_message_id, cx)
        });
    }

    fn on_new_chat(&mut self, _: &NewChat, _: &mut Window, cx: &mut Context<Self>) {
        self.set_view(AppView::Chat, cx);
        self.service.update(cx, |service, cx| service.new_chat(cx));
    }

    fn on_quit(&mut self, _: &Quit, _: &mut Window, cx: &mut Context<Self>) {
        self.request_quit(cx);
    }

    /// The quit barrier: warn + cancel when a generation is in flight, stop
    /// the background services that spawn tokio work, mark the barrier ready,
    /// and quit. Full dialog UX lands later — for now a warning log plus
    /// clean cancellation so no tokio stream task leaks past shutdown.
    fn request_quit(&mut self, cx: &mut Context<Self>) {
        let barrier = self.stores.quit_barrier.clone();
        if self.service.read(cx).generation_active() {
            tracing::warn!(
                "Quit requested with an in-flight generation — cancelling the stream before shutdown."
            );
            // Aborts the provider stream: sets the driver's cancel flag and
            // settles the partial bubble so the watcher/driver tasks end
            // instead of running to completion into a dead channel.
            self.service
                .update(cx, |service, cx| service.stop_generation(cx));
        }
        // Stop the scheduler tick loop (aborts the tick task, requests
        // cancellation of any live runs) so no background tokio task
        // outlives the app.
        self.stores.scheduler.stop();
        // Barrier bookkeeping: the renderer can no longer veto, and the quit
        // is forced through any lingering generation gate.
        barrier.note_renderer_closed();
        barrier.force();
        cx.quit();
    }

    // =======================================================================
    // Keyboard shortcuts (parity audit UI §2: catalog parity → wiring parity)
    // =======================================================================

    /// ⌘,: open Settings (providers section is the landing spot).
    fn on_open_settings(&mut self, _: &OpenSettings, window: &mut Window, cx: &mut Context<Self>) {
        self.open_settings_section(window, cx);
    }

    /// ⌘⇧F: focus the sidebar chat search.
    fn on_search_chats(&mut self, _: &SearchChats, window: &mut Window, cx: &mut Context<Self>) {
        self.set_view(AppView::Chat, cx);
        self.search_input
            .update(cx, |input, cx| input.focus(window, cx));
    }

    /// ⌘⇧[ / ⌘⇧]: previous/next chat in the sidebar order.
    fn on_previous_chat(&mut self, _: &PreviousChat, _: &mut Window, cx: &mut Context<Self>) {
        self.cycle_chat(false, cx);
    }

    fn on_next_chat(&mut self, _: &NextChat, _: &mut Window, cx: &mut Context<Self>) {
        self.cycle_chat(true, cx);
    }

    /// ⌘1..⌘9: jump to the Nth chat in the (search-filtered) sidebar list.
    fn jump_to_chat(&mut self, index: usize, cx: &mut Context<Self>) {
        let ids: Vec<String> = self
            .service
            .read(cx)
            .filtered_chats()
            .iter()
            .map(|meta| meta.id.clone())
            .collect();
        let Some(id) = ids.get(index).cloned() else {
            tracing::debug!(index, count = ids.len(), "chat jump out of range");
            return;
        };
        self.set_view(AppView::Chat, cx);
        self.service
            .update(cx, |service, cx| service.select_chat(&id, cx));
    }

    fn on_chat_jump_1(&mut self, _: &ChatJump1, _: &mut Window, cx: &mut Context<Self>) {
        self.jump_to_chat(0, cx);
    }

    fn on_chat_jump_2(&mut self, _: &ChatJump2, _: &mut Window, cx: &mut Context<Self>) {
        self.jump_to_chat(1, cx);
    }

    fn on_chat_jump_3(&mut self, _: &ChatJump3, _: &mut Window, cx: &mut Context<Self>) {
        self.jump_to_chat(2, cx);
    }

    fn on_chat_jump_4(&mut self, _: &ChatJump4, _: &mut Window, cx: &mut Context<Self>) {
        self.jump_to_chat(3, cx);
    }

    fn on_chat_jump_5(&mut self, _: &ChatJump5, _: &mut Window, cx: &mut Context<Self>) {
        self.jump_to_chat(4, cx);
    }

    fn on_chat_jump_6(&mut self, _: &ChatJump6, _: &mut Window, cx: &mut Context<Self>) {
        self.jump_to_chat(5, cx);
    }

    fn on_chat_jump_7(&mut self, _: &ChatJump7, _: &mut Window, cx: &mut Context<Self>) {
        self.jump_to_chat(6, cx);
    }

    fn on_chat_jump_8(&mut self, _: &ChatJump8, _: &mut Window, cx: &mut Context<Self>) {
        self.jump_to_chat(7, cx);
    }

    fn on_chat_jump_9(&mut self, _: &ChatJump9, _: &mut Window, cx: &mut Context<Self>) {
        self.jump_to_chat(8, cx);
    }

    /// ⌘O: open the macOS workspace-folder picker.
    fn on_open_workspace_folder(
        &mut self,
        _: &OpenWorkspaceFolder,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.workspace_state
            .update(cx, |state, cx| state.choose_folder(window, cx));
    }

    /// ⌘⇧E: open the "open in editor" overlay for the active workspace.
    fn on_open_in_editor(&mut self, _: &OpenInEditor, window: &mut Window, cx: &mut Context<Self>) {
        self.set_view(AppView::Chat, cx);
        self.workspace_state.update(cx, |state, cx| {
            state.open_overlay(Overlay::Editors, window, cx);
        });
    }

    /// ⌘W: close the window. A single-window app has nothing to fall back to,
    /// so this is a full quit (same barrier path as ⌘Q) — no windowless
    /// process lingers in the dock.
    fn on_close_window(&mut self, _: &CloseWindow, _: &mut Window, cx: &mut Context<Self>) {
        self.request_quit(cx);
    }

    /// ⌃⌘S (cmd-ctrl-s): show/hide the sidebar.
    fn on_toggle_sidebar(&mut self, _: &ToggleSidebar, _: &mut Window, cx: &mut Context<Self>) {
        self.sidebar_visible = !self.sidebar_visible;
        cx.notify();
    }

    /// Toggle a panel view: opening it again (or ⌘⇧A/S/U from another view)
    /// returns to the chat view.
    fn toggle_view(&mut self, target: AppView, cx: &mut Context<Self>) {
        if self.view == target {
            self.set_view(AppView::Chat, cx);
        } else {
            self.set_view(target, cx);
        }
    }

    /// ⌘⇧A: toggle the Assistant panel.
    fn on_toggle_assistant(&mut self, _: &ToggleAssistant, _: &mut Window, cx: &mut Context<Self>) {
        self.toggle_view(AppView::Assistant, cx);
    }

    /// ⌘⇧S: toggle the Subagents panel.
    fn on_toggle_subagents(&mut self, _: &ToggleSubagents, _: &mut Window, cx: &mut Context<Self>) {
        self.toggle_view(AppView::Subagents, cx);
    }

    /// ⌘⇧U: toggle the Usage panel.
    fn on_toggle_usage(&mut self, _: &ToggleUsage, _: &mut Window, cx: &mut Context<Self>) {
        self.toggle_view(AppView::Usage, cx);
    }

    /// ⌥⌘Space: focus the composer (the TS global `composer.focus`, bound
    /// in-app until the OS-global hotkey wiring lands).
    fn on_focus_composer(
        &mut self,
        _: &FocusComposer,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.set_view(AppView::Chat, cx);
        self.composer_input
            .update(cx, |input, cx| input.focus(window, cx));
    }

    /// ⌘↩: send the composer contents from anywhere (plain Enter already
    /// sends while the composer is focused).
    fn on_send_message(&mut self, _: &SendMessage, window: &mut Window, cx: &mut Context<Self>) {
        let text = self.composer_input.read(cx).value().to_string();
        self.send_composer(&text, window, cx);
    }

    /// ⌘S: no file editor is wired in the GPUI port yet — accept the shortcut
    /// so the settings catalog stays honest (parity audit UI §2).
    fn on_save_file(&mut self, _: &SaveFile, _: &mut Window, _cx: &mut Context<Self>) {
        tracing::debug!("file.save: no file editor is wired yet");
    }

    // =======================================================================
    // View routing
    // =======================================================================

    /// Route the main content area (session-only; never persisted).
    pub(crate) fn set_view(&mut self, view: AppView, cx: &mut Context<Self>) {
        if self.view != view {
            self.view = view;
            cx.notify();
        }
        // The workspace bar (and its git poll) lives in the chat view; refresh
        // it whenever that view is (re)focused.
        if view == AppView::Chat {
            self.workspace_state.update(cx, |state, cx| {
                state.on_view_focused(cx);
            });
        } else {
            self.workspace_state.update(cx, |state, cx| {
                state.set_visible(false, cx);
            });
        }
    }

    /// Route to Settings and select the Providers section (the shell's
    /// default settings landing spot).
    pub(crate) fn open_settings_section(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.set_view(AppView::Settings, cx);
        let settings = self.settings_entity(window, cx);
        settings.update(cx, |settings, cx| {
            settings.select_section(SettingsSection::Providers, cx);
        });
    }

    // =======================================================================
    // Command palette (⌘K)
    // =======================================================================

    fn on_toggle_palette(
        &mut self,
        _: &TogglePalette,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.ensure_palette(window, cx);
        self.refresh_palette_source(cx);
        if let Some(palette) = &self.palette {
            palette.update(cx, |palette, cx| palette.toggle(window, cx));
        }
    }

    /// The live snapshot for the palette (chats, providers, selection,
    /// appearance) read from the chat service.
    fn palette_source_snapshot(&self, cx: &mut Context<Self>) -> PaletteSourceSnapshot {
        let service = self.service.read(cx);
        PaletteSourceSnapshot {
            chats: service.chat_list.clone(),
            providers: service.providers.iter().map(palette_provider).collect(),
            selection: service
                .selection
                .as_ref()
                .map(|selection| (selection.provider_id.clone(), selection.model.clone())),
            appearance: Some(service.appearance.mode),
        }
    }

    fn refresh_palette_source(&self, cx: &mut Context<Self>) {
        if let Some(source) = &self.palette_source {
            if let Ok(mut guard) = source.lock() {
                *guard = self.palette_source_snapshot(cx);
            }
        }
    }

    /// Create the palette once (the recency store persists to `settings.json`
    /// through the config store).
    fn ensure_palette(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.palette.is_some() {
            return;
        }
        let snapshot = Arc::new(std::sync::Mutex::new(self.palette_source_snapshot(cx)));
        let data: Arc<dyn PaletteDataSource> = Arc::new(AppPaletteSource::new(snapshot.clone()));
        let recent: Arc<dyn RecentCommandsStore> =
            Arc::new(SettingsRecentStore::new(self.stores.config.clone()));
        let entity = cx.new(|cx| CommandPalette::new(cx, CommandPaletteDeps::new(data, recent)));
        self._subscriptions.push(cx.subscribe_in(
            &entity,
            window,
            |this, _source, event, window, cx| {
                this.on_palette_command(event.clone(), window, cx);
            },
        ));
        self.palette = Some(entity);
        self.palette_source = Some(snapshot);
    }

    /// Dismiss the palette overlay (used for commands that do not close it
    /// themselves, e.g. RefreshProviders).
    fn close_palette(&self, window: &mut Window, cx: &mut Context<Self>) {
        if let Some(palette) = &self.palette {
            palette.update(cx, |palette, cx| palette.close_state(cx));
            window.close_dialog(cx);
        }
    }

    /// Route one palette command onto the shell services.
    fn on_palette_command(
        &mut self,
        command: PaletteCommand,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        match command {
            PaletteCommand::NewChat => {
                self.set_view(AppView::Chat, cx);
                self.service.update(cx, |service, cx| service.new_chat(cx));
            }
            PaletteCommand::SelectChat(id) => {
                self.set_view(AppView::Chat, cx);
                self.service
                    .update(cx, |service, cx| service.select_chat(&id, cx));
            }
            PaletteCommand::SelectModel { provider_id, model } => {
                self.set_view(AppView::Chat, cx);
                self.service.update(cx, |service, cx| {
                    service.select_model(&provider_id, &model, cx);
                });
            }
            PaletteCommand::OpenSettings => self.open_settings_section(window, cx),
            PaletteCommand::OpenSettingsSection(id) => {
                if let Some(section) = settings_section_from_id(&id) {
                    self.set_view(AppView::Settings, cx);
                    let settings = self.settings_entity(window, cx);
                    settings.update(cx, |settings, cx| {
                        settings.select_section(section, cx);
                    });
                } else if id == "usage" {
                    self.set_view(AppView::Usage, cx);
                }
            }
            PaletteCommand::SetAppearanceMode(mode) => {
                self.service
                    .update(cx, |service, cx| service.set_appearance_mode(mode, cx));
            }
            PaletteCommand::ToggleTheme => {
                let mode = self.service.read(cx).appearance.mode;
                self.service.update(cx, |service, cx| {
                    service.set_appearance_mode(cycle_appearance_mode(mode), cx);
                });
            }
            PaletteCommand::OpenScheduled => self.set_view(AppView::Scheduled, cx),
            PaletteCommand::OpenUsage => self.set_view(AppView::Usage, cx),
            PaletteCommand::OpenSubagents => self.set_view(AppView::Subagents, cx),
            PaletteCommand::OpenAssistant => self.set_view(AppView::Assistant, cx),
            PaletteCommand::Quit => cx.quit(),
            PaletteCommand::ToggleTerminal => self.toggle_terminal(window, cx),
            PaletteCommand::FocusComposer => {
                self.composer_input
                    .update(cx, |input, cx| input.focus(window, cx));
            }
            PaletteCommand::NextChat | PaletteCommand::PreviousChat => {
                let forward = matches!(command, PaletteCommand::NextChat);
                self.cycle_chat(forward, cx);
            }
            PaletteCommand::RefreshProviders => {
                self.service
                    .update(cx, |service, cx| service.refresh_providers(cx));
                self.close_palette(window, cx);
            }
            PaletteCommand::ToggleSidebar
            | PaletteCommand::ToggleEnvironment
            | PaletteCommand::OpenWorkspaceEditor
            | PaletteCommand::SearchChats
            | PaletteCommand::ChangeModel
            | PaletteCommand::ManageProviders
            | PaletteCommand::SearchSettings => {
                // These surface commands map onto real services when their
                // target surfaces (sidebar collapse, env panel, editor
                // launching) land; keep them accepted so the palette never
                // drops a selection silently.
                tracing::debug!(?command, "palette command has no wired service yet");
            }
        }
    }

    /// Move to the previous/next chat in the sidebar order (palette arrows).
    fn cycle_chat(&mut self, forward: bool, cx: &mut Context<Self>) {
        let ids: Vec<String> = self
            .service
            .read(cx)
            .filtered_chats()
            .iter()
            .map(|meta| meta.id.clone())
            .collect();
        if ids.is_empty() {
            return;
        }
        let step: i64 = if forward { 1 } else { -1 };
        let current = self.service.read(cx).active_chat_id.clone();
        let index = current
            .as_ref()
            .and_then(|id| ids.iter().position(|candidate| candidate == id))
            .unwrap_or(0);
        let next = ((index as i64 + step).rem_euclid(ids.len() as i64)) as usize;
        self.set_view(AppView::Chat, cx);
        self.service
            .update(cx, |service, cx| service.select_chat(&ids[next], cx));
    }

    // =======================================================================
    // Terminal drawer (⌘J, chat view only)
    // =======================================================================

    fn on_toggle_terminal(
        &mut self,
        _: &ToggleTerminal,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.toggle_terminal(window, cx);
    }

    fn toggle_terminal(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        // The drawer only renders inside the chat view (see `chat_view`).
        // Toggling it from another view would silently flip its open state
        // with no visible feedback, and the drawer would pop open (with its
        // live PTY) the next time the user returns to Chat.
        if self.view != AppView::Chat {
            return;
        }
        let entity = self.terminal_entity(window, cx);
        entity.update(cx, |terminal, cx| terminal.toggle(window, cx));
    }

    /// Create the terminal drawer once; the PTY stays alive across toggles
    /// (the drawer hides/shows, it is never destroyed).
    fn terminal_entity(
        &mut self,
        _window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Entity<TerminalDrawer> {
        if let Some(entity) = &self.terminal {
            return entity.clone();
        }
        let deps = TerminalDeps {
            shell: None,
            // The terminal starts in the active workspace folder (the git repo
            // root); a later workspace switch re-homes it via `set_cwd`.
            cwd: self
                .service
                .read(cx)
                .workspace_folder()
                .or_else(|| Some(aiden_data::home_dir())),
            simple: false,
        };
        let entity = cx.new(|cx| TerminalDrawer::new(cx, deps));
        self.terminal = Some(entity.clone());
        entity
    }

    // =======================================================================
    // Lazy panel entities (created on first navigation)
    // =======================================================================

    fn settings_entity(
        &mut self,
        _window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Entity<SettingsView> {
        if let Some(entity) = &self.settings {
            return entity.clone();
        }
        let services = SettingsServices::from_stores(&self.stores);
        let entity = cx.new(|cx| SettingsView::new(cx, services));
        self.settings = Some(entity.clone());
        entity
    }

    fn scheduled_entity(
        &mut self,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Entity<ScheduledPanel> {
        if let Some(entity) = &self.scheduled {
            return entity.clone();
        }
        let source: Arc<dyn ScheduledTaskSource> =
            Arc::new(StoreScheduledSource::new(self.stores.schedules.clone()));
        let entity = cx.new(|cx| ScheduledPanel::new(cx, ScheduledPanelDeps::new(source)));
        let panel = entity.clone();
        self._subscriptions.push(cx.subscribe_in(
            &entity,
            window,
            move |this, _source, event, window, cx| match event {
                ScheduledPanelEvent::Refresh => {}
                ScheduledPanelEvent::ToggleEnabled { id, enabled } => {
                    this.toggle_scheduled_task(panel.clone(), id, *enabled, cx);
                }
                ScheduledPanelEvent::RunNow { .. } => {
                    // There is no scheduler runtime in the shell yet; the
                    // panel lists and toggles tasks, execution lands later.
                    window.push_notification(
                        "Scheduled task execution lands with the scheduler runtime.",
                        cx,
                    );
                }
            },
        ));
        self.scheduled = Some(entity.clone());
        entity
    }

    /// Persist an enable/disable toggle through the shared schedule store,
    /// then reload the panel.
    fn toggle_scheduled_task(
        &mut self,
        panel: Entity<ScheduledPanel>,
        id: &str,
        enabled: bool,
        cx: &mut Context<Self>,
    ) {
        let schedules = self.stores.schedules.clone();
        let id = id.to_string();
        cx.spawn(async move |_this, cx| {
            cx.background_spawn(async move {
                let _ = schedules.set_enabled(&id, enabled);
            })
            .await;
            let _ = panel.update(cx, |panel, cx| panel.refresh(cx));
        })
        .detach();
    }

    fn usage_entity(&mut self, _window: &mut Window, cx: &mut Context<Self>) -> Entity<UsagePanel> {
        if let Some(entity) = &self.usage {
            return entity.clone();
        }
        let source: Arc<dyn UsageDataSource> =
            Arc::new(StoreUsageSource::new(self.stores.usage.clone()));
        let entity = cx.new(|cx| UsagePanel::new(cx, UsagePanelDeps::new(source)));
        self.usage = Some(entity.clone());
        entity
    }

    fn subagents_entity(
        &mut self,
        _window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Entity<SubagentsPanel> {
        if let Some(entity) = &self.subagents {
            return entity.clone();
        }
        // No live subagent runtime yet: the roster renders from an empty
        // in-memory source (the empty state) until the run registry lands.
        let source: Arc<dyn SubagentRunSource> = Arc::new(MemoryRunSource::default());
        let entity = cx.new(|cx| SubagentsPanel::new(cx, SubagentsPanelDeps::new(source)));
        self.subagents = Some(entity.clone());
        entity
    }

    /// The proactive-assistant panel: created once on first navigation (its
    /// MCP inventory and recent automations are collected on open) and kept
    /// alive so a pending thread + approval queue survive view switches.
    fn assistant_entity(
        &mut self,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Entity<AssistantPanel> {
        if let Some(entity) = &self.assistant {
            return entity.clone();
        }
        let entity = cx.new(|cx| {
            AssistantPanel::new(window, cx, AssistantPanelDeps::new(self.stores.clone()))
        });
        self._subscriptions.push(cx.subscribe_in(
            &entity,
            window,
            |_this, _source, _event: &AssistantPanelEvent, _window, _cx| {},
        ));
        self.assistant = Some(entity.clone());
        entity
    }

    // =======================================================================
    // Dictation pill (⌘⇧D)
    // =======================================================================

    fn on_toggle_pill(&mut self, _: &TogglePill, _window: &mut Window, cx: &mut Context<Self>) {
        if let Some(pill) = PILL_COORDINATOR.get().cloned() {
            cx.spawn(async move |_this, _cx| {
                pill.toggle().await;
            })
            .detach();
        } else {
            tracing::warn!("dictation pill toggle: coordinator is not wired");
        }
    }
}

/// Open (or focus) the pill window on the foreground; `true` when a new
/// window was created. Also stores the window handle in [`PILL_WINDOW`] so
/// later broadcasts can reach the view.
fn bridge_show_pill(
    cx: &mut gpui::AsyncApp,
    audio: &Arc<LiveAudioSource>,
    appearance: &aiden_core::appearance::AppearanceConfig,
) -> bool {
    let on_cancel: Arc<dyn Fn() + Send + Sync> = Arc::new(|| {
        if let Some(pill) = PILL_COORDINATOR.get() {
            pill.request_cancel();
        }
    });
    let mut guard = match PILL_WINDOW.lock() {
        Ok(guard) => guard,
        Err(poisoned) => poisoned.into_inner(),
    };
    if let Some(handle) = guard.as_ref() {
        let activate =
            cx.update(|app| handle.update(app, |_view, window, _cx| window.activate_window()));
        if matches!(activate, Ok(Ok(()))) {
            return false;
        }
        // The cached handle is stale (window closed via Escape); replace it.
        *guard = None;
    }
    let deps = PillDeps {
        audio: Rc::new(RefCell::new(audio.clone())),
        appearance: appearance.clone(),
        // Real OS probe (cached for the app lifetime) instead of the previous
        // hardcoded `false` — parity audit UI §7.
        system_reduced_motion: system_reduced_motion(),
        on_cancel: Some(on_cancel),
    };
    match cx.update(|app| open_pill_window(app, deps)) {
        Ok(Ok(handle)) => {
            *guard = Some(handle);
            true
        }
        _ => false,
    }
}

/// Close the pill window (GPUI has no hide API; the pill is re-created on the
/// next toggle, matching the Escape-close model).
fn bridge_close_pill(cx: &mut gpui::AsyncApp) {
    let _ = cx.update(|app| {
        let handle = match PILL_WINDOW.lock() {
            Ok(mut guard) => guard.take(),
            Err(poisoned) => poisoned.into_inner().take(),
        };
        if let Some(handle) = handle {
            let _ = handle.update(app, |_view, window, _cx| window.remove_window());
        }
    });
}

/// Forward a `dictation:state` payload into the pill view.
fn bridge_broadcast(
    cx: &mut gpui::AsyncApp,
    payload: &aiden_core::dictation::DictationStatePayload,
) {
    let _ = cx.update(|app| {
        let handle = match PILL_WINDOW.lock() {
            Ok(guard) => *guard,
            Err(poisoned) => *poisoned.into_inner(),
        };
        if let Some(handle) = handle {
            let _ = handle.update(app, |view, _window, cx| {
                view.push_dictation(payload, cx);
            });
        }
    });
}

/// Wire the dictation pill: spawn the foreground window-command bridge and
/// construct the coordinator over it. Runs once from [`AppState::new`].
fn wire_pill_coordinator(cx: &mut Context<AppState>) {
    let (command_tx, mut command_rx) = tokio::sync::mpsc::unbounded_channel::<PillCommand>();
    let audio = Arc::new(LiveAudioSource::new());

    // Foreground task performing window ops (windows can only be touched on
    // the main thread). The appearance is read from the live chat service at
    // open time (the pill paints it immediately).
    let bridge_audio = audio.clone();
    cx.spawn(async move |this, cx| {
        while let Some(command) = command_rx.recv().await {
            match command {
                PillCommand::Show { reply } => {
                    let appearance = this
                        .upgrade()
                        .and_then(|entity| {
                            cx.read_entity(&entity, |state, app| {
                                state.service.read(app).appearance.clone()
                            })
                            .ok()
                        })
                        .unwrap_or_else(aiden_core::appearance::create_default_appearance_config);
                    let created = bridge_show_pill(cx, &bridge_audio, &appearance);
                    let _ = reply.send(created);
                }
                PillCommand::Hide => bridge_close_pill(cx),
                PillCommand::Destroy => bridge_close_pill(cx),
                PillCommand::Broadcast(payload) => bridge_broadcast(cx, &payload),
            }
        }
    })
    .detach();

    let show_pill_command = command_tx.clone();
    let hide_pill_command = command_tx.clone();
    let destroy_pill_command = command_tx.clone();
    let broadcast_command = command_tx.clone();
    let (pill, watcher) = PillCoordinator::new(PillCoordinatorDeps {
        show_pill: Box::new(move || {
            let command = show_pill_command.clone();
            async move {
                let (reply, reply_rx) = tokio::sync::oneshot::channel();
                if command.send(PillCommand::Show { reply }).is_err() {
                    return Err("the pill bridge is shut down".into());
                }
                Ok(reply_rx.await.unwrap_or(false))
            }
            .boxed()
        }),
        hide_pill: Box::new(move || {
            let _ = hide_pill_command.send(PillCommand::Hide);
        }),
        destroy_pill: Box::new(move || {
            let _ = destroy_pill_command.send(PillCommand::Destroy);
        }),
        forward: Box::new(move |payload| {
            let _ = broadcast_command.send(PillCommand::Broadcast(payload));
        }),
        paste: Some(Arc::new(aiden_mac::paste::MacPasteDeps)),
        log_error: Box::new(|message, error| {
            tracing::error!("dictation: {message}: {error}");
        }),
        model_id: "parakeet-v3".to_string(),
        audio,
        transcribe: None,
    });
    // Spawn the pill watcher on the tokio bridge (NOT tokio::spawn directly —
    // we're on a GPUI thread without a tokio runtime guard).
    gpui_tokio_bridge::Tokio::spawn(cx, watcher).detach();
    let _ = PILL_COORDINATOR.set(pill);
}

// ===========================================================================
// Global dictation hotkey (parity audit config §12)
// ===========================================================================

/// The OS-global dictation accelerator. This is the catalog default for
/// `dictation.toggle` (`renderer/shared/keybindings.ts:77` and
/// `aiden-core::keybindings::CommandId::DictationToggle` both use
/// "Command+Shift+D"). The in-app `cmd-shift-d` binding stays as the
/// fallback for builds/apps without the global registration.
#[cfg(target_os = "macos")]
const DICTATION_GLOBAL_ACCELERATOR: &str = "Command+Shift+D";

/// Register the dictation pill toggle as a REAL OS-global hotkey, so ⌘⇧D
/// starts/stops dictation while another app is focused — the TS
/// `globalShortcut.register` equivalent (parity audit config §12). Called
/// once from `main.rs` boot after the stores open.
///
/// Accessibility permission: registering a global hotkey requires the macOS
/// Accessibility permission for this process. When it is missing the OS
/// either refuses the registration or `GlobalHotkeyManager::initialize`
/// fails — in both cases we log a warning, register nothing, and the in-app
/// binding remains the only toggle path.
///
/// The `MacHotkeyPort` (which owns the `global-hotkey` manager and thus the
/// live OS claim) is moved into the app-lifetime listener task; the claim is
/// released when the tokio bridge runtime tears down at process exit.
#[cfg(target_os = "macos")]
pub(crate) fn register_global_dictation_hotkey(cx: &mut App) -> bool {
    let manager = match GlobalHotkeyManager::initialize() {
        Ok(manager) => manager,
        Err(error) => {
            tracing::warn!(
                "global dictation hotkey unavailable ({error}); falling back to in-app ⌘⇧D"
            );
            return false;
        }
    };
    let port = MacHotkeyPort::new(manager);
    if !port.register(DICTATION_GLOBAL_ACCELERATOR) {
        tracing::warn!(
            "could not register the global dictation hotkey {DICTATION_GLOBAL_ACCELERATOR} \
             (Accessibility permission missing?); falling back to in-app ⌘⇧D"
        );
        return false;
    }
    let expected_id = DICTATION_GLOBAL_ACCELERATOR
        .parse::<global_hotkey::hotkey::HotKey>()
        .map(|hotkey| hotkey.id())
        .ok();
    // Route OS-level presses onto the pill coordinator. The listener runs on
    // the tokio bridge so `PillCoordinator::toggle` (a tokio state machine)
    // can be awaited directly; the blocking channel poll is moved off the
    // tokio workers via `spawn_blocking`. `Tokio::spawn` needs an entity
    // context to bridge the future back onto the GPUI executor, so a
    // throwaway scaffold entity provides it (dropped immediately; the tokio
    // task — and the `MacHotkeyPort` inside it — outlives the scaffold).
    let scaffold = cx.new(|_| ());
    cx.update_entity(&scaffold, |_, inner| {
        gpui_tokio_bridge::Tokio::spawn(inner, dictation_hotkey_listener(expected_id, port))
            .detach();
    });
    tracing::info!(
        accelerator = DICTATION_GLOBAL_ACCELERATOR,
        "registered the global dictation hotkey"
    );
    true
}

/// Non-macOS builds have no OS-global hotkey surface; the in-app binding is
/// the only toggle path. Compile-time no-op so `main.rs` stays
/// platform-agnostic.
#[cfg(not(target_os = "macos"))]
pub(crate) fn register_global_dictation_hotkey(_cx: &mut App) -> bool {
    false
}

/// Poll the `global-hotkey` event channel for the dictation accelerator and
/// toggle the pill coordinator on each press. Keeps `port` alive for the app
/// lifetime — dropping the listener (at process exit) unregisters the hotkey.
#[cfg(target_os = "macos")]
async fn dictation_hotkey_listener(expected_id: Option<u32>, port: MacHotkeyPort) {
    let _port = port; // the OS claim lives exactly as long as this task
    loop {
        let event = tokio::task::spawn_blocking({
            || GlobalHotKeyEvent::receiver().recv_timeout(std::time::Duration::from_millis(250))
        })
        .await;
        match event {
            Ok(Ok(hotkey_event)) => {
                if hotkey_event.state == HotKeyState::Pressed
                    && expected_id.is_none_or(|id| id == hotkey_event.id)
                {
                    toggle_dictation_from_global_hotkey().await;
                }
            }
            // Channel poll timeout — nothing pressed, keep waiting.
            Ok(Err(_)) => {}
            // The blocking poll task ended (runtime shutdown) — stop.
            Err(_) => break,
        }
    }
}

/// Toggle dictation from the OS-global hotkey — the exact same path as the
/// in-app ⌘⇧D binding. The coordinator is only wired after the main window
/// opens (`AppState::new`), so earlier presses are ignored with a debug log.
#[cfg(target_os = "macos")]
async fn toggle_dictation_from_global_hotkey() {
    match PILL_COORDINATOR.get() {
        Some(pill) => pill.toggle().await,
        None => {
            tracing::debug!(
                "global dictation hotkey pressed before the pill coordinator was wired"
            );
        }
    }
}

impl Render for AppState {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        self.sync_model_select(window, cx);
        let theme = cx.theme();

        // Title bar: traffic lights are OS-provided; the bar shows the chat
        // title (or the workspace name when no chat is open).
        let title: String = self
            .service
            .read(cx)
            .active_chat
            .as_ref()
            .map(|chat| chat.title.clone())
            .unwrap_or_else(|| {
                if aiden_data::is_dev_mode() {
                    "Aiden-RS-DEV".to_string()
                } else {
                    "Aiden".to_string()
                }
            });

        v_flex()
            .id("aiden-root")
            .size_full()
            .bg(theme.background)
            .text_color(theme.foreground)
            .key_context("App")
            .on_action(cx.listener(Self::on_new_chat))
            .on_action(cx.listener(Self::on_quit))
            .on_action(cx.listener(Self::on_toggle_palette))
            .on_action(cx.listener(Self::on_toggle_terminal))
            .on_action(cx.listener(Self::on_toggle_pill))
            .on_action(cx.listener(Self::on_open_settings))
            .on_action(cx.listener(Self::on_search_chats))
            .on_action(cx.listener(Self::on_previous_chat))
            .on_action(cx.listener(Self::on_next_chat))
            .on_action(cx.listener(Self::on_chat_jump_1))
            .on_action(cx.listener(Self::on_chat_jump_2))
            .on_action(cx.listener(Self::on_chat_jump_3))
            .on_action(cx.listener(Self::on_chat_jump_4))
            .on_action(cx.listener(Self::on_chat_jump_5))
            .on_action(cx.listener(Self::on_chat_jump_6))
            .on_action(cx.listener(Self::on_chat_jump_7))
            .on_action(cx.listener(Self::on_chat_jump_8))
            .on_action(cx.listener(Self::on_chat_jump_9))
            .on_action(cx.listener(Self::on_open_workspace_folder))
            .on_action(cx.listener(Self::on_open_in_editor))
            .on_action(cx.listener(Self::on_close_window))
            .on_action(cx.listener(Self::on_toggle_sidebar))
            .on_action(cx.listener(Self::on_toggle_assistant))
            .on_action(cx.listener(Self::on_toggle_subagents))
            .on_action(cx.listener(Self::on_toggle_usage))
            .on_action(cx.listener(Self::on_focus_composer))
            .on_action(cx.listener(Self::on_send_message))
            .on_action(cx.listener(Self::on_save_file))
            .child(
                gpui_component::TitleBar::new().child(
                    h_flex()
                        .id("titlebar-content")
                        .size_full()
                        .items_center()
                        .px_3()
                        .child(
                            div()
                                .text_sm()
                                .font_weight(FontWeight::MEDIUM)
                                .text_color(theme.muted_foreground)
                                .truncate()
                                .child(title),
                        ),
                ),
            )
            .child(
                h_flex()
                    .id("app-body")
                    .flex_1()
                    .size_full()
                    .when(self.sidebar_visible, |el| {
                        el.child(self.sidebar(window, cx))
                    })
                    .child(self.content_view(window, cx)),
            )
    }
}

impl AppState {
    /// The main content area for the active view. Panels paint their own
    /// full-size root; the wrapper flexes so the panel fills the space left
    /// by the sidebar.
    fn content_view(&mut self, window: &mut Window, cx: &mut Context<Self>) -> gpui::AnyElement {
        let content = match self.view {
            AppView::Chat => self.chat_view(window, cx).into_any_element(),
            AppView::Assistant => self.assistant_entity(window, cx).into_any_element(),
            AppView::Scheduled => self.scheduled_entity(window, cx).into_any_element(),
            AppView::Usage => self.usage_entity(window, cx).into_any_element(),
            AppView::Subagents => self.subagents_entity(window, cx).into_any_element(),
            AppView::Settings => self.settings_entity(window, cx).into_any_element(),
        };
        v_flex()
            .id("view-content")
            .flex_1()
            .h_full()
            .min_w(px(0.))
            .child(content)
            .into_any_element()
    }

    /// The chat surface: message list + composer, with the terminal drawer
    /// attached at the bottom when it is open (⌘J, chat view only).
    fn chat_view(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let terminal_open = self
            .terminal
            .as_ref()
            .is_some_and(|terminal| terminal.read(cx).is_open());
        v_flex()
            .id("chat-view")
            .flex_1()
            .h_full()
            .min_w(px(0.))
            .child(self.chat_pane(window, cx))
            .when(terminal_open, |el| {
                el.child(self.terminal_entity(window, cx))
            })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn view_router_defaults_to_chat_and_labels_are_unique() {
        assert_eq!(AppView::default(), AppView::Chat);
        let labels: std::collections::HashSet<_> =
            AppView::ALL.iter().map(|view| view.label()).collect();
        assert_eq!(labels.len(), AppView::ALL.len());
        for view in AppView::ALL {
            assert!(!view.label().is_empty());
        }
    }

    #[test]
    fn settings_section_mapping_covers_palette_destinations() {
        assert_eq!(
            settings_section_from_id("providers"),
            Some(SettingsSection::Providers)
        );
        assert_eq!(
            settings_section_from_id("appearance"),
            Some(SettingsSection::Appearance)
        );
        assert_eq!(
            settings_section_from_id("scheduled-tasks"),
            Some(SettingsSection::ScheduledTasks)
        );
        // Usage lives on its own panel, not in settings.
        assert_eq!(settings_section_from_id("usage"), None);
        assert_eq!(settings_section_from_id("nonsense"), None);
    }

    #[test]
    fn appearance_mode_cycles_through_all_three_modes() {
        assert_eq!(cycle_appearance_mode(Mode::System), Mode::Light);
        assert_eq!(cycle_appearance_mode(Mode::Light), Mode::Dark);
        assert_eq!(cycle_appearance_mode(Mode::Dark), Mode::System);
    }

    #[test]
    fn motion_gate_resolves_the_override_and_the_os_probe() {
        // On: always reduced, regardless of the OS probe.
        assert!(motion_reduced(ReduceMotion::On, false));
        assert!(motion_reduced(ReduceMotion::On, true));
        // Off: never reduced.
        assert!(!motion_reduced(ReduceMotion::Off, false));
        assert!(!motion_reduced(ReduceMotion::Off, true));
        // System: follows the OS probe (parity with the pill's MotionGate).
        assert!(motion_reduced(ReduceMotion::System, true));
        assert!(!motion_reduced(ReduceMotion::System, false));
    }

    #[test]
    fn palette_provider_mapping_keeps_the_catalog_shape() {
        let provider = ConfiguredProvider {
            id: "custom:ollama".into(),
            label: "Ollama (local)".into(),
            kind: aiden_data::portable_config::ProviderKind::Openai,
            base_url: "http://127.0.0.1:11434/v1".into(),
            models: vec!["qwen3:8b".into()],
            default_model: Some("qwen3:8b".into()),
            model_metadata: Default::default(),
            catalog_models: Vec::new(),
            needs_key: false,
            has_key: false,
        };
        let mapped = palette_provider(&provider);
        assert_eq!(mapped.id, "custom:ollama");
        assert_eq!(mapped.label, "Ollama (local)");
        assert_eq!(mapped.models, vec!["qwen3:8b"]);
        assert!(!mapped.needs_key);
        assert!(!mapped.has_key);
    }

    #[test]
    fn app_palette_source_reads_the_snapshot() {
        let snapshot = Arc::new(std::sync::Mutex::new(PaletteSourceSnapshot {
            chats: vec![aiden_core::ChatMeta {
                id: "chat-1".into(),
                title: "GPUI port notes".into(),
                workspace_id: None,
                provider_id: None,
                model: None,
                created_at: 1,
                updated_at: 2,
            }],
            providers: vec![PaletteProvider {
                id: "anthropic".into(),
                label: "Anthropic".into(),
                models: vec!["claude-sonnet-4-5".into()],
                needs_key: true,
                has_key: true,
            }],
            selection: Some(("anthropic".into(), "claude-sonnet-4-5".into())),
            appearance: Some(Mode::Dark),
        }));
        let source = AppPaletteSource::new(snapshot);
        assert_eq!(source.chats().len(), 1);
        assert_eq!(source.providers()[0].models, vec!["claude-sonnet-4-5"]);
        assert_eq!(
            source.selected(),
            Some(("anthropic".to_string(), "claude-sonnet-4-5".to_string()))
        );
        assert_eq!(source.appearance_mode(), Some(Mode::Dark));
    }
}
