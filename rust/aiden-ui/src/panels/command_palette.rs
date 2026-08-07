//! Command palette — the ⌘K overlay (port of `renderer/components/command-palette.tsx`
//! plus `renderer/lib/command-palette-recent.ts` and the command-system core contract).
//!
//! The palette is a standalone entity. The orchestrator calls [`CommandPalette::toggle`]
//! (or binds ⌘K to it), and every executed action is emitted as a
//! [`PaletteCommand`] event for the orchestrator to wire to services. Recent
//! command ordering persists to `settings.json` through the injected
//! [`RecentCommandsStore`]; persistence runs on the background executor.
//!
//! Keyboard handling lives on a custom focusable input (`query_focus`) rather
//! than a gpui-component `InputState`, because the palette needs to intercept
//! Up/Down/Escape/Backspace before the editor's own cursor-movement bindings.

use std::sync::Arc;

use aiden_core::appearance::Mode;
use aiden_core::ChatMeta;
use gpui::{
    div, prelude::FluentBuilder as _, px, AppContext as _, Context, ElementId, FocusHandle,
    FontWeight, InteractiveElement as _, IntoElement, ParentElement as _, Render, SharedString,
    StatefulInteractiveElement as _, Styled as _, Window,
};
use gpui_component::{h_flex, v_flex, ActiveTheme, Icon, IconName, Sizable as _, WindowExt as _};

/// `COMMAND_PALETTE_RECENT_LIMIT` in the renderer.
pub const PALETTE_RECENT_LIMIT: usize = 12;
/// The `settings.json` key used by the real persistence adapter
/// (renderer: `localStorage["aiden.command-palette.recent.v1"]`).
pub const PALETTE_RECENT_SETTINGS_KEY: &str = "commandPalette.recent";

/// The palette action the orchestrator turns into a real service call.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PaletteCommand {
    FocusComposer,
    OpenAssistant,
    NewChat,
    // Mode-openers that never leave the palette as commands (they enter a
    // sub-mode instead); kept so the renderer contract is exhaustive.
    #[allow(dead_code)]
    SearchChats,
    PreviousChat,
    NextChat,
    #[allow(dead_code)]
    ChangeModel,
    #[allow(dead_code)]
    ManageProviders,
    #[allow(dead_code)]
    SearchSettings,
    OpenSettings,
    ToggleSidebar,
    ToggleTerminal,
    ToggleEnvironment,
    OpenWorkspaceEditor,
    OpenSettingsSection(String),
    SelectChat(String),
    SelectModel {
        provider_id: String,
        model: String,
    },
    RefreshProviders,
    SetAppearanceMode(Mode),
    /// Cycle system → light → dark appearance.
    ToggleTheme,
    /// Route the main content area to the scheduled-tasks panel.
    OpenScheduled,
    /// Route the main content area to the usage/profile panel.
    OpenUsage,
    /// Route the main content area to the subagent roster.
    OpenSubagents,
    /// Exit Aiden.
    Quit,
}

/// Palette sub-modes, mirroring the renderer's `CommandPaletteMode`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum PaletteMode {
    #[default]
    Root,
    Chats,
    Models,
    Providers,
    Settings,
}

impl PaletteMode {
    pub fn label(self) -> &'static str {
        match self {
            PaletteMode::Root => "Commands",
            PaletteMode::Chats => "Chats",
            PaletteMode::Models => "Models",
            PaletteMode::Providers => "Providers",
            PaletteMode::Settings => "Settings",
        }
    }

    pub fn lowercase(self) -> &'static str {
        match self {
            PaletteMode::Root => "commands",
            PaletteMode::Chats => "chats",
            PaletteMode::Models => "models",
            PaletteMode::Providers => "providers",
            PaletteMode::Settings => "settings",
        }
    }
}

// ===========================================================================
// Command catalog
// ===========================================================================

/// Root-mode command identifiers shown in the palette (`showInPalette` subset
/// of `renderer/shared/keybindings.ts`). Appearance entries are settings items,
/// not commands, so they are intentionally excluded (recents only record ids
/// in this set — `is_command_id` below).
pub const PALETTE_COMMAND_IDS: &[&str] = &[
    "composer.focus",
    "assistant.open",
    "chat.new",
    "chat.search",
    "chat.previous",
    "chat.next",
    "model.change",
    "provider.manage",
    "settings.search",
    "settings.open",
    "workspace.openPreferredEditor",
    "sidebar.toggle",
    "terminal.toggle",
    "environment.toggle",
    "theme.toggle",
    "view.scheduled",
    "view.usage",
    "view.subagents",
    "app.quit",
];

/// The ids that open a sub-mode instead of executing immediately.
const MODE_OPENERS: &[&str] = &[
    "chat.search",
    "model.change",
    "provider.manage",
    "settings.search",
];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PaletteCategory {
    Aiden,
    Chat,
    Navigate,
    Tools,
    Settings,
}

/// One root-mode command definition (subset of the renderer's `COMMANDS`).
#[derive(Debug, Clone)]
pub struct PaletteCommandDefinition {
    pub id: &'static str,
    pub title: &'static str,
    pub description: &'static str,
    pub category: PaletteCategory,
    pub keywords: &'static [&'static str],
}

