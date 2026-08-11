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

use aiden_computer_use::{
    ComputerUseApprovalDecision, ComputerUseApprovalRequest, ComputerUseEnableIntent,
    ComputerUseNoticeDismissal, ComputerUsePrivacyNoticeState, COMPUTER_USE_NOTICE_DISMISSED_KEY,
    COMPUTER_USE_NOTICE_VERSION,
};
use aiden_core::app_update::AppUpdateSnapshot;
use aiden_core::appearance::{Mode, ReduceMotion};
use futures::FutureExt;
use gpui::{
    actions, div, prelude::FluentBuilder as _, px, Animation, AnimationExt as _, App,
    AppContext as _, Context, Entity, FocusHandle, Focusable as _, FontWeight,
    InteractiveElement as _, IntoElement, ParentElement as _, Render, ScrollHandle,
    StatefulInteractiveElement as _, Styled as _, Subscription, Timer, Window,
};
#[cfg(target_os = "macos")]
use gpui_component::{
    button::{Button, ButtonVariants as _},
    h_flex,
    input::{Input, InputEvent, InputState},
    resizable::ResizableState,
    scroll::ScrollableElement as _,
    v_flex, ActiveTheme, Disableable as _, IconName, PixelsExt as _, Sizable as _, WindowExt as _,
};
use gpui_tokio_bridge::Tokio;
use std::time::Duration;

use crate::assistant::{AssistantPanel, AssistantPanelDeps, AssistantPanelEvent};
use crate::chat::composer::{model_items_with_layout, model_key, COMPOSER_MAX_ROWS};
use crate::chat::model_pad_picker::ModelPadRuntime;
use crate::chat::model_picker::{ComposerModelPicker, ModelPickerPins};
use crate::chat::slash::{
    parse_slash_query, rank_commands, rank_skills, should_open_palette, RankedSkill,
    RankedSlashCommand, SkillInvocationSelection, SlashQuery,
};
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
use crate::panels::subagents_panel::{SubagentRunSource, SubagentsPanel, SubagentsPanelDeps};
use crate::panels::terminal_drawer::{TerminalDeps, TerminalDrawer};
use crate::panels::usage_panel::{StoreUsageSource, UsageDataSource, UsagePanel, UsagePanelDeps};
use crate::pill::{
    open_pill_window, LiveAudioSource, PillCoordinator, PillCoordinatorDeps, PillDeps, PillView,
};
use crate::services::accessibility_announcements::{
    AccessibilityAnnouncementState, GenerationAnnouncementPhase,
};
use crate::services::chat_service::{ActiveSubagentApproval, ChatService};
use crate::services::provider_kit::ConfiguredProvider;
use crate::services::skill_tools::{
    collect_skill_catalog, stream_context_for_mode, SkillCatalogEntry, SkillRuntimeMode,
};
use crate::services::stores::Stores;
use crate::services::subagents::{
    SubagentMcpMutationApprovalRequest, SubagentMcpMutationDecision,
    SubagentMcpReadApprovalRequest, SubagentMcpReadDecision, SubagentShellApprovalRequest,
    SubagentShellDecision, SubagentWorkspaceWriteApprovalRequest, SubagentWorkspaceWriteDecision,
};
use crate::settings::navigation::{
    capture_settings_return_view, settings_compact_tab_target, settings_escape_target,
    SettingsCompactTabTarget, SettingsEscapeTarget, SettingsNavigation,
};
use crate::settings::{SettingsEvent, SettingsSection, SettingsServices, SettingsView};
use crate::workspace::{NotificationKind, WorkspaceEvent, WorkspaceState};

fn pending_files_replay_authorized(
    generation_active: bool,
    git_busy: bool,
    files_saving: bool,
    pending: bool,
) -> bool {
    pending && !generation_active && !git_busy && !files_saving
}

const COMPUTER_USE_QUIT_FAILURE: &str =
    "Aiden couldn't save Computer Use safely, so it stayed open. Check settings access and try quitting again.";

fn claim_quit(quit_in_flight: &mut bool) -> bool {
    if *quit_in_flight {
        return false;
    }
    *quit_in_flight = true;
    true
}

fn trapped_focus_index(backwards: bool, position: Option<usize>, count: usize) -> usize {
    debug_assert!(count > 0);
    match (backwards, position) {
        (true, Some(0) | None) => count - 1,
        (true, Some(position)) => position - 1,
        (false, Some(position)) if position + 1 == count => 0,
        (false, Some(position)) => position + 1,
        (false, None) => 0,
    }
}

fn computer_use_escape_decision(deciding: bool) -> Option<ComputerUseApprovalDecision> {
    (!deciding).then_some(ComputerUseApprovalDecision::Deny)
}

fn subagent_write_escape_decision(deciding: bool) -> Option<SubagentWorkspaceWriteDecision> {
    (!deciding).then_some(SubagentWorkspaceWriteDecision::Deny)
}

#[derive(Default)]
struct SubagentWriteModalFocusState {
    active_id: Option<String>,
    return_focus: Option<FocusHandle>,
}

enum SubagentWriteModalFocusTransition {
    Unchanged,
    FocusDeny,
    Restore(FocusHandle),
}

impl SubagentWriteModalFocusState {
    fn reconcile(
        &mut self,
        next_id: Option<&str>,
        current_focus: Option<FocusHandle>,
    ) -> SubagentWriteModalFocusTransition {
        if self.active_id.as_deref() == next_id {
            return SubagentWriteModalFocusTransition::Unchanged;
        }
        if let Some(next_id) = next_id {
            if self.active_id.is_none() {
                self.return_focus = current_focus;
            }
            self.active_id = Some(next_id.to_string());
            SubagentWriteModalFocusTransition::FocusDeny
        } else {
            self.active_id = None;
            self.return_focus
                .take()
                .map_or(SubagentWriteModalFocusTransition::Unchanged, |focus| {
                    SubagentWriteModalFocusTransition::Restore(focus)
                })
        }
    }
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
/// Appearance owned by the process rather than the visible main-window
/// entity. The pill remains usable after that entity is closed, so retaining
/// the last authoritative snapshot avoids silently reverting to the default
/// palette or motion policy on the next windowless dictation.
#[derive(Clone)]
struct PillAppearanceSnapshot {
    appearance: aiden_core::appearance::AppearanceConfig,
    system_reduced_motion: bool,
}

static PILL_APPEARANCE: std::sync::OnceLock<Arc<std::sync::RwLock<PillAppearanceSnapshot>>> =
    std::sync::OnceLock::new();

fn pill_appearance_store() -> &'static Arc<std::sync::RwLock<PillAppearanceSnapshot>> {
    PILL_APPEARANCE.get_or_init(|| {
        Arc::new(std::sync::RwLock::new(PillAppearanceSnapshot {
            appearance: aiden_core::appearance::create_default_appearance_config(),
            system_reduced_motion: false,
        }))
    })
}

fn publish_pill_appearance(appearance: aiden_core::appearance::AppearanceConfig, reduced: bool) {
    let snapshot = PillAppearanceSnapshot {
        appearance,
        system_reduced_motion: reduced,
    };
    match pill_appearance_store().write() {
        Ok(mut current) => *current = snapshot,
        Err(poisoned) => *poisoned.into_inner() = snapshot,
    }
}

fn read_pill_appearance() -> (aiden_core::appearance::AppearanceConfig, bool) {
    match pill_appearance_store().read() {
        Ok(snapshot) => (snapshot.appearance.clone(), snapshot.system_reduced_motion),
        Err(poisoned) => {
            let snapshot = poisoned.into_inner();
            (snapshot.appearance.clone(), snapshot.system_reduced_motion)
        }
    }
}

fn pill_appearance_for_show(
    live: Option<(aiden_core::appearance::AppearanceConfig, bool)>,
    cached: (aiden_core::appearance::AppearanceConfig, bool),
) -> (aiden_core::appearance::AppearanceConfig, bool) {
    live.unwrap_or(cached)
}
/// Mirrors the active chat's generation state for the OS-global dictation
/// callback, which runs outside the `AppState` entity.
static CHAT_GENERATION_ACTIVE: AtomicBool = AtomicBool::new(false);

/// Handle the process-wide dictation shortcut without requiring a visible
/// main window. Electron keeps the pill usable after the main window is
/// closed; the coordinator is app-lifetime state and can be toggled
/// directly from the GPUI application executor. Returning `true` also
/// tells the shortcut dispatcher that the command was handled, including
/// the intentional generation-active no-op, so it never falls through to
/// a window-activating action.
pub(crate) fn toggle_global_dictation(cx: &App) -> bool {
    if CHAT_GENERATION_ACTIVE.load(Ordering::Relaxed) {
        return true;
    }
    let Some(pill) = PILL_COORDINATOR.get().cloned() else {
        return false;
    };
    cx.spawn(async move |_cx| {
        pill.toggle().await;
    })
    .detach();
    true
}

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

/// The UI half of persistence-first composer submission. It owns the exact
/// draft snapshot until the service reports the matching durable admission;
/// this prevents a late completion from clearing text the user typed after a
/// failed or superseded request.
#[derive(Default)]
struct ComposerSubmissionCoordinator {
    pending: Option<(
        crate::services::chat_service::ChatSubmissionIdentity,
        String,
        crate::chat::composer::ComposerDraft,
    )>,
}

impl ComposerSubmissionCoordinator {
    fn begin(
        &mut self,
        submission: crate::services::chat_service::ChatSubmissionIdentity,
        text: String,
        draft: crate::chat::composer::ComposerDraft,
    ) -> bool {
        if self.pending.is_some() {
            return false;
        }
        self.pending = Some((submission, text, draft));
        true
    }

    fn pending(
        &self,
    ) -> Option<&(
        crate::services::chat_service::ChatSubmissionIdentity,
        String,
        crate::chat::composer::ComposerDraft,
    )> {
        self.pending.as_ref()
    }

    /// Consume a durable admission only when it belongs to the currently
    /// pending submission. Returns whether the visible composer still exactly
    /// matches the snapshotted draft and therefore may be cleared once.
    fn settle(
        &mut self,
        submission: &crate::services::chat_service::ChatSubmissionIdentity,
        outcome: Option<crate::services::chat_service::ChatSubmissionOutcome>,
        current_text: &str,
        current_draft: &crate::chat::composer::ComposerDraft,
    ) -> bool {
        let Some((pending, text, draft)) = self.pending.as_ref() else {
            return false;
        };
        let Some(outcome) = outcome else {
            return false;
        };
        if pending != submission {
            return false;
        }
        if outcome == crate::services::chat_service::ChatSubmissionOutcome::Rejected {
            self.pending = None;
            return false;
        }
        if outcome == crate::services::chat_service::ChatSubmissionOutcome::Unknown {
            // Do not discard the exact draft and do not permit an unsafe
            // duplicate retry until the user follows the recovery guidance.
            return false;
        }
        let clear = text == current_text
            && draft.attachments == current_draft.attachments
            && draft.editing_message_id == current_draft.editing_message_id
            && draft.skill_selection == current_draft.skill_selection;
        self.pending = None;
        clear
    }
}

/// Session-only state for the non-modal composer slash surface. The catalog is
/// renderer-safe metadata; explicit skill selection remains an opaque draft
/// value and does not grant any runtime permission.
#[derive(Default)]
pub(crate) struct SlashPaletteState {
    pub(crate) open: bool,
    pub(crate) query: Option<SlashQuery>,
    pub(crate) commands: Vec<RankedSlashCommand>,
    pub(crate) skills: Vec<RankedSkill>,
    pub(crate) catalog: Vec<SkillCatalogEntry>,
    pub(crate) selected: usize,
    pub(crate) catalog_loading: bool,
    pub(crate) catalog_loaded: bool,
    pub(crate) catalog_identity: Option<String>,
    pub(crate) notice: Option<String>,
}

/// Snapshot the one opaque skill descriptor for the service's send-time
/// resolver. Expanded instructions never live in the draft.
pub(crate) fn skill_selection_for_send(
    selection: &crate::chat::slash::SkillSelection,
) -> Option<SkillInvocationSelection> {
    selection.selected().cloned()
}

impl SlashPaletteState {
    fn catalog_refresh_needed(&self, workspace_identity: &str) -> bool {
        !self.catalog_loading
            && (!self.catalog_loaded
                || self.catalog_identity.as_deref() != Some(workspace_identity))
    }

    fn recompute(&mut self) {
        let Some(query) = self.query.as_ref() else {
            self.open = false;
            self.commands.clear();
            self.skills.clear();
            self.selected = 0;
            return;
        };
        self.commands = rank_commands(&query.query);
        self.skills = rank_skills(&query.query, &self.catalog);
        self.open = should_open_palette(query, self.commands.len(), self.skills.len());
        let count = self.commands.len() + self.skills.len();
        self.selected = if count == 0 {
            0
        } else {
            self.selected.min(count - 1)
        };
    }

    fn close(&mut self) {
        self.open = false;
        self.query = None;
        self.commands.clear();
        self.skills.clear();
        self.selected = 0;
    }

    fn move_selection(&mut self, forward: bool) {
        let count = self.commands.len() + self.skills.len();
        if count == 0 {
            return;
        }
        self.selected = if forward {
            (self.selected + 1) % count
        } else if self.selected == 0 {
            count - 1
        } else {
            self.selected - 1
        };
    }

    fn selected_command_id(&self) -> Option<&'static str> {
        (self.selected < self.commands.len()).then(|| self.commands[self.selected].definition.id)
    }

    fn selected_skill(&self) -> Option<SkillCatalogEntry> {
        if self.selected < self.commands.len() {
            return None;
        }
        self.skills
            .get(self.selected - self.commands.len())
            .map(|row| row.entry.clone())
    }
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
    /// Exact draft awaiting the persistence-first submission admission.
    composer_submission: ComposerSubmissionCoordinator,
    /// Non-modal slash palette session (kept separate from Command-K dialog).
    pub(crate) slash_palette: SlashPaletteState,
    slash_catalog_revision: u64,
    last_catalog: Vec<String>,
    /// Last workspace id seen from the service (terminal cwd re-home on change).
    last_workspace_id: Option<String>,
    appearance_applied: bool,
    /// Latest app-update state published by the process-lifetime authority.
    /// The sidebar consumes this immutable snapshot; no renderer/network
    /// work is performed during render.
    pub(crate) app_update_snapshot: AppUpdateSnapshot,
    pub(crate) app_update_dismissed_version: Option<String>,
    /// Coarse lifecycle state used to send deduplicated VoiceOver announcements.
    accessibility_announcements: AccessibilityAnnouncementState,
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
    /// One app-root-owned Assistant entity; its panel never participates in
    /// route replacement, so an active chat remains mounted while it opens.
    assistant: Option<Entity<AssistantPanel>>,
    assistant_open: bool,
    /// Keeps the panel painted through its short minimize exit. The bubble is
    /// deliberately withheld until this is false, avoiding a double surface.
    assistant_present: bool,
    assistant_return_focus: Option<FocusHandle>,
    assistant_bubble_focus: FocusHandle,
    assistant_unread: u8,
    assistant_preview: Option<String>,
    assistant_preview_generation: u64,
    pub(crate) terminal: Option<Entity<TerminalDrawer>>,
    pub(crate) environment: Entity<EnvironmentWorkbench>,
    pub(crate) files: Entity<FilesWorkbench>,
    pub(crate) review: Entity<ReviewWorkbench>,
    files_dirty: bool,
    files_saving: bool,
    pending_files_mutation: Option<PendingFilesMutation>,
    quit_in_flight: bool,
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
    computer_use_deny_focus: FocusHandle,
    computer_use_allow_focus: FocusHandle,
    subagent_write_modal_focus: SubagentWriteModalFocusState,
    subagent_write_deny_focus: FocusHandle,
    subagent_write_allow_focus: FocusHandle,
    subagent_shell_deny_focus: FocusHandle,
    subagent_shell_allow_focus: FocusHandle,
    subagent_mcp_read_deny_focus: FocusHandle,
    subagent_mcp_read_allow_focus: FocusHandle,
    subagent_mcp_mutation_deny_focus: FocusHandle,
    subagent_mcp_mutation_allow_focus: FocusHandle,
    computer_use_privacy: ComputerUsePrivacyNoticeState,
    computer_use_privacy_return_focus: Option<FocusHandle>,
    computer_use_privacy_cancel_focus: FocusHandle,
    computer_use_privacy_session_focus: FocusHandle,
    computer_use_privacy_permanent_focus: FocusHandle,
    pi_provider_setup: Option<PiProviderSetupModal>,
    pi_provider_cancel_focus: FocusHandle,
    pi_provider_save_focus: FocusHandle,
    pi_provider_sign_out_focus: FocusHandle,
}

struct PiProviderSetupModal {
    provider_id: String,
    label: String,
    lease: crate::services::pi_provider_setup::PiSetupLease,
    api_key: Entity<InputState>,
    configured: bool,
    busy: bool,
    error: Option<String>,
    return_focus: Option<FocusHandle>,
}

fn pi_provider_setup_can_close(busy: bool) -> bool {
    !busy
}

fn pi_provider_setup_completion_is_current(
    active_provider_id: &str,
    active_lease: crate::services::pi_provider_setup::PiSetupLease,
    completed_provider_id: &str,
    completed_lease: crate::services::pi_provider_setup::PiSetupLease,
) -> bool {
    active_provider_id == completed_provider_id && active_lease == completed_lease
}

