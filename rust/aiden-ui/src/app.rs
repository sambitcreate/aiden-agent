//! The application shell: window root, title bar, view routing, and
//! orchestration of the sidebar + content area. All render helpers live on
//! `AppState` but are defined in per-surface modules (`shell::sidebar`,
//! `chat::chat_pane`, `chat::message_list`) so each file stays small.
//!
//! The shell owns the main-window panels (command palette, terminal drawer,
//! scheduled/usage/subagents, settings) as lazily created entities, and
//! routes the sidebar palette / gear / keyboard actions onto them.

use std::cell::{Cell, RefCell};
use std::rc::Rc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use aiden_core::appearance::{Mode, ReduceMotion};
use futures::FutureExt;
use gpui::{
    actions, div, prelude::FluentBuilder as _, px, App, AppContext as _, Context, Entity,
    FocusHandle, Focusable as _, FontWeight, InteractiveElement as _, IntoElement,
    ParentElement as _, Render, ScrollHandle, StatefulInteractiveElement as _, Styled as _,
    Subscription, Window,
};
#[cfg(target_os = "macos")]
use gpui_component::{
    button::ButtonVariants as _,
    h_flex,
    input::{InputEvent, InputState},
    resizable::ResizableState,
    v_flex, ActiveTheme, IconName, PixelsExt as _, Sizable as _, WindowExt as _,
};

use crate::assistant::{AssistantPanel, AssistantPanelDeps, AssistantPanelEvent};
use crate::chat::composer::{model_items_with_layout, model_key, COMPOSER_MAX_ROWS};
use crate::chat::model_pad_picker::ModelPadRuntime;
use crate::chat::model_picker::{ComposerModelPicker, ModelPickerPins};
use crate::environment::{
    EnvironmentWorkbench, FilesEvent, FilesNotification, FilesWorkbench, ReviewEvent,
    ReviewWorkbench,
};
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
use crate::settings::navigation::{
    capture_settings_return_view, settings_compact_tab_target, settings_escape_target,
    SettingsCompactTabTarget, SettingsEscapeTarget, SettingsNavigation,
};
use crate::settings::{SettingsSection, SettingsServices, SettingsView};
use crate::workspace::{NotificationKind, WorkspaceEvent, WorkspaceState};

fn pending_files_replay_authorized(
    generation_active: bool,
    git_busy: bool,
    files_saving: bool,
    pending: bool,
) -> bool {
    pending && !generation_active && !git_busy && !files_saving
}

const fn model_pad_settings_entry_allowed(git_busy: bool) -> bool {
    !git_busy
}

fn provider_catalog_fingerprint(providers: &[ConfiguredProvider]) -> Vec<String> {
    providers
        .iter()
        .map(|provider| {
            let mut models = provider.models.clone();
            models.sort();
            let mut metadata = provider.model_metadata.iter().collect::<Vec<_>>();
            metadata.sort_by(|left, right| left.0.cmp(right.0));
            let metadata = metadata
                .into_iter()
                .map(|(model, metadata)| {
                    format!(
                        "{model}={}",
                        serde_json::to_string(metadata).unwrap_or_default()
                    )
                })
                .collect::<Vec<_>>()
                .join(",");
            format!(
                "{}|{}|{}|{:?}|{}|{}|{}|{}|{}",
                provider.id,
                provider.label,
                provider.base_url,
                provider.deployment,
                provider.has_key,
                provider.needs_key,
                provider.default_model.as_deref().unwrap_or_default(),
                models.join(","),
                metadata
            )
        })
        .collect()
}