pub static PALETTE_COMMANDS: &[PaletteCommandDefinition] = &[
    PaletteCommandDefinition {
        id: "composer.focus",
        title: "Focus composer",
        description: "Bring Aiden forward and focus the message composer.",
        category: PaletteCategory::Aiden,
        keywords: &["write", "message", "input"],
    },
    PaletteCommandDefinition {
        id: "assistant.open",
        title: "Open Aiden",
        description: "Open the docked Aiden assistant.",
        category: PaletteCategory::Aiden,
        keywords: &["assistant", "companion", "dock"],
    },
    PaletteCommandDefinition {
        id: "chat.new",
        title: "New chat",
        description: "Start a new chat in the active workspace.",
        category: PaletteCategory::Chat,
        keywords: &["conversation", "compose"],
    },
    PaletteCommandDefinition {
        id: "chat.search",
        title: "Search chats",
        description: "Open the palette in chat search.",
        category: PaletteCategory::Chat,
        keywords: &["history", "conversation", "find"],
    },
    PaletteCommandDefinition {
        id: "chat.previous",
        title: "Previous chat",
        description: "Open the previous chat in the sidebar.",
        category: PaletteCategory::Chat,
        keywords: &["back", "older"],
    },
    PaletteCommandDefinition {
        id: "chat.next",
        title: "Next chat",
        description: "Open the next chat in the sidebar.",
        category: PaletteCategory::Chat,
        keywords: &["forward", "newer"],
    },
    PaletteCommandDefinition {
        id: "model.change",
        title: "Change model",
        description: "Choose the active provider and model.",
        category: PaletteCategory::Navigate,
        keywords: &["llm", "provider", "select"],
    },
    PaletteCommandDefinition {
        id: "provider.manage",
        title: "Manage providers",
        description: "Review providers and refresh their model catalogs.",
        category: PaletteCategory::Settings,
        keywords: &["api", "connection", "models"],
    },
    PaletteCommandDefinition {
        id: "settings.search",
        title: "Search settings",
        description: "Open quick settings search.",
        category: PaletteCategory::Settings,
        keywords: &["preferences", "configure"],
    },
    PaletteCommandDefinition {
        id: "settings.open",
        title: "Open Settings",
        description: "Open Aiden settings.",
        category: PaletteCategory::Settings,
        keywords: &["preferences", "configure"],
    },
    PaletteCommandDefinition {
        id: "workspace.openPreferredEditor",
        title: "Open workspace in preferred editor",
        description: "Open the active workspace in its preferred editor.",
        category: PaletteCategory::Tools,
        keywords: &["vscode", "cursor", "finder", "folder"],
    },
    PaletteCommandDefinition {
        id: "sidebar.toggle",
        title: "Toggle sidebar",
        description: "Show or hide the leading sidebar.",
        category: PaletteCategory::Navigate,
        keywords: &["collapse", "navigation"],
    },
    PaletteCommandDefinition {
        id: "terminal.toggle",
        title: "Toggle terminal",
        description: "Show or hide the workspace terminal.",
        category: PaletteCategory::Tools,
        keywords: &["shell", "console"],
    },
    PaletteCommandDefinition {
        id: "environment.toggle",
        title: "Toggle environment panel",
        description: "Show or hide files and Git tools.",
        category: PaletteCategory::Tools,
        keywords: &["files", "git", "changes"],
    },
    PaletteCommandDefinition {
        id: "theme.toggle",
        title: "Toggle appearance",
        description: "Cycle between system, light, and dark appearance.",
        category: PaletteCategory::Settings,
        keywords: &["theme", "dark", "light", "mode"],
    },
    PaletteCommandDefinition {
        id: "view.scheduled",
        title: "Scheduled tasks",
        description: "Open the scheduled tasks panel.",
        category: PaletteCategory::Navigate,
        keywords: &["schedule", "cron", "automation"],
    },
    PaletteCommandDefinition {
        id: "view.usage",
        title: "Usage & profile",
        description: "Open the usage and profile panel.",
        category: PaletteCategory::Navigate,
        keywords: &["tokens", "cost", "activity"],
    },
    PaletteCommandDefinition {
        id: "view.subagents",
        title: "Subagents",
        description: "Open the subagent roster for this chat.",
        category: PaletteCategory::Navigate,
        keywords: &["runs", "scout", "planner"],
    },
    PaletteCommandDefinition {
        id: "app.quit",
        title: "Quit Aiden",
        description: "Exit Aiden.",
        category: PaletteCategory::Aiden,
        keywords: &["exit", "close", "shutdown"],
    },
];

/// Strictly gate stored ids: only known command ids, no user text.
pub fn is_command_id(value: &str) -> bool {
    PALETTE_COMMAND_IDS.contains(&value)
}

// ===========================================================================
// Fuzzy matching
// ===========================================================================

/// Small deterministic fuzzy scorer: subsequence match with bonuses for
/// prefixes, word starts, and consecutive runs. `None` means no match;
/// higher scores rank better.
pub fn fuzzy_score(query: &str, candidate: &str) -> Option<u32> {
    let query = query.trim();
    if query.is_empty() {
        return Some(0);
    }
    let needle: Vec<char> = query.to_lowercase().chars().collect();
    let haystack: Vec<char> = candidate.to_lowercase().chars().collect();
    if needle.len() > haystack.len() {
        return None;
    }

    let mut score = 0u32;
    let mut hay_ix = 0usize;
    let mut prev_match: Option<usize> = None;
    for needle_char in needle {
        let relative = if needle_char == ' ' {
            // A space in the query matches any run of whitespace.
            haystack[hay_ix..].iter().position(|ch| ch.is_whitespace())
        } else {
            haystack[hay_ix..].iter().position(|ch| ch == &needle_char)
        }?;
        let matched = hay_ix + relative;

        let starts_word = matched == 0
            || (matched > 0
                && (haystack[matched - 1].is_whitespace()
                    || (!haystack[matched - 1].is_alphanumeric() && haystack[matched - 1] != '_')));
        let is_capital = haystack[matched].is_uppercase();

        score += if starts_word {
            8
        } else if is_capital {
            4
        } else {
            1
        };
        if matched > 0 && prev_match == Some(matched - 1) {
            score += 12; // consecutive run
        }
        if let Some(prev) = prev_match {
            score = score.saturating_sub((matched - prev - 1) as u32);
        }

        prev_match = Some(matched);
        hay_ix = matched + 1;
    }
    Some(score)
}

/// Rank a filtered list, best first. Entries that do not match are dropped.
pub fn fuzzy_rank<T>(query: &str, candidates: &[T], text: impl Fn(&T) -> String) -> Vec<(T, u32)>
where
    T: Clone,
{
    let mut scored: Vec<(T, u32)> = Vec::new();
    for candidate in candidates {
        if let Some(score) = fuzzy_score(query, &text(candidate)) {
            scored.push((candidate.clone(), score));
        }
    }
    scored.sort_by(|left, right| {
        right
            .1
            .cmp(&left.1)
            .then_with(|| text(&left.0).cmp(&text(&right.0)))
    });
    scored
}

// ===========================================================================
// Recent-command history (port of renderer/lib/command-palette-recent.ts)
// ===========================================================================

/// Deduplicate, validate, and cap a raw list of recent command ids.
pub fn normalize_recent_commands(value: &[String]) -> Vec<String> {
    let mut seen = Vec::<&str>::new();
    let mut result = Vec::new();
    for item in value {
        if !is_command_id(item) || seen.contains(&item.as_str()) {
            continue;
        }
        seen.push(item.as_str());
        result.push(item.clone());
        if result.len() == PALETTE_RECENT_LIMIT {
            break;
        }
    }
    result
}