impl AppState {
    /// Canonical bottom-right dock. This lives outside `content_view`, making
    /// it stable across routes and ensuring there can only be one panel entity.
    fn assistant_dock(&mut self, window: &mut Window, cx: &mut Context<Self>) -> gpui::AnyElement {
        if self.assistant_interaction_blocked(window, cx) {
            return div().id("assistant-dock-inert").into_any_element();
        }
        let theme = cx.theme();
        let viewport = window.viewport_size();
        let dock_width = assistant_dock_width(viewport.width.as_f32());
        let dock_height = assistant_dock_height(viewport.height.as_f32());
        if assistant_entity_required_for_dock(self.assistant_open, self.assistant_present)
            && assistant_dock_panel_present(self.assistant_open, self.assistant_present)
        {
            // The bubble is deliberately cheap: constructing the entity boots
            // the MCP inventory, so defer it until an explicit open.
            let Some(panel) = self.assistant.clone() else {
                return div().id("assistant-dock-missing-panel").into_any_element();
            };
            let dock = div()
                .id("assistant-dock")
                .absolute()
                .right_4()
                .bottom_4()
                .w(px(dock_width))
                .h(px(dock_height))
                .rounded_xl()
                .overflow_hidden()
                .bg(theme.popover)
                .border_1()
                .border_color(theme.border)
                .shadow_lg();
            if self.assistant_open {
                return dock.child(panel).into_any_element();
            }
            // The retained exit shell has no panel child: fading the actual
            // panel would leave its composer hit targets and tab stops alive.
            // Animate the complete inert chrome (surface, border, shadow).
            return dock
                .child(
                    div()
                        .id("assistant-dock-exit-snapshot")
                        .size_full()
                        .bg(theme.popover),
                )
                .with_animation(
                    "assistant-dock-close",
                    Animation::new(Duration::from_millis(120)),
                    |dock, progress| dock.opacity(1. - progress),
                )
                .into_any_element();
        }

        let unread = if self.assistant_unread > 9 {
            "9+".to_string()
        } else {
            self.assistant_unread.to_string()
        };
        let pointer = crate::services::appearance::pointer_cursors_enabled(cx);
        h_flex()
            .id("assistant-bubble")
            .absolute()
            .right_4()
            .bottom_4()
            .gap_2()
            .items_center()
            .track_focus(&self.assistant_bubble_focus)
            .tab_stop(true)
            .when(pointer, |el| el.cursor_pointer())
            .on_key_down(cx.listener(|this, event: &gpui::KeyDownEvent, window, cx| {
                if matches!(event.keystroke.key.as_str(), "enter" | "space") {
                    this.open_assistant(window, cx);
                    cx.stop_propagation();
                }
            }))
            .on_click(cx.listener(|this, _event, window, cx| this.open_assistant(window, cx)))
            .when_some(self.assistant_preview.clone(), |el, preview| {
                el.child(
                    div()
                        .max_w(px(240.))
                        .px_3()
                        .py_2()
                        .rounded_lg()
                        .bg(theme.popover)
                        .border_1()
                        .border_color(theme.border)
                        .text_sm()
                        .truncate()
                        .child(preview),
                )
            })
            .child(
                div()
                    .relative()
                    .size(px(48.))
                    .rounded_full()
                    .bg(theme.sidebar_primary)
                    .flex()
                    .items_center()
                    .justify_center()
                    .child(IconName::Bot)
                    .when(self.assistant_unread > 0, |el| {
                        el.child(
                            div()
                                .absolute()
                                .top(px(-4.))
                                .right(px(-4.))
                                .min_w(px(18.))
                                .h(px(18.))
                                .rounded_full()
                                .bg(theme.danger)
                                .text_xs()
                                .text_color(theme.danger_foreground)
                                .flex()
                                .items_center()
                                .justify_center()
                                .child(unread.clone()),
                        )
                    }),
            )
            .child(
                Button::new("assistant-bubble-open")
                    .ghost()
                    .xsmall()
                    .tab_stop(false)
                    .tooltip(if self.assistant_unread == 0 {
                        "Open Aiden".to_string()
                    } else {
                        format!("Open Aiden — {unread} unread")
                    })
                    .on_click(cx.listener(|this, _event, window, cx| {
                        this.open_assistant(window, cx);
                    })),
            )
            .into_any_element()
    }

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
            let recovery = self
                .composer_submission
                .pending()
                .filter(|(submission, _, _)| submission.chat_id == id)
                .map(|(submission, _, _)| submission.clone());
            if let Some(submission) = recovery {
                self.service.update(cx, |service, cx| {
                    service.reconcile_unknown_submission(&submission, cx)
                });
            }
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
        if self.quit_in_flight {
            return;
        }
        self.cancel_shortcut_recording(cx);
        if self.authorize_files_mutation(PendingFilesMutation::Quit, window, cx) {
            self.request_quit(window, cx);
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
            self.stores.voice.cancel();
            self.cancel_settings_codex_auth(cx);
            // The process remains alive after the red-window close, but no
            // generation (especially an attended Computer Use action) may
            // continue without a visible approval/cancellation surface.
            // `dispose` synchronously cancels the active stream/Computer Use
            // lease and also performs the required Appearance flush without
            // changing the user's persisted Computer Use preference.
            self.service.update(cx, |service, cx| service.dispose(cx));
            // This process-wide gate is normally refreshed by `render`, but a
            // native close removes the AppState entity before another render
            // can publish the cancelled state. Clear it with the same close
            // transaction so windowless dictation remains usable.
            CHAT_GENERATION_ACTIVE.store(false, Ordering::Release);
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
        let initial_pill_appearance = {
            let service = service.read(cx);
            (service.appearance.clone(), service.system_reduced_motion())
        };
        publish_pill_appearance(initial_pill_appearance.0, initial_pill_appearance.1);
        if crate::services::scheduled_execution::global_enabled(&stores.config)
            && stores.scheduler_executor.is_ready()
        {
            let scheduler = stores.scheduler.clone();
            cx.spawn(async move |_this, cx| {
                let result = cx.background_spawn(async move { scheduler.start().await }).await;
                if let Err(error) = result {
                    tracing::warn!(%error, "scheduled runtime failed to start; execution remains unavailable");
                }
            })
            .detach();
        }

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
        let app_update_authority = stores.app_updates.clone();
        let initial_app_update_snapshot = app_update_authority.snapshot();
        let mut app_update_receiver = app_update_authority.subscribe();
        let mut computer_use_privacy = ComputerUsePrivacyNoticeState::default();
        computer_use_privacy.hydrate(stores.config.get_settings().ok().and_then(|settings| {
            settings
                .get(COMPUTER_USE_NOTICE_DISMISSED_KEY)
                .and_then(serde_json::Value::as_u64)
        }));

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
            composer_submission: ComposerSubmissionCoordinator::default(),
            slash_palette: SlashPaletteState::default(),
            slash_catalog_revision: 0,
            last_catalog: Vec::new(),
            last_workspace_id: None,
            appearance_applied: false,
            app_update_snapshot: initial_app_update_snapshot,
            app_update_dismissed_version: None,
            accessibility_announcements: AccessibilityAnnouncementState::default(),
            _subscriptions: Vec::new(),
            workspace_state,
            environment: cx.new(|cx| EnvironmentWorkbench::new(environment_config, cx)),
            files,
            review,
            files_dirty: false,
            files_saving: false,
            pending_files_mutation: None,
            quit_in_flight: false,
            settings: None,
            scheduled: None,
            usage: None,
            subagents: None,
            assistant: None,
            assistant_open: false,
            assistant_present: false,
            assistant_return_focus: None,
            assistant_bubble_focus: cx.focus_handle().tab_stop(true),
            assistant_unread: 0,
            assistant_preview: None,
            assistant_preview_generation: 0,
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
            computer_use_deny_focus: cx.focus_handle().tab_stop(true),
            computer_use_allow_focus: cx.focus_handle().tab_stop(true),
            subagent_write_modal_focus: SubagentWriteModalFocusState::default(),
            subagent_write_deny_focus: cx.focus_handle().tab_stop(true),
            subagent_write_allow_focus: cx.focus_handle().tab_stop(true),
            subagent_shell_deny_focus: cx.focus_handle().tab_stop(true),
            subagent_shell_allow_focus: cx.focus_handle().tab_stop(true),
            subagent_mcp_read_deny_focus: cx.focus_handle().tab_stop(true),
            subagent_mcp_read_allow_focus: cx.focus_handle().tab_stop(true),
            subagent_mcp_mutation_deny_focus: cx.focus_handle().tab_stop(true),
            subagent_mcp_mutation_allow_focus: cx.focus_handle().tab_stop(true),
            computer_use_privacy,
            computer_use_privacy_return_focus: None,
            computer_use_privacy_cancel_focus: cx.focus_handle().tab_stop(true),
            computer_use_privacy_session_focus: cx.focus_handle().tab_stop(true),
            computer_use_privacy_permanent_focus: cx.focus_handle().tab_stop(true),
            pi_provider_setup: None,
            pi_provider_cancel_focus: cx.focus_handle().tab_stop(true),
            pi_provider_save_focus: cx.focus_handle().tab_stop(true),
            pi_provider_sign_out_focus: cx.focus_handle().tab_stop(true),
        };