actions!(
    aiden,
    [
        NewChat,
        Quit,
        TogglePalette,
        ToggleTerminal,
        ToggleEnvironment,
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
        OpenAssistant,
        ToggleSubagents,
        ToggleUsage,
        FocusComposer,
        SendMessage,
        SaveFile,
        ChangeModel,
        ManageProviders,
        SearchSettings,
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

#[derive(Debug, Clone)]
enum PendingFilesMutation {
    SelectWorkspace(String),
    AdoptFolder(std::path::PathBuf),
    ChooseWorkspaceFolder,
    SelectChat(String),
    DeleteChat(String),
    NewChat,
    Navigate(AppView),
    Quit,
    CloseWindow,
    Palette(PaletteCommand),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum FilesMutationGate {
    Allow,
    ConfirmDiscard,
    BlockSaving,
}

fn files_mutation_gate(dirty: bool, saving: bool) -> FilesMutationGate {
    if saving {
        FilesMutationGate::BlockSaving
    } else if dirty {
        FilesMutationGate::ConfirmDiscard
    } else {
        FilesMutationGate::Allow
    }
}

fn settings_auth_must_cancel_on_navigation(current: AppView, next: AppView) -> bool {
    current == AppView::Settings && next != AppView::Settings
}

fn competing_root_modal_allowed(codex_auth_active: bool) -> bool {
    !codex_auth_active
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum PostAuthNavigationFocus {
    Composer,
    Sidebar,
}

fn post_auth_navigation_focus(view: AppView) -> PostAuthNavigationFocus {
    if view == AppView::Chat {
        PostAuthNavigationFocus::Composer
    } else {
        PostAuthNavigationFocus::Sidebar
    }
}

fn settings_return_capture_allowed(
    gate: FilesMutationGate,
    pending_confirmation_established: bool,
) -> bool {
    gate == FilesMutationGate::Allow
        || (gate == FilesMutationGate::ConfirmDiscard && pending_confirmation_established)
}

fn environment_workbench_rendered(view: AppView) -> bool {
    view == AppView::Chat
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
/// Mirrors the active chat's generation state for the OS-global dictation
/// callback, which runs outside the `AppState` entity.
static CHAT_GENERATION_ACTIVE: AtomicBool = AtomicBool::new(false);

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
    /// Search field owned by the retained composer model picker.
    pub(crate) model_picker_input: Entity<InputState>,
    /// Retained composer picker presentation state. ChatService owns selection.
    pub(crate) model_picker: Entity<ComposerModelPicker>,
    /// One roving-focus stop for the filtered model-list rows.
    pub(crate) model_picker_focus: FocusHandle,
    pub(crate) model_picker_pad_focus: FocusHandle,
    pub(crate) model_picker_empty_pad_focus: FocusHandle,
    pub(crate) model_picker_trigger_focus: FocusHandle,
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
    pub(crate) settings: Option<Entity<SettingsView>>,
    scheduled: Option<Entity<ScheduledPanel>>,
    usage: Option<Entity<UsagePanel>>,
    subagents: Option<Entity<SubagentsPanel>>,
    assistant: Option<Entity<AssistantPanel>>,
    pub(crate) terminal: Option<Entity<TerminalDrawer>>,
    pub(crate) environment: Entity<EnvironmentWorkbench>,
    pub(crate) files: Entity<FilesWorkbench>,
    pub(crate) review: Entity<ReviewWorkbench>,
    files_dirty: bool,
    files_saving: bool,
    pending_files_mutation: Option<PendingFilesMutation>,
    palette: Option<Entity<CommandPalette>>,
    palette_source: Option<Arc<std::sync::Mutex<PaletteSourceSnapshot>>>,
    palette_invoker_focus: Option<FocusHandle>,
    /// Persisted wide-screen preference plus transient compact-overlay state.
    pub(crate) sidebar_visibility: crate::shell::sidebar::SidebarVisibility,
    /// The persisted inline width and the state backing pointer resizing.
    pub(crate) sidebar_width: f32,
    sidebar_resizable: Entity<ResizableState>,
    /// Focus restoration and keyboard resizing for the compact overlay/rail.
    pub(crate) sidebar_return_focus: Option<FocusHandle>,
    pub(crate) sidebar_last_focus: FocusHandle,
    pub(crate) sidebar_toggle_focus: FocusHandle,
    sidebar_resize_focus: FocusHandle,
    pub(crate) settings_navigation: SettingsNavigation,
    pub(crate) settings_return_view: Option<AppView>,
    pub(crate) settings_return_focus: Option<FocusHandle>,
    pub(crate) terminal_toggle_focus: FocusHandle,
    pub(crate) environment_toggle_focus: FocusHandle,
    last_environment_overlay: bool,
    last_environment_summary: bool,
}

impl AppState {
    fn authorize_files_mutation(
        &mut self,
        mutation: PendingFilesMutation,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> bool {
        match files_mutation_gate(self.files_dirty, self.files_saving) {
            FilesMutationGate::Allow => return true,
            FilesMutationGate::BlockSaving => return false,
            FilesMutationGate::ConfirmDiscard => {}
        }
        self.pending_files_mutation = Some(mutation);
        self.set_view(AppView::Chat, cx);
        self.environment.update(cx, |environment, cx| {
            environment.show(crate::environment::EnvironmentTab::Files, window, cx);
        });
        self.files
            .update(cx, |files, cx| files.request_external_discard(window, cx));
        false
    }

    pub(crate) fn navigate_view(
        &mut self,
        view: AppView,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if view == AppView::Settings {
            let return_focus = window.focused(cx);
            if self.authorize_settings_entry(
                PendingFilesMutation::Navigate(view),
                return_focus,
                window,
                cx,
            ) {
                self.enter_settings(Some(SettingsSection::Providers), window, cx);
            }
            return;
        }
        if self.authorize_files_mutation(PendingFilesMutation::Navigate(view), window, cx) {
            self.set_view(view, cx);
        }
    }

    pub(crate) fn navigate_chat(
        &mut self,
        id: String,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if self.authorize_files_mutation(PendingFilesMutation::SelectChat(id.clone()), window, cx) {
            self.set_view(AppView::Chat, cx);
            self.service
                .update(cx, |service, cx| service.select_chat(&id, cx));
        }
    }

    pub(crate) fn delete_chat_guarded(
        &mut self,
        id: String,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if self.authorize_files_mutation(PendingFilesMutation::DeleteChat(id.clone()), window, cx) {
            self.service
                .update(cx, |service, cx| service.delete_chat(&id, cx));
        }
    }

    pub(crate) fn new_chat_guarded(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.service.read(cx).workspace.is_none() {
            return;
        }
        if self.authorize_files_mutation(PendingFilesMutation::NewChat, window, cx) {
            self.set_view(AppView::Chat, cx);
            self.service.update(cx, |service, cx| service.new_chat(cx));
        }
    }

    fn quit_guarded(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.cancel_shortcut_recording(cx);
        if self.authorize_files_mutation(PendingFilesMutation::Quit, window, cx) {
            self.request_quit(cx);
        }
    }

    pub(crate) fn request_native_close(
        &mut self,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> bool {
        self.cancel_shortcut_recording(cx);
        let authorized =
            self.authorize_files_mutation(PendingFilesMutation::CloseWindow, window, cx);
        if authorized {
            self.cancel_settings_codex_auth(cx);
            self.service.update(cx, |service, _cx| {
                service.flush_appearance_save_before_quit()
            });
        }
        authorized
    }

    fn sidebar_frame(&self, window: &mut Window, cx: &mut Context<Self>) -> gpui::AnyElement {
        let theme = cx.theme().clone();
        let rail = if self.view == AppView::Settings {
            self.settings_navigation_view(window, cx).into_any_element()
        } else {
            self.sidebar(window, cx).into_any_element()
        };
        v_flex()
            .id("sidebar-frame")
            .size_full()
            .bg(theme.sidebar)
            .child(gpui_component::TitleBar::new().h(px(52.)).bg(theme.sidebar))
            .child(div().flex_1().min_h(px(0.)).child(rail))
            .into_any_element()
    }

    fn main_column(
        &mut self,
        title: String,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> gpui::AnyElement {
        let theme = cx.theme().clone();
        let title_inset = crate::chat::toolbar::titlebar_left_inset(self.sidebar_visibility);
        v_flex()
            .id("main-column")
            .size_full()
            .min_w(px(0.))
            .bg(theme.background)
            .child(
                gpui_component::TitleBar::new()
                    .h(px(crate::chat::toolbar::CHAT_TITLEBAR_HEIGHT_PX))
                    .child(
                        h_flex()
                            .size_full()
                            .items_center()
                            .pl(px(title_inset))
                            .pr_4()
                            .gap_3()
                            .child(
                                div()
                                    .min_w(px(0.))
                                    .flex_1()
                                    .text_sm()
                                    .font_weight(FontWeight::SEMIBOLD)
                                    .text_color(theme.foreground)
                                    .truncate()
                                    .child(title),
                            )
                            .when(self.view == AppView::Chat, |el| {
                                el.child(self.chat_toolbar_actions(window, cx))
                            }),
                    ),
            )
            .child(self.content_view(window, cx))
            .into_any_element()
    }

    fn environment_container_width(&self, window: &Window) -> f32 {
        let width = window.viewport_size().width.as_f32();
        if !self.sidebar_visibility.compact && self.sidebar_visibility.visible() {
            (width - self.sidebar_width).max(0.0)
        } else {
            width
        }
    }

    fn environment_overlay_open(&self, window: &Window, cx: &App) -> bool {
        if !environment_workbench_rendered(self.view) {
            return false;
        }
        let environment = self.environment.read(cx);
        environment.full_open()
            && !crate::environment::layout::resolve_layout(
                environment.preferred_width,
                self.environment_container_width(window),
            )
            .inline
    }

    fn workbench_column(
        &mut self,
        title: String,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> gpui::AnyElement {
        let conversation = self.main_column(title, window, cx);
        if self.view != AppView::Chat {
            return conversation;
        }
        let width = self.environment_container_width(window);
        let workspace = self.service.read(cx).workspace.clone();
        let (overlay, summary, should_focus_overlay, should_focus_summary, focus_target) = {
            let environment = self.environment.read(cx);
            let layout =
                crate::environment::layout::resolve_layout(environment.preferred_width, width);
            let overlay = environment.full_open() && !layout.inline;
            let summary =
                environment.open && environment.tab == crate::environment::EnvironmentTab::Overview;
            (
                overlay,
                summary,
                crate::environment::should_focus_overlay_transition(
                    self.last_environment_overlay,
                    overlay,
                    environment.panel_scope.contains_focused(window, cx),
                ),
                crate::environment::should_focus_summary_transition(
                    self.last_environment_summary,
                    summary,
                    environment.summary_scope.contains_focused(window, cx),
                ),
                if summary {
                    environment.summary_focus.clone()
                } else {
                    environment.active_tab_focus.clone()
                },
            )
        };
        if should_focus_overlay || should_focus_summary {
            cx.defer_in(window, move |_this, window, _cx| {
                focus_target.focus(window);
            });
        }
        self.last_environment_overlay = overlay;
        self.last_environment_summary = summary;
        crate::environment::environment_workbench(
            &self.environment,
            conversation,
            crate::environment::EnvironmentWorkbenchProps {
                container_width: width,
                workspace,
                fallback_focus: self.environment_toggle_focus.clone(),
                files: self.files.clone(),
                review: self.review.clone(),
            },
            window,
            cx,
        )
    }

    fn shell_body(
        &mut self,
        title: String,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> gpui::AnyElement {
        if self.sidebar_visibility.compact {
            let saved_width = self
                .sidebar_resizable
                .read(cx)
                .sizes()
                .first()
                .map(|width| width.as_f32())
                .unwrap_or(self.sidebar_width);
            let overlay_width = crate::shell::sidebar::sidebar_overlay_width(
                saved_width,
                window.viewport_size().width.as_f32(),
            );
            return div()
                .id("app-body-compact")
                .relative()
                .flex_1()
                .size_full()
                .overflow_hidden()
                .child(self.workbench_column(title, window, cx))
                .when(self.sidebar_visibility.visible(), |el| {
                    el.child(
                        div()
                            .id("sidebar-overlay-backdrop")
                            .absolute()
                            .inset_0()
                            .occlude()
                            .bg(gpui::black().opacity(0.18))
                            .on_mouse_down(gpui::MouseButton::Left, |_event, _window, cx| {
                                cx.stop_propagation();
                            })
                            .on_click(cx.listener(|this, _event, window, cx| {
                                cx.stop_propagation();
                                this.dismiss_compact_sidebar(window, cx);
                            })),
                    )
                    .child(
                        div()
                            .absolute()
                            .top_0()
                            .left_0()
                            .h_full()
                            .w(px(overlay_width))
                            .occlude()
                            .child(self.sidebar_frame(window, cx)),
                    )
                })
                .into_any_element();
        }

        if !self.sidebar_visibility.visible() {
            return h_flex()
                .id("app-body")
                .flex_1()
                .size_full()
                .child(self.workbench_column(title, window, cx))
                .into_any_element();
        }

        let config = self.stores.config.clone();
        let app = cx.weak_entity();
        let resizable = gpui_component::resizable::h_resizable("app-body-resizable")
            .with_state(&self.sidebar_resizable)
            .child(
                gpui_component::resizable::resizable_panel()
                    .size(px(self.sidebar_width))
                    .size_range(
                        px(crate::shell::sidebar::SIDEBAR_MIN_WIDTH)
                            ..px(crate::shell::sidebar::SIDEBAR_MAX_WIDTH),
                    )
                    .child(self.sidebar_frame(window, cx)),
            )
            .child(
                gpui_component::resizable::resizable_panel()
                    .size_range(px(320.)..gpui::Pixels::MAX)
                    .child(self.workbench_column(title, window, cx)),
            )
            .on_resize(move |state, _window, cx| {
                let Some(width) = state.read(cx).sizes().first().copied() else {
                    return;
                };
                let _ = app.update(cx, |this, cx| {
                    this.sidebar_width = width.as_f32();
                    cx.notify();
                });
                crate::shell::sidebar::persist_sidebar_width(config.clone(), width.as_f32(), cx);
            });
        let theme = cx.theme();
        div()
            .id("app-body")
            .relative()
            .flex_1()
            .size_full()
            .child(resizable)
            .child(
                div()
                    .id("sidebar-keyboard-resize")
                    .absolute()
                    .top_0()
                    .bottom_0()
                    .left(px(self.sidebar_width - 4.0))
                    .w(px(8.0))
                    .cursor_col_resize()
                    .track_focus(&self.sidebar_resize_focus)
                    .tab_stop(true)
                    .focus(move |style| style.bg(theme.list_active))
                    .on_key_down(
                        cx.listener(|this, event: &gpui::KeyDownEvent, _window, cx| {
                            let shift = event.keystroke.modifiers.shift;
                            if let Some(width) = crate::shell::sidebar::keyboard_resize_width(
                                this.sidebar_width,
                                &event.keystroke.key,
                                shift,
                            ) {
                                this.sidebar_width = width;
                                this.sidebar_resizable = cx.new(|_| ResizableState::default());
                                crate::shell::sidebar::persist_sidebar_width(
                                    this.stores.config.clone(),
                                    width,
                                    cx,
                                );
                                cx.stop_propagation();
                                cx.notify();
                            }
                        }),
                    ),
            )
            .into_any_element()
    }

    pub fn new(
        stores: Stores,
        initial_appearance: aiden_core::appearance::AppearanceConfig,
        prepared_native: crate::services::native_appearance::PreparedNativeAppearance,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Self {
        if cx.try_global::<ModelPadRuntime>().is_none() {
            cx.set_global(ModelPadRuntime::default());
        }
        if cx.try_global::<ModelPickerPins>().is_none() {
            cx.set_global(ModelPickerPins::load(&stores.config));
        }
        let service =
            cx.new(|cx| ChatService::new(stores.clone(), initial_appearance, prepared_native, cx));
        // This is intentionally before `Root::new` renders its first frame.
        service.update(cx, |service, cx| service.apply_appearance(cx));
        service.update(cx, |service, cx| service.boot(cx));

        let composer_input = cx.new(|cx| {
            InputState::new(window, cx)
                .auto_grow(1, COMPOSER_MAX_ROWS)
                .placeholder("Message Aiden…")
        });
        let search_input = cx.new(|cx| InputState::new(window, cx).placeholder("Search chats"));
        let model_picker_input =
            cx.new(|cx| InputState::new(window, cx).placeholder("Filter models…"));
        let sidebar_width = crate::shell::sidebar::load_sidebar_width(&stores.config);
        let sidebar_compact =
            crate::shell::sidebar::is_compact_sidebar_width(window.viewport_size().width.as_f32());
        let sidebar_wide_visible = crate::shell::sidebar::load_sidebar_wide_visible(&stores.config);
        let sidebar_resizable = cx.new(|_| ResizableState::default());
        let workspace_config = stores.config.clone();
        let environment_config = stores.config.clone();
        let files = cx.new(|cx| FilesWorkbench::new(window, cx));
        let workspace_state = cx.new(|cx| WorkspaceState::new(workspace_config, window, cx));
        let review_git = workspace_state.read(cx).git_service();
        let review = cx.new(|cx| ReviewWorkbench::new(review_git, window, cx));
        let settings_navigation = SettingsNavigation::new(window, cx);

        let mut this = Self {
            service: service.clone(),
            stores,
            view: AppView::default(),
            composer_input,
            search_input,
            model_picker_input,
            model_picker: cx.new(|cx| {
                let providers = service.read(cx).providers.clone();
                let selection = service
                    .read(cx)
                    .selection
                    .as_ref()
                    .map(|selection| model_key(&selection.provider_id, &selection.model));
                ComposerModelPicker::new(
                    model_items_with_layout(&providers, cx.try_global::<ModelPadRuntime>()),
                    selection,
                )
            }),
            model_picker_focus: cx.focus_handle(),
            model_picker_pad_focus: cx.focus_handle(),
            model_picker_empty_pad_focus: cx.focus_handle(),
            model_picker_trigger_focus: cx.focus_handle(),
            message_scroll: ScrollHandle::new(),
            last_message_len: 0,
            last_catalog: Vec::new(),
            last_workspace_id: None,
            appearance_applied: false,
            _subscriptions: Vec::new(),
            workspace_state,
            environment: cx.new(|cx| EnvironmentWorkbench::new(environment_config, cx)),
            files,
            review,
            files_dirty: false,
            files_saving: false,
            pending_files_mutation: None,
            settings: None,
            scheduled: None,
            usage: None,
            subagents: None,
            assistant: None,
            terminal: None,
            palette: None,
            palette_source: None,
            palette_invoker_focus: None,
            sidebar_visibility: crate::shell::sidebar::SidebarVisibility::new(
                sidebar_wide_visible,
                sidebar_compact,
            ),
            sidebar_width,
            sidebar_resizable,
            sidebar_return_focus: None,
            sidebar_last_focus: cx.focus_handle().tab_stop(true),
            sidebar_toggle_focus: cx.focus_handle().tab_stop(true),
            sidebar_resize_focus: cx.focus_handle().tab_stop(true),
            settings_navigation,
            settings_return_view: None,
            settings_return_focus: None,
            terminal_toggle_focus: cx.focus_handle().tab_stop(true),
            environment_toggle_focus: cx.focus_handle().tab_stop(true),
            last_environment_overlay: false,
            last_environment_summary: false,
        };

        // The pill is a separate GPUI window, so it does not inherit the
        // main window's globals. Keep an already-open pill synchronized with
        // both persisted appearance edits and AppKit accessibility events.
        this._subscriptions
            .push(cx.observe(&service, |_this, service, cx| {
                let appearance = service.read(cx).appearance.clone();
                let system_reduced = service.read(cx).system_reduced_motion();
                let handle = match PILL_WINDOW.lock() {
                    Ok(guard) => *guard,
                    Err(poisoned) => *poisoned.into_inner(),
                };
                if let Some(handle) = handle {
                    let _ = handle.update(cx, |view, _window, cx| {
                        view.update_appearance(appearance, cx);
                        view.set_system_reduced_motion(system_reduced, cx);
                    });
                }
            }));

        cx.spawn(async move |this, cx| {
            let layout = cx
                .background_spawn(async move {
                    aiden_data::model_pad_store::ModelPadStore::default().load()
                })
                .await;
            if let Ok(layout) = layout {
                let _ =
                    cx.update_global::<ModelPadRuntime, _>(|runtime, _cx| runtime.replace(layout));
                this.update(cx, |this, cx| {
                    this.reconcile_model_picker(cx);
                    cx.notify();
                })
                .ok();
            }
        })
        .detach();
        this._subscriptions
            .push(cx.observe_global::<ModelPadRuntime>(|this, cx| {
                this.reconcile_model_picker(cx);
                cx.notify();
            }));

        this._subscriptions
            .push(cx.observe_window_bounds(window, |this, window, cx| {
                let compact = crate::shell::sidebar::is_compact_sidebar_width(
                    window.viewport_size().width.as_f32(),
                );
                if compact != this.sidebar_visibility.compact {
                    let restore_focus = this.sidebar_visibility.compact_open;
                    this.sidebar_visibility = this.sidebar_visibility.transition(
                        crate::shell::sidebar::SidebarVisibilityEvent::WindowCompact(compact),
                    );
                    if restore_focus {
                        this.restore_sidebar_focus(window);
                    }
                    cx.notify();
                }
            }));

        // Keep `Mode::System` synchronized with native light/dark changes.
        // Explicit Light/Dark modes resolve to themselves, so reapplying them
        // here is harmless and keeps this observer independent of Settings.
        this._subscriptions.push(cx.observe_window_appearance(
            window,
            |this: &mut AppState, _window: &mut Window, cx: &mut Context<AppState>| {
                this.service
                    .update(cx, |service, cx| service.apply_appearance(cx));
                cx.notify();
            },
        ));

        // Wire the dictation pill (coordinator + window bridge).
        wire_pill_coordinator(cx);

        // Scheduled execution remains deliberately dormant until the app owns
        // a real bounded executor. Starting with a placeholder would create
        // unattended fictional-success runs.

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
                        if let Some(settings) = this.settings.clone() {
                            settings.update(cx, |settings, cx| settings.refresh_managed_skills(cx));
                        }
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
                InputEvent::Focus | InputEvent::Blur => cx.notify(),
                InputEvent::PressEnter { secondary: true } => {}
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

        this._subscriptions.push(cx.subscribe_in(
            &this.model_picker_input,
            window,
            |this, _source, event, _window, cx| {
                if matches!(event, InputEvent::Change) {
                    let query = this.model_picker_input.read(cx).value().to_string();
                    this.model_picker.update(cx, |picker, cx| {
                        picker.query = query;
                        picker.repair_active_visible();
                        cx.notify();
                    });
                }
            },
        ));

        // Settings search only filters the dedicated settings rail. The active
        // section remains unchanged even when its row is filtered out.
        this._subscriptions.push(cx.subscribe_in(
            &this.settings_navigation.search,
            window,
            |_this, _source, event, _window, cx| {
                if matches!(
                    event,
                    InputEvent::Change | InputEvent::Focus | InputEvent::Blur
                ) {
                    cx.notify();
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
                    if this.service.read(cx).generation_active() {
                        return;
                    }
                    if !this.authorize_files_mutation(
                        PendingFilesMutation::SelectWorkspace(id.clone()),
                        window,
                        cx,
                    ) {
                        return;
                    }
                    this.service
                        .update(cx, |service, cx| service.select_workspace(id, cx));
                }
                WorkspaceEvent::AdoptFolder { folder } => {
                    if this.service.read(cx).generation_active() {
                        return;
                    }
                    if !this.authorize_files_mutation(
                        PendingFilesMutation::AdoptFolder(folder.clone()),
                        window,
                        cx,
                    ) {
                        return;
                    }
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
        this._subscriptions.push(cx.observe_in(
            &this.workspace_state,
            window,
            |this, workspace_state, window, cx| {
                let git_busy = workspace_state.read(cx).git_busy;
                let blocked = git_busy || this.service.read(cx).generation_active();
                this.files.update(cx, |files, cx| {
                    files.set_interaction_blocked(blocked, window, cx);
                });
                cx.notify();
            },
        ));
        this._subscriptions
            .push(cx.observe(&this.environment, |this, environment, cx| {
                let environment = environment.read(cx);
                let active = environment.open
                    && matches!(
                        environment.tab,
                        crate::environment::EnvironmentTab::Review
                            | crate::environment::EnvironmentTab::Overview
                    );
                let overview = environment.tab == crate::environment::EnvironmentTab::Overview;
                this.review.update(cx, |review, cx| {
                    if overview && review.mode != crate::environment::ReviewMode::Changes {
                        review.set_mode(crate::environment::ReviewMode::Changes, cx);
                    }
                    review.set_active(active, cx);
                });
                cx.notify();
            }));
        this._subscriptions.push(cx.subscribe_in(
            &this.review,
            window,
            |this, _source, event: &ReviewEvent, window, cx| match event {
                ReviewEvent::OpenFile { request_id, path } => {
                    this.environment.update(cx, |environment, cx| {
                        environment.show(crate::environment::EnvironmentTab::Files, window, cx)
                    });
                    let container_width = this.environment_container_width(window);
                    let preferred_width = this.environment.read(cx).preferred_width;
                    this.files.update(cx, |files, cx| {
                        files.open_from_review(
                            *request_id,
                            path.clone(),
                            crate::environment::compact_files_for_environment(
                                preferred_width,
                                container_width,
                            ),
                            window,
                            cx,
                        )
                    });
                }
            },
        ));
        this._subscriptions
            .push(cx.observe(&this.review, |_this, _review, cx| cx.notify()));
        this._subscriptions
            .push(cx.observe(&this.files, |_this, _files, cx| cx.notify()));
        this._subscriptions.push(cx.subscribe_in(
            &this.files,
            window,
            |this, _source, event: &FilesEvent, window, cx| match event {
                FilesEvent::StateChanged(snapshot) => {
                    this.files_dirty = snapshot.dirty;
                    this.files_saving = snapshot.saving;
                    let blocked = this.service.read(cx).generation_active()
                        || snapshot.dirty
                        || snapshot.saving;
                    this.workspace_state.update(cx, |state, cx| {
                        state.set_interaction_blocked(blocked, cx);
                    });
                    cx.notify();
                }
                FilesEvent::ExternalDiscardRequested => {
                    let authorized = pending_files_replay_authorized(
                        this.service.read(cx).generation_active(),
                        this.workspace_state.read(cx).git_busy,
                        this.files_saving,
                        this.pending_files_mutation.is_some(),
                    );
                    if !authorized {
                        return;
                    }
                    let confirmed = this
                        .files
                        .update(cx, |files, cx| files.confirm_external_discard(window, cx));
                    if confirmed {
                        if let Some(mutation) = this.pending_files_mutation.take() {
                            match mutation {
                                PendingFilesMutation::SelectWorkspace(id) => {
                                    this.service.update(cx, |service, cx| {
                                        service.select_workspace(&id, cx)
                                    });
                                }
                                PendingFilesMutation::AdoptFolder(folder) => {
                                    this.service.update(cx, |service, cx| {
                                        service.add_workspace_from_folder(&folder, cx)
                                    });
                                }
                                PendingFilesMutation::ChooseWorkspaceFolder => {
                                    this.workspace_state
                                        .update(cx, |state, cx| state.choose_folder(window, cx));
                                }
                                PendingFilesMutation::SelectChat(id) => {
                                    this.set_view(AppView::Chat, cx);
                                    this.service
                                        .update(cx, |service, cx| service.select_chat(&id, cx));
                                }
                                PendingFilesMutation::DeleteChat(id) => {
                                    this.service
                                        .update(cx, |service, cx| service.delete_chat(&id, cx));
                                }
                                PendingFilesMutation::NewChat => {
                                    this.set_view(AppView::Chat, cx);
                                    this.service.update(cx, |service, cx| service.new_chat(cx));
                                }
                                PendingFilesMutation::Navigate(AppView::Settings) => {
                                    this.enter_settings(
                                        Some(SettingsSection::Providers),
                                        window,
                                        cx,
                                    );
                                }
                                PendingFilesMutation::Navigate(view) => this.set_view(view, cx),
                                PendingFilesMutation::Quit => this.request_quit(cx),
                                PendingFilesMutation::CloseWindow => {
                                    this.cancel_settings_codex_auth(cx);
                                    this.service.update(cx, |service, _cx| {
                                        service.flush_appearance_save_before_quit()
                                    });
                                    crate::mark_main_window_closed(cx);
                                    window.remove_window();
                                }
                                PendingFilesMutation::Palette(command) => {
                                    this.on_palette_command(command, window, cx)
                                }
                            }
                        }
                    }
                }
                FilesEvent::ExternalDiscardCancelled => {
                    if this
                        .pending_files_mutation
                        .as_ref()
                        .is_some_and(|mutation| {
                            matches!(
                                mutation,
                                PendingFilesMutation::Navigate(AppView::Settings)
                                    | PendingFilesMutation::Palette(
                                        PaletteCommand::OpenSettings
                                            | PaletteCommand::OpenSettingsSection(_)
                                    )
                            )
                        })
                    {
                        this.settings_return_view = None;
                        this.settings_return_focus = None;
                        this.palette_invoker_focus = None;
                    }
                    this.pending_files_mutation = None;
                }
                FilesEvent::Notification(FilesNotification::Warning(message)) => {
                    window.push_notification(
                        gpui_component::notification::Notification::warning(message.clone()),
                        cx,
                    );
                }
            },
        ));

        // Service changes: apply appearance once booted, sync the model picker
        // catalog, follow streaming output, and mirror workspace state.
        this._subscriptions.push(cx.observe_in(
            &this.service,
            window,
            |this, _service, window, cx| {
                this.sync_from_service(cx);
                let files_blocked = this.service.read(cx).generation_active()
                    || this.workspace_state.read(cx).git_busy;
                let workspace = this.service.read(cx).workspace.clone();
                this.files.update(cx, |files, cx| {
                    files.set_interaction_blocked(files_blocked, window, cx);
                    files.set_workspace(workspace.clone(), window, cx);
                });
                this.review
                    .update(cx, |review, cx| review.set_workspace(workspace, cx));
                if !crate::chat::toolbar::terminal_eligible(
                    this.service.read(cx).workspace.as_ref(),
                ) && this.environment.read(cx).open
                {
                    let composer_focus = this.composer_input.read(cx).focus_handle(cx);
                    this.environment.update(cx, |environment, cx| {
                        environment.close_to_fallback(window, &composer_focus, cx);
                    });
                }
            },
        ));

        // The chat view is the default view, so the workspace bar is visible
        // from startup (refresh + poll are gated on a folder being present).
        this.workspace_state.update(cx, |state, cx| {
            state.set_visible(true, cx);
        });
        let initial_workspace = this.service.read(cx).workspace.clone();
        let review_active = {
            let environment = this.environment.read(cx);
            environment.open
                && matches!(
                    environment.tab,
                    crate::environment::EnvironmentTab::Review
                        | crate::environment::EnvironmentTab::Overview
                )
        };
        this.review.update(cx, |review, cx| {
            review.set_workspace(initial_workspace, cx);
            review.set_active(review_active, cx);
        });

        this
    }

    fn reconcile_model_picker(&mut self, cx: &mut Context<Self>) {
        let service = self.service.read(cx);
        let booted = service.booted;
        let providers = service.providers.clone();
        let selection = service
            .selection
            .as_ref()
            .map(|selection| model_key(&selection.provider_id, &selection.model));
        let runtime = cx.try_global::<ModelPadRuntime>().cloned();
        self.model_picker.update(cx, |picker, cx| {
            picker.reconcile(&providers, runtime.as_ref(), selection);
            cx.notify();
        });
        if booted {
            let available = self
                .model_picker
                .read(cx)
                .items
                .iter()
                .map(crate::chat::composer::ModelItem::value_key)
                .collect();
            let pins = cx.default_global::<ModelPickerPins>();
            if pins.reconcile(&available) {
                let snapshot = pins.clone();
                let store = self.stores.config.clone();
                cx.background_spawn(async move { snapshot.persist(&store) })
                    .detach();
            }
        }
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
        let catalog = provider_catalog_fingerprint(&service.providers);
        let providers = service.providers.clone();
        let selection = service
            .selection
            .as_ref()
            .map(|selection| model_key(&selection.provider_id, &selection.model));
        let _ = service;
        if catalog != self.last_catalog {
            self.last_catalog = catalog;
            let runtime = cx.try_global::<ModelPadRuntime>().cloned();
            self.model_picker.update(cx, |picker, cx| {
                picker.reconcile(&providers, runtime.as_ref(), selection);
                cx.notify();
            });
        }
        if booted {
            let available = self
                .model_picker
                .read(cx)
                .items
                .iter()
                .map(crate::chat::composer::ModelItem::value_key)
                .collect();
            let pins = cx.default_global::<ModelPickerPins>();
            if pins.reconcile(&available) {
                let snapshot = pins.clone();
                let store = self.stores.config.clone();
                cx.background_spawn(async move { snapshot.persist(&store) })
                    .detach();
            }
        }
        let service = self.service.read(cx);

        let generation_active = service.generation_active();
        CHAT_GENERATION_ACTIVE.store(generation_active, Ordering::Relaxed);
        let message_len = service
            .active_chat
            .as_ref()
            .map_or(0, |chat| chat.messages.len());
        if message_len != self.last_message_len || generation_active {
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
        let workspace = service.workspace.clone();
        let terminal_allowed = crate::chat::toolbar::terminal_eligible(workspace.as_ref());
        let workspace_changed = active_id != self.last_workspace_id;
        if workspace_changed {
            self.last_workspace_id = active_id.clone();
        }
        if workspace_changed {
            if let Some(terminal) = &self.terminal {
                if let Some(cwd) = folder.clone() {
                    terminal.update(cx, |terminal, cx| terminal.set_cwd(cwd, cx));
                } else {
                    terminal.update(cx, |terminal, cx| terminal.close(cx));
                }
            }
        }
        if !terminal_allowed {
            if let Some(terminal) = &self.terminal {
                terminal.update(cx, |terminal, cx| terminal.close(cx));
            }
        }
        let workspace_interaction_blocked =
            generation_active || self.files_dirty || self.files_saving;
        self.workspace_state.update(cx, |state, cx| {
            state.set_mirror(workspaces, active_id, folder, cx);
            state.set_interaction_blocked(workspace_interaction_blocked, cx);
        });
        if let Some(settings) = self.settings.clone() {
            settings.update(cx, |settings, cx| {
                settings.set_skills_workspace(workspace.as_ref(), cx)
            });
        }
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

    fn on_new_chat(&mut self, _: &NewChat, window: &mut Window, cx: &mut Context<Self>) {
        self.new_chat_guarded(window, cx);
    }

    fn on_quit(&mut self, _: &Quit, window: &mut Window, cx: &mut Context<Self>) {
        self.quit_guarded(window, cx);
    }

    /// The quit barrier: warn + cancel when a generation is in flight, stop
    /// the background services that spawn tokio work, mark the barrier ready,
    /// and quit. Full dialog UX lands later — for now a warning log plus
    /// clean cancellation so no tokio stream task leaks past shutdown.
    fn request_quit(&mut self, cx: &mut Context<Self>) {
        self.cancel_settings_codex_auth(cx);
        let barrier = self.stores.quit_barrier.clone();
        if self.service.read(cx).generation_active() {
            tracing::warn!(
                "Quit requested with an in-flight generation — cancelling the stream before shutdown."
            );
            // Aborts the provider stream: sets the driver's cancel flag and
            // settles the partial bubble so the watcher/driver tasks end
            // instead of running to completion into a dead channel.
        }
        self.service.update(cx, |service, cx| service.dispose(cx));
        self.stores.foundation_models.dispose();
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
        let return_focus = window.focused(cx);
        if !self.authorize_settings_entry(
            PendingFilesMutation::Navigate(AppView::Settings),
            return_focus.clone(),
            window,
            cx,
        ) {
            return;
        }
        self.dismiss_compact_sidebar_for_navigation(window, cx);
        self.enter_settings(Some(SettingsSection::Providers), window, cx);
    }

    /// ⌘⇧F: focus the sidebar chat search.
    fn on_search_chats(&mut self, _: &SearchChats, window: &mut Window, cx: &mut Context<Self>) {
        self.set_view(AppView::Chat, cx);
        if !self.sidebar_visibility.visible() {
            self.open_sidebar(window, cx);
        }
        self.search_input
            .update(cx, |input, cx| input.focus(window, cx));
    }

    /// ⌘⇧[ / ⌘⇧]: previous/next chat in the sidebar order.
    fn on_previous_chat(&mut self, _: &PreviousChat, window: &mut Window, cx: &mut Context<Self>) {
        self.cycle_chat(false, window, cx);
    }

    fn on_next_chat(&mut self, _: &NextChat, window: &mut Window, cx: &mut Context<Self>) {
        self.cycle_chat(true, window, cx);
    }

    /// ⌘1..⌘9: jump to the Nth chat in the (search-filtered) sidebar list.
    fn jump_to_chat(&mut self, index: usize, window: &mut Window, cx: &mut Context<Self>) {
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
        self.navigate_chat(id, window, cx);
    }

    fn on_chat_jump_1(&mut self, _: &ChatJump1, window: &mut Window, cx: &mut Context<Self>) {
        self.jump_to_chat(0, window, cx);
    }

    fn on_chat_jump_2(&mut self, _: &ChatJump2, window: &mut Window, cx: &mut Context<Self>) {
        self.jump_to_chat(1, window, cx);
    }

    fn on_chat_jump_3(&mut self, _: &ChatJump3, window: &mut Window, cx: &mut Context<Self>) {
        self.jump_to_chat(2, window, cx);
    }

    fn on_chat_jump_4(&mut self, _: &ChatJump4, window: &mut Window, cx: &mut Context<Self>) {
        self.jump_to_chat(3, window, cx);
    }

    fn on_chat_jump_5(&mut self, _: &ChatJump5, window: &mut Window, cx: &mut Context<Self>) {
        self.jump_to_chat(4, window, cx);
    }

    fn on_chat_jump_6(&mut self, _: &ChatJump6, window: &mut Window, cx: &mut Context<Self>) {
        self.jump_to_chat(5, window, cx);
    }

    fn on_chat_jump_7(&mut self, _: &ChatJump7, window: &mut Window, cx: &mut Context<Self>) {
        self.jump_to_chat(6, window, cx);
    }

    fn on_chat_jump_8(&mut self, _: &ChatJump8, window: &mut Window, cx: &mut Context<Self>) {
        self.jump_to_chat(7, window, cx);
    }

    fn on_chat_jump_9(&mut self, _: &ChatJump9, window: &mut Window, cx: &mut Context<Self>) {
        self.jump_to_chat(8, window, cx);
    }

    /// ⌘O: open the macOS workspace-folder picker.
    fn on_open_workspace_folder(
        &mut self,
        _: &OpenWorkspaceFolder,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if !competing_root_modal_allowed(self.settings_codex_auth_active(cx)) {
            return;
        }
        if self.environment_overlay_open(window, cx) {
            return;
        }
        if self.service.read(cx).generation_active() {
            return;
        }
        if !self.authorize_files_mutation(PendingFilesMutation::ChooseWorkspaceFolder, window, cx) {
            return;
        }
        self.dismiss_compact_sidebar_before_content_focus(cx);
        self.workspace_state
            .update(cx, |state, cx| state.choose_folder(window, cx));
    }

    /// ⌘⇧E: open the "open in editor" overlay for the active workspace.
    fn on_open_in_editor(&mut self, _: &OpenInEditor, window: &mut Window, cx: &mut Context<Self>) {
        if self.environment_overlay_open(window, cx) {
            return;
        }
        if self.service.read(cx).generation_active() {
            return;
        }
        self.dismiss_compact_sidebar_before_content_focus(cx);
        self.set_view(AppView::Chat, cx);
        self.workspace_state.update(cx, |state, cx| {
            state.open_preferred_editor(window, cx);
        });
    }

    /// ⌘W: close the window. A single-window app has nothing to fall back to,
    /// so this is a full quit (same barrier path as ⌘Q) — no windowless
    /// process lingers in the dock.
    fn on_close_window(&mut self, _: &CloseWindow, window: &mut Window, cx: &mut Context<Self>) {
        self.quit_guarded(window, cx);
    }

    /// ⌃⌘S (cmd-ctrl-s): show/hide the sidebar.
    fn on_toggle_sidebar(
        &mut self,
        _: &ToggleSidebar,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.toggle_sidebar(window, cx);
    }

    fn open_sidebar(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.sidebar_visibility.compact {
            if !self.sidebar_visibility.compact_open {
                if self.environment_overlay_open(window, cx) {
                    let fallback = self.environment_toggle_focus.clone();
                    self.environment.update(cx, |environment, cx| {
                        environment.close(window, &fallback, cx);
                    });
                }
                self.sidebar_return_focus = window.focused(cx);
                self.sidebar_visibility = self
                    .sidebar_visibility
                    .transition(crate::shell::sidebar::SidebarVisibilityEvent::Toggle);
            }
        } else if !self.sidebar_visibility.wide_visible {
            self.sidebar_visibility = self
                .sidebar_visibility
                .transition(crate::shell::sidebar::SidebarVisibilityEvent::Toggle);
            crate::shell::sidebar::persist_sidebar_wide_visible(
                self.stores.config.clone(),
                self.sidebar_visibility.wide_visible,
                cx,
            );
        }
        cx.notify();
    }

    fn toggle_sidebar(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.sidebar_visibility.compact && !self.sidebar_visibility.compact_open {
            if self.environment_overlay_open(window, cx) {
                let fallback = self.environment_toggle_focus.clone();
                self.environment.update(cx, |environment, cx| {
                    environment.close(window, &fallback, cx);
                });
            }
            self.sidebar_return_focus = window.focused(cx);
        }
        let was_compact_open = self.sidebar_visibility.compact_open;
        self.sidebar_visibility = self
            .sidebar_visibility
            .transition(crate::shell::sidebar::SidebarVisibilityEvent::Toggle);
        if self.sidebar_visibility.compact {
            if self.sidebar_visibility.compact_open {
                if self.view == AppView::Settings {
                    self.settings_navigation.back_focus.focus(window);
                } else {
                    self.search_input
                        .update(cx, |input, cx| input.focus(window, cx));
                }
            } else if was_compact_open {
                self.restore_sidebar_focus(window);
            }
        } else {
            crate::shell::sidebar::persist_sidebar_wide_visible(
                self.stores.config.clone(),
                self.sidebar_visibility.wide_visible,
                cx,
            );
        }
        cx.notify();
    }

    pub(crate) fn dismiss_compact_sidebar(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if !self.sidebar_visibility.compact_open {
            return;
        }
        self.sidebar_visibility = self
            .sidebar_visibility
            .transition(crate::shell::sidebar::SidebarVisibilityEvent::DismissCompact);
        self.restore_sidebar_focus(window);
        cx.notify();
    }

    pub(crate) fn dismiss_compact_sidebar_for_navigation(
        &mut self,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if !self.sidebar_visibility.compact_open {
            return;
        }
        self.sidebar_visibility = self
            .sidebar_visibility
            .transition(crate::shell::sidebar::SidebarVisibilityEvent::DismissCompact);
        self.sidebar_return_focus = None;
        self.sidebar_toggle_focus.focus(window);
        cx.notify();
    }

    fn dismiss_compact_sidebar_before_content_focus(&mut self, cx: &mut Context<Self>) {
        if self.sidebar_visibility.compact_open {
            self.sidebar_visibility = self
                .sidebar_visibility
                .transition(crate::shell::sidebar::SidebarVisibilityEvent::DismissCompact);
            self.sidebar_return_focus = None;
            cx.notify();
        }
    }

    fn restore_sidebar_focus(&mut self, window: &mut Window) {
        if let Some(focus) = self.sidebar_return_focus.take() {
            focus.focus(window);
        }
    }

    /// Toggle a panel view: opening it again (or ⌘⇧A/S/U from another view)
    /// returns to the chat view.
    fn toggle_view(&mut self, target: AppView, window: &mut Window, cx: &mut Context<Self>) {
        let destination = if self.view == target {
            AppView::Chat
        } else {
            target
        };
        self.navigate_view(destination, window, cx);
    }

    /// ⌘⇧A: toggle the Assistant panel.
    fn on_toggle_assistant(
        &mut self,
        _: &ToggleAssistant,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.dismiss_compact_sidebar_for_navigation(window, cx);
        self.toggle_view(AppView::Assistant, window, cx);
    }

    fn on_open_assistant(
        &mut self,
        _: &OpenAssistant,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.dismiss_compact_sidebar_for_navigation(window, cx);
        self.navigate_view(AppView::Assistant, window, cx);
    }

    /// ⌘⇧S: toggle the Subagents panel.
    fn on_toggle_subagents(
        &mut self,
        _: &ToggleSubagents,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.dismiss_compact_sidebar_for_navigation(window, cx);
        self.toggle_view(AppView::Subagents, window, cx);
    }

    /// ⌘⇧U: toggle the Usage panel.
    fn on_toggle_usage(&mut self, _: &ToggleUsage, window: &mut Window, cx: &mut Context<Self>) {
        self.dismiss_compact_sidebar_for_navigation(window, cx);
        self.toggle_view(AppView::Usage, window, cx);
    }

    /// ⌥⌘Space: focus the composer (the TS global `composer.focus`, bound
    /// in-app until the OS-global hotkey wiring lands).
    fn on_focus_composer(
        &mut self,
        _: &FocusComposer,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if self.environment_overlay_open(window, cx) {
            return;
        }
        self.dismiss_compact_sidebar_before_content_focus(cx);
        self.set_view(AppView::Chat, cx);
        self.composer_input
            .update(cx, |input, cx| input.focus(window, cx));
    }

    /// ⌘↩: send the composer contents from anywhere (plain Enter already
    /// sends while the composer is focused).
    fn on_send_message(&mut self, _: &SendMessage, window: &mut Window, cx: &mut Context<Self>) {
        if self.environment_overlay_open(window, cx) {
            return;
        }
        let text = self.composer_input.read(cx).value().to_string();
        self.send_composer(&text, window, cx);
    }

    fn on_save_file(&mut self, _: &SaveFile, window: &mut Window, cx: &mut Context<Self>) {
        if self.environment.read(cx).tab != crate::environment::EnvironmentTab::Files
            || !self.files.read(cx).focus_inside(window, cx)
        {
            return;
        }
        self.files.update(cx, |files, cx| files.save(window, cx));
    }

    // =======================================================================
    // View routing
    // =======================================================================

    /// Route the main content area (session-only; never persisted).
    pub(crate) fn set_view(&mut self, view: AppView, cx: &mut Context<Self>) {
        if self.view == AppView::Settings && view != AppView::Settings {
            self.service
                .update(cx, |service, cx| service.flush_appearance_save(cx));
        }
        if settings_auth_must_cancel_on_navigation(self.view, view) {
            let close_auth_dialog = self.cancel_settings_codex_auth(cx);
            if close_auth_dialog {
                let destination_focus = match post_auth_navigation_focus(view) {
                    PostAuthNavigationFocus::Composer => {
                        self.composer_input.read(cx).focus_handle(cx)
                    }
                    PostAuthNavigationFocus::Sidebar => self.sidebar_last_focus.clone(),
                };
                if let Some(window_handle) = cx.active_window() {
                    cx.defer(move |cx| {
                        let _ = window_handle.update(cx, |_, window, cx| {
                            window.close_dialog(cx);
                            destination_focus.focus(window);
                        });
                    });
                }
            }
            self.cancel_shortcut_recording(cx);
            self.settings_return_view = None;
            self.settings_return_focus = None;
        }
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

    fn cancel_shortcut_recording(&mut self, cx: &mut Context<Self>) {
        if let Some(settings) = &self.settings {
            settings.update(cx, |settings, cx| settings.cancel_shortcut_recording(cx));
        }
    }

    fn settings_codex_auth_active(&self, cx: &App) -> bool {
        self.settings
            .as_ref()
            .is_some_and(|settings| settings.read(cx).codex_auth_active())
    }

    fn cancel_settings_codex_auth(&self, cx: &mut Context<Self>) -> bool {
        self.settings.as_ref().is_some_and(|settings| {
            settings.update(cx, |settings, _| settings.cancel_codex_sign_in())
        })
    }

    fn enter_settings(
        &mut self,
        section: Option<SettingsSection>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.set_view(AppView::Settings, cx);
        let settings = self.settings_entity(window, cx);
        let workspace = self.service.read(cx).workspace.clone();
        settings.update(cx, |settings, cx| {
            settings.set_skills_workspace(workspace.as_ref(), cx)
        });
        if let Some(section) = section {
            settings.update(cx, |settings, cx| settings.select_section(section, cx));
        }
        cx.notify();
    }

    fn capture_settings_return(&mut self, origin_view: AppView, origin_focus: Option<FocusHandle>) {
        if origin_view == AppView::Settings {
            return;
        }
        self.settings_return_view =
            capture_settings_return_view(self.settings_return_view, origin_view);
        if self.settings_return_focus.is_none() {
            self.settings_return_focus = origin_focus;
        }
    }

    fn authorize_settings_entry(
        &mut self,
        mutation: PendingFilesMutation,
        origin_focus: Option<FocusHandle>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> bool {
        let origin_view = self.view;
        let gate = files_mutation_gate(self.files_dirty, self.files_saving);
        let allowed = self.authorize_files_mutation(mutation, window, cx);
        let pending_confirmation_established = !allowed
            && gate == FilesMutationGate::ConfirmDiscard
            && self.pending_files_mutation.is_some();
        if settings_return_capture_allowed(gate, pending_confirmation_established) {
            self.capture_settings_return(origin_view, origin_focus);
        }
        allowed
    }

    /// Route to Settings and select the Providers section (the shell's
    /// default settings landing spot).
    pub(crate) fn open_settings_section(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let return_focus = window.focused(cx);
        if self.authorize_settings_entry(
            PendingFilesMutation::Navigate(AppView::Settings),
            return_focus,
            window,
            cx,
        ) {
            self.enter_settings(Some(SettingsSection::Providers), window, cx);
        }
    }

    pub(crate) fn open_model_pad_settings(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if !model_pad_settings_entry_allowed(self.workspace_state.read(cx).git_busy) {
            return;
        }
        let return_focus = Some(self.model_picker_trigger_focus.clone());
        if self.authorize_settings_entry(
            PendingFilesMutation::Navigate(AppView::Settings),
            return_focus,
            window,
            cx,
        ) {
            self.enter_settings(Some(SettingsSection::ModelData), window, cx);
        }
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
        let opening = self
            .palette
            .as_ref()
            .is_none_or(|palette| !palette.read(cx).open);
        if opening && !competing_root_modal_allowed(self.settings_codex_auth_active(cx)) {
            return;
        }
        if opening {
            self.palette_invoker_focus = window.focused(cx);
        }
        self.dismiss_compact_sidebar_before_content_focus(cx);
        self.ensure_palette(window, cx);
        self.refresh_palette_source(cx);
        if let Some(palette) = &self.palette {
            palette.update(cx, |palette, cx| palette.toggle(window, cx));
        }
    }

    fn open_palette_mode(
        &mut self,
        mode: crate::panels::command_palette::PaletteMode,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if !competing_root_modal_allowed(self.settings_codex_auth_active(cx)) {
            return;
        }
        self.palette_invoker_focus = window.focused(cx);
        self.dismiss_compact_sidebar_before_content_focus(cx);
        self.ensure_palette(window, cx);
        self.refresh_palette_source(cx);
        if let Some(palette) = &self.palette {
            palette.update(cx, |palette, cx| {
                palette.open(window, cx);
                palette.enter_mode(mode, cx);
            });
        }
    }

    fn on_change_model(&mut self, _: &ChangeModel, window: &mut Window, cx: &mut Context<Self>) {
        self.open_palette_mode(
            crate::panels::command_palette::PaletteMode::Models,
            window,
            cx,
        );
    }

    fn on_manage_providers(
        &mut self,
        _: &ManageProviders,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.open_palette_mode(
            crate::panels::command_palette::PaletteMode::Providers,
            window,
            cx,
        );
    }

    fn on_search_settings(
        &mut self,
        _: &SearchSettings,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.open_palette_mode(
            crate::panels::command_palette::PaletteMode::Settings,
            window,
            cx,
        );
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
        if self.settings_codex_auth_active(cx) {
            return;
        }
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
        if self.settings_codex_auth_active(cx) {
            return;
        }
        let palette_invoker_focus = self.palette_invoker_focus.take();
        let settings_target = match &command {
            PaletteCommand::OpenSettings => Some(SettingsSection::Providers),
            PaletteCommand::OpenSettingsSection(id) => SettingsSection::parse(id),
            _ => None,
        };
        let settings_command = matches!(
            command,
            PaletteCommand::OpenSettings | PaletteCommand::OpenSettingsSection(_)
        );
        if settings_command && settings_target.is_none() {
            self.close_palette(window, cx);
            return;
        }
        if let Some(section) = settings_target {
            if !self.authorize_settings_entry(
                PendingFilesMutation::Palette(command.clone()),
                palette_invoker_focus.clone(),
                window,
                cx,
            ) {
                self.palette_invoker_focus = palette_invoker_focus;
                self.close_palette(window, cx);
                return;
            }
            self.enter_settings(Some(section), window, cx);
            return;
        }
        let changes_context = matches!(
            command,
            PaletteCommand::NewChat
                | PaletteCommand::SelectChat(_)
                | PaletteCommand::OpenScheduled
                | PaletteCommand::OpenUsage
                | PaletteCommand::OpenSubagents
                | PaletteCommand::OpenAssistant
                | PaletteCommand::Quit
                | PaletteCommand::NextChat
                | PaletteCommand::PreviousChat
        );
        if changes_context
            && !self.authorize_files_mutation(
                PendingFilesMutation::Palette(command.clone()),
                window,
                cx,
            )
        {
            self.palette_invoker_focus = palette_invoker_focus;
            self.close_palette(window, cx);
            return;
        }
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
                if self.service.read(cx).generation_active() {
                    self.palette_invoker_focus = palette_invoker_focus;
                    self.close_palette(window, cx);
                    return;
                }
                self.set_view(AppView::Chat, cx);
                self.service.update(cx, |service, cx| {
                    service.select_model(&provider_id, &model, cx);
                });
            }
            PaletteCommand::OpenSettings | PaletteCommand::OpenSettingsSection(_) => {}
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
            PaletteCommand::Quit => self.request_quit(cx),
            PaletteCommand::ToggleTerminal => self.toggle_terminal(window, cx),
            PaletteCommand::ToggleEnvironment => self.toggle_environment(window, cx),
            PaletteCommand::OpenWorkspaceEditor => {
                if !self.service.read(cx).generation_active() {
                    self.workspace_state.update(cx, |state, cx| {
                        state.open_preferred_editor(window, cx);
                    });
                }
            }
            PaletteCommand::FocusComposer => {
                self.composer_input
                    .update(cx, |input, cx| input.focus(window, cx));
            }
            PaletteCommand::NextChat | PaletteCommand::PreviousChat => {
                let forward = matches!(command, PaletteCommand::NextChat);
                self.cycle_chat(forward, window, cx);
            }
            PaletteCommand::RefreshProviders => {
                self.service
                    .update(cx, |service, cx| service.refresh_providers(cx));
                self.close_palette(window, cx);
            }
            PaletteCommand::ToggleSidebar
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
    fn cycle_chat(&mut self, forward: bool, window: &mut Window, cx: &mut Context<Self>) {
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
        self.navigate_chat(ids[next].clone(), window, cx);
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
        if self.environment_overlay_open(window, cx) {
            return;
        }
        self.dismiss_compact_sidebar_before_content_focus(cx);
        self.toggle_terminal(window, cx);
    }

    pub(crate) fn toggle_terminal(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        // The drawer only renders inside the chat view (see `chat_view`).
        // Toggling it from another view would silently flip its open state
        // with no visible feedback, and the drawer would pop open (with its
        // live PTY) the next time the user returns to Chat.
        if self.view != AppView::Chat {
            return;
        }
        if !crate::chat::toolbar::terminal_eligible(self.service.read(cx).workspace.as_ref()) {
            return;
        }
        let Some(entity) = self.terminal_entity(window, cx) else {
            return;
        };
        entity.update(cx, |terminal, cx| terminal.toggle(window, cx));
    }

    fn on_toggle_environment(
        &mut self,
        _: &ToggleEnvironment,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.toggle_environment(window, cx);
    }

    pub(crate) fn toggle_environment(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if !crate::chat::toolbar::terminal_eligible(self.service.read(cx).workspace.as_ref()) {
            return;
        }
        self.dismiss_compact_sidebar_for_navigation(window, cx);
        self.set_view(AppView::Chat, cx);
        let fallback = self.environment_toggle_focus.clone();
        self.environment.update(cx, |environment, cx| {
            environment.toggle(window, &fallback, cx);
        });
    }

    /// Create the terminal drawer once; the PTY stays alive across toggles
    /// (the drawer hides/shows, it is never destroyed).
    fn terminal_entity(
        &mut self,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Option<Entity<TerminalDrawer>> {
        if let Some(entity) = &self.terminal {
            return Some(entity.clone());
        }
        let cwd = self.service.read(cx).workspace_folder()?;
        let deps = TerminalDeps {
            shell: None,
            // The terminal starts in the active workspace folder (the git repo
            // root); a later workspace switch re-homes it via `set_cwd`.
            cwd: Some(cwd),
            simple: false,
        };
        let entity = cx.new(|cx| TerminalDrawer::new(cx, deps));
        let was_open = Rc::new(Cell::new(false));
        self._subscriptions.push(cx.observe_in(
            &entity,
            window,
            move |this, terminal, window, cx| {
                let open = terminal.read(cx).is_open();
                if was_open.replace(open) && !open {
                    this.terminal_toggle_focus.focus(window);
                }
                cx.notify();
            },
        ));
        self.terminal = Some(entity.clone());
        Some(entity)
    }

    // =======================================================================
    // Lazy panel entities (created on first navigation)
    // =======================================================================

    fn settings_entity(
        &mut self,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Entity<SettingsView> {
        if let Some(entity) = &self.settings {
            return entity.clone();
        }
        let shortcut_runtime = crate::shortcut_runtime::runtime(cx)
            .expect("shortcut runtime is initialized before the main window");
        let services =
            SettingsServices::from_stores(&self.stores, shortcut_runtime, self.service.clone());
        let workspace = self.service.read(cx).workspace.clone();
        let entity = cx.new(|cx| SettingsView::new(cx, services, workspace));
        self._subscriptions.push(cx.observe_in(
            &entity,
            window,
            |_this, _settings, _window, cx| cx.notify(),
        ));
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
                    window.push_notification("Scheduled task execution is not available yet.", cx);
                }
            },
        ));
        self.scheduled = Some(entity.clone());
        entity
    }

    /// Persist an enable/disable toggle through the shared scheduler authority,
    /// then reload the panel.
    fn toggle_scheduled_task(
        &mut self,
        panel: Entity<ScheduledPanel>,
        id: &str,
        enabled: bool,
        cx: &mut Context<Self>,
    ) {
        let scheduler = self.stores.scheduler.clone();
        let id = id.to_string();
        cx.spawn(async move |_this, cx| {
            cx.background_spawn(async move {
                if enabled {
                    let _ = scheduler.resume(&id).await;
                } else {
                    let _ = scheduler.pause(&id).await;
                }
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
        self.toggle_dictation_from_composer(cx);
    }

    pub(crate) fn toggle_dictation_from_composer(&mut self, cx: &mut Context<Self>) {
        if self.service.read(cx).generation_active() {
            return;
        }
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
    system_reduced_motion: bool,
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
        system_reduced_motion,
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
    if PILL_COORDINATOR.get().is_some() {
        return;
    }
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
                                let service = state.service.read(app);
                                (service.appearance.clone(), service.system_reduced_motion())
                            })
                            .ok()
                        })
                        .unwrap_or_else(|| {
                            (
                                aiden_core::appearance::create_default_appearance_config(),
                                false,
                            )
                        });
                    let created = bridge_show_pill(cx, &bridge_audio, &appearance.0, appearance.1);
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

impl Render for AppState {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = cx.theme().clone();

        let title = match self.view {
            AppView::Chat => crate::chat::toolbar::chat_title(
                self.service
                    .read(cx)
                    .active_chat
                    .as_ref()
                    .map(|chat| chat.title.as_str()),
            ),
            AppView::Assistant => "Assistant".to_string(),
            AppView::Scheduled => "Scheduled".to_string(),
            AppView::Usage => "Profile".to_string(),
            AppView::Subagents => "Subagents".to_string(),
            AppView::Settings => "Settings".to_string(),
        };
        let environment_overlay = self.environment_overlay_open(window, cx);
        let files_confirmation = self.files.read(cx).confirmation_open();
        let skills_modal = self
            .settings
            .as_ref()
            .is_some_and(|settings| settings.read(cx).skills_modal_open());
        let app_key_context = if skills_modal {
            "SettingsModal"
        } else if environment_overlay || files_confirmation {
            "EnvironmentModal"
        } else {
            "App"
        };
        let sidebar_blocker_width = if environment_overlay
            && !self.sidebar_visibility.compact
            && self.sidebar_visibility.visible()
        {
            self.sidebar_width
        } else {
            0.0
        };

        v_flex()
            .id("aiden-root")
            .relative()
            .size_full()
            .bg(theme.background)
            .text_color(theme.foreground)
            .key_context(app_key_context)
            .on_key_down(cx.listener(|this, event: &gpui::KeyDownEvent, window, cx| {
                if let Some(settings) = this
                    .settings
                    .clone()
                    .filter(|settings| settings.read(cx).skills_modal_open())
                {
                    if event.keystroke.key == "escape" {
                        settings.update(cx, |settings, cx| settings.close_skills_modal(window, cx));
                        cx.stop_propagation();
                        return;
                    }
                    if event.keystroke.key == "tab" {
                        let (handles, focus_inside) = {
                            let state = settings.read(cx);
                            (
                                state.skills_modal_focus_handles(cx),
                                state.skills_modal_contains_focus(window, cx),
                            )
                        };
                        if let Some((first, last)) = handles {
                            let focused = window.focused(cx);
                            let backwards = event.keystroke.modifiers.shift;
                            if backwards && focused.as_ref() == Some(&first) {
                                last.focus(window);
                            } else if !backwards && focused.as_ref() == Some(&last) {
                                first.focus(window);
                            } else if !focus_inside {
                                if backwards {
                                    last.focus(window);
                                } else {
                                    first.focus(window);
                                }
                            } else {
                                return;
                            }
                            cx.stop_propagation();
                        }
                    }
                    return;
                }
                if this.files.read(cx).confirmation_open() {
                    if event.keystroke.key == "escape" {
                        this.files
                            .update(cx, |files, cx| files.cancel_confirmation(window, cx));
                        cx.stop_propagation();
                        return;
                    }
                    if event.keystroke.key == "tab" {
                        let (first, last) = {
                            let files = this.files.read(cx);
                            (
                                files.confirmation_focus.clone(),
                                files.confirmation_last_focus.clone(),
                            )
                        };
                        let focused = window.focused(cx);
                        if event.keystroke.modifiers.shift {
                            if focused.as_ref() == Some(&last) {
                                return;
                            }
                            last.focus(window);
                        } else {
                            if focused.as_ref() == Some(&first) {
                                return;
                            }
                            first.focus(window);
                        }
                        cx.stop_propagation();
                        return;
                    }
                }
                if window.has_active_dialog(cx) {
                    return;
                }
                if this.view == AppView::Settings && event.keystroke.key == "escape" {
                    let search_focus = this.settings_navigation.search.read(cx).focus_handle(cx);
                    match settings_escape_target(
                        search_focus.is_focused(window),
                        this.sidebar_visibility.compact_open,
                    ) {
                        SettingsEscapeTarget::ClearSearchAndFocusBack => {
                            this.settings_navigation.search.update(cx, |input, cx| {
                                input.set_value("", window, cx);
                            });
                            this.settings_navigation.back_focus.focus(window);
                            cx.stop_propagation();
                            return;
                        }
                        SettingsEscapeTarget::DismissCompact => {
                            this.dismiss_compact_sidebar(window, cx);
                            cx.stop_propagation();
                            return;
                        }
                        SettingsEscapeTarget::Native => return,
                    }
                }
                let environment_open = this.environment.read(cx).open;
                if environment_workbench_rendered(this.view)
                    && environment_open
                    && event.keystroke.key == "escape"
                {
                    if this.environment.read(cx).tab == crate::environment::EnvironmentTab::Files
                        && this.files.read(cx).confirmation_open()
                    {
                        this.files
                            .update(cx, |files, cx| files.cancel_confirmation(window, cx));
                        cx.stop_propagation();
                        return;
                    }
                    let fallback = this.environment_toggle_focus.clone();
                    this.environment.update(cx, |environment, cx| {
                        environment.close(window, &fallback, cx);
                    });
                    cx.stop_propagation();
                    return;
                }
                if this.environment_overlay_open(window, cx) && event.keystroke.key == "tab" {
                    let (first, last, focus_inside) = {
                        let environment = this.environment.read(cx);
                        (
                            environment.first_focus.clone(),
                            environment.last_focus.clone(),
                            environment.panel_scope.contains_focused(window, cx),
                        )
                    };
                    let focused = window.focused(cx);
                    let backwards = event.keystroke.modifiers.shift;
                    if backwards && focused.as_ref() == Some(&first) {
                        last.focus(window);
                    } else if !backwards && focused.as_ref() == Some(&last) {
                        first.focus(window);
                    } else if !focus_inside {
                        if backwards {
                            last.focus(window);
                        } else {
                            first.focus(window);
                        }
                    } else {
                        return;
                    }
                    cx.stop_propagation();
                    return;
                }
                if !this.sidebar_visibility.compact_open {
                    return;
                }
                if this.view == AppView::Settings {
                    if event.keystroke.key != "tab" {
                        return;
                    }
                    let focused = window.focused(cx);
                    let last_rail_focus = this.settings_navigation.last_visible_focus(cx);
                    let target = settings_compact_tab_target(
                        event.keystroke.modifiers.shift,
                        focused.as_ref() == Some(&this.settings_navigation.back_focus),
                        focused.as_ref() == Some(&this.sidebar_toggle_focus),
                        focused.as_ref() == Some(&last_rail_focus),
                        this.settings_navigation.scope.contains_focused(window, cx),
                    );
                    match target {
                        SettingsCompactTabTarget::Native => return,
                        SettingsCompactTabTarget::Back => {
                            this.settings_navigation.back_focus.focus(window)
                        }
                        SettingsCompactTabTarget::LastRailControl => last_rail_focus.focus(window),
                        SettingsCompactTabTarget::LeadingToggle => {
                            this.sidebar_toggle_focus.focus(window)
                        }
                    }
                    cx.stop_propagation();
                    return;
                }
                let search_focus = this.search_input.read(cx).focus_handle(cx);
                if event.keystroke.key == "escape" {
                    if search_focus.is_focused(window)
                        && !this.search_input.read(cx).value().is_empty()
                    {
                        this.search_input
                            .update(cx, |input, cx| input.set_value("", window, cx));
                    } else {
                        this.dismiss_compact_sidebar(window, cx);
                    }
                    cx.stop_propagation();
                    return;
                }
                if event.keystroke.key != "tab" {
                    return;
                }
                let backwards = event.keystroke.modifiers.shift;
                let focused = window.focused(cx);
                if backwards && focused.as_ref() == Some(&search_focus) {
                    this.sidebar_toggle_focus.focus(window);
                } else if backwards && focused.as_ref() == Some(&this.sidebar_toggle_focus) {
                    this.sidebar_last_focus.focus(window);
                } else if !backwards && focused.as_ref() == Some(&this.sidebar_last_focus) {
                    this.sidebar_toggle_focus.focus(window);
                } else if !backwards && focused.as_ref() == Some(&this.sidebar_toggle_focus) {
                    search_focus.focus(window);
                } else if focused.as_ref() != Some(&search_focus)
                    && focused.as_ref() != Some(&this.sidebar_last_focus)
                {
                    if backwards {
                        this.sidebar_toggle_focus.focus(window);
                    } else {
                        search_focus.focus(window);
                    }
                } else {
                    return;
                }
                cx.stop_propagation();
            }))
            .on_action(cx.listener(Self::on_new_chat))
            .on_action(cx.listener(Self::on_quit))
            .on_action(cx.listener(Self::on_toggle_palette))
            .on_action(cx.listener(Self::on_toggle_terminal))
            .on_action(cx.listener(Self::on_toggle_environment))
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
            .on_action(cx.listener(Self::on_open_assistant))
            .on_action(cx.listener(Self::on_toggle_subagents))
            .on_action(cx.listener(Self::on_toggle_usage))
            .on_action(cx.listener(Self::on_focus_composer))
            .on_action(cx.listener(Self::on_send_message))
            .on_action(cx.listener(Self::on_save_file))
            .on_action(cx.listener(Self::on_change_model))
            .on_action(cx.listener(Self::on_manage_providers))
            .on_action(cx.listener(Self::on_search_settings))
            .child(self.shell_body(title, window, cx))
            .when(sidebar_blocker_width > 0.0, |el| {
                el.child(
                    div()
                        .id("environment-sidebar-modal-blocker")
                        .absolute()
                        .top_0()
                        .bottom_0()
                        .left_0()
                        .w(px(sidebar_blocker_width))
                        .occlude()
                        .on_mouse_down(gpui::MouseButton::Left, |_event, _window, cx| {
                            cx.stop_propagation();
                        })
                        .on_click(|_event, _window, cx| cx.stop_propagation()),
                )
            })
            .when(!environment_overlay, |el| {
                el.child(
                    div()
                        .id("leading-sidebar-toggle")
                        .absolute()
                        .top_0()
                        .left(px(90.))
                        .h(px(52.))
                        .w(px(36.))
                        .flex()
                        .items_center()
                        .justify_center()
                        .track_focus(&self.sidebar_toggle_focus)
                        .tab_stop(true)
                        .focus(move |style| style.bg(theme.list_active))
                        .on_key_down(cx.listener(|this, event: &gpui::KeyDownEvent, window, cx| {
                            if matches!(event.keystroke.key.as_str(), "enter" | "space") {
                                this.toggle_sidebar(window, cx);
                                cx.stop_propagation();
                            }
                        }))
                        .child(
                            gpui_component::button::Button::new("titlebar-sidebar-toggle")
                                .ghost()
                                .xsmall()
                                .tab_stop(false)
                                .icon(if self.sidebar_visibility.visible() {
                                    IconName::PanelLeftClose
                                } else {
                                    IconName::PanelLeftOpen
                                })
                                .tooltip("Toggle sidebar (⌃⌘S)")
                                .on_click(cx.listener(|this, _event, window, cx| {
                                    this.toggle_sidebar(window, cx);
                                })),
                        ),
                )
            })
            .when(files_confirmation, |el| {
                el.child(crate::environment::files_confirmation_modal(
                    &self.files,
                    cx,
                ))
            })
            .when(skills_modal, |el| {
                el.when_some(self.settings.clone(), |el, settings| {
                    el.child(crate::settings::skills::skills_modal(&settings, cx))
                })
            })
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
        let terminal = self
            .terminal
            .as_ref()
            .filter(|terminal| terminal.read(cx).is_open())
            .cloned();
        v_flex()
            .id("chat-view")
            .flex_1()
            .h_full()
            .min_w(px(0.))
            .child(self.chat_pane(window, cx))
            .when_some(terminal, |el, terminal| el.child(terminal))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pending_files_replay_rechecks_live_busy_state() {
        assert!(pending_files_replay_authorized(false, false, false, true));
        assert!(!pending_files_replay_authorized(true, false, false, true));
        assert!(!pending_files_replay_authorized(false, true, false, true));
        assert!(!pending_files_replay_authorized(false, false, true, true));
        assert!(!pending_files_replay_authorized(false, false, false, false));
    }

    #[test]
    fn view_router_defaults_to_chat() {
        assert_eq!(AppView::default(), AppView::Chat);
    }

    #[test]
    fn leaving_settings_cancels_retained_auth_but_in_section_navigation_does_not() {
        assert!(settings_auth_must_cancel_on_navigation(
            AppView::Settings,
            AppView::Chat
        ));
        assert!(!settings_auth_must_cancel_on_navigation(
            AppView::Settings,
            AppView::Settings
        ));
        assert!(!settings_auth_must_cancel_on_navigation(
            AppView::Chat,
            AppView::Settings
        ));
    }

    #[test]
    fn active_auth_dialog_blocks_stacking_and_late_finish_cannot_pop_replacement() {
        let lease = crate::services::codex_auth::CodexDialogLease::default();
        lease.mark_open();
        assert!(!competing_root_modal_allowed(lease.is_open()));

        lease.mark_closed();
        assert!(competing_root_modal_allowed(lease.is_open()));
        assert!(!lease.take_owned_dialog());
    }

    #[test]
    fn chat_navigation_detaches_auth_before_late_finish_and_keeps_destination_focus() {
        let lease = crate::services::codex_auth::CodexDialogLease::default();
        lease.mark_open();
        assert!(lease.take_owned_dialog());
        assert_eq!(
            post_auth_navigation_focus(AppView::Chat),
            PostAuthNavigationFocus::Composer
        );

        assert!(!lease.take_owned_dialog());
        assert!(!lease.should_restore_focus());
    }

    #[test]
    fn settings_section_mapping_covers_palette_destinations() {
        for section in SettingsSection::ALL {
            assert_eq!(SettingsSection::parse(section.as_str()), Some(*section));
        }
        assert_eq!(SettingsSection::parse("scheduled-tasks"), None);
        assert_eq!(SettingsSection::parse("usage"), None);
    }

    #[test]
    fn appearance_mode_cycles_through_all_three_modes() {
        assert_eq!(cycle_appearance_mode(Mode::System), Mode::Light);
        assert_eq!(cycle_appearance_mode(Mode::Light), Mode::Dark);
        assert_eq!(cycle_appearance_mode(Mode::Dark), Mode::System);
    }

    #[test]
    fn files_mutation_gate_allows_clean_confirms_dirty_and_blocks_saving() {
        assert_eq!(files_mutation_gate(false, false), FilesMutationGate::Allow);
        assert_eq!(
            files_mutation_gate(true, false),
            FilesMutationGate::ConfirmDiscard
        );
        assert_eq!(
            files_mutation_gate(true, true),
            FilesMutationGate::BlockSaving
        );
    }

    #[test]
    fn blocked_settings_routes_leave_no_stale_return_state_then_capture_on_success() {
        for route in ["navigation", "command shortcut", "palette"] {
            let mut return_view = None;
            if settings_return_capture_allowed(FilesMutationGate::BlockSaving, false) {
                return_view = capture_settings_return_view(return_view, AppView::Chat);
            }
            assert_eq!(return_view, None, "{route} must not capture while saving");

            if settings_return_capture_allowed(FilesMutationGate::Allow, false) {
                return_view = capture_settings_return_view(return_view, AppView::Chat);
            }
            assert_eq!(
                return_view,
                Some(AppView::Chat),
                "{route} captures the fresh origin after the later successful attempt"
            );
        }
    }

    #[test]
    fn dirty_settings_route_captures_only_after_confirmation_is_established() {
        assert!(!settings_return_capture_allowed(
            FilesMutationGate::ConfirmDiscard,
            false
        ));
        assert!(settings_return_capture_allowed(
            FilesMutationGate::ConfirmDiscard,
            true
        ));
    }

    #[test]
    fn focused_settings_search_wins_escape_before_a_hidden_environment() {
        assert!(!environment_workbench_rendered(AppView::Settings));
        assert_eq!(
            settings_escape_target(true, false),
            SettingsEscapeTarget::ClearSearchAndFocusBack
        );
        assert!(environment_workbench_rendered(AppView::Chat));
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
            deployment: Some(aiden_data::portable_config::ProviderDeployment::Local),
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
    fn catalog_fingerprint_detects_same_count_model_replacement() {
        let mut provider = ConfiguredProvider {
            id: "p".into(),
            label: "Provider".into(),
            kind: aiden_data::portable_config::ProviderKind::Openai,
            base_url: "https://example.test/v1".into(),
            deployment: Some(aiden_data::portable_config::ProviderDeployment::Hosted),
            models: vec!["old".into()],
            default_model: Some("old".into()),
            model_metadata: Default::default(),
            catalog_models: Vec::new(),
            needs_key: false,
            has_key: true,
        };
        let before = provider_catalog_fingerprint(&[provider.clone()]);
        provider.models = vec!["new".into()];

        assert_ne!(before, provider_catalog_fingerprint(&[provider]));
    }

    #[test]
    fn model_pad_settings_entry_is_blocked_while_git_is_busy() {
        assert!(!model_pad_settings_entry_allowed(true));
        assert!(model_pad_settings_entry_allowed(false));
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