/// Promote a command to the front of the recency list.
pub fn record_recent_command(current: &[String], command_id: &str) -> Vec<String> {
    if !is_command_id(command_id) {
        return current.to_vec();
    }
    let promoted = [command_id.to_string()]
        .into_iter()
        .chain(
            current
                .iter()
                .filter(|item| item.as_str() != command_id)
                .cloned(),
        )
        .collect::<Vec<_>>();
    normalize_recent_commands(&promoted)
}

/// Order root commands by recency (most recent first, unknown last), matching
/// the renderer's `rootCommands` memo.
pub fn order_commands_by_recent(
    definitions: &'static [PaletteCommandDefinition],
    recent: &[String],
) -> Vec<&'static PaletteCommandDefinition> {
    let mut order = std::collections::HashMap::new();
    for (index, id) in recent.iter().enumerate() {
        order.insert(id.as_str(), index);
    }
    let mut ordered: Vec<&'static PaletteCommandDefinition> = definitions.iter().collect();
    ordered.sort_by_key(|definition| order.get(definition.id).copied().unwrap_or(usize::MAX));
    ordered
}

// ===========================================================================
// Service dependencies (Arc-injected; orchestrator wires real impls later)
// ===========================================================================

/// Read/write seam for the recency history. The real implementation persists
/// to `settings.json` under [`PALETTE_RECENT_SETTINGS_KEY`].
pub trait RecentCommandsStore: Send + Sync {
    fn load(&self) -> Vec<String>;
    fn save(&self, commands: &[String]);
}

/// One configured provider surfaced to the palette.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PaletteProvider {
    pub id: String,
    pub label: String,
    pub models: Vec<String>,
    pub needs_key: bool,
    pub has_key: bool,
}

/// Everything the palette renders that comes from the app shell. The
/// orchestrator implements this over the chat service + provider catalog.
pub trait PaletteDataSource: Send + Sync {
    fn chats(&self) -> Vec<ChatMeta>;
    fn providers(&self) -> Vec<PaletteProvider>;
    fn selected(&self) -> Option<(String, String)>;
    fn appearance_mode(&self) -> Option<Mode>;
}

/// In-memory recency store (also used by tests and the standalone demo).
#[allow(dead_code)] // standalone/demo scaffolding; the app uses `SettingsRecentStore`
#[derive(Debug, Default)]
pub struct MemoryRecentStore {
    commands: std::sync::Mutex<Vec<String>>,
}

impl MemoryRecentStore {
    #[allow(dead_code)] // standalone/demo scaffolding
    pub fn new(commands: Vec<String>) -> Self {
        Self {
            commands: std::sync::Mutex::new(commands),
        }
    }
}

impl RecentCommandsStore for MemoryRecentStore {
    fn load(&self) -> Vec<String> {
        let guard = self.commands.lock();
        guard.map(|commands| commands.clone()).unwrap_or_default()
    }

    fn save(&self, commands: &[String]) {
        if let Ok(mut guard) = self.commands.lock() {
            *guard = commands.to_vec();
        }
    }
}

/// Recency persistence on top of the aiden-data config store. Callers should
/// run [`RecentCommandsStore::save`] on the background executor (the palette
/// does this for every executed command).
pub struct SettingsRecentStore {
    config: Arc<aiden_data::config_store::ConfigStore>,
}

impl SettingsRecentStore {
    pub fn new(config: Arc<aiden_data::config_store::ConfigStore>) -> Self {
        Self { config }
    }
}