        // The pill is a separate GPUI window, so it does not inherit the
        // main window's globals. Keep an already-open pill synchronized with
        // both persisted appearance edits and AppKit accessibility events.
        this._subscriptions
            .push(cx.observe(&service, |_this, service, cx| {
                let service = service.read(cx);
                let appearance = service.appearance.clone();
                let system_reduced = service.system_reduced_motion();
                publish_pill_appearance(appearance.clone(), system_reduced);
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
        wire_pill_coordinator(this.stores.voice.clone(), cx);

        // The real provider owns its timers/network on the dedicated Tokio
        // bridge. Unpackaged/dev builds use the inert provider and therefore
        // perform no update I/O.
        let start_updates = app_update_authority.clone();
        Tokio::spawn(cx, async move {
            start_updates.start();
        })
        .detach();
        cx.spawn(async move |this, cx| {
            while app_update_receiver.changed().await.is_ok() {
                let snapshot = app_update_receiver.borrow().clone();
                let _ = this.update(cx, |this, cx| {
                    this.app_update_snapshot = snapshot;
                    cx.notify();
                });
            }
        })
        .detach();

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
                        this.invalidate_slash_catalog();
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
                InputEvent::Change => this.update_slash_palette(cx),
                InputEvent::PressEnter { secondary: false } => {
                    if !this.slash_palette.open {
                        this.send_composer(window, cx);
                    }
                }
                InputEvent::Focus => cx.notify(),
                InputEvent::Blur => {
                    cx.defer_in(window, |_this, window, cx| {
                        let composer_focused = _this
                            .composer_input
                            .read(cx)
                            .focus_handle(cx)
                            .is_focused(window);
                        if !composer_focused {
                            _this.slash_palette.close();
                        }
                        cx.notify();
                    });
                }
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
                                PendingFilesMutation::Quit => this.request_quit(window, cx),
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
                this.sync_from_service(window, cx);
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
    fn sync_from_service(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if let Some((submission, _text, _draft)) = self.composer_submission.pending().cloned() {
            let outcome = self.service.update(cx, |service, _cx| {
                service.take_submission_outcome(&submission)
            });
            let current_text = self.composer_input.read(cx).value().to_string();
            let current_draft = crate::chat::composer::composer_draft(cx).clone();
            if self
                .composer_submission
                .settle(&submission, outcome, &current_text, &current_draft)
            {
                self.composer_input
                    .update(cx, |input, inner| input.set_value("", window, inner));
                crate::chat::composer::composer_draft(cx).clear();
            }
        }
        let booted = self.service.read(cx).booted;
        if booted && !self.appearance_applied {
            self.appearance_applied = true;
            self.service
                .update(cx, |service, inner| service.apply_appearance(inner));
        }

        let service = self.service.read(cx);
        let catalog = provider_catalog_fingerprint(&service.providers);
        let providers = service.providers.clone();
        let assistant_selection = service.selection.clone();
        let selection = service
            .selection
            .as_ref()
            .map(|selection| model_key(&selection.provider_id, &selection.model));
        let generation_owner = service
            .generation
            .as_ref()
            .map(|generation| format!("{}:{}", generation.chat_id, generation.counter));
        let generation_phase = service.generation.as_ref().map(|generation| {
            if generation.error.is_some() {
                GenerationAnnouncementPhase::Failed
            } else if generation.complete {
                GenerationAnnouncementPhase::Completed
            } else {
                GenerationAnnouncementPhase::Running
            }
        });
        let approval_id = service
            .active_subagent_approval()
            .map(|approval| approval.approval_id().to_string());
        let _ = service;
        let generation_announcement = self
            .accessibility_announcements
            .observe_generation(generation_owner.as_deref(), generation_phase);
        let approval_announcement = self
            .accessibility_announcements
            .observe_approval(generation_owner.as_deref(), approval_id.as_deref());
        if let Some(message) = generation_announcement {
            let _ = aiden_mac::accessibility::announce(&message);
        }
        if let Some(message) = approval_announcement {
            let _ = aiden_mac::accessibility::announce(&message);
        }
        self.sync_assistant_readiness(providers.clone(), assistant_selection, cx);
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
        // Mirror the workspace list / active workspace into the bar (only a
        // folder change restarts the bar's git poll) and tear down any PTYs
        // owned by the previous workspace before adopting the next one.
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
            self.invalidate_slash_catalog();
        }
        if let Some(terminal) = &self.terminal {
            if terminal_allowed {
                if let (Some(workspace_id), Some(cwd)) = (active_id.clone(), folder.clone()) {
                    terminal.update(cx, |terminal, cx| {
                        terminal.set_workspace(workspace_id, cwd, cx)
                    });
                } else {
                    terminal.update(cx, |terminal, cx| terminal.clear_workspace(cx));
                }
            } else {
                terminal.update(cx, |terminal, cx| terminal.clear_workspace(cx));
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

    /// Keep an already-created dock panel on the ChatService's foreground
    /// provider/model snapshot. This is local-only: selecting a model updates
    /// the dock before the asynchronous settings write, while an external
    /// provider deletion disables it as soon as refresh_providers publishes.
    fn sync_assistant_readiness(
        &mut self,
        providers: Vec<ConfiguredProvider>,
        selection: Option<crate::services::provider_kit::ModelSelection>,
        cx: &mut Context<Self>,
    ) {
        if let Some(panel) = self.assistant.clone() {
            panel.update(cx, |panel, cx| {
                panel.refresh_readiness_from_snapshot(providers, selection, cx)
            });
        }
    }

    /// Submit the exact composer draft. Every entry point (button, Enter, and
    /// ⌘↩) uses this transaction: dispatch first, then clear once admitted.
    pub fn send_composer(&mut self, _window: &mut Window, cx: &mut Context<Self>) {
        if self.composer_submission.pending().is_some() {
            return;
        }
        let text = self.composer_input.read(cx).value().to_string();
        let draft = crate::chat::composer::composer_draft(cx).clone();
        if text.trim().is_empty() && !draft.has_attachments() {
            return;
        }

        let skill_selection = skill_selection_for_send(&draft.skill_selection);
        let admitted = self.service.update(cx, |service, cx| {
            service.send_message_with_skill(
                &text,
                draft.attachments.clone(),
                draft.editing_message_id.clone(),
                skill_selection,
                cx,
            )
        });
        let Some(submission) = admitted else {
            return;
        };

        let began = self.composer_submission.begin(submission, text, draft);
        debug_assert!(began, "checked for a pending composer submission above");
    }

    fn refresh_slash_catalog(&mut self, cx: &mut Context<Self>) {
        let workspace_identity = self
            .service
            .read(cx)
            .workspace
            .as_ref()
            .map(|workspace| workspace.id.clone())
            .unwrap_or_else(|| "<none>".to_string());
        if !self
            .slash_palette
            .catalog_refresh_needed(&workspace_identity)
        {
            return;
        }
        let (workspace_root, permission) = {
            let service = self.service.read(cx);
            (
                service
                    .workspace
                    .as_ref()
                    .and_then(|workspace| workspace.folder_path.as_deref())
                    .map(std::path::PathBuf::from),
                service
                    .workspace
                    .as_ref()
                    .map(|workspace| workspace.permission)
                    .unwrap_or(aiden_data::portable_config::WorkspacePermission::None),
            )
        };
        let context = stream_context_for_mode(
            SkillRuntimeMode::Chat,
            self.stores.config.clone(),
            workspace_root,
            permission,
        )
        .expect("Chat mode always permits skill catalog context");
        let revision = self.slash_catalog_revision.wrapping_add(1);
        self.slash_catalog_revision = revision;
        self.slash_palette.catalog_loading = true;
        self.slash_palette.catalog_identity = Some(workspace_identity);
        cx.spawn(async move |this, cx| {
            let catalog = cx
                .background_spawn(async move {
                    let cancel = AtomicBool::new(false);
                    collect_skill_catalog(&context, &cancel)
                })
                .await;
            this.update(cx, |this, cx| {
                if this.slash_catalog_revision != revision {
                    return;
                }
                this.slash_palette.catalog = catalog;
                this.slash_palette.catalog_loading = false;
                this.slash_palette.catalog_loaded = true;
                this.slash_palette.recompute();
                cx.notify();
            })
            .ok();
        })
        .detach();
    }

    fn invalidate_slash_catalog(&mut self) {
        self.slash_catalog_revision = self.slash_catalog_revision.wrapping_add(1);
        self.slash_palette.catalog.clear();
        self.slash_palette.catalog_identity = None;
        self.slash_palette.catalog_loaded = false;
        self.slash_palette.catalog_loading = false;
    }

    pub(crate) fn update_slash_palette(&mut self, cx: &mut Context<Self>) {
        let (text, cursor) = {
            let input = self.composer_input.read(cx);
            (input.value().to_string(), input.cursor())
        };
        self.slash_palette.query = parse_slash_query(&text, cursor);
        if self.slash_palette.query.is_none() {
            self.slash_palette.close();
            cx.notify();
            return;
        }
        self.slash_palette.recompute();
        if self.slash_palette.open
            && self.slash_palette.catalog.is_empty()
            && !self.slash_palette.catalog_loaded
            && !self.slash_palette.catalog_loading
        {
            self.refresh_slash_catalog(cx);
        }
        cx.notify();
    }

    fn remove_slash_token(
        &mut self,
        query: &SlashQuery,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let text = self.composer_input.read(cx).value().to_string();
        let Some(value) = query.remove_token(&text) else {
            return;
        };
        self.composer_input.update(cx, |input, cx| {
            input.set_value(value, window, cx);
            input.focus(window, cx);
        });
    }

    pub(crate) fn select_slash_skill(
        &mut self,
        entry: SkillCatalogEntry,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let (workspace_identity, workspace_permission) = self
            .service
            .read(cx)
            .workspace
            .as_ref()
            .map(|workspace| (Some(workspace.id.clone()), Some(workspace.permission)))
            .unwrap_or((
                None,
                Some(aiden_data::portable_config::WorkspacePermission::None),
            ));
        let query = self.slash_palette.query.clone();
        if let Some(query) = query.as_ref() {
            self.remove_slash_token(query, window, cx);
        }
        crate::chat::composer::composer_draft(cx)
            .skill_selection
            .replace_for_workspace(&entry, workspace_identity.as_deref(), workspace_permission);
        self.slash_palette.close();
        self.slash_palette.notice = None;
        self.composer_input
            .update(cx, |input, cx| input.focus(window, cx));
        cx.notify();
    }

    pub(crate) fn clear_slash_skill_selection(&mut self, cx: &mut Context<Self>) {
        crate::chat::composer::composer_draft(cx)
            .skill_selection
            .clear();
        self.slash_palette.notice = None;
        cx.notify();
    }

    pub(crate) fn dispatch_slash_command_id(
        &mut self,
        command_id: &str,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let Some(command) = (match command_id {
            "assistant.open" => Some(PaletteCommand::OpenAssistant),
            "chat.new" => Some(PaletteCommand::NewChat),
            "chat.search" => Some(PaletteCommand::SearchChats),
            "model.change" => Some(PaletteCommand::ChangeModel),
            "provider.manage" => Some(PaletteCommand::ManageProviders),
            "settings.open" => Some(PaletteCommand::OpenSettings),
            "workspace.openPreferredEditor" => Some(PaletteCommand::OpenWorkspaceEditor),
            "sidebar.toggle" => Some(PaletteCommand::ToggleSidebar),
            "terminal.toggle" => Some(PaletteCommand::ToggleTerminal),
            "environment.toggle" => Some(PaletteCommand::ToggleEnvironment),
            "theme.toggle" => Some(PaletteCommand::ToggleTheme),
            "view.scheduled" => Some(PaletteCommand::OpenScheduled),
            "view.usage" => Some(PaletteCommand::OpenUsage),
            "view.subagents" => Some(PaletteCommand::OpenSubagents),
            _ => None,
        }) else {
            return;
        };
        self.palette_invoker_focus = Some(self.composer_input.read(cx).focus_handle(cx));
        self.on_palette_command(command, window, cx);
    }

    pub(crate) fn select_slash_command_id(
        &mut self,
        command_id: &str,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let query = self.slash_palette.query.clone();
        if let Some(query) = query.as_ref() {
            self.remove_slash_token(query, window, cx);
        }
        self.slash_palette.close();
        self.dispatch_slash_command_id(command_id, window, cx);
    }

    pub(crate) fn handle_slash_key(
        &mut self,
        event: &gpui::KeyDownEvent,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if !self.slash_palette.open {
            return;
        }
        match event.keystroke.key.as_str() {
            "up" => self.slash_palette.move_selection(false),
            "down" => self.slash_palette.move_selection(true),
            "escape" => {
                self.slash_palette.close();
                self.composer_input
                    .update(cx, |input, cx| input.focus(window, cx));
            }
            "enter" => {
                if let Some(command_id) = self.slash_palette.selected_command_id() {
                    let command_id = command_id.to_string();
                    self.select_slash_command_id(&command_id, window, cx);
                } else if let Some(entry) = self.slash_palette.selected_skill() {
                    self.select_slash_skill(entry, window, cx);
                }
            }
            _ => return,
        }
        cx.stop_propagation();
        cx.notify();
    }

    fn on_new_chat(&mut self, _: &NewChat, window: &mut Window, cx: &mut Context<Self>) {
        self.new_chat_guarded(window, cx);
    }

    fn on_quit(&mut self, _: &Quit, window: &mut Window, cx: &mut Context<Self>) {
        self.quit_guarded(window, cx);
    }

    /// Complete the irreversible half of quit after every authoritative
    /// Computer Use persistence/teardown operation has succeeded.
    fn finish_quit(&mut self, cx: &mut Context<Self>) {
        let barrier = self.stores.quit_barrier.clone();
        self.service.update(cx, |service, cx| service.dispose(cx));
        if let Some(pill) = PILL_COORDINATOR.get() {
            pill.dispose();
        } else {
            self.stores.voice.cancel();
        }
        self.stores.foundation_models.dispose();
        // Stop the scheduler tick loop (aborts the tick task, requests
        // cancellation of any live runs) so no background tokio task
        // outlives the app.
        self.stores.scheduler.stop();
        barrier.note_renderer_closed();
        barrier.force();
        cx.quit();
    }

    /// The quit barrier: claim one quit attempt, stop foreground work without
    /// tearing down the app, then await the authority-owned Computer Use
    /// shutdown before crossing the irreversible process quit boundary.
    fn request_quit(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if !claim_quit(&mut self.quit_in_flight) {
            return;
        }
        self.cancel_settings_codex_auth(cx);
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
        if let Some(pill) = PILL_COORDINATOR.get() {
            pill.request_cancel();
        } else {
            self.stores.voice.cancel();
        }
        let computer_use = Arc::clone(&self.stores.computer_use);
        let authority_for_resume = Arc::clone(&computer_use);
        let shutdown = Tokio::spawn(cx, async move { computer_use.shutdown().await });
        cx.spawn_in(window, async move |this, cx| {
            let result = shutdown.await;
            let _ = this.update_in(cx, |this, window, cx| {
                this.quit_in_flight = false;
                match result {
                    Ok(Ok(())) => this.finish_quit(cx),
                    Ok(Err(error)) => {
                        tracing::warn!("Computer Use shutdown did not finish cleanly: {error}");
                        authority_for_resume.resume_after_cancelled_shutdown();
                        window.push_notification(
                            gpui_component::notification::Notification::error(
                                COMPUTER_USE_QUIT_FAILURE,
                            ),
                            cx,
                        );
                        cx.notify();
                    }
                    Err(error) => {
                        tracing::warn!("Computer Use shutdown task failed: {error}");
                        authority_for_resume.resume_after_cancelled_shutdown();
                        window.push_notification(
                            gpui_component::notification::Notification::error(
                                COMPUTER_USE_QUIT_FAILURE,
                            ),
                            cx,
                        );
                        cx.notify();
                    }
                }
            });
        })
        .detach();
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

    pub(crate) fn dismiss_app_update(&mut self, cx: &mut Context<Self>) {
        if let AppUpdateSnapshot::Ready { version } = &self.app_update_snapshot {
            self.app_update_dismissed_version = Some(version.clone());
            cx.notify();
        }
    }

    pub(crate) fn open_app_update(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let AppUpdateSnapshot::Ready { version } = &self.app_update_snapshot else {
            return;
        };
        let version = version.clone();
        if self.stores.app_updates.open_downloaded_installer() {
            self.app_update_dismissed_version = Some(version);
            window.push_notification(
                "The verified Aiden installer is open. Finish the update there.",
                cx,
            );
        } else {
            window.push_notification(
                "This update is ready, but the installer is unavailable in this build.",
                cx,
            );
        }
        cx.notify();
    }

    pub(crate) fn check_for_app_update(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let authority = self.stores.app_updates.clone();
        let task = Tokio::spawn(cx, async move { authority.check_now(true).await });
        cx.spawn(async move |_this, _cx| {
            let _ = task.await;
        })
        .detach();
        window.push_notification("Checking for Aiden updates…", cx);
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

    /// ⌘⇧A toggles the persistent app-root Assistant dock; it never changes
    /// `view`, so the chat/main surface stays mounted underneath it.
    fn on_toggle_assistant(
        &mut self,
        _: &ToggleAssistant,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if self.assistant_open {
            self.minimize_assistant(window, cx);
        } else {
            self.open_assistant(window, cx);
        }
    }

    fn on_open_assistant(
        &mut self,
        _: &OpenAssistant,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.open_assistant(window, cx);
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
        self.send_composer(window, cx);
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
            PaletteCommand::OpenAssistant => {
                // The palette owns an active dialog; release it before the
                // dock's modal guard runs, then capture the original invoker
                // as the dock's restore target.
                self.close_palette(window, cx);
                if let Some(focus) = palette_invoker_focus {
                    focus.focus(window);
                }
                self.open_assistant(window, cx);
            }
            PaletteCommand::Quit => self.request_quit(window, cx),
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

    /// Create the terminal drawer once. Its workspace-owned PTYs stay alive
    /// across drawer toggles, but are destroyed on workspace/window teardown.
    fn terminal_entity(
        &mut self,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Option<Entity<TerminalDrawer>> {
        if let Some(entity) = &self.terminal {
            return Some(entity.clone());
        }
        let service = self.service.read(cx);
        let workspace_id = service.workspace.as_ref()?.id.clone();
        let cwd = service.workspace_folder()?;
        let deps = TerminalDeps {
            shell: None,
            // The terminal starts in the active workspace folder (the git repo
            // root); a later workspace switch destroys all prior sessions.
            cwd: Some(cwd),
            simple: false,
        };
        let config = self.stores.config.clone();
        let entity =
            cx.new(|cx| TerminalDrawer::new_owned(cx, deps, Some(workspace_id), Some(config)));
        let was_open = Rc::new(Cell::new(false));
        self._subscriptions.push(cx.observe_in(
            &entity,
            window,
            move |this, terminal, window, cx| {
                let open = terminal.read(cx).is_open();
                if was_open.replace(open)
                    && !open
                    && terminal.read(cx).should_restore_toggle_focus()
                {
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
        self._subscriptions.push(cx.subscribe_in(
            &entity,
            window,
            |this, _settings, event: &SettingsEvent, window, cx| match event {
                SettingsEvent::PiProviderSetupRequested {
                    provider_id,
                    label,
                    authority_revision,
                } => {
                    this.open_pi_provider_setup(
                        provider_id,
                        label,
                        Some(*authority_revision),
                        window,
                        cx,
                    );
                }
                SettingsEvent::ComputerUsePrivacyNoticeRestored => {
                    this.computer_use_privacy.restore();
                    cx.notify();
                }
            },
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
        let source: Arc<dyn ScheduledTaskSource> = Arc::new(StoreScheduledSource::new(
            self.stores.schedules.clone(),
            self.stores.config.clone(),
            self.stores.scheduler.clone(),
            self.stores.scheduler_executor.clone(),
        ));
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
                ScheduledPanelEvent::RunNow { id } => {
                    this.run_scheduled_task(panel.clone(), id, window, cx);
                }
            },
        ));
        self.scheduled = Some(entity.clone());
        entity
    }

    fn run_scheduled_task(
        &mut self,
        panel: Entity<ScheduledPanel>,
        id: &str,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let scheduler = self.stores.scheduler.clone();
        let id = id.to_string();
        window.push_notification("Starting scheduled task…", cx);
        cx.spawn(async move |_this, cx| {
            let result = cx
                .background_spawn(async move {
                    let run = scheduler.run_now(&id)?;
                    run.await
                })
                .await;
            let _ = panel.update(cx, |panel, cx| {
                panel.set_error(
                    result
                        .as_ref()
                        .err()
                        .map(|error| format!("Run Now failed: {error}")),
                    cx,
                );
                panel.refresh(cx);
            });
        })
        .detach();
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
        let source: Arc<dyn UsageDataSource> = Arc::new(StoreUsageSource::new(
            self.stores.usage.clone(),
            self.stores.config.clone(),
        ));
        let entity = cx.new(|cx| UsagePanel::new(cx, UsagePanelDeps::new(source)));
        self.usage = Some(entity.clone());
        entity
    }

    fn subagents_entity(
        &mut self,
        _window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Entity<SubagentsPanel> {
        let active_chat = self.service.read(cx).active_chat_id.clone();
        if let Some(entity) = &self.subagents {
            entity.update(cx, |panel, cx| panel.set_active_chat(active_chat, cx));
            return entity.clone();
        }
        let source: Arc<dyn SubagentRunSource> = self.stores.subagents.clone();
        let entity = cx.new(|cx| SubagentsPanel::new(cx, SubagentsPanelDeps::new(source)));
        entity.update(cx, |panel, cx| panel.set_active_chat(active_chat, cx));
        self.subagents = Some(entity.clone());
        entity
    }

    /// Open the Subagents roster for a transcript chip and select the exact
    /// persisted run. Navigation goes through the same files-mutation gate as
    /// the keyboard/sidebar command, so a pending editor cannot be discarded
    /// silently by clicking a chip.
    pub(crate) fn open_subagent_run(
        &mut self,
        run_id: &str,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.dismiss_compact_sidebar_for_navigation(window, cx);
        self.navigate_view(AppView::Subagents, window, cx);
        if self.view != AppView::Subagents {
            return;
        }
        let panel = self.subagents_entity(window, cx);
        let run_id = run_id.to_string();
        panel.update(cx, |panel, cx| panel.select_run(&run_id, cx));
    }

    fn open_assistant(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.assistant_interaction_blocked(window, cx) {
            return;
        }
        if !self.assistant_open {
            self.assistant_return_focus = window.focused(cx);
            self.assistant_open = true;
            self.assistant_present = true;
            self.assistant_unread = 0;
            self.assistant_preview = None;
            self.assistant_preview_generation = self.assistant_preview_generation.wrapping_add(1);
        }
        let panel = self.assistant_entity(window, cx);
        panel.read(cx).focus_composer(window, cx);
        cx.notify();
    }

    fn minimize_assistant(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if !self.assistant_open {
            return;
        }
        self.assistant_open = false;
        if self.assistant_motion_reduced(cx) {
            self.finish_assistant_minimize(window, cx);
        } else if let Some(window_handle) = cx.active_window() {
            cx.spawn(async move |this, cx| {
                Timer::after(Duration::from_millis(120)).await;
                let _ = window_handle.update(cx, |_, window, cx| {
                    this.update(cx, |this, cx| this.finish_assistant_minimize(window, cx))
                        .ok();
                });
            })
            .detach();
        } else {
            self.finish_assistant_minimize(window, cx);
        }
        cx.notify();
    }

    fn finish_assistant_minimize(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.assistant_open || !self.assistant_present {
            return;
        }
        self.assistant_present = false;
        let restore_focus =
            assistant_minimize_may_restore_focus(self.assistant_interaction_blocked(window, cx));
        let return_focus = self.assistant_return_focus.take();
        if restore_focus {
            if let Some(focus) = return_focus {
                focus.focus(window);
            } else {
                self.assistant_bubble_focus.focus(window);
            }
        }
        cx.notify();
    }

    fn assistant_motion_reduced(&self, cx: &App) -> bool {
        cx.try_global::<crate::services::appearance::AidenAppearanceRuntime>()
            .is_some_and(|appearance| appearance.motion_reduced)
    }

    fn assistant_notice(&mut self, notice: String, cx: &mut Context<Self>) {
        if self.assistant_open {
            return;
        }
        let (unread, preview) =
            assistant_notice_state(self.assistant_open, self.assistant_unread, &notice);
        self.assistant_unread = unread;
        self.assistant_preview = preview;
        self.assistant_preview_generation = self.assistant_preview_generation.wrapping_add(1);
        let generation = self.assistant_preview_generation;
        cx.spawn(async move |this, cx| {
            Timer::after(Duration::from_secs(8)).await;
            this.update(cx, |this, cx| {
                if this.assistant_preview_generation == generation {
                    this.assistant_preview = None;
                    cx.notify();
                }
            })
            .ok();
        })
        .detach();
        cx.notify();
    }

    fn assistant_interaction_blocked(&self, window: &mut Window, cx: &mut App) -> bool {
        let root_modal = window.has_active_dialog(cx)
            || self.files.read(cx).confirmation_open()
            || self
                .settings
                .as_ref()
                .is_some_and(|settings| settings.read(cx).skills_modal_open())
            || self
                .settings
                .as_ref()
                .is_some_and(|settings| settings.read(cx).provider_editor_modal_open())
            || self
                .service
                .read(cx)
                .pending_computer_use_approval()
                .is_some()
            || self
                .service
                .read(cx)
                .pending_subagent_write_approval()
                .is_some()
            || self
                .service
                .read(cx)
                .pending_subagent_shell_approval()
                .is_some()
            || self.computer_use_privacy.is_open()
            || self.pi_provider_setup.is_some();
        assistant_dock_occluded(self.environment_overlay_open(window, cx), root_modal)
    }

    /// The proactive-assistant panel: created once from the root dock and kept
    /// alive so a pending thread + approval queue survive every route switch.
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
            |this, _source, event: &AssistantPanelEvent, window, cx| match event {
                AssistantPanelEvent::Refresh => {}
                AssistantPanelEvent::Notice(notice) => this.assistant_notice(notice.clone(), cx),
                AssistantPanelEvent::Minimize => this.minimize_assistant(window, cx),
            },
        ));
        let providers = self.service.read(cx).providers.clone();
        let selection = self.service.read(cx).selection.clone();
        entity.update(cx, |panel, cx| {
            panel.refresh_readiness_from_snapshot(providers, selection, cx)
        });
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

/// Sanitise a dock notification to one visual line without exposing an
/// unbounded streamed reply beside the bubble.
fn assistant_preview_text(text: &str) -> String {
    const MAX_CHARS: usize = 80;
    const FALLBACK: &str = "Aiden has an update";
    let compact: String = text
        .chars()
        .filter_map(|character| {
            if is_format_control(character) || matches!(character, '`' | '*' | '_' | '#') {
                None
            } else if character.is_control() {
                Some(' ')
            } else {
                Some(character)
            }
        })
        .collect::<String>()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");
    let compact = compact.trim_matches(|character: char| {
        matches!(character, '-' | '>' | '[' | ']' | '(' | ')' | '~')
    });
    let compact = if compact.is_empty() {
        FALLBACK
    } else {
        compact
    };
    if compact.chars().count() <= MAX_CHARS {
        return compact.to_string();
    }
    let candidate: String = compact.chars().take(MAX_CHARS).collect();
    let clipped = candidate
        .rfind(' ')
        .map(|cut| candidate[..cut].trim_end())
        .unwrap_or(candidate.as_str());
    format!("{clipped}…")
}

/// Rust does not expose Unicode general category Cf directly. This is the
/// complete format-control set relevant to the Unicode ranges Electron's
/// `\p{Cf}` sanitizer removes, including bidi controls and zero-width marks.
fn is_format_control(character: char) -> bool {
    matches!(character,
        '\u{00ad}' | '\u{0600}'..='\u{0605}' | '\u{061c}' | '\u{06dd}' | '\u{070f}' |
        '\u{0890}'..='\u{0891}' | '\u{08e2}' | '\u{180e}' | '\u{200b}'..='\u{200f}' |
        '\u{202a}'..='\u{202e}' | '\u{2060}'..='\u{2064}' | '\u{2066}'..='\u{206f}' |
        '\u{feff}' | '\u{fff9}'..='\u{fffb}' | '\u{110bd}' | '\u{110cd}' |
        '\u{13430}'..='\u{1343f}' | '\u{1bca0}'..='\u{1bca3}' | '\u{1d173}'..='\u{1d17a}' |
        '\u{e0001}' | '\u{e0020}'..='\u{e007f}'
    )
}

fn assistant_notice_state(open: bool, unread: u8, notice: &str) -> (u8, Option<String>) {
    if open {
        (unread, None)
    } else {
        (
            unread.saturating_add(1),
            Some(assistant_preview_text(notice)),
        )
    }
}

/// `present` is intentionally independent from `open` for the 120 ms exit.
fn assistant_dock_panel_present(_open: bool, present: bool) -> bool {
    present
}

/// The minimized root bubble must never create a network-owning panel.
fn assistant_entity_required_for_dock(open: bool, present: bool) -> bool {
    open || present
}

fn assistant_dock_width(viewport_width: f32) -> f32 {
    (viewport_width - 48.).clamp(200., 368.)
}

fn assistant_dock_height(viewport_height: f32) -> f32 {
    (viewport_height - 128.).clamp(220., 544.)
}

fn assistant_dock_occluded(environment_overlay: bool, root_modal: bool) -> bool {
    environment_overlay || root_modal
}

const fn assistant_minimize_may_restore_focus(interaction_blocked: bool) -> bool {
    !interaction_blocked
}

/// Show (or reuse) the pill window on the foreground; `true` when a new
/// window was created. The retained window is deliberately probed without
/// activation: the pill is a non-activating overlay and must never steal the
/// focused target that will receive the dictated paste. Also stores the
/// window handle in [`PILL_WINDOW`] so later broadcasts can reach the view.
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
        // A retained pill is already visible/non-activating. Use a no-op
        // entity update only to detect a stale handle; calling
        // `activate_window` here would move keyboard focus away from the
        // user's target application before the transcript is pasted.
        let alive = cx.update(|app| handle.update(app, |_view, _window, _cx| {}));
        if matches!(alive, Ok(Ok(()))) {
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
fn wire_pill_coordinator(
    voice: Arc<crate::services::voice::VoiceAuthority>,
    cx: &mut Context<AppState>,
) {
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
                    let live = this.upgrade().and_then(|entity| {
                        cx.read_entity(&entity, |state, app| {
                            let service = state.service.read(app);
                            (service.appearance.clone(), service.system_reduced_motion())
                        })
                        .ok()
                    });
                    if let Some((appearance, reduced)) = live.as_ref() {
                        publish_pill_appearance(appearance.clone(), *reduced);
                    }
                    let appearance = pill_appearance_for_show(live, read_pill_appearance());
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
        voice,
        audio,
        transcribe: None,
    });
    // Spawn the pill watcher on the tokio bridge (NOT tokio::spawn directly —
    // we're on a GPUI thread without a tokio runtime guard).
    gpui_tokio_bridge::Tokio::spawn(cx, watcher).detach();
    let _ = PILL_COORDINATOR.set(pill);
}

impl AppState {
    pub(crate) fn toggle_active_chat_computer_use(
        &mut self,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let enabled = self
            .service
            .read(cx)
            .active_chat
            .as_ref()
            .is_some_and(|chat| chat.computer_use_enabled == Some(true));
        if enabled {
            self.service.update(cx, |service, cx| {
                service.set_active_chat_computer_use(false, cx)
            });
            return;
        }
        match self.computer_use_privacy.request_chat_enable() {
            ComputerUseEnableIntent::Proceed => self.service.update(cx, |service, cx| {
                service.set_active_chat_computer_use(true, cx)
            }),
            ComputerUseEnableIntent::ShowPrivacyNotice => {
                self.computer_use_privacy_return_focus = window.focused(cx);
                let focus = self.computer_use_privacy_cancel_focus.clone();
                cx.defer_in(window, move |_this, window, _cx| focus.focus(window));
                cx.notify();
            }
        }
    }

    fn cancel_computer_use_privacy(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.computer_use_privacy.cancel();
        if let Some(focus) = self.computer_use_privacy_return_focus.take() {
            cx.defer_in(window, move |_this, window, _cx| focus.focus(window));
        }
        cx.notify();
    }

    fn accept_computer_use_privacy(
        &mut self,
        dismissal: ComputerUseNoticeDismissal,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if !self.computer_use_privacy.accept(dismissal) {
            return;
        }
        if dismissal == ComputerUseNoticeDismissal::Permanent {
            let config = Arc::clone(&self.stores.config);
            cx.background_spawn(async move {
                let mut patch = serde_json::Map::new();
                patch.insert(
                    COMPUTER_USE_NOTICE_DISMISSED_KEY.into(),
                    COMPUTER_USE_NOTICE_VERSION.into(),
                );
                if let Err(error) = config.set_settings(&patch, &|| true) {
                    tracing::warn!("could not save Computer Use privacy acknowledgement: {error}");
                }
            })
            .detach();
        }
        self.service.update(cx, |service, cx| {
            service.set_active_chat_computer_use(true, cx)
        });
        if let Some(focus) = self.computer_use_privacy_return_focus.take() {
            cx.defer_in(window, move |_this, window, _cx| focus.focus(window));
        }
        cx.notify();
    }

    fn decide_computer_use_approval(
        &mut self,
        approval_id: &str,
        decision: ComputerUseApprovalDecision,
        cx: &mut Context<Self>,
    ) {
        self.service.update(cx, |service, cx| {
            service.decide_computer_use_approval(approval_id, decision, cx);
        });
    }

    fn reconcile_subagent_approval_focus(
        &mut self,
        approval_id: Option<&str>,
        deny_focus: FocusHandle,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        match self
            .subagent_write_modal_focus
            .reconcile(approval_id, window.focused(cx))
        {
            SubagentWriteModalFocusTransition::Unchanged => {}
            SubagentWriteModalFocusTransition::FocusDeny => {
                let focus = deny_focus;
                cx.defer_in(window, move |_this, window, _cx| focus.focus(window));
            }
            SubagentWriteModalFocusTransition::Restore(focus) => {
                cx.defer_in(window, move |_this, window, _cx| focus.focus(window));
            }
        }
    }

    fn decide_subagent_write_approval(
        &mut self,
        approval_id: &str,
        decision: SubagentWorkspaceWriteDecision,
        cx: &mut Context<Self>,
    ) {
        self.service.update(cx, |service, cx| {
            service.decide_subagent_write_approval(approval_id, decision, cx);
        });
    }

    pub(crate) fn open_pi_provider_setup(
        &mut self,
        provider_id: &str,
        label: &str,
        expected_revision: Option<u64>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if self
            .pi_provider_setup
            .as_ref()
            .is_some_and(|modal| !pi_provider_setup_can_close(modal.busy))
        {
            return;
        }
        let authority = &self.stores.pi_providers;
        let statuses = authority.list();
        let Some(status) = statuses
            .iter()
            .find(|status| status.provider.id == provider_id)
        else {
            return;
        };
        if expected_revision.is_some_and(|revision| revision != status.revision) {
            return;
        }
        let configured = status.configured;
        let api_key = cx.new(|cx| {
            InputState::new(window, cx)
                .masked(true)
                .placeholder(if configured {
                    "Replace API key"
                } else {
                    "Paste API key"
                })
        });
        let input_focus = api_key.read(cx).focus_handle(cx);
        self.pi_provider_setup = Some(PiProviderSetupModal {
            provider_id: provider_id.to_string(),
            label: label.to_string(),
            lease: authority.begin_setup(),
            api_key,
            configured,
            busy: false,
            error: None,
            return_focus: window.focused(cx),
        });
        cx.defer_in(window, move |_this, window, _cx| input_focus.focus(window));
        cx.notify();
    }

    fn close_pi_provider_setup(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self
            .pi_provider_setup
            .as_ref()
            .is_some_and(|modal| !pi_provider_setup_can_close(modal.busy))
        {
            return;
        }
        let return_focus = self
            .pi_provider_setup
            .take()
            .and_then(|modal| modal.return_focus);
        if let Some(return_focus) = return_focus {
            cx.defer_in(window, move |_this, window, _cx| return_focus.focus(window));
        }
        cx.notify();
    }

    fn save_pi_provider_setup(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some(modal) = self.pi_provider_setup.as_mut() else {
            return;
        };
        if modal.busy {
            return;
        }
        let key = modal.api_key.read(cx).value().to_string();
        let provider_id = modal.provider_id.clone();
        let lease = modal.lease;
        modal.busy = true;
        modal.error = None;
        let authority = self.stores.pi_providers.clone();
        let settings = self.settings.clone();
        cx.spawn_in(window, async move |this, cx| {
            let operation_provider_id = provider_id.clone();
            let result = cx
                .background_spawn(async move {
                    authority.commit_api_key(&operation_provider_id, &key, lease)
                })
                .await;
            let _ = this.update_in(cx, |this, window, cx| {
                let Some(modal) = this.pi_provider_setup.as_mut() else {
                    return;
                };
                if !pi_provider_setup_completion_is_current(
                    &modal.provider_id,
                    modal.lease,
                    &provider_id,
                    lease,
                ) {
                    return;
                }
                modal.busy = false;
                match result {
                    Ok(()) => {
                        if let Some(settings) = settings {
                            settings.update(cx, |settings, cx| settings.refresh(cx));
                        }
                        this.close_pi_provider_setup(window, cx);
                    }
                    Err(error) => {
                        modal.error = Some(error.to_string());
                        cx.notify();
                    }
                }
            });
        })
        .detach();
    }

    fn sign_out_pi_provider(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some(modal) = self.pi_provider_setup.as_mut() else {
            return;
        };
        if modal.busy {
            return;
        }
        modal.busy = true;
        modal.error = None;
        let provider_id = modal.provider_id.clone();
        let lease = modal.lease;
        let authority = self.stores.pi_providers.clone();
        let settings = self.settings.clone();
        cx.spawn_in(window, async move |this, cx| {
            let operation_provider_id = provider_id.clone();
            let result = cx
                .background_spawn(async move { authority.sign_out(&operation_provider_id) })
                .await;
            let _ = this.update_in(cx, |this, window, cx| {
                let Some(modal) = this.pi_provider_setup.as_mut() else {
                    return;
                };
                if !pi_provider_setup_completion_is_current(
                    &modal.provider_id,
                    modal.lease,
                    &provider_id,
                    lease,
                ) {
                    return;
                }
                modal.busy = false;
                match result {
                    Ok(()) => {
                        if let Some(settings) = settings {
                            settings.update(cx, |settings, cx| settings.refresh(cx));
                        }
                        this.close_pi_provider_setup(window, cx);
                    }
                    Err(error) => {
                        modal.error = Some(error.to_string());
                        cx.notify();
                    }
                }
            });
        })
        .detach();
    }

    fn pi_provider_setup_modal(&self, cx: &mut Context<Self>) -> gpui::AnyElement {
        let theme = cx.theme().clone();
        let Some(modal) = self.pi_provider_setup.as_ref() else {
            return div().into_any_element();
        };
        let busy = modal.busy;
        let configured = modal.configured;
        v_flex()
            .id("pi-provider-setup-backdrop")
            .absolute().inset_0().occlude().items_center().justify_center()
            .bg(gpui::black().opacity(0.18))
            .on_mouse_down(gpui::MouseButton::Left, |_event, _window, cx| cx.stop_propagation())
            .on_click(cx.listener(|this, _event, window, cx| { cx.stop_propagation(); this.close_pi_provider_setup(window, cx); }))
            .on_key_down(cx.listener(|this, event: &gpui::KeyDownEvent, window, cx| {
                if event.keystroke.key == "escape" { this.close_pi_provider_setup(window, cx); cx.stop_propagation(); return; }
                if event.keystroke.key != "tab" { return; }
                let Some(modal) = this.pi_provider_setup.as_ref() else { return };
                let mut handles = vec![modal.api_key.read(cx).focus_handle(cx), this.pi_provider_cancel_focus.clone(), this.pi_provider_save_focus.clone()];
                if modal.configured { handles.push(this.pi_provider_sign_out_focus.clone()); }
                let position = handles.iter().position(|handle| handle.is_focused(window));
                handles[trapped_focus_index(event.keystroke.modifiers.shift, position, handles.len())].focus(window);
                cx.stop_propagation();
            }))
            .child(v_flex().id("pi-provider-setup-dialog").w(px(440.)).max_w(gpui::relative(0.9)).gap_3().p_4().rounded(px(16.)).border_1().border_color(theme.border).bg(theme.popover).shadow_lg().occlude()
                .on_mouse_down(gpui::MouseButton::Left, |_event, _window, cx| cx.stop_propagation())
                .on_click(|_event, _window, cx| cx.stop_propagation())
                .child(div().font_weight(FontWeight::SEMIBOLD).child(format!("Set up {}", modal.label)))
                .child(div().text_sm().text_color(theme.muted_foreground).child("This credential is encrypted on this Mac and bound to Pi's exact provider catalog."))
                .child(Input::new(&modal.api_key).mask_toggle().disabled(busy))
                .when_some(modal.error.clone(), |el, error| el.child(div().text_sm().text_color(theme.danger).child(error)))
                .child(h_flex().justify_between().gap_2()
                    .child(if configured { div().track_focus(&self.pi_provider_sign_out_focus).tab_stop(true).child(Button::new("pi-provider-sign-out").danger().small().tab_stop(false).label("Sign out").disabled(busy).on_click(cx.listener(|this, _, window, cx| this.sign_out_pi_provider(window, cx)))).into_any_element() } else { div().into_any_element() })
                    .child(h_flex().gap_2()
                        .child(div().track_focus(&self.pi_provider_cancel_focus).tab_stop(true).child(Button::new("pi-provider-cancel").ghost().small().tab_stop(false).label("Cancel").disabled(busy).on_click(cx.listener(|this, _, window, cx| this.close_pi_provider_setup(window, cx)))))
                        .child(div().track_focus(&self.pi_provider_save_focus).tab_stop(true).child(Button::new("pi-provider-save").primary().small().tab_stop(false).label(if busy { "Saving…" } else { "Save" }).disabled(busy).on_click(cx.listener(|this, _, window, cx| this.save_pi_provider_setup(window, cx)))))))
            ).into_any_element()
    }

    fn computer_use_approval_modal(
        &self,
        request: ComputerUseApprovalRequest,
        deciding: bool,
        cx: &mut Context<Self>,
    ) -> gpui::AnyElement {
        let theme = cx.theme().clone();
        let approval_id = request.approval_id.clone();
        let allow_id = request.approval_id.clone();
        let deny_service = self.service.clone();
        let deny_keyboard_service = self.service.clone();
        let allow_service = self.service.clone();
        let allow_keyboard_service = self.service.clone();
        let backdrop_service = self.service.clone();
        let backdrop_id = approval_id.clone();
        v_flex()
            .id("computer-use-approval-backdrop")
            .absolute()
            .inset_0()
            .occlude()
            .items_center()
            .justify_center()
            .bg(gpui::black().opacity(0.18))
            .on_mouse_down(gpui::MouseButton::Left, |_event, _window, cx| {
                cx.stop_propagation()
            })
            .on_click(move |_event, _window, cx| {
                cx.stop_propagation();
                if !deciding {
                    backdrop_service.update(cx, |service, cx| {
                        service.decide_computer_use_approval(
                            &backdrop_id,
                            ComputerUseApprovalDecision::Deny,
                            cx,
                        );
                    });
                }
            })
            .child(
                v_flex()
                    .id("computer-use-approval-dialog")
                    .w(px(440.))
                    .max_w(gpui::relative(0.9))
                    .gap_3()
                    .p_4()
                    .rounded(px(16.))
                    .border_1()
                    .border_color(theme.border)
                    .bg(theme.popover)
                    .shadow_lg()
                    .occlude()
                    .on_mouse_down(gpui::MouseButton::Left, |_event, _window, cx| {
                        cx.stop_propagation()
                    })
                    .on_click(|_event, _window, cx| cx.stop_propagation())
                    .child(
                        div()
                            .font_weight(FontWeight::SEMIBOLD)
                            .child("Allow Computer Use once?"),
                    )
                    .child(
                        div()
                            .text_sm()
                            .text_color(theme.foreground)
                            .child(request.summary),
                    )
                    .child(
                        div()
                            .text_xs()
                            .text_color(theme.muted_foreground)
                            .child(format!(
                                "Exact target: PID {}, window {}. This grant is consumed by this action only.",
                                request.target_pid, request.target_window_id
                            )),
                    )
                    .child(
                        h_flex()
                            .justify_end()
                            .gap_2()
                            .child(
                                div()
                                    .track_focus(&self.computer_use_deny_focus)
                                    .tab_stop(true)
                                    .on_key_down({
                                        let approval_id = request.approval_id.clone();
                                        move |event: &gpui::KeyDownEvent, _window, cx| {
                                            if !deciding
                                                && matches!(
                                                    event.keystroke.key.as_str(),
                                                    "enter" | "space"
                                                )
                                            {
                                                deny_keyboard_service.update(
                                                    cx,
                                                    |service, cx| {
                                                        service.decide_computer_use_approval(
                                                            &approval_id,
                                                            ComputerUseApprovalDecision::Deny,
                                                            cx,
                                                        );
                                                    },
                                                );
                                                cx.stop_propagation();
                                            }
                                        }
                                    })
                                    .child(
                                        Button::new("computer-use-deny")
                                            .ghost()
                                            .small()
                                            .label("Deny")
                                            .disabled(deciding)
                                            .tab_stop(false)
                                            .on_click(move |_event, _window, cx| {
                                                deny_service.update(cx, |service, cx| {
                                                    service.decide_computer_use_approval(
                                                        &approval_id,
                                                        ComputerUseApprovalDecision::Deny,
                                                        cx,
                                                    );
                                                });
                                            }),
                                    ),
                            )
                            .child(
                                div()
                                    .track_focus(&self.computer_use_allow_focus)
                                    .tab_stop(true)
                                    .on_key_down({
                                        let approval_id = request.approval_id.clone();
                                        move |event: &gpui::KeyDownEvent, _window, cx| {
                                            if !deciding
                                                && matches!(
                                                    event.keystroke.key.as_str(),
                                                    "enter" | "space"
                                                )
                                            {
                                                allow_keyboard_service.update(
                                                    cx,
                                                    |service, cx| {
                                                        service.decide_computer_use_approval(
                                                            &approval_id,
                                                            ComputerUseApprovalDecision::AllowOnce,
                                                            cx,
                                                        );
                                                    },
                                                );
                                                cx.stop_propagation();
                                            }
                                        }
                                    })
                                    .child(
                                        Button::new("computer-use-allow-once")
                                            .primary()
                                            .small()
                                            .label(if deciding { "Continuing…" } else { "Allow once" })
                                            .disabled(deciding)
                                            .tab_stop(false)
                                            .on_click(move |_event, _window, cx| {
                                                allow_service.update(cx, |service, cx| {
                                                    service.decide_computer_use_approval(
                                                        &allow_id,
                                                        ComputerUseApprovalDecision::AllowOnce,
                                                        cx,
                                                    );
                                                });
                                            }),
                                    ),
                            ),
                    ),
            )
            .into_any_element()
    }

    fn subagent_mcp_read_approval_modal(
        &self,
        request: SubagentMcpReadApprovalRequest,
        deciding: bool,
        error: Option<String>,
        cx: &mut Context<Self>,
    ) -> gpui::AnyElement {
        let theme = cx.theme().clone();
        let deny_id = request.approval_id.clone();
        let deny_button_id = request.approval_id.clone();
        let allow_id = request.approval_id.clone();
        let deny_service = self.service.clone();
        let deny_button_service = self.service.clone();
        let deny_keyboard_service = self.service.clone();
        let allow_button_service = self.service.clone();
        let allow_keyboard_service = self.service.clone();
        let arguments = request.canonical_arguments.clone();
        v_flex()
            .id("subagent-mcp-read-approval-backdrop")
            .absolute()
            .inset_0()
            .occlude()
            .items_center()
            .justify_center()
            .bg(gpui::black().opacity(0.18))
            .on_mouse_down(gpui::MouseButton::Left, |_event, _window, cx| {
                cx.stop_propagation()
            })
            .on_click(move |_event, _window, cx| {
                if !deciding {
                    deny_service.update(cx, |service, cx| {
                        service.decide_subagent_mcp_read_approval(
                            &deny_id,
                            SubagentMcpReadDecision::Deny,
                            cx,
                        );
                    });
                }
            })
            .child(
                v_flex()
                    .id("subagent-mcp-read-approval-dialog")
                    .w(px(560.))
                    .max_w(gpui::relative(0.92))
                    .max_h(gpui::relative(0.86))
                    .gap_3()
                    .p_4()
                    .rounded(px(16.))
                    .border_1()
                    .border_color(theme.border)
                    .bg(theme.popover)
                    .shadow_lg()
                    .occlude()
                    .on_click(|_event, _window, cx| cx.stop_propagation())
                    .child(
                        div()
                            .font_weight(FontWeight::SEMIBOLD)
                            .child("Allow this MCP call once?"),
                    )
                    .child(
                        div().text_sm().child(format!(
                            "A delegated task wants to call {}:{}.",
                            request.server_id, request.tool_name
                        )),
                    )
                    .child(
                        div()
                            .text_xs()
                            .text_color(theme.muted_foreground)
                            .child("The configured server controls the actual effect. Its result will be treated as untrusted evidence."),
                    )
                    .child(
                        v_flex()
                            .gap_1()
                            .child(
                                div()
                                    .text_xs()
                                    .text_color(theme.muted_foreground)
                                    .child("Arguments sent to this server"),
                            )
                            .child(
                                div()
                                    .max_h(px(220.))
                                    .overflow_y_scrollbar()
                                    .p_3()
                                    .rounded_md()
                                    .bg(theme.muted)
                                    .font_family(theme.mono_font_family.clone())
                                    .text_xs()
                                    .child(arguments),
                            ),
                    )
                    .when_some(error, |el, error| {
                        el.child(div().text_xs().text_color(theme.danger).child(error))
                    })
                    .child(
                        h_flex()
                            .justify_end()
                            .gap_2()
                            .child(
                                div()
                                    .track_focus(&self.subagent_mcp_read_deny_focus)
                                    .tab_stop(true)
                                    .on_key_down({
                                        let id = request.approval_id.clone();
                                        move |event: &gpui::KeyDownEvent, _window, cx| {
                                            if !deciding
                                                && matches!(
                                                    event.keystroke.key.as_str(),
                                                    "enter" | "space"
                                                )
                                            {
                                                deny_keyboard_service.update(cx, |service, cx| {
                                                    service.decide_subagent_mcp_read_approval(
                                                        &id,
                                                        SubagentMcpReadDecision::Deny,
                                                        cx,
                                                    );
                                                });
                                                cx.stop_propagation();
                                            }
                                        }
                                    })
                                    .child(
                                        Button::new("subagent-mcp-read-deny")
                                            .ghost()
                                            .small()
                                            .label("Deny")
                                            .disabled(deciding)
                                            .tab_stop(false)
                                            .on_click(move |_event, _window, cx| {
                                                deny_button_service.update(cx, |service, cx| {
                                                    service.decide_subagent_mcp_read_approval(
                                                        &deny_button_id,
                                                        SubagentMcpReadDecision::Deny,
                                                        cx,
                                                    );
                                                });
                                            }),
                                    ),
                            )
                            .child(
                                div()
                                    .track_focus(&self.subagent_mcp_read_allow_focus)
                                    .tab_stop(true)
                                    .on_key_down({
                                        let id = allow_id.clone();
                                        move |event: &gpui::KeyDownEvent, _window, cx| {
                                            if !deciding
                                                && matches!(
                                                    event.keystroke.key.as_str(),
                                                    "enter" | "space"
                                                )
                                            {
                                                allow_keyboard_service.update(cx, |service, cx| {
                                                    service.decide_subagent_mcp_read_approval(
                                                        &id,
                                                        SubagentMcpReadDecision::AllowOnce,
                                                        cx,
                                                    );
                                                });
                                                cx.stop_propagation();
                                            }
                                        }
                                    })
                                    .child(
                                        Button::new("subagent-mcp-read-allow-once")
                                            .primary()
                                            .small()
                                            .label(if deciding { "Calling…" } else { "Allow once" })
                                            .disabled(deciding)
                                            .tab_stop(false)
                                            .on_click(move |_event, _window, cx| {
                                                allow_button_service.update(cx, |service, cx| {
                                                    service.decide_subagent_mcp_read_approval(
                                                        &allow_id,
                                                        SubagentMcpReadDecision::AllowOnce,
                                                        cx,
                                                    );
                                                });
                                            }),
                                    ),
                            ),
                    ),
            )
            .into_any_element()
    }

    fn subagent_mcp_mutation_approval_modal(
        &self,
        request: SubagentMcpMutationApprovalRequest,
        deciding: bool,
        error: Option<String>,
        cx: &mut Context<Self>,
    ) -> gpui::AnyElement {
        let theme = cx.theme().clone();
        let deny_id = request.approval_id.clone();
        let allow_id = request.approval_id.clone();
        let deny_button_id = request.approval_id.clone();
        let deny_service = self.service.clone();
        let deny_button_service = self.service.clone();
        let deny_keyboard_service = self.service.clone();
        let allow_button_service = self.service.clone();
        let allow_keyboard_service = self.service.clone();
        let arguments = request.canonical_arguments.clone();
        let profile = format!(
            "Effect profile: {} · {} · {} · {} · task {}",
            request.classification,
            request.destructive,
            request.idempotency,
            request.open_world,
            request.task_support
        );
        let prior_unknown = request.prior_unknown_effect;
        v_flex()
            .id("subagent-mcp-mutation-approval-backdrop")
            .absolute()
            .inset_0()
            .occlude()
            .items_center()
            .justify_center()
            .bg(gpui::black().opacity(0.18))
            .on_mouse_down(gpui::MouseButton::Left, |_event, _window, cx| {
                cx.stop_propagation()
            })
            .on_click(move |_event, _window, cx| {
                if !deciding {
                    deny_service.update(cx, |service, cx| {
                        service.decide_subagent_mcp_mutation_approval(
                            &deny_id,
                            SubagentMcpMutationDecision::Deny,
                            cx,
                        );
                    });
                }
            })
            .child(
                v_flex()
                    .id("subagent-mcp-mutation-approval-dialog")
                    .w(px(600.))
                    .max_w(gpui::relative(0.92))
                    .max_h(gpui::relative(0.86))
                    .gap_3()
                    .p_4()
                    .rounded(px(16.))
                    .border_1()
                    .border_color(theme.border)
                    .bg(theme.popover)
                    .shadow_lg()
                    .occlude()
                    .on_click(|_event, _window, cx| cx.stop_propagation())
                    .child(
                        div()
                            .font_weight(FontWeight::SEMIBOLD)
                            .child("Allow this MCP mutation once?"),
                    )
                    .child(div().text_sm().child(format!(
                        "A delegated task wants to call {}:{}.",
                        request.server_id, request.tool_name
                    )))
                    .child(
                        div()
                            .text_xs()
                            .text_color(theme.muted_foreground)
                            .child("The configured server controls the actual effect. This call can change remote state; its result is untrusted evidence."),
                    )
                    .child(div().text_xs().text_color(theme.muted_foreground).child(profile))
                    .when(prior_unknown, |el| {
                        el.child(
                            div()
                                .text_xs()
                                .text_color(theme.danger)
                                .child("A prior identical mutation has an unknown outcome. Do not retry automatically; verify the server first."),
                        )
                    })
                    .child(
                        v_flex()
                            .gap_1()
                            .child(
                                div()
                                    .text_xs()
                                    .text_color(theme.muted_foreground)
                                    .child("Arguments sent to this server"),
                            )
                            .child(
                                div()
                                    .max_h(px(220.))
                                    .overflow_y_scrollbar()
                                    .p_3()
                                    .rounded_md()
                                    .bg(theme.muted)
                                    .font_family(theme.mono_font_family.clone())
                                    .text_xs()
                                    .child(arguments),
                            ),
                    )
                    .when_some(error, |el, error| {
                        el.child(div().text_xs().text_color(theme.danger).child(error))
                    })
                    .child(
                        h_flex()
                            .justify_end()
                            .gap_2()
                            .child(
                                div()
                                    .track_focus(&self.subagent_mcp_mutation_deny_focus)
                                    .tab_stop(true)
                                    .on_key_down({
                                        let id = request.approval_id.clone();
                                        move |event: &gpui::KeyDownEvent, _window, cx| {
                                            if !deciding
                                                && matches!(
                                                    event.keystroke.key.as_str(),
                                                    "enter" | "space"
                                                )
                                            {
                                                deny_keyboard_service.update(cx, |service, cx| {
                                                    service.decide_subagent_mcp_mutation_approval(
                                                        &id,
                                                        SubagentMcpMutationDecision::Deny,
                                                        cx,
                                                    );
                                                });
                                                cx.stop_propagation();
                                            }
                                        }
                                    })
                                    .child(
                                        Button::new("subagent-mcp-mutation-deny")
                                            .ghost()
                                            .small()
                                            .label("Deny")
                                            .disabled(deciding)
                                            .tab_stop(false)
                                            .on_click(move |_event, _window, cx| {
                                                deny_button_service.update(cx, |service, cx| {
                                                    service.decide_subagent_mcp_mutation_approval(
                                                        &deny_button_id,
                                                        SubagentMcpMutationDecision::Deny,
                                                        cx,
                                                    );
                                                });
                                            }),
                                    ),
                            )
                            .child(
                                div()
                                    .track_focus(&self.subagent_mcp_mutation_allow_focus)
                                    .tab_stop(true)
                                    .on_key_down({
                                        let id = allow_id.clone();
                                        move |event: &gpui::KeyDownEvent, _window, cx| {
                                            if !deciding
                                                && matches!(
                                                    event.keystroke.key.as_str(),
                                                    "enter" | "space"
                                                )
                                            {
                                                allow_keyboard_service.update(cx, |service, cx| {
                                                    service.decide_subagent_mcp_mutation_approval(
                                                        &id,
                                                        SubagentMcpMutationDecision::AllowOnce,
                                                        cx,
                                                    );
                                                });
                                                cx.stop_propagation();
                                            }
                                        }
                                    })
                                    .child(
                                        Button::new("subagent-mcp-mutation-allow-once")
                                            .primary()
                                            .small()
                                            .label(if deciding { "Calling…" } else { "Allow once" })
                                            .disabled(deciding)
                                            .tab_stop(false)
                                            .on_click(move |_event, _window, cx| {
                                                allow_button_service.update(cx, |service, cx| {
                                                    service.decide_subagent_mcp_mutation_approval(
                                                        &allow_id,
                                                        SubagentMcpMutationDecision::AllowOnce,
                                                        cx,
                                                    );
                                                });
                                            }),
                                    ),
                            ),
                    ),
            )
            .into_any_element()
    }

    fn subagent_shell_approval_modal(
        &self,
        request: SubagentShellApprovalRequest,
        deciding: bool,
        error: Option<String>,
        cx: &mut Context<Self>,
    ) -> gpui::AnyElement {
        let theme = cx.theme().clone();
        let deny_id = request.approval_id.clone();
        let allow_id = request.approval_id.clone();
        let deny_service = self.service.clone();
        let allow_service = self.service.clone();
        let deny_action_service = self.service.clone();
        let deny_keyboard_service = self.service.clone();
        let allow_keyboard_service = self.service.clone();
        v_flex()
            .id("subagent-shell-approval-backdrop")
            .absolute()
            .inset_0()
            .occlude()
            .items_center()
            .justify_center()
            .bg(gpui::black().opacity(0.18))
            .on_mouse_down(gpui::MouseButton::Left, |_event, _window, cx| {
                cx.stop_propagation()
            })
            .on_click(move |_event, _window, cx| {
                if !deciding {
                    deny_service.update(cx, |service, cx| {
                        service.decide_subagent_shell_approval(
                            &deny_id,
                            SubagentShellDecision::Deny,
                            cx,
                        );
                    });
                }
            })
            .child(
                v_flex()
                    .id("subagent-shell-approval-dialog")
                    .w(px(560.))
                    .max_w(gpui::relative(0.92))
                    .max_h(gpui::relative(0.86))
                    .gap_3()
                    .p_4()
                    .rounded(px(16.))
                    .border_1()
                    .border_color(theme.border)
                    .bg(theme.popover)
                    .shadow_lg()
                    .occlude()
                    .on_click(|_event, _window, cx| cx.stop_propagation())
                    .child(
                        div()
                            .font_weight(FontWeight::SEMIBOLD)
                            .child("Allow this command once?"),
                    )
                    .child(crate::approvals::shell_approval::shell_approval_section(
                        &theme,
                        &serde_json::to_value(aiden_core::ToolApprovalDetails::SubagentShell(
                            request.details.clone(),
                        ))
                        .unwrap_or_default(),
                    ))
                    .when_some(error, |el, error| {
                        el.child(div().text_xs().text_color(theme.danger).child(error))
                    })
                    .child(
                        h_flex()
                            .justify_end()
                            .gap_2()
                            .child(
                                div()
                                    .track_focus(&self.subagent_shell_deny_focus)
                                    .tab_stop(true)
                                    .on_key_down({
                                        let id = request.approval_id.clone();
                                        move |event: &gpui::KeyDownEvent, _window, cx| {
                                            if !deciding
                                                && matches!(
                                                    event.keystroke.key.as_str(),
                                                    "enter" | "space"
                                                )
                                            {
                                                deny_keyboard_service.update(cx, |service, cx| {
                                                    service.decide_subagent_shell_approval(
                                                        &id,
                                                        SubagentShellDecision::Deny,
                                                        cx,
                                                    );
                                                });
                                                cx.stop_propagation();
                                            }
                                        }
                                    })
                                    .child(
                                        Button::new("subagent-shell-deny")
                                            .ghost()
                                            .small()
                                            .label("Deny")
                                            .disabled(deciding)
                                            .tab_stop(false)
                                            .on_click(move |_event, _window, cx| {
                                                let id = request.approval_id.clone();
                                                let service = deny_action_service.clone();
                                                service.update(cx, |service, cx| {
                                                    service.decide_subagent_shell_approval(
                                                        &id,
                                                        SubagentShellDecision::Deny,
                                                        cx,
                                                    )
                                                });
                                            }),
                                    ),
                            )
                            .child(
                                div()
                                    .track_focus(&self.subagent_shell_allow_focus)
                                    .tab_stop(true)
                                    .on_key_down({
                                        let allow_id = allow_id.clone();
                                        move |event: &gpui::KeyDownEvent, _window, cx| {
                                            if !deciding
                                                && matches!(
                                                    event.keystroke.key.as_str(),
                                                    "enter" | "space"
                                                )
                                            {
                                                let service = allow_keyboard_service.clone();
                                                let id = allow_id.clone();
                                                service.update(cx, |service, cx| {
                                                    service.decide_subagent_shell_approval(
                                                        &id,
                                                        SubagentShellDecision::AllowOnce,
                                                        cx,
                                                    )
                                                });
                                                cx.stop_propagation();
                                            }
                                        }
                                    })
                                    .child(
                                        Button::new("subagent-shell-allow-once")
                                            .primary()
                                            .small()
                                            .label(if deciding {
                                                "Starting…"
                                            } else {
                                                "Allow once"
                                            })
                                            .disabled(deciding)
                                            .tab_stop(false)
                                            .on_click(move |_event, _window, cx| {
                                                let service = allow_service.clone();
                                                let id = allow_id.clone();
                                                service.update(cx, |service, cx| {
                                                    service.decide_subagent_shell_approval(
                                                        &id,
                                                        SubagentShellDecision::AllowOnce,
                                                        cx,
                                                    )
                                                });
                                            }),
                                    ),
                            ),
                    ),
            )
            .into_any_element()
    }

    fn subagent_write_approval_modal(
        &self,
        request: SubagentWorkspaceWriteApprovalRequest,
        deciding: bool,
        error: Option<String>,
        cx: &mut Context<Self>,
    ) -> gpui::AnyElement {
        let theme = cx.theme().clone();
        let operation = match request.details.operation {
            aiden_core::WorkspaceWriteOperation::Create => "Create file",
            aiden_core::WorkspaceWriteOperation::Replace => "Replace file",
            aiden_core::WorkspaceWriteOperation::Edit => "Edit file",
        };
        let approval_id = request.approval_id.clone();
        let allow_id = request.approval_id.clone();
        let backdrop_id = request.approval_id.clone();
        let deny_service = self.service.clone();
        let deny_keyboard_service = self.service.clone();
        let allow_service = self.service.clone();
        let allow_keyboard_service = self.service.clone();
        let backdrop_service = self.service.clone();
        v_flex()
            .id("subagent-write-approval-backdrop")
            .absolute()
            .inset_0()
            .occlude()
            .items_center()
            .justify_center()
            .bg(gpui::black().opacity(0.18))
            .on_mouse_down(gpui::MouseButton::Left, |_event, _window, cx| {
                cx.stop_propagation()
            })
            .on_click(move |_event, _window, cx| {
                cx.stop_propagation();
                if !deciding {
                    backdrop_service.update(cx, |service, cx| {
                        service.decide_subagent_write_approval(
                            &backdrop_id,
                            SubagentWorkspaceWriteDecision::Deny,
                            cx,
                        );
                    });
                }
            })
            .child(
                v_flex()
                    .id("subagent-write-approval-dialog")
                    .w(px(560.))
                    .max_w(gpui::relative(0.92))
                    .max_h(gpui::relative(0.86))
                    .gap_3()
                    .p_4()
                    .rounded(px(16.))
                    .border_1()
                    .border_color(theme.border)
                    .bg(theme.popover)
                    .shadow_lg()
                    .occlude()
                    .on_mouse_down(gpui::MouseButton::Left, |_event, _window, cx| {
                        cx.stop_propagation()
                    })
                    .on_click(|_event, _window, cx| cx.stop_propagation())
                    .child(
                        div()
                            .font_weight(FontWeight::SEMIBOLD)
                            .child("Allow this workspace change once?"),
                    )
                    .child(
                        div()
                            .text_sm()
                            .text_color(theme.foreground)
                            .child(format!(
                                "{} · {} · {}",
                                operation, request.details.path, request.details.workspace_label
                            )),
                    )
                    .child(
                        div()
                            .text_xs()
                            .text_color(theme.muted_foreground)
                            .child(format!(
                                "{} proposes this exact change. Before: {} · After: {}. No command will run.",
                                request.details.child_label,
                                request
                                    .details
                                    .pre_digest_prefix
                                    .as_deref()
                                    .unwrap_or("must not exist"),
                                request.details.post_digest_prefix,
                            )),
                    )
                    .child(
                        v_flex()
                            .gap_1()
                            .child(
                                div()
                                    .text_xs()
                                    .font_weight(FontWeight::SEMIBOLD)
                                    .text_color(theme.muted_foreground)
                                    .child(if request.details.diff_truncated {
                                        "Sanitized change preview · truncated"
                                    } else {
                                        "Sanitized change preview"
                                    }),
                            )
                            .child(
                                div()
                                    .max_h(px(240.))
                                    .overflow_y_scrollbar()
                                    .p_3()
                                    .rounded_md()
                                    .bg(theme.secondary)
                                    .text_xs()
                                    .child(request.details.diff_preview.clone()),
                            ),
                    )
                    .child(
                        div()
                            .text_xs()
                            .text_color(theme.muted_foreground)
                            .child("Aiden will refuse the change if the workspace, file, provider, credential, or approval binding has changed since this preview."),
                    )
                    .when_some(error, |el, error| {
                        el.child(div().text_xs().text_color(theme.danger).child(error))
                    })
                    .child(
                        h_flex()
                            .justify_end()
                            .gap_2()
                            .child(
                                div()
                                    .track_focus(&self.subagent_write_deny_focus)
                                    .tab_stop(true)
                                    .on_key_down({
                                        let approval_id = request.approval_id.clone();
                                        move |event: &gpui::KeyDownEvent, _window, cx| {
                                            if !deciding
                                                && matches!(
                                                    event.keystroke.key.as_str(),
                                                    "enter" | "space"
                                                )
                                            {
                                                deny_keyboard_service.update(cx, |service, cx| {
                                                    service.decide_subagent_write_approval(
                                                        &approval_id,
                                                        SubagentWorkspaceWriteDecision::Deny,
                                                        cx,
                                                    );
                                                });
                                                cx.stop_propagation();
                                            }
                                        }
                                    })
                                    .child(
                                        Button::new("subagent-write-deny")
                                            .ghost()
                                            .small()
                                            .label("Deny")
                                            .disabled(deciding)
                                            .tab_stop(false)
                                            .on_click(move |_event, _window, cx| {
                                                deny_service.update(cx, |service, cx| {
                                                    service.decide_subagent_write_approval(
                                                        &approval_id,
                                                        SubagentWorkspaceWriteDecision::Deny,
                                                        cx,
                                                    );
                                                });
                                            }),
                                    ),
                            )
                            .child(
                                div()
                                    .track_focus(&self.subagent_write_allow_focus)
                                    .tab_stop(true)
                                    .on_key_down({
                                        let approval_id = request.approval_id.clone();
                                        move |event: &gpui::KeyDownEvent, _window, cx| {
                                            if !deciding
                                                && matches!(
                                                    event.keystroke.key.as_str(),
                                                    "enter" | "space"
                                                )
                                            {
                                                allow_keyboard_service.update(cx, |service, cx| {
                                                    service.decide_subagent_write_approval(
                                                        &approval_id,
                                                        SubagentWorkspaceWriteDecision::AllowOnce,
                                                        cx,
                                                    );
                                                });
                                                cx.stop_propagation();
                                            }
                                        }
                                    })
                                    .child(
                                        Button::new("subagent-write-allow-once")
                                            .primary()
                                            .small()
                                            .label(if deciding { "Applying…" } else { "Allow once" })
                                            .disabled(deciding)
                                            .tab_stop(false)
                                            .on_click(move |_event, _window, cx| {
                                                allow_service.update(cx, |service, cx| {
                                                    service.decide_subagent_write_approval(
                                                        &allow_id,
                                                        SubagentWorkspaceWriteDecision::AllowOnce,
                                                        cx,
                                                    );
                                                });
                                            }),
                                    ),
                            ),
                    ),
            )
            .into_any_element()
    }

    fn computer_use_privacy_modal(&self, cx: &mut Context<Self>) -> gpui::AnyElement {
        let theme = cx.theme().clone();
        v_flex()
            .id("computer-use-privacy-backdrop")
            .absolute()
            .inset_0()
            .occlude()
            .items_center()
            .justify_center()
            .bg(gpui::black().opacity(0.18))
            .on_mouse_down(gpui::MouseButton::Left, |_event, _window, cx| {
                cx.stop_propagation()
            })
            .on_click(cx.listener(|this, _event, window, cx| {
                cx.stop_propagation();
                this.cancel_computer_use_privacy(window, cx);
            }))
            .child(
                v_flex()
                    .id("computer-use-privacy-dialog")
                    .w(px(500.))
                    .max_w(gpui::relative(0.9))
                    .gap_3()
                    .p_4()
                    .rounded(px(16.))
                    .border_1()
                    .border_color(theme.border)
                    .bg(theme.popover)
                    .shadow_lg()
                    .occlude()
                    .on_mouse_down(gpui::MouseButton::Left, |_event, _window, cx| {
                        cx.stop_propagation()
                    })
                    .on_click(|_event, _window, cx| cx.stop_propagation())
                    .child(
                        div()
                            .font_weight(FontWeight::SEMIBOLD)
                            .child("Enable Computer Use for this chat?"),
                    )
                    .child(div().text_sm().text_color(theme.muted_foreground).child(
                        "Computer Use can inspect the selected app's pixels and accessibility details. That transient UI context may be sent to your selected model provider, but Aiden does not save or log captures. Every input action still asks for Allow once or Deny.",
                    ))
                    .child(div().text_xs().text_color(theme.muted_foreground).child(
                        "The pinned helper and macOS permissions must be ready. Permission prompts only appear after you explicitly request them in Settings.",
                    ))
                    .child(
                        h_flex()
                            .justify_end()
                            .gap_2()
                            .child(
                                div()
                                    .track_focus(&self.computer_use_privacy_cancel_focus)
                                    .tab_stop(true)
                                    .on_key_down(cx.listener(
                                        |this, event: &gpui::KeyDownEvent, window, cx| {
                                            if matches!(
                                                event.keystroke.key.as_str(),
                                                "enter" | "space"
                                            ) {
                                                this.cancel_computer_use_privacy(window, cx);
                                                cx.stop_propagation();
                                            }
                                        },
                                    ))
                                    .child(
                                        Button::new("computer-use-privacy-cancel")
                                            .ghost()
                                            .small()
                                            .label("Not now")
                                            .tab_stop(false)
                                            .on_click(cx.listener(
                                                |this, _event, window, cx| {
                                                    this.cancel_computer_use_privacy(window, cx)
                                                },
                                            )),
                                    ),
                            )
                            .child(
                                div()
                                    .track_focus(&self.computer_use_privacy_session_focus)
                                    .tab_stop(true)
                                    .on_key_down(cx.listener(
                                        |this, event: &gpui::KeyDownEvent, window, cx| {
                                            if matches!(
                                                event.keystroke.key.as_str(),
                                                "enter" | "space"
                                            ) {
                                                this.accept_computer_use_privacy(
                                                    ComputerUseNoticeDismissal::Session,
                                                    window,
                                                    cx,
                                                );
                                                cx.stop_propagation();
                                            }
                                        },
                                    ))
                                    .child(
                                        Button::new("computer-use-privacy-session")
                                            .outline()
                                            .small()
                                            .label("Enable this session")
                                            .tab_stop(false)
                                            .on_click(cx.listener(
                                                |this, _event, window, cx| {
                                                    this.accept_computer_use_privacy(
                                                        ComputerUseNoticeDismissal::Session,
                                                        window,
                                                        cx,
                                                    )
                                                },
                                            )),
                                    ),
                            )
                            .child(
                                div()
                                    .track_focus(&self.computer_use_privacy_permanent_focus)
                                    .tab_stop(true)
                                    .on_key_down(cx.listener(
                                        |this, event: &gpui::KeyDownEvent, window, cx| {
                                            if matches!(
                                                event.keystroke.key.as_str(),
                                                "enter" | "space"
                                            ) {
                                                this.accept_computer_use_privacy(
                                                    ComputerUseNoticeDismissal::Permanent,
                                                    window,
                                                    cx,
                                                );
                                                cx.stop_propagation();
                                            }
                                        },
                                    ))
                                    .child(
                                        Button::new("computer-use-privacy-permanent")
                                            .primary()
                                            .small()
                                            .label("Enable & remember")
                                            .tab_stop(false)
                                            .on_click(cx.listener(
                                                |this, _event, window, cx| {
                                                    this.accept_computer_use_privacy(
                                                        ComputerUseNoticeDismissal::Permanent,
                                                        window,
                                                        cx,
                                                    )
                                                },
                                            )),
                                    ),
                            ),
                    ),
            )
            .into_any_element()
    }
}

impl Render for AppState {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = cx.theme().clone();
        let active_subagent_approval = self.service.read(cx).active_subagent_approval();
        let computer_use_approval = match &active_subagent_approval {
            Some(ActiveSubagentApproval::ComputerUse(request)) => Some(request.clone()),
            _ => None,
        };
        let subagent_write_approval = match &active_subagent_approval {
            Some(ActiveSubagentApproval::WorkspaceWrite(request)) => Some(request.clone()),
            _ => None,
        };
        let subagent_shell_approval = match &active_subagent_approval {
            Some(ActiveSubagentApproval::Shell(request)) => Some(request.clone()),
            _ => None,
        };
        let subagent_mcp_read_approval = match &active_subagent_approval {
            Some(ActiveSubagentApproval::McpRead(request)) => Some(request.clone()),
            _ => None,
        };
        let subagent_mcp_mutation_approval = match &active_subagent_approval {
            Some(ActiveSubagentApproval::McpMutation(request)) => Some(request.clone()),
            _ => None,
        };
        let deny_focus = match &active_subagent_approval {
            Some(ActiveSubagentApproval::ComputerUse(_)) => self.computer_use_deny_focus.clone(),
            Some(ActiveSubagentApproval::WorkspaceWrite(_)) => {
                self.subagent_write_deny_focus.clone()
            }
            Some(ActiveSubagentApproval::Shell(_)) => self.subagent_shell_deny_focus.clone(),
            Some(ActiveSubagentApproval::McpRead(_)) => self.subagent_mcp_read_deny_focus.clone(),
            Some(ActiveSubagentApproval::McpMutation(_)) => {
                self.subagent_mcp_mutation_deny_focus.clone()
            }
            None => self.subagent_write_deny_focus.clone(),
        };
        self.reconcile_subagent_approval_focus(
            active_subagent_approval
                .as_ref()
                .map(ActiveSubagentApproval::approval_id),
            deny_focus,
            window,
            cx,
        );
        let computer_use_deciding = self.service.read(cx).computer_use_approval_deciding();
        let subagent_write_deciding = self.service.read(cx).subagent_write_approval_deciding();
        let subagent_write_error = self
            .service
            .read(cx)
            .subagent_write_approval_error()
            .map(str::to_string);
        let subagent_shell_deciding = self.service.read(cx).subagent_shell_approval_deciding();
        let subagent_shell_error = self
            .service
            .read(cx)
            .subagent_shell_approval_error()
            .map(str::to_string);
        let subagent_mcp_read_deciding =
            self.service.read(cx).subagent_mcp_read_approval_deciding();
        let subagent_mcp_read_error = self
            .service
            .read(cx)
            .subagent_mcp_read_approval_error()
            .map(str::to_string);
        let subagent_mcp_mutation_deciding = self
            .service
            .read(cx)
            .subagent_mcp_mutation_approval_deciding();
        let subagent_mcp_mutation_error = self
            .service
            .read(cx)
            .subagent_mcp_mutation_approval_error()
            .map(str::to_string);
        let show_subagent_shell_approval = subagent_shell_approval.is_some();
        let computer_use_privacy = self.computer_use_privacy.is_open();

        let title = match self.view {
            AppView::Chat => crate::chat::toolbar::chat_title(
                self.service
                    .read(cx)
                    .active_chat
                    .as_ref()
                    .map(|chat| chat.title.as_str()),
            ),
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
        let provider_editor = self
            .settings
            .clone()
            .filter(|settings| settings.read(cx).provider_editor_modal_open());
        let provider_editor_open = provider_editor.is_some();
        let app_key_context = if subagent_mcp_mutation_approval.is_some() {
            "SubagentMcpMutationApprovalModal"
        } else if subagent_mcp_read_approval.is_some() {
            "SubagentMcpReadApprovalModal"
        } else if subagent_shell_approval.is_some() {
            "SubagentShellApprovalModal"
        } else if subagent_write_approval.is_some() {
            "SubagentWorkspaceWriteApprovalModal"
        } else if computer_use_approval.is_some() {
            "ComputerUseApprovalModal"
        } else if computer_use_privacy {
            "ComputerUsePrivacyModal"
        } else if skills_modal {
            "SettingsModal"
        } else if provider_editor_open {
            "SettingsProviderEditorModal"
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
                if let Some(request) = this
                    .service
                    .read(cx)
                    .pending_subagent_mcp_mutation_approval()
                    .cloned()
                {
                    let deciding = this
                        .service
                        .read(cx)
                        .subagent_mcp_mutation_approval_deciding();
                    if event.keystroke.key == "escape" && !deciding {
                        this.service.update(cx, |service, cx| {
                            service.decide_subagent_mcp_mutation_approval(
                                &request.approval_id,
                                SubagentMcpMutationDecision::Deny,
                                cx,
                            );
                        });
                        cx.stop_propagation();
                    }
                    if event.keystroke.key == "tab" {
                        let handles = [
                            this.subagent_mcp_mutation_deny_focus.clone(),
                            this.subagent_mcp_mutation_allow_focus.clone(),
                        ];
                        let focused = window.focused(cx);
                        let position = handles
                            .iter()
                            .position(|handle| focused.as_ref() == Some(handle));
                        handles[trapped_focus_index(
                            event.keystroke.modifiers.shift,
                            position,
                            handles.len(),
                        )]
                        .focus(window);
                        cx.stop_propagation();
                    }
                    return;
                }
                if let Some(request) = this
                    .service
                    .read(cx)
                    .pending_subagent_mcp_read_approval()
                    .cloned()
                {
                    let deciding = this.service.read(cx).subagent_mcp_read_approval_deciding();
                    if event.keystroke.key == "escape" && !deciding {
                        this.service.update(cx, |service, cx| {
                            service.decide_subagent_mcp_read_approval(
                                &request.approval_id,
                                SubagentMcpReadDecision::Deny,
                                cx,
                            );
                        });
                        cx.stop_propagation();
                    }
                    if event.keystroke.key == "tab" {
                        let handles = [
                            this.subagent_mcp_read_deny_focus.clone(),
                            this.subagent_mcp_read_allow_focus.clone(),
                        ];
                        let focused = window.focused(cx);
                        let position = handles
                            .iter()
                            .position(|handle| focused.as_ref() == Some(handle));
                        handles[trapped_focus_index(
                            event.keystroke.modifiers.shift,
                            position,
                            handles.len(),
                        )]
                        .focus(window);
                        cx.stop_propagation();
                    }
                    return;
                }
                if let Some(request) = this
                    .service
                    .read(cx)
                    .pending_subagent_shell_approval()
                    .cloned()
                {
                    let deciding = this.service.read(cx).subagent_shell_approval_deciding();
                    if event.keystroke.key == "escape" && !deciding {
                        this.service.update(cx, |service, cx| {
                            service.decide_subagent_shell_approval(
                                &request.approval_id,
                                SubagentShellDecision::Deny,
                                cx,
                            );
                        });
                        cx.stop_propagation();
                    }
                    if event.keystroke.key == "tab" {
                        let handles = [
                            this.subagent_shell_deny_focus.clone(),
                            this.subagent_shell_allow_focus.clone(),
                        ];
                        let focused = window.focused(cx);
                        let position = handles
                            .iter()
                            .position(|handle| focused.as_ref() == Some(handle));
                        handles[trapped_focus_index(
                            event.keystroke.modifiers.shift,
                            position,
                            handles.len(),
                        )]
                        .focus(window);
                        cx.stop_propagation();
                    }
                    return;
                }
                if let Some(request) = this
                    .service
                    .read(cx)
                    .pending_subagent_write_approval()
                    .cloned()
                {
                    let deciding = this.service.read(cx).subagent_write_approval_deciding();
                    if event.keystroke.key == "escape" {
                        if let Some(decision) = subagent_write_escape_decision(deciding) {
                            this.decide_subagent_write_approval(&request.approval_id, decision, cx);
                            cx.stop_propagation();
                        }
                        return;
                    }
                    if event.keystroke.key == "tab" {
                        let handles = [
                            this.subagent_write_deny_focus.clone(),
                            this.subagent_write_allow_focus.clone(),
                        ];
                        let focused = window.focused(cx);
                        let position = handles
                            .iter()
                            .position(|handle| focused.as_ref() == Some(handle));
                        let next = trapped_focus_index(
                            event.keystroke.modifiers.shift,
                            position,
                            handles.len(),
                        );
                        handles[next].focus(window);
                        cx.stop_propagation();
                    }
                    return;
                }
                if let Some(request) = this
                    .service
                    .read(cx)
                    .pending_computer_use_approval()
                    .cloned()
                {
                    let deciding = this.service.read(cx).computer_use_approval_deciding();
                    if event.keystroke.key == "escape" {
                        if let Some(decision) = computer_use_escape_decision(deciding) {
                            this.decide_computer_use_approval(&request.approval_id, decision, cx);
                            cx.stop_propagation();
                        }
                        return;
                    }
                    if event.keystroke.key == "tab" {
                        let focused = window.focused(cx);
                        let backwards = event.keystroke.modifiers.shift;
                        if backwards && focused.as_ref() == Some(&this.computer_use_deny_focus) {
                            this.computer_use_allow_focus.focus(window);
                        } else if !backwards
                            && focused.as_ref() == Some(&this.computer_use_allow_focus)
                        {
                            this.computer_use_deny_focus.focus(window);
                        } else if focused.as_ref() != Some(&this.computer_use_deny_focus)
                            && focused.as_ref() != Some(&this.computer_use_allow_focus)
                        {
                            if backwards {
                                this.computer_use_allow_focus.focus(window);
                            } else {
                                this.computer_use_deny_focus.focus(window);
                            }
                        } else {
                            return;
                        }
                        cx.stop_propagation();
                    }
                    return;
                }
                if this.computer_use_privacy.is_open() {
                    if event.keystroke.key == "escape" {
                        this.cancel_computer_use_privacy(window, cx);
                        cx.stop_propagation();
                        return;
                    }
                    if event.keystroke.key == "tab" {
                        let handles = [
                            this.computer_use_privacy_cancel_focus.clone(),
                            this.computer_use_privacy_session_focus.clone(),
                            this.computer_use_privacy_permanent_focus.clone(),
                        ];
                        let focused = window.focused(cx);
                        let position = handles
                            .iter()
                            .position(|handle| focused.as_ref() == Some(handle));
                        let next = trapped_focus_index(
                            event.keystroke.modifiers.shift,
                            position,
                            handles.len(),
                        );
                        handles[next].focus(window);
                        cx.stop_propagation();
                    }
                    return;
                }
                if let Some(settings) = this
                    .settings
                    .clone()
                    .filter(|settings| settings.read(cx).provider_editor_modal_open())
                {
                    if event.keystroke.key == "escape" {
                        settings.update(cx, |settings, cx| {
                            settings.close_provider_editor(window, cx)
                        });
                        cx.stop_propagation();
                        return;
                    }
                    if event.keystroke.key == "tab" {
                        let (handles, focus_inside) = {
                            let state = settings.read(cx);
                            (
                                state.provider_editor_modal_focus_handles(cx),
                                state.provider_editor_modal_contains_focus(window, cx),
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
            // Paint above every route but before root modal layers. A compact
            // Environment sheet or approval/auth dialog makes it inert/hidden.
            .child(self.assistant_dock(window, cx))
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
            .when(provider_editor_open, |el| {
                el.when_some(provider_editor, |el, settings| {
                    el.child(crate::settings::providers::provider_editor_modal(
                        &settings, cx,
                    ))
                })
            })
            .when_some(computer_use_approval, |el, request| {
                el.child(self.computer_use_approval_modal(request, computer_use_deciding, cx))
            })
            .when_some(subagent_write_approval, |el, request| {
                el.child(self.subagent_write_approval_modal(
                    request,
                    subagent_write_deciding,
                    subagent_write_error,
                    cx,
                ))
            })
            .when(show_subagent_shell_approval, |el| {
                el.when_some(subagent_shell_approval, |el, request| {
                    el.child(self.subagent_shell_approval_modal(
                        request,
                        subagent_shell_deciding,
                        subagent_shell_error,
                        cx,
                    ))
                })
            })
            .when_some(subagent_mcp_read_approval, |el, request| {
                el.child(self.subagent_mcp_read_approval_modal(
                    request,
                    subagent_mcp_read_deciding,
                    subagent_mcp_read_error,
                    cx,
                ))
            })
            .when_some(subagent_mcp_mutation_approval, |el, request| {
                el.child(self.subagent_mcp_mutation_approval_modal(
                    request,
                    subagent_mcp_mutation_deciding,
                    subagent_mcp_mutation_error,
                    cx,
                ))
            })
            .when(computer_use_privacy, |el| {
                el.child(self.computer_use_privacy_modal(cx))
            })
            .when(self.pi_provider_setup.is_some(), |el| {
                el.child(self.pi_provider_setup_modal(cx))
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
    use std::collections::VecDeque;

    /// A real GPUI entity/window harness for the root-dock lifecycle. It uses
    /// a tiny panel instead of the production network-owning AssistantPanel,
    /// so it can assert entity identity and focus deterministically.
    struct AssistantDockPanelHarness {
        composer: FocusHandle,
    }

    impl Render for AssistantDockPanelHarness {
        fn render(&mut self, _window: &mut Window, _cx: &mut Context<Self>) -> impl IntoElement {
            div().track_focus(&self.composer).tab_stop(true)
        }
    }

    struct AssistantDockLifecycleHarness {
        view: AppView,
        panel: Option<Entity<AssistantDockPanelHarness>>,
        open: bool,
        present: bool,
        unread: u8,
        preview: Option<String>,
        return_focus: Option<FocusHandle>,
        bubble: FocusHandle,
        origin: FocusHandle,
    }

    impl AssistantDockLifecycleHarness {
        fn open(&mut self, window: &mut Window, cx: &mut Context<Self>) {
            if !self.open {
                self.return_focus = window.focused(cx);
                self.open = true;
                self.present = true;
                self.unread = 0;
                self.preview = None;
            }
            let panel = self.panel.get_or_insert_with(|| {
                cx.new(|cx| AssistantDockPanelHarness {
                    composer: cx.focus_handle(),
                })
            });
            panel.read(cx).composer.focus(window);
            cx.notify();
        }

        fn minimize(&mut self, window: &mut Window, cx: &mut Context<Self>) {
            self.open = false;
            // The actual app waits 120 ms except under reduced motion; the
            // harness makes the exit boundary explicit and deterministic.
            self.finish_minimize(window, cx);
        }

        fn finish_minimize(&mut self, window: &mut Window, cx: &mut Context<Self>) {
            self.present = false;
            self.return_focus
                .take()
                .unwrap_or_else(|| self.bubble.clone())
                .focus(window);
            cx.notify();
        }

        fn notice(&mut self, message: &str, cx: &mut Context<Self>) {
            let (unread, preview) = assistant_notice_state(self.open, self.unread, message);
            self.unread = unread;
            self.preview = preview;
            cx.notify();
        }
    }

    impl Render for AssistantDockLifecycleHarness {
        fn render(&mut self, _window: &mut Window, _cx: &mut Context<Self>) -> impl IntoElement {
            div()
                .child(div().track_focus(&self.origin).tab_stop(true))
                .child(div().track_focus(&self.bubble).tab_stop(true))
        }
    }

    #[gpui::test]
    fn assistant_dock_entity_lifecycle_preserves_routes_focus_and_minimized_notices(
        cx: &mut gpui::TestAppContext,
    ) {
        let (dock, cx) = cx.add_window_view(|_window, cx| AssistantDockLifecycleHarness {
            view: AppView::Chat,
            panel: None,
            open: false,
            present: false,
            unread: 0,
            preview: None,
            return_focus: None,
            bubble: cx.focus_handle(),
            origin: cx.focus_handle(),
        });
        cx.update(|window, app| {
            let origin = dock.read(app).origin.clone();
            origin.focus(window);
            assert!(dock.read(app).panel.is_none());

            dock.update(app, |state, cx| state.open(window, cx));
            let first = dock.read(app).panel.clone().expect("one panel");
            assert_eq!(dock.read(app).view, AppView::Chat);
            assert_eq!(window.focused(app), Some(first.read(app).composer.clone()));

            // A route change does not replace the dock entity.
            dock.update(app, |state, cx| {
                state.view = AppView::Scheduled;
                cx.notify();
            });
            assert_eq!(
                dock.read(app).panel.as_ref().unwrap().entity_id(),
                first.entity_id()
            );

            dock.update(app, |state, cx| state.minimize(window, cx));
            assert!(!dock.read(app).present);
            assert_eq!(window.focused(app), Some(origin));

            dock.update(app, |state, cx| state.notice("background reply", cx));
            assert_eq!(dock.read(app).unread, 1);
            assert_eq!(dock.read(app).preview.as_deref(), Some("background reply"));
            dock.update(app, |state, cx| state.open(window, cx));
            assert_eq!(dock.read(app).unread, 0);
            assert!(dock.read(app).preview.is_none());
            assert_eq!(
                dock.read(app).panel.as_ref().unwrap().entity_id(),
                first.entity_id()
            );
        });
    }

    #[test]
    fn retained_pill_reuse_never_activates_the_target_window() {
        // The GPUI window handle is intentionally not faked here: the
        // production bridge's retained-handle branch is the contract under
        // test. A no-op update probes liveness; activation would steal focus
        // from the application that receives the eventual paste.
        let source = include_str!("app.rs");
        let bridge = source
            .split_once("fn bridge_show_pill(")
            .and_then(|(_, rest)| rest.split_once("fn bridge_close_pill("))
            .map(|(bridge, _)| bridge)
            .expect("pill bridge boundaries");
        assert!(bridge.contains("handle.update(app, |_view, _window, _cx| {})"));
        assert!(!bridge.contains("window.activate_window()"));
    }

    #[test]
    fn slash_phase2_catalog_refresh_is_cached_until_workspace_changes() {
        let mut state = SlashPaletteState::default();
        // An empty catalog is still a completed load. The next query must not
        // rediscover it merely because no matching skill rows were returned.
        assert!(state.catalog_refresh_needed("workspace-a"));
        state.catalog_identity = Some("workspace-a".into());
        state.catalog_loaded = true;
        assert!(!state.catalog_refresh_needed("workspace-a"));
        assert!(state.catalog_refresh_needed("workspace-b"));
        state.catalog_loading = true;
        assert!(!state.catalog_refresh_needed("workspace-b"));
    }

    #[test]
    fn slash_phase3_selected_skill_send_snapshots_the_opaque_chip() {
        let mut selection = crate::chat::slash::SkillSelection::default();
        assert!(skill_selection_for_send(&selection).is_none());
        let entry = SkillCatalogEntry {
            id: "skillref_example".into(),
            name: "Review".into(),
            description: "Review a change".into(),
            source: crate::services::skill_tools::SkillCatalogSource::Workspace,
            revision: "rev-1".into(),
        };
        selection.replace(&entry);
        let snapshot = skill_selection_for_send(&selection).expect("selected chip");
        assert_eq!(snapshot.id, "skillref_example");
        assert_eq!(snapshot.workspace_identity, None);
        // The service owns resolution; taking the snapshot has no mutation
        // side effect, so the chip remains available on a rejected lease.
        assert!(selection.is_selected("skillref_example"));
    }

    #[test]
    fn slash_phase3_rejected_or_unknown_admission_keeps_the_selected_chip() {
        use crate::services::chat_service::ChatSubmissionOutcome;

        let mut draft = crate::chat::composer::ComposerDraft::default();
        let entry = SkillCatalogEntry {
            id: "skillref_example".into(),
            name: "Review".into(),
            description: "Review a change".into(),
            source: crate::services::skill_tools::SkillCatalogSource::Workspace,
            revision: "rev-1".into(),
        };
        draft.skill_selection.replace(&entry);
        let submission = submission_identity("chat-a", 11);
        let mut coordinator = ComposerSubmissionCoordinator::default();
        assert!(coordinator.begin(submission.clone(), "draft".into(), draft.clone()));
        assert!(!coordinator.settle(
            &submission,
            Some(ChatSubmissionOutcome::Rejected),
            "draft",
            &draft,
        ));
        assert!(coordinator.pending().is_none());
        assert!(draft.skill_selection.is_selected("skillref_example"));

        assert!(coordinator.begin(submission.clone(), "draft".into(), draft.clone()));
        assert!(!coordinator.settle(
            &submission,
            Some(ChatSubmissionOutcome::Unknown),
            "draft",
            &draft,
        ));
        assert!(coordinator.pending().is_some());
        assert!(draft.skill_selection.is_selected("skillref_example"));
    }

    #[test]
    fn slash_phase2_popup_is_non_modal_and_keeps_composer_focus() {
        let popup_source = include_str!("chat/chat_pane.rs");
        let popup = popup_source
            .split_once("fn slash_palette_popup(")
            .and_then(|(_, rest)| rest.split_once("fn composer_model_picker("))
            .map(|(popup, _)| popup)
            .expect("slash popup source boundaries");
        assert!(popup.contains("composer-slash-palette"));
        assert!(popup.contains("overflow_y_scroll"));
        assert!(popup.matches(".tab_stop(false)").count() >= 2);
        assert!(popup.contains("Commands"));
        assert!(popup.contains("Skills"));
        assert!(!popup.contains("open_dialog"));

        let app_source = include_str!("app.rs");
        assert!(app_source.contains("InputEvent::Blur"));
        assert!(app_source.contains("cx.defer_in(window"));
        assert!(app_source.contains("handle_slash_key"));
    }

    #[test]
    fn quit_claim_is_single_use_until_the_attempt_settles() {
        let mut quit_in_flight = false;
        assert!(claim_quit(&mut quit_in_flight));
        assert!(!claim_quit(&mut quit_in_flight));

        // A failed authority shutdown clears the claim so the user can retry;
        // a successful one never returns to the live AppState.
        quit_in_flight = false;
        assert!(claim_quit(&mut quit_in_flight));
    }

    #[test]
    fn quit_waits_for_authority_and_keeps_failure_on_the_live_app() {
        let source = include_str!("app.rs");
        let request = source
            .split_once("fn request_quit(")
            .and_then(|(_, rest)| {
                rest.split_once(
                    "// =======================================================================",
                )
            })
            .map(|(request, _)| request)
            .expect("quit request source boundaries");

        assert!(request.contains("let shutdown = Tokio::spawn(cx"));
        assert!(request.contains("computer_use.shutdown().await"));
        assert!(request.contains("Ok(Ok(())) => this.finish_quit(cx)"));
        assert!(request.contains("this.quit_in_flight = false"));
        assert!(request.contains("resume_after_cancelled_shutdown"));
        assert!(request.contains("Notification::error"));
        assert!(request.contains("COMPUTER_USE_QUIT_FAILURE"));
        assert!(!request.contains("cx.quit()"));
        assert!(!request.contains("service.dispose(cx)"));
    }

    #[test]
    fn quit_barrier_does_not_treat_manual_update_open_as_automatic_install() {
        let source = include_str!("app.rs");
        let finish = source
            .split_once("fn finish_quit(")
            .and_then(|(_, rest)| rest.split_once("/// The quit barrier:"))
            .map(|(finish, _)| finish)
            .expect("finish quit source boundaries");
        assert!(!finish.contains("open_downloaded_installer"));
        assert!(!finish.contains("install_on_quit"));
    }

    #[test]
    fn native_close_clears_the_windowless_dictation_generation_gate() {
        let source = include_str!("app.rs");
        let close = source
            .split_once("pub(crate) fn request_native_close(")
            .and_then(|(_, rest)| rest.split_once("fn sidebar_frame("))
            .map(|(close, _)| close)
            .expect("native close source boundaries");
        assert!(close.contains("service.dispose(cx)"));
        assert!(close.contains("CHAT_GENERATION_ACTIVE.store(false, Ordering::Release)"));
    }

    fn submission_identity(
        chat_id: &str,
        counter: u64,
    ) -> crate::services::chat_service::ChatSubmissionIdentity {
        crate::services::chat_service::ChatSubmissionIdentity {
            chat_id: chat_id.into(),
            counter,
        }
    }

    fn draft_with_image_and_edit() -> crate::chat::composer::ComposerDraft {
        crate::chat::composer::ComposerDraft {
            attachments: vec![aiden_core::Attachment {
                id: "image-1".into(),
                name: "photo.png".into(),
                mime_type: "image/png".into(),
                kind: aiden_core::AttachmentKind::Image,
                size: 3,
                data: Some("abc".into()),
                text: None,
            }],
            editing_message_id: Some("user-before-branch".into()),
            attaching: false,
            skill_selection: crate::chat::slash::SkillSelection::default(),
        }
    }

    #[gpui::test]
    fn composer_submission_entity_keeps_failed_drafts_and_clears_only_the_matching_retry(
        cx: &mut gpui::TestAppContext,
    ) {
        use crate::services::chat_service::ChatSubmissionOutcome;

        let coordinator = cx.new(|_| ComposerSubmissionCoordinator::default());
        let original_text = "replace this branch".to_string();
        let original_draft = draft_with_image_and_edit();
        let failed = submission_identity("chat-a", 1);
        let retry = submission_identity("chat-a", 2);

        coordinator.update(cx, |state, _| {
            assert!(state.begin(
                failed.clone(),
                original_text.clone(),
                original_draft.clone()
            ));
            // Button, Enter, and ⌘↩ cannot produce a second in-flight write.
            assert!(!state.begin(retry.clone(), "duplicate".into(), Default::default()));
            // A forced persistence failure unlocks retry but requests no UI
            // clear, so text, image attachment, and edit target remain exact.
            assert!(!state.settle(
                &failed,
                Some(ChatSubmissionOutcome::Rejected),
                &original_text,
                &original_draft,
            ));
            assert!(state.pending().is_none());
            assert!(state.begin(retry.clone(), original_text.clone(), original_draft.clone()));
        });

        coordinator.update(cx, |state, _| {
            // A late success for the failed request cannot consume the newer
            // pending retry, even though both refer to the same chat.
            assert!(!state.settle(
                &failed,
                Some(ChatSubmissionOutcome::Admitted),
                &original_text,
                &original_draft,
            ));
            assert_eq!(state.pending().unwrap().0, retry);
            // The matching retry clears exactly once.
            assert!(state.settle(
                &retry,
                Some(ChatSubmissionOutcome::Admitted),
                &original_text,
                &original_draft,
            ));
            assert!(!state.settle(
                &retry,
                Some(ChatSubmissionOutcome::Admitted),
                &original_text,
                &original_draft,
            ));
        });
    }

    #[gpui::test]
    fn composer_submission_entity_never_clears_a_draft_edited_while_persisting(
        cx: &mut gpui::TestAppContext,
    ) {
        use crate::services::chat_service::ChatSubmissionOutcome;

        let coordinator = cx.new(|_| ComposerSubmissionCoordinator::default());
        let submitted = submission_identity("chat-a", 7);
        let draft = draft_with_image_and_edit();
        coordinator.update(cx, |state, _| {
            assert!(state.begin(submitted.clone(), "original".into(), draft.clone()));
            let mut newer = draft.clone();
            newer.editing_message_id = Some("different-target".into());
            assert!(!state.settle(
                &submitted,
                Some(ChatSubmissionOutcome::Admitted),
                "newer text",
                &newer,
            ));
            assert!(state.pending().is_none());
        });
    }

    #[gpui::test]
    fn composer_submission_unknown_stays_locked_until_reopen_reconciliation_settles(
        cx: &mut gpui::TestAppContext,
    ) {
        use crate::services::chat_service::ChatSubmissionOutcome;

        let coordinator = cx.new(|_| ComposerSubmissionCoordinator::default());
        let submission = submission_identity("chat-a", 9);
        let draft = draft_with_image_and_edit();
        coordinator.update(cx, |state, _| {
            assert!(state.begin(submission.clone(), "draft".into(), draft.clone()));
            assert!(!state.settle(
                &submission,
                Some(ChatSubmissionOutcome::Unknown),
                "draft",
                &draft,
            ));
            assert!(state.pending().is_some());
            // Reopening the chat may prove the exact turn absent; only then
            // does the retained draft become safely retryable.
            assert!(!state.settle(
                &submission,
                Some(ChatSubmissionOutcome::Rejected),
                "draft",
                &draft,
            ));
            assert!(state.pending().is_none());
        });
    }

    struct SubagentWriteFocusHarness {
        origin: FocusHandle,
        deny: FocusHandle,
        allow: FocusHandle,
    }

    impl Render for SubagentWriteFocusHarness {
        fn render(&mut self, _window: &mut Window, _cx: &mut Context<Self>) -> impl IntoElement {
            div()
                .child(div().track_focus(&self.origin).tab_stop(true))
                .child(div().track_focus(&self.deny).tab_stop(true))
                .child(div().track_focus(&self.allow).tab_stop(true))
        }
    }

    #[gpui::test]
    fn subagent_write_modal_focus_wraps_between_deny_and_allow(cx: &mut gpui::TestAppContext) {
        let (view, cx) = cx.add_window_view(|_window, cx| SubagentWriteFocusHarness {
            origin: cx.focus_handle(),
            deny: cx.focus_handle(),
            allow: cx.focus_handle(),
        });
        cx.update(|window, app| {
            let harness = view.read(app);
            let handles = [harness.deny.clone(), harness.allow.clone()];
            handles[0].focus(window);
            handles[trapped_focus_index(true, Some(0), handles.len())].focus(window);
            assert_eq!(window.focused(app), Some(harness.allow.clone()));
            handles[trapped_focus_index(false, Some(1), handles.len())].focus(window);
            assert_eq!(window.focused(app), Some(harness.deny.clone()));
        });
    }

    #[gpui::test]
    fn shared_subagent_modal_order_retains_focus_across_kind_changes_and_restores_once(
        cx: &mut gpui::TestAppContext,
    ) {
        let (view, cx) = cx.add_window_view(|_window, cx| SubagentWriteFocusHarness {
            origin: cx.focus_handle(),
            deny: cx.focus_handle(),
            allow: cx.focus_handle(),
        });
        cx.update(|window, app| {
            use crate::services::chat_service::{
                push_subagent_approval_order, remove_subagent_approval_order,
                subagent_approval_order_is_head, SubagentApprovalKind,
            };
            let origin = view.read(app).origin.clone();
            origin.focus(window);
            let mut focus = SubagentWriteModalFocusState::default();
            let mut order = VecDeque::new();
            push_subagent_approval_order(
                &mut order,
                "computer-0",
                SubagentApprovalKind::ComputerUse,
            );
            push_subagent_approval_order(&mut order, "shell-1", SubagentApprovalKind::Shell);
            push_subagent_approval_order(&mut order, "mcp-2", SubagentApprovalKind::McpRead);
            push_subagent_approval_order(
                &mut order,
                "write-3",
                SubagentApprovalKind::WorkspaceWrite,
            );
            assert!(subagent_approval_order_is_head(
                &order,
                SubagentApprovalKind::ComputerUse,
                "computer-0"
            ));
            match focus.reconcile(Some("computer-0"), window.focused(app)) {
                SubagentWriteModalFocusTransition::FocusDeny => view.read(app).deny.focus(window),
                _ => panic!("first modal must own focus"),
            }
            remove_subagent_approval_order(&mut order, "computer-0");
            assert!(subagent_approval_order_is_head(
                &order,
                SubagentApprovalKind::Shell,
                "shell-1"
            ));
            assert!(matches!(
                focus.reconcile(Some("shell-1"), window.focused(app)),
                SubagentWriteModalFocusTransition::FocusDeny
            ));
            remove_subagent_approval_order(&mut order, "shell-1");
            assert!(subagent_approval_order_is_head(
                &order,
                SubagentApprovalKind::McpRead,
                "mcp-2"
            ));
            assert!(matches!(
                focus.reconcile(Some("mcp-2"), window.focused(app)),
                SubagentWriteModalFocusTransition::FocusDeny
            ));
            remove_subagent_approval_order(&mut order, "mcp-2");
            assert!(subagent_approval_order_is_head(
                &order,
                SubagentApprovalKind::WorkspaceWrite,
                "write-3"
            ));
            assert!(matches!(
                focus.reconcile(Some("write-3"), window.focused(app)),
                SubagentWriteModalFocusTransition::FocusDeny
            ));
            assert_eq!(window.focused(app), Some(view.read(app).deny.clone()));
            assert!(matches!(
                focus.reconcile(Some("write-3"), window.focused(app)),
                SubagentWriteModalFocusTransition::Unchanged
            ));
            remove_subagent_approval_order(&mut order, "write-3");
            let SubagentWriteModalFocusTransition::Restore(restored) =
                focus.reconcile(None, window.focused(app))
            else {
                panic!("final drain must restore original focus");
            };
            restored.focus(window);
            assert_eq!(window.focused(app), Some(origin));

            push_subagent_approval_order(&mut order, "shell-3", SubagentApprovalKind::Shell);
            push_subagent_approval_order(
                &mut order,
                "computer-4",
                SubagentApprovalKind::ComputerUse,
            );
            assert!(subagent_approval_order_is_head(
                &order,
                SubagentApprovalKind::Shell,
                "shell-3"
            ));
            assert!(!subagent_approval_order_is_head(
                &order,
                SubagentApprovalKind::ComputerUse,
                "computer-4"
            ));
        });
    }

    struct SubagentWriteModalLifecycleHarness {
        origin: FocusHandle,
        deny: FocusHandle,
        allow: FocusHandle,
        queue: VecDeque<SubagentWorkspaceWriteApprovalRequest>,
        deciding: Option<String>,
        focus: SubagentWriteModalFocusState,
        decisions: Vec<(String, SubagentWorkspaceWriteDecision)>,
    }

    impl SubagentWriteModalLifecycleHarness {
        fn enqueue(&mut self, approval_id: &str, window: &mut Window, cx: &mut Context<Self>) {
            let generation = crate::services::chat_service::GenerationState {
                chat_id: "chat-1".into(),
                counter: 1,
                provider_id: "provider-1".into(),
                text: String::new(),
                thinking: String::new(),
                thinking_active: false,
                thinking_expanded: false,
                complete: false,
                error: None,
                error_retryable: false,
                model: Some("model-1".into()),
                timeline: None,
            };
            crate::services::chat_service::enqueue_subagent_write_request(
                &mut self.queue,
                Some(&generation),
                subagent_write_request(approval_id),
                1,
            )
            .unwrap();
            self.reconcile(window, cx);
        }

        fn reconcile(&mut self, window: &mut Window, cx: &mut Context<Self>) {
            match self.focus.reconcile(
                self.queue
                    .front()
                    .map(|request| request.approval_id.as_str()),
                window.focused(cx),
            ) {
                SubagentWriteModalFocusTransition::Unchanged => {}
                SubagentWriteModalFocusTransition::FocusDeny => self.deny.focus(window),
                SubagentWriteModalFocusTransition::Restore(focus) => focus.focus(window),
            }
        }

        fn decide(
            &mut self,
            approval_id: &str,
            decision: SubagentWorkspaceWriteDecision,
            window: &mut Window,
            cx: &mut Context<Self>,
        ) -> bool {
            if !crate::services::chat_service::subagent_write_decision_is_current(
                &self.queue,
                self.deciding.as_deref(),
                approval_id,
                1,
            ) {
                return false;
            }
            self.deciding = Some(approval_id.to_string());
            self.decisions.push((approval_id.to_string(), decision));
            crate::services::chat_service::remove_subagent_write_request(
                &mut self.queue,
                &mut self.deciding,
                approval_id,
            );
            self.reconcile(window, cx);
            cx.notify();
            true
        }
    }

    impl Render for SubagentWriteModalLifecycleHarness {
        fn render(&mut self, _window: &mut Window, _cx: &mut Context<Self>) -> impl IntoElement {
            div()
                .track_focus(&self.origin)
                .tab_stop(true)
                .when(!self.queue.is_empty(), |root| {
                    root.child(
                        v_flex()
                            .id("subagent-write-approval-backdrop")
                            .absolute()
                            .inset_0()
                            .occlude()
                            .child(div().track_focus(&self.deny).tab_stop(true).child("Deny"))
                            .child(
                                div()
                                    .track_focus(&self.allow)
                                    .tab_stop(true)
                                    .child("Allow once"),
                            ),
                    )
                })
        }
    }

    fn subagent_write_request(approval_id: &str) -> SubagentWorkspaceWriteApprovalRequest {
        SubagentWorkspaceWriteApprovalRequest {
            approval_id: approval_id.into(),
            generation_id: "chat-1:1".into(),
            chat_id: "chat-1".into(),
            run_id: "run-1".into(),
            child_id: "child-1".into(),
            tool_call_id: format!("call-{approval_id}"),
            authority_revision: 1,
            argument_digest: "a".repeat(64),
            effect_digest: "b".repeat(64),
            authority_digest: "c".repeat(64),
            expires_at: u64::MAX,
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

    #[gpui::test]
    fn subagent_write_modal_forces_fifo_deny_allow_and_rejects_stale_decision(
        cx: &mut gpui::TestAppContext,
    ) {
        let (view, cx) = cx.add_window_view(|_window, cx| SubagentWriteModalLifecycleHarness {
            origin: cx.focus_handle(),
            deny: cx.focus_handle(),
            allow: cx.focus_handle(),
            queue: VecDeque::new(),
            deciding: None,
            focus: SubagentWriteModalFocusState::default(),
            decisions: Vec::new(),
        });
        cx.update(|window, app| {
            let origin = view.read(app).origin.clone();
            origin.focus(window);
            view.update(app, |modal, cx| {
                modal.enqueue("approval-1", window, cx);
                modal.enqueue("approval-2", window, cx);
            });
            assert_eq!(window.focused(app), Some(view.read(app).deny.clone()));
            view.update(app, |modal, cx| {
                assert!(!modal.decide(
                    "approval-2",
                    SubagentWorkspaceWriteDecision::AllowOnce,
                    window,
                    cx,
                ));
                assert!(modal.decide(
                    "approval-1",
                    SubagentWorkspaceWriteDecision::Deny,
                    window,
                    cx,
                ));
            });
            assert_eq!(
                view.read(app).focus.active_id.as_deref(),
                Some("approval-2")
            );
            assert_eq!(window.focused(app), Some(view.read(app).deny.clone()));
            view.update(app, |modal, cx| {
                assert!(!modal.decide(
                    "approval-1",
                    SubagentWorkspaceWriteDecision::AllowOnce,
                    window,
                    cx,
                ));
                assert!(modal.decide(
                    "approval-2",
                    SubagentWorkspaceWriteDecision::AllowOnce,
                    window,
                    cx,
                ));
            });
            assert!(view.read(app).queue.is_empty());
            assert_eq!(window.focused(app), Some(origin));
            assert_eq!(
                view.read(app).decisions,
                vec![
                    ("approval-1".into(), SubagentWorkspaceWriteDecision::Deny),
                    (
                        "approval-2".into(),
                        SubagentWorkspaceWriteDecision::AllowOnce
                    ),
                ]
            );
        });
    }

    #[test]
    fn subagent_write_escape_denies_only_while_idle() {
        assert_eq!(
            subagent_write_escape_decision(false),
            Some(SubagentWorkspaceWriteDecision::Deny)
        );
        assert_eq!(subagent_write_escape_decision(true), None);
    }

    struct PiProviderFocusHarness {
        input: FocusHandle,
        cancel: FocusHandle,
        save: FocusHandle,
        sign_out: FocusHandle,
    }

    impl Render for PiProviderFocusHarness {
        fn render(&mut self, _window: &mut Window, _cx: &mut Context<Self>) -> impl IntoElement {
            div()
                .child(div().track_focus(&self.input).tab_stop(true))
                .child(div().track_focus(&self.cancel).tab_stop(true))
                .child(div().track_focus(&self.save).tab_stop(true))
                .child(div().track_focus(&self.sign_out).tab_stop(true))
        }
    }

    #[gpui::test]
    fn pi_provider_modal_focus_wraps_and_restores_explicit_owner(cx: &mut gpui::TestAppContext) {
        let (view, cx) = cx.add_window_view(|_window, cx| PiProviderFocusHarness {
            input: cx.focus_handle(),
            cancel: cx.focus_handle(),
            save: cx.focus_handle(),
            sign_out: cx.focus_handle(),
        });
        cx.update(|window, app| {
            let harness = view.read(app);
            let handles = [
                harness.input.clone(),
                harness.cancel.clone(),
                harness.save.clone(),
                harness.sign_out.clone(),
            ];
            handles[0].focus(window);
            let backwards = trapped_focus_index(true, Some(0), handles.len());
            handles[backwards].focus(window);
            assert_eq!(window.focused(app), Some(harness.sign_out.clone()));

            let forwards = trapped_focus_index(false, Some(backwards), handles.len());
            handles[forwards].focus(window);
            assert_eq!(window.focused(app), Some(harness.input.clone()));

            let return_focus = harness.cancel.clone();
            return_focus.focus(window);
            assert_eq!(window.focused(app), Some(return_focus));
        });
    }

    #[test]
    fn pi_provider_modal_busy_lock_and_stale_completion_are_fail_closed() {
        use crate::services::pi_provider_setup::PiSetupLease;

        assert!(pi_provider_setup_can_close(false));
        assert!(!pi_provider_setup_can_close(true));

        let first = PiSetupLease::for_test(7);
        let replacement = PiSetupLease::for_test(8);
        assert!(pi_provider_setup_completion_is_current(
            "anthropic",
            first,
            "anthropic",
            first,
        ));
        assert!(!pi_provider_setup_completion_is_current(
            "anthropic",
            replacement,
            "anthropic",
            first,
        ));
        assert!(!pi_provider_setup_completion_is_current(
            "google",
            first,
            "anthropic",
            first,
        ));
    }

    #[test]
    fn computer_use_modal_traps_focus_and_escape_can_only_deny_once_idle() {
        assert_eq!(trapped_focus_index(false, None, 2), 0);
        assert_eq!(trapped_focus_index(false, Some(1), 2), 0);
        assert_eq!(trapped_focus_index(true, Some(0), 2), 1);
        assert_eq!(trapped_focus_index(false, Some(2), 3), 0);
        assert_eq!(trapped_focus_index(true, Some(0), 3), 2);
        assert_eq!(
            computer_use_escape_decision(false),
            Some(ComputerUseApprovalDecision::Deny)
        );
        assert_eq!(computer_use_escape_decision(true), None);
    }

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
    fn windowless_pill_show_prefers_live_appearance_and_retains_cached_state() {
        let mut cached = aiden_core::appearance::create_default_appearance_config();
        cached.mode = Mode::Dark;
        cached.reduce_motion = ReduceMotion::On;
        let mut live = cached.clone();
        live.mode = Mode::Light;
        live.reduce_motion = ReduceMotion::Off;

        assert_eq!(
            pill_appearance_for_show(None, (cached.clone(), true)),
            (cached, true)
        );
        assert_eq!(
            pill_appearance_for_show(
                Some((live.clone(), false)),
                (
                    aiden_core::appearance::create_default_appearance_config(),
                    true
                )
            ),
            (live, false)
        );
    }

    #[test]
    fn assistant_dock_keeps_the_panel_present_until_its_exit_settles() {
        assert!(assistant_dock_panel_present(true, true));
        // Minimize starts an exit: no bubble is rendered while the panel is
        // still present. Reduced motion clears `present` immediately.
        assert!(assistant_dock_panel_present(false, true));
        assert!(!assistant_dock_panel_present(false, false));
        assert!(!assistant_entity_required_for_dock(false, false));
        assert!(assistant_entity_required_for_dock(true, true));
    }

    #[test]
    fn assistant_notice_badges_only_while_minimized_and_bounds_the_preview() {
        let reply = format!("first\n{}", "word ".repeat(160));
        let (unread, preview) = assistant_notice_state(false, 9, &reply);
        assert_eq!(unread, 10);
        assert!(preview.expect("preview").ends_with('…'));

        let (unread, preview) = assistant_notice_state(true, 3, "visible reply");
        assert_eq!(unread, 3);
        assert!(preview.is_none());
    }

    #[test]
    fn assistant_preview_collapses_whitespace_for_a_single_bubble_line() {
        assert_eq!(
            assistant_preview_text("  reply\n\nwith\tspace  "),
            "reply with space"
        );
    }

    #[test]
    fn assistant_preview_removes_bidi_format_controls_markdown_and_uses_a_safe_fallback() {
        assert_eq!(
            assistant_preview_text("**`\u{200b}hello\u{200e}\u{061c}`** \u{2067}world\u{2069}"),
            "hello world"
        );
        assert_eq!(
            assistant_preview_text("\u{feff}\u{202e}\u{2060}"),
            "Aiden has an update"
        );
        let long = format!("{} tail", "word ".repeat(30));
        let preview = assistant_preview_text(&long);
        assert!(preview.chars().count() <= 81 && preview.ends_with('…'));
        assert_eq!(
            assistant_preview_text(&"😀".repeat(100)).chars().count(),
            81
        );
        assert_eq!(
            assistant_preview_text(&"界".repeat(100)).chars().count(),
            81
        );
    }

    #[test]
    fn assistant_dock_is_occluded_by_environment_and_every_root_modal() {
        assert!(!assistant_dock_occluded(false, false));
        assert!(assistant_dock_occluded(true, false));
        assert!(assistant_dock_occluded(false, true));
    }

    #[test]
    fn delayed_assistant_minimize_never_restores_focus_through_a_new_modal() {
        assert!(assistant_minimize_may_restore_focus(false));
        assert!(!assistant_minimize_may_restore_focus(true));
    }

    #[test]
    fn assistant_dock_geometry_keeps_the_required_window_insets() {
        assert_eq!(assistant_dock_width(300.), 252.);
        assert_eq!(assistant_dock_width(900.), 368.);
        assert_eq!(assistant_dock_height(700.), 544.);
        assert_eq!(assistant_dock_height(500.), 372.);
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