impl RecentCommandsStore for SettingsRecentStore {
    fn load(&self) -> Vec<String> {
        let settings = self.config.get_settings().unwrap_or_default();
        let parsed = settings
            .get(PALETTE_RECENT_SETTINGS_KEY)
            .and_then(serde_json::Value::as_array)
            .map(|items| {
                items
                    .iter()
                    .filter_map(serde_json::Value::as_str)
                    .map(str::to_string)
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        normalize_recent_commands(&parsed)
    }

    fn save(&self, commands: &[String]) {
        let mut patch = serde_json::Map::new();
        patch.insert(
            PALETTE_RECENT_SETTINGS_KEY.to_string(),
            serde_json::Value::Array(
                commands
                    .iter()
                    .map(|id| serde_json::Value::String(id.clone()))
                    .collect(),
            ),
        );
        let _ = self.config.set_settings(&patch, &|| true);
    }
}

/// Demo in-memory data source so the panel can be exercised standalone and in
/// tests before the orchestrator wires the real chat service.
#[allow(dead_code)] // standalone/demo scaffolding; the app uses `AppPaletteSource`
#[derive(Debug, Default, Clone)]
pub struct DemoPaletteSource {
    pub chats: Vec<ChatMeta>,
    pub providers: Vec<PaletteProvider>,
    pub selection: Option<(String, String)>,
    pub appearance: Option<Mode>,
}

impl PaletteDataSource for DemoPaletteSource {
    fn chats(&self) -> Vec<ChatMeta> {
        self.chats.clone()
    }

    fn providers(&self) -> Vec<PaletteProvider> {
        self.providers.clone()
    }

    fn selected(&self) -> Option<(String, String)> {
        self.selection.clone()
    }

    fn appearance_mode(&self) -> Option<Mode> {
        self.appearance
    }
}

impl DemoPaletteSource {
    #[allow(dead_code)] // standalone/demo scaffolding
    pub fn sample() -> Self {
        Self {
            chats: vec![
                ChatMeta {
                    id: "chat-1".into(),
                    title: "GPUI port notes".into(),
                    workspace_id: None,
                    provider_id: None,
                    model: None,
                    created_at: 1_700_000_000_000,
                    updated_at: 1_700_000_100_000,
                },
                ChatMeta {
                    id: "chat-2".into(),
                    title: "Terminal drawer research".into(),
                    workspace_id: None,
                    provider_id: None,
                    model: None,
                    created_at: 1_700_000_200_000,
                    updated_at: 1_700_000_300_000,
                },
            ],
            providers: vec![
                PaletteProvider {
                    id: "anthropic".into(),
                    label: "Anthropic".into(),
                    models: vec!["claude-sonnet-4-5".into(), "claude-opus-4-1".into()],
                    needs_key: true,
                    has_key: true,
                },
                PaletteProvider {
                    id: "openai".into(),
                    label: "OpenAI".into(),
                    models: vec!["gpt-4.1".into(), "gpt-4.1-mini".into()],
                    needs_key: true,
                    has_key: false,
                },
            ],
            selection: Some(("anthropic".into(), "claude-sonnet-4-5".into())),
            appearance: Some(Mode::System),
        }
    }
}

// ===========================================================================
// The palette entity
// ===========================================================================

/// One filtered row the list renders.
#[derive(Debug, Clone)]
pub enum PaletteRow {
    Command(&'static PaletteCommandDefinition),
    NewChat,
    Chat(ChatMeta),
    Model {
        provider_id: String,
        provider_label: String,
        model: String,
        label: String,
        selected: bool,
    },
    UnavailableProvider {
        id: String,
        label: String,
        model_count: usize,
    },
    RefreshProviders,
    Provider(PaletteProvider),
    Appearance(Mode),
    SettingsDestination {
        id: String,
        title: String,
        group: &'static str,
    },
}

impl PartialEq for PaletteRow {
    fn eq(&self, other: &Self) -> bool {
        match (self, other) {
            (PaletteRow::Command(left), PaletteRow::Command(right)) => left.id == right.id,
            (PaletteRow::NewChat, PaletteRow::NewChat) => true,
            (PaletteRow::Chat(left), PaletteRow::Chat(right)) => left.id == right.id,
            (
                PaletteRow::Model {
                    provider_id: left_provider,
                    model: left_model,
                    ..
                },
                PaletteRow::Model {
                    provider_id: right_provider,
                    model: right_model,
                    ..
                },
            ) => left_provider == right_provider && left_model == right_model,
            (
                PaletteRow::UnavailableProvider { id: left, .. },
                PaletteRow::UnavailableProvider { id: right, .. },
            ) => left == right,
            (PaletteRow::RefreshProviders, PaletteRow::RefreshProviders) => true,
            (PaletteRow::Provider(left), PaletteRow::Provider(right)) => left.id == right.id,
            (PaletteRow::Appearance(left), PaletteRow::Appearance(right)) => left == right,
            (
                PaletteRow::SettingsDestination { id: left, .. },
                PaletteRow::SettingsDestination { id: right, .. },
            ) => left == right,
            _ => false,
        }
    }
}

impl Eq for PaletteRow {}

pub struct CommandPalette {
    pub(crate) data: Arc<dyn PaletteDataSource>,
    pub(crate) recent: Arc<dyn RecentCommandsStore>,
    pub(crate) open: bool,
    pub(crate) mode: PaletteMode,
    pub(crate) query: String,
    pub(crate) selected: usize,
    pub(crate) busy: bool,
    pub(crate) recents: Vec<String>,
    /// Focus handle for the query input; created when the dialog opens
    /// (a `FocusHandle` can only be created with a context).
    pub(crate) query_focus: Option<FocusHandle>,
}

/// Dependencies for [`CommandPalette::new`]. The orchestrator provides the
/// real implementations; convenience constructors inject the in-memory demo
/// stores.
pub struct CommandPaletteDeps {
    pub data: Arc<dyn PaletteDataSource>,
    pub recent: Arc<dyn RecentCommandsStore>,
}

impl CommandPaletteDeps {
    pub fn new(data: Arc<dyn PaletteDataSource>, recent: Arc<dyn RecentCommandsStore>) -> Self {
        Self { data, recent }
    }

    /// Demo wiring so the palette is exercisable standalone.
    #[allow(dead_code)] // standalone/demo scaffolding
    pub fn demo() -> Self {
        Self::new(
            Arc::new(DemoPaletteSource::sample()),
            Arc::new(MemoryRecentStore::new(vec!["chat.new".into()])),
        )
    }
}

impl CommandPalette {
    pub fn new(_cx: &mut Context<Self>, deps: CommandPaletteDeps) -> Self {
        Self::from_deps(deps)
    }

    fn from_deps(deps: CommandPaletteDeps) -> Self {
        let recents = deps.recent.load();
        Self {
            recent: deps.recent,
            data: deps.data,
            open: false,
            mode: PaletteMode::Root,
            query: String::new(),
            selected: 0,
            busy: false,
            recents,
            query_focus: None,
        }
    }

    /// Load the recency history on the background executor (I/O rule).
    #[allow(dead_code)] // reload hook; the app refreshes recents at construction
    pub fn refresh_recent(&mut self, cx: &mut Context<Self>) {
        let recent = self.recent.clone();
        cx.spawn(async move |this, cx| {
            let commands = cx.background_spawn(async move { recent.load() }).await;
            this.update(cx, |this, cx| {
                this.recents = commands;
                cx.notify();
            })
            .ok();
        })
        .detach();
    }

    /// Open (or re-open) the palette in the root mode.
    pub fn open(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.open {
            return;
        }
        self.open = true;
        self.mode = PaletteMode::Root;
        self.query.clear();
        self.selected = 0;
        self.open_dialog(window, cx);
    }

    /// Mark the palette closed (no window access); the caller closes the
    /// dialog if it has one.
    pub fn close_state(&mut self, cx: &mut Context<Self>) {
        self.open = false;
        cx.notify();
    }

    /// Close the palette and the dialog overlay.
    pub fn close(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.open = false;
        window.close_dialog(cx);
        cx.notify();
    }

    /// Toggle the palette open/closed (⌘K).
    pub fn toggle(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.open {
            self.close(window, cx);
        } else {
            self.open(window, cx);
        }
    }

    fn open_dialog(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let entity = cx.entity();
        let focus_handle = cx.focus_handle();
        self.query_focus = Some(focus_handle.clone());
        window.open_dialog(cx, move |dialog, window, cx| {
            dialog
                .title("Command palette")
                .close_button(false)
                .keyboard(false)
                .overlay_closable(true)
                .on_close({
                    let entity = entity.clone();
                    move |_, _window, cx| {
                        entity.update(cx, |palette, cx| {
                            palette.open = false;
                            cx.notify();
                        });
                    }
                })
                .on_cancel({
                    let entity = entity.clone();
                    move |_, _window, cx| entity.read(cx).mode == PaletteMode::Root
                })
                .w(px(640.))
                .child(palette_content(&entity, window, cx))
        });
        // Focus the query field once the dialog content has rendered.
        cx.defer_in(window, move |_this, window, _cx| {
            focus_handle.focus(window);
        });
    }

    /// Enter a sub-mode (renderer: `enterMode`).
    pub fn enter_mode(&mut self, mode: PaletteMode, cx: &mut Context<Self>) {
        self.mode = mode;
        self.query.clear();
        self.selected = 0;
        cx.notify();
    }

    /// Persist a command execution to the recency history (background write).
    fn record_recent(&mut self, id: &str, cx: &mut Context<Self>) {
        self.recents = record_recent_command(&self.recents, id);
        let recent = self.recent.clone();
        let commands = self.recents.clone();
        cx.background_spawn(async move { recent.save(&commands) })
            .detach();
    }

    /// Run a root command: mode openers enter a mode, the rest execute.
    pub fn run_command(&mut self, id: &'static str, cx: &mut Context<Self>) {
        self.record_recent(id, cx);
        match id {
            "chat.search" => self.enter_mode(PaletteMode::Chats, cx),
            "model.change" => self.enter_mode(PaletteMode::Models, cx),
            "provider.manage" => self.enter_mode(PaletteMode::Providers, cx),
            "settings.search" => self.enter_mode(PaletteMode::Settings, cx),
            _ => {
                self.emit_for(id, cx);
                self.close_state(cx);
            }
        }
    }

    fn emit_for(&mut self, id: &str, cx: &mut Context<Self>) {
        let command = match id {
            "composer.focus" => PaletteCommand::FocusComposer,
            "assistant.open" => PaletteCommand::OpenAssistant,
            "chat.new" => PaletteCommand::NewChat,
            "chat.previous" => PaletteCommand::PreviousChat,
            "chat.next" => PaletteCommand::NextChat,
            "settings.open" => PaletteCommand::OpenSettings,
            "workspace.openPreferredEditor" => PaletteCommand::OpenWorkspaceEditor,
            "sidebar.toggle" => PaletteCommand::ToggleSidebar,
            "terminal.toggle" => PaletteCommand::ToggleTerminal,
            "environment.toggle" => PaletteCommand::ToggleEnvironment,
            "theme.toggle" => PaletteCommand::ToggleTheme,
            "view.scheduled" => PaletteCommand::OpenScheduled,
            "view.usage" => PaletteCommand::OpenUsage,
            "view.subagents" => PaletteCommand::OpenSubagents,
            "app.quit" => PaletteCommand::Quit,
            _ => return,
        };
        cx.emit(command);
    }

    /// Execute the currently selected row (window-less; the caller closes
    /// the dialog when the palette reports itself closed).
    pub fn run_selected(&mut self, cx: &mut Context<Self>) {
        let rows = self.rows();
        let Some(row) = rows.get(self.selected).cloned() else {
            return;
        };
        match row {
            PaletteRow::Command(definition) => self.run_command(definition.id, cx),
            PaletteRow::NewChat => {
                self.record_recent("chat.new", cx);
                cx.emit(PaletteCommand::NewChat);
                self.close_state(cx);
            }
            PaletteRow::Chat(chat) => {
                self.record_recent("chat.search", cx);
                cx.emit(PaletteCommand::SelectChat(chat.id));
                self.close_state(cx);
            }
            PaletteRow::Model {
                provider_id, model, ..
            } => {
                self.record_recent("model.change", cx);
                cx.emit(PaletteCommand::SelectModel { provider_id, model });
                self.close_state(cx);
            }
            PaletteRow::UnavailableProvider { .. } => {
                self.record_recent("model.change", cx);
                cx.emit(PaletteCommand::OpenSettingsSection("providers".into()));
                self.close_state(cx);
            }
            PaletteRow::RefreshProviders => {
                cx.emit(PaletteCommand::RefreshProviders);
                self.busy = true;
                cx.notify();
            }
            PaletteRow::Provider(_) => {
                cx.emit(PaletteCommand::OpenSettingsSection("providers".into()));
                self.close_state(cx);
            }
            PaletteRow::Appearance(mode) => {
                cx.emit(PaletteCommand::SetAppearanceMode(mode));
                self.close_state(cx);
            }
            PaletteRow::SettingsDestination { id, .. } => {
                cx.emit(PaletteCommand::OpenSettingsSection(id));
                self.close_state(cx);
            }
        }
    }

    /// The rows for the current mode + query (fuzzy-filtered).
    pub fn rows(&self) -> Vec<PaletteRow> {
        match self.mode {
            PaletteMode::Root => {
                let ordered = order_commands_by_recent(PALETTE_COMMANDS, &self.recents);
                fuzzy_rank(&self.query, &ordered, |definition| {
                    format!(
                        "{} {} {}",
                        definition.title,
                        definition.description,
                        definition.keywords.join(" ")
                    )
                })
                .into_iter()
                .map(|(definition, _)| PaletteRow::Command(definition))
                .collect()
            }
            PaletteMode::Chats => {
                let mut rows = Vec::new();
                if fuzzy_score(&self.query, "New chat conversation").is_some() {
                    rows.push(PaletteRow::NewChat);
                }
                let mut chats: Vec<ChatMeta> = self
                    .data
                    .chats()
                    .into_iter()
                    .filter(|chat| {
                        fuzzy_score(&self.query, &format!("{} {}", chat.title, chat.updated_at))
                            .is_some()
                    })
                    .collect();
                chats.sort_by_key(|chat| std::cmp::Reverse(chat.updated_at));
                rows.extend(chats.into_iter().map(PaletteRow::Chat));
                rows
            }
            PaletteMode::Models => {
                let mut rows = Vec::new();
                let providers = self.data.providers();
                let selection = self.data.selected();
                let mut ranked =
                    fuzzy_rank(&self.query, &providers, |provider| provider.label.clone());
                let mut flattened = Vec::new();
                for (provider, _) in ranked.drain(..) {
                    for model in &provider.models {
                        let selected =
                            selection
                                .as_ref()
                                .is_some_and(|(provider_id, selected_model)| {
                                    provider_id == &provider.id && selected_model == model
                                });
                        let label = format!("{} · {}", provider.label, model);
                        if fuzzy_score(&self.query, &label).is_some() {
                            flattened.push(PaletteRow::Model {
                                provider_id: provider.id.clone(),
                                provider_label: provider.label.clone(),
                                model: model.clone(),
                                label,
                                selected,
                            });
                        }
                    }
                    if provider.models.is_empty()
                        && fuzzy_score(&self.query, &provider.label).is_some()
                    {
                        flattened.push(PaletteRow::UnavailableProvider {
                            id: provider.id.clone(),
                            label: provider.label.clone(),
                            model_count: 0,
                        });
                    }
                }
                rows.extend(flattened);
                rows
            }
            PaletteMode::Providers => {
                let mut rows = Vec::new();
                if fuzzy_score(&self.query, "Refresh provider model catalogs update").is_some() {
                    rows.push(PaletteRow::RefreshProviders);
                }
                let providers = self.data.providers();
                let mut ranked = fuzzy_rank(&self.query, &providers, |provider| {
                    format!(
                        "{} {} manage connection models",
                        provider.label, provider.id
                    )
                });
                rows.extend(
                    ranked
                        .drain(..)
                        .map(|(provider, _)| PaletteRow::Provider(provider)),
                );
                rows
            }
            PaletteMode::Settings => {
                let mut rows = Vec::new();
                for (mode, title) in [
                    (Mode::System, "Follow macOS appearance"),
                    (Mode::Light, "Use light appearance"),
                    (Mode::Dark, "Use dark appearance"),
                ] {
                    if fuzzy_score(&self.query, &format!("{title} theme appearance")).is_some() {
                        rows.push(PaletteRow::Appearance(mode));
                    }
                }
                for destination in settings_destinations() {
                    if fuzzy_score(
                        &self.query,
                        &format!("{} {}", destination.title, destination.keywords.join(" ")),
                    )
                    .is_some()
                    {
                        rows.push(PaletteRow::SettingsDestination {
                            id: destination.id.to_string(),
                            title: destination.title.to_string(),
                            group: destination.group,
                        });
                    }
                }
                rows
            }
        }
    }

    /// Route one keystroke and return whether the palette is still open.
    /// Callers with a window should close the dialog when this returns
    /// `false` (the dialog content does exactly that).
    pub fn handle_key(
        &mut self,
        key: &str,
        key_char: Option<&str>,
        cx: &mut Context<Self>,
    ) -> bool {
        match key {
            "enter" | "secondary-enter" => {
                self.run_selected(cx);
            }
            "escape" if self.mode == PaletteMode::Root => {
                self.close_state(cx);
            }
            _ => {
                self.handle_key_state(key, key_char);
            }
        }
        // Character input, cursor keys, backspace, and mode changes all
        // mutate the filtered list, so every keystroke re-renders.
        cx.notify();
        self.open
    }

    /// Pure state transition for one keystroke (unit-testable without a
    /// window). Handles navigation keys and character input.
    fn handle_key_state(&mut self, key: &str, key_char: Option<&str>) {
        match key {
            "escape" => {
                if self.mode != PaletteMode::Root {
                    self.mode = PaletteMode::Root;
                    self.query.clear();
                }
            }
            "up" => {
                self.selected = self.selected.saturating_sub(1);
            }
            "down" => {
                let rows = self.rows().len();
                if rows > 0 {
                    self.selected = (self.selected + 1).min(rows - 1);
                }
            }
            "backspace" => {
                if self.query.is_empty() && self.mode != PaletteMode::Root {
                    self.mode = PaletteMode::Root;
                } else {
                    self.query.pop();
                    self.selected = 0;
                }
            }
            "left" | "right" => {
                if self.query.is_empty() && self.mode != PaletteMode::Root {
                    self.mode = PaletteMode::Root;
                }
            }
            _ => {
                if let Some(character) = key_char {
                    if !character.chars().any(char::is_control) {
                        self.query.push_str(character);
                        self.selected = 0;
                    }
                }
            }
        }
    }
}

impl gpui::EventEmitter<PaletteCommand> for CommandPalette {}

impl Render for CommandPalette {
    fn render(&mut self, _window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = cx.theme().clone();
        // The palette paints inside the Root dialog layer; the entity itself
        // renders a quiet trigger affordance so the orchestrator can drop it
        // into any surface.
        v_flex()
            .id("command-palette-anchor")
            .size_full()
            .bg(theme.background)
            .child(
                h_flex()
                    .id("command-palette-trigger")
                    .gap_2()
                    .items_center()
                    .px_3()
                    .py_2()
                    .child(
                        Icon::new(IconName::Search)
                            .small()
                            .text_color(theme.muted_foreground),
                    )
                    .child(
                        div()
                            .text_sm()
                            .text_color(theme.muted_foreground)
                            .child("Command palette — press ⌘K"),
                    ),
            )
    }
}

// ===========================================================================
// Dialog content
// ===========================================================================

struct SettingsDestination {
    id: &'static str,
    title: &'static str,
    group: &'static str,
    keywords: &'static [&'static str],
}

fn settings_destinations() -> Vec<SettingsDestination> {
    vec![
        SettingsDestination {
            id: "appearance",
            title: "Appearance",
            group: "Appearance",
            keywords: &["theme", "mode"],
        },
        SettingsDestination {
            id: "providers",
            title: "Providers",
            group: "Models",
            keywords: &["api", "key", "catalog"],
        },
        SettingsDestination {
            id: "scheduled-tasks",
            title: "Scheduled tasks",
            group: "Automation",
            keywords: &["schedule", "cron", "automation"],
        },
        SettingsDestination {
            id: "usage",
            title: "Usage & profile",
            group: "Profile",
            keywords: &["tokens", "cost", "activity"],
        },
    ]
}

fn category_icon(category: PaletteCategory) -> IconName {
    match category {
        PaletteCategory::Aiden => IconName::Bot,
        PaletteCategory::Chat => IconName::BookOpen,
        PaletteCategory::Navigate => IconName::Search,
        PaletteCategory::Tools => IconName::SquareTerminal,
        PaletteCategory::Settings => IconName::Settings2,
    }
}

fn palette_content(
    entity: &gpui::Entity<CommandPalette>,
    _window: &mut Window,
    cx: &mut gpui::App,
) -> impl IntoElement {
    let theme = cx.theme().clone();
    let palette = entity.read(cx);
    let mode = palette.mode;
    let query = palette.query.clone();
    let rows = palette.rows();
    let selected = palette.selected.min(rows.len().saturating_sub(1));
    let appearance = palette.data.appearance_mode();
    let busy = palette.busy;
    let query_focus = palette.query_focus.clone();

    let placeholder = if mode == PaletteMode::Root {
        "Search commands, chats, models, providers, or settings…"
    } else {
        "Search {mode.lowercase()}…"
    };

    let input_entity = entity.clone();
    let list_children: Vec<gpui::AnyElement> = if rows.is_empty() {
        vec![div()
            .w_full()
            .py_3()
            .items_center()
            .justify_center()
            .gap_1()
            .child(
                Icon::new(IconName::Search)
                    .small()
                    .text_color(theme.muted_foreground),
            )
            .child(
                div()
                    .text_xs()
                    .text_color(theme.muted_foreground)
                    .child(format!("No {} match “{}”.", mode.lowercase(), query.trim())),
            )
            .into_any_element()]
    } else {
        rows.iter()
            .enumerate()
            .map(|(index, row)| {
                palette_row(&input_entity, row, index == selected, appearance, busy, cx)
                    .into_any_element()
            })
            .collect()
    };

    v_flex()
        .id("command-palette")
        .w_full()
        .bg(theme.popover)
        .rounded_lg()
        .border_1()
        .border_color(theme.border)
        .shadow_lg()
        .overflow_hidden()
        .child(
            // Header row: mode label + workspace + Esc hint.
            h_flex()
                .id("palette-header")
                .w_full()
                .h(px(40.))
                .px_3()
                .gap_2()
                .items_center()
                .border_b_1()
                .border_color(theme.border)
                .child(
                    div()
                        .size(px(22.))
                        .rounded_md()
                        .bg(theme.input)
                        .text_color(theme.secondary)
                        .items_center()
                        .justify_center()
                        .child(Icon::new(IconName::Search).xsmall()),
                )
                .child(
                    div()
                        .text_sm()
                        .font_weight(FontWeight::SEMIBOLD)
                        .text_color(theme.secondary)
                        .child(mode.label()),
                )
                .child(
                    div()
                        .text_xs()
                        .text_color(theme.muted_foreground)
                        .child("/"),
                )
                .child(
                    div()
                        .flex_1()
                        .truncate()
                        .text_xs()
                        .text_color(theme.muted_foreground)
                        .child("Aiden"),
                )
                .child(
                    div()
                        .rounded_md()
                        .px_1p5()
                        .py_0p5()
                        .bg(theme.input)
                        .text_xs()
                        .text_color(theme.muted_foreground)
                        .child("Esc"),
                ),
        )
        .child(
            // Query input (custom, so the palette owns Up/Down/Escape).
            div()
                .id("palette-input")
                .w_full()
                .h(px(44.))
                .px_3()
                .items_center()
                .focusable()
                .when_some(query_focus, |el, handle| el.track_focus(&handle))
                .child(
                    div()
                        .text_sm()
                        .text_color(if query.is_empty() {
                            theme.muted_foreground
                        } else {
                            theme.foreground
                        })
                        .child(if query.is_empty() {
                            placeholder.to_string()
                        } else {
                            query.clone()
                        }),
                )
                .on_key_down(move |event, window, cx| {
                    let still_open = input_entity.update(cx, |this, cx| {
                        this.handle_key(
                            &event.keystroke.key,
                            event.keystroke.key_char.as_deref(),
                            cx,
                        )
                    });
                    if !still_open {
                        window.close_dialog(cx);
                    }
                }),
        )
        .child(
            // Result list.
            div()
                .id("palette-list")
                .w_full()
                .h(px(320.))
                .overflow_y_scroll()
                .px_2()
                .py_2()
                .children(list_children),
        )
        .child(
            // Footer hints.
            h_flex()
                .id("palette-footer")
                .w_full()
                .h(px(36.))
                .px_3()
                .gap_3()
                .items_center()
                .border_t_1()
                .border_color(theme.border)
                .text_xs()
                .text_color(theme.muted_foreground)
                .child(div().child("↑↓ Navigate"))
                .child(div().child("↩ Run"))
                .child(div().flex_1())
                .child(
                    h_flex()
                        .gap_1()
                        .items_center()
                        .child(Icon::new(IconName::SquareTerminal).xsmall())
                        .child(div().child("Local app actions")),
                ),
        )
}

#[allow(clippy::too_many_arguments)]
fn palette_row(
    entity: &gpui::Entity<CommandPalette>,
    row: &PaletteRow,
    selected: bool,
    appearance: Option<Mode>,
    busy: bool,
    cx: &mut gpui::App,
) -> impl IntoElement {
    let theme = cx.theme().clone();
    let (bg, fg) = if selected {
        (theme.accent, theme.accent_foreground)
    } else {
        (theme.popover, theme.foreground)
    };

    let (icon, title, detail, marker): (IconName, String, Option<String>, Option<IconName>) =
        match row {
            PaletteRow::Command(definition) => (
                category_icon(definition.category),
                definition.title.to_string(),
                None,
                if MODE_OPENERS.contains(&definition.id) {
                    Some(IconName::ChevronRight)
                } else {
                    None
                },
            ),
            PaletteRow::NewChat => (IconName::BookOpen, "New chat".into(), None, None),
            PaletteRow::Chat(chat) => (
                IconName::BookOpen,
                chat.title.clone(),
                Some(date_label(chat.updated_at)),
                None,
            ),
            PaletteRow::Model {
                provider_label,
                label,
                selected: is_current,
                ..
            } => (
                IconName::Bot,
                label.clone(),
                Some(provider_label.clone()),
                if *is_current {
                    Some(IconName::Check)
                } else {
                    None
                },
            ),
            PaletteRow::UnavailableProvider {
                label, model_count, ..
            } => (
                IconName::Settings2,
                format!("{label} models"),
                Some(if *model_count > 0 {
                    "Setup needed".into()
                } else {
                    "No models available".into()
                }),
                Some(IconName::ChevronRight),
            ),
            PaletteRow::RefreshProviders => (
                IconName::LoaderCircle,
                if busy {
                    "Refreshing providers…".into()
                } else {
                    "Refresh provider catalogs".into()
                },
                None,
                None,
            ),
            PaletteRow::Provider(provider) => (
                IconName::Settings2,
                provider.label.clone(),
                Some(if provider.has_key || !provider.needs_key {
                    "Connected".into()
                } else {
                    "Setup needed".into()
                }),
                Some(IconName::ChevronRight),
            ),
            PaletteRow::Appearance(mode) => (
                match mode {
                    Mode::System => IconName::Palette,
                    Mode::Light => IconName::Sun,
                    Mode::Dark => IconName::Moon,
                },
                match mode {
                    Mode::System => "Follow macOS appearance".into(),
                    Mode::Light => "Use light appearance".into(),
                    Mode::Dark => "Use dark appearance".into(),
                },
                None,
                if appearance == Some(*mode) {
                    Some(IconName::Check)
                } else {
                    None
                },
            ),
            PaletteRow::SettingsDestination { title, group, .. } => (
                IconName::Settings2,
                title.clone(),
                Some((*group).to_string()),
                Some(IconName::ChevronRight),
            ),
        };

    let row_entity = entity.clone();
    let row = row.clone();
    let is_current = matches!(&row, PaletteRow::Appearance(mode) if appearance == Some(*mode))
        || matches!(&row, PaletteRow::Model { selected: true, .. });

    h_flex()
        .id(ElementId::Name(SharedString::from(format!(
            "palette-row-{title}"
        ))))
        .w_full()
        .min_h(px(44.))
        .px_3()
        .gap_2()
        .items_center()
        .rounded_md()
        .cursor_pointer()
        .bg(bg)
        .text_color(fg)
        .on_click(move |_event, window, cx| {
            let still_open = row_entity.update(cx, |this, cx| {
                if let Some(position) = this.rows().iter().position(|candidate| candidate == &row) {
                    this.selected = position;
                }
                this.run_selected(cx);
                this.open
            });
            if !still_open {
                window.close_dialog(cx);
            }
        })
        .child(Icon::new(icon).xsmall().text_color(if selected {
            theme.accent_foreground
        } else {
            theme.muted_foreground
        }))
        .child(
            div()
                .flex_1()
                .min_w(px(0.))
                .text_sm()
                .truncate()
                .child(title),
        )
        .when_some(detail, |el, detail| {
            el.child(
                div()
                    .flex_shrink_0()
                    .text_xs()
                    .opacity(0.7)
                    .truncate()
                    .child(detail),
            )
        })
        .when(is_current, |el| {
            el.child(Icon::new(IconName::Check).xsmall().text_color(theme.accent))
        })
        .when_some(marker, |el, marker| {
            el.child(
                Icon::new(marker)
                    .xsmall()
                    .text_color(theme.muted_foreground),
            )
        })
}

fn date_label(timestamp: u64) -> String {
    chrono::DateTime::from_timestamp_millis(timestamp as i64)
        .map(|date| date.format("%b %d").to_string())
        .unwrap_or_else(|| "Earlier".to_string())
}

// ===========================================================================
// Tests
// ===========================================================================

#[cfg(test)]
mod tests {
    use super::*;

    impl CommandPalette {
        fn new_demo() -> Self {
            CommandPalette::from_deps(CommandPaletteDeps::demo())
        }
    }

    #[test]
    fn recent_history_keeps_only_unique_command_ids_and_no_user_text() {
        let normalized = normalize_recent_commands(&[
            "chat.new".to_string(),
            "not-a-command".to_string(),
            "settings.open".to_string(),
            "chat.new".to_string(),
            "private workspace name".to_string(),
        ]);
        assert_eq!(normalized, vec!["chat.new", "settings.open"]);
    }

    #[test]
    fn recording_promotes_a_command_and_caps_local_history() {
        let mut recent = normalize_recent_commands(&[
            "chat.new".to_string(),
            "settings.open".to_string(),
            "terminal.toggle".to_string(),
        ]);
        recent = record_recent_command(&recent, "settings.open");
        assert_eq!(recent, vec!["settings.open", "chat.new", "terminal.toggle"]);

        for index in 1..=9 {
            recent = record_recent_command(&recent, &format!("chat.jump.{index}"));
        }
        assert!(recent.len() <= PALETTE_RECENT_LIMIT);
    }

    #[test]
    fn unknown_command_ids_are_never_recorded() {
        let recent = record_recent_command(&[], "user-typed-value");
        assert!(recent.is_empty());
        let recent = record_recent_command(&[], "chat.new");
        assert_eq!(recent, vec!["chat.new"]);
    }

    #[test]
    fn order_commands_by_recent_places_used_commands_first() {
        let recent = vec!["terminal.toggle".to_string(), "chat.new".to_string()];
        let ordered = order_commands_by_recent(PALETTE_COMMANDS, &recent);
        assert_eq!(ordered[0].id, "terminal.toggle");
        assert_eq!(ordered[1].id, "chat.new");
        // Unknown commands stay last, in catalog order.
        let last = ordered.last().unwrap();
        assert!(!recent.contains(&last.id.to_string()));
    }

    #[test]
    fn fuzzy_score_requires_subsequence() {
        assert!(fuzzy_score("new chat", "New chat").is_some());
        assert!(fuzzy_score("new chat", "New chat").unwrap() > 0);
        assert!(fuzzy_score("nwct", "New chat").is_some());
        assert_eq!(fuzzy_score("xyz", "New chat"), None);
        assert_eq!(fuzzy_score("", "anything"), Some(0));
    }

    #[test]
    fn fuzzy_score_prefers_exact_and_consecutive_matches() {
        let exact = fuzzy_score("chat", "chat").unwrap();
        let scattered = fuzzy_score("chat", "c-h-a-t").unwrap();
        assert!(exact > scattered);
        let consecutive = fuzzy_score("to", "to").unwrap();
        let split = fuzzy_score("to", "t o").unwrap();
        assert!(consecutive > split);
    }

    #[test]
    fn fuzzy_rank_sorts_best_first_and_drops_non_matches() {
        let candidates = vec![
            "Toggle terminal".to_string(),
            "Total options".to_string(),
            "Change model".to_string(),
        ];
        let ranked = fuzzy_rank("to", &candidates, |text| text.clone());
        let ranked_text: Vec<&str> = ranked.iter().map(|(text, _)| text.as_str()).collect();
        assert_eq!(ranked_text[0], "Toggle terminal");
        assert!(ranked_text.contains(&"Total options"));
        assert!(!ranked_text.contains(&"Change model"));
    }

    #[test]
    fn rows_root_mode_returns_all_commands_with_empty_query() {
        let palette = CommandPalette::new_demo();
        let rows = palette.rows();
        assert_eq!(rows.len(), PALETTE_COMMANDS.len());
        assert!(matches!(rows[0], PaletteRow::Command(_)));
    }

    #[test]
    fn handle_key_moves_selection_and_filters() {
        let mut palette = CommandPalette::new_demo();
        palette.handle_key_state("down", None);
        assert_eq!(palette.selected, 1);
        palette.handle_key_state("up", None);
        assert_eq!(palette.selected, 0);

        palette.handle_key_state("t", Some("t"));
        palette.handle_key_state("o", Some("o"));
        let rows = palette.rows();
        assert!(!rows.is_empty());
        assert!(
            matches!(rows[0], PaletteRow::Command(definition) if definition.id.contains("toggle"))
        );

        palette.handle_key_state("z", Some("z"));
        palette.handle_key_state("z", Some("z"));
        palette.handle_key_state("z", Some("z"));
        palette.handle_key_state("z", Some("z"));
        let rows = palette.rows();
        assert!(rows.is_empty());
    }
}
