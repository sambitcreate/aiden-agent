//! Port of `renderer/shared/keybindings.ts` — the canonical command and
//! keybinding contracts shared by Electron and the renderer, including
//! accelerator normalization, conflict/reservation rules, legacy migration,
//! and the V1 override document repair/mutation pipeline.
//!
//! Override documents are manipulated as `serde_json::Value` so unknown root
//! fields and unknown future command entries survive byte-for-byte, matching
//! the Electron implementation's `Object.entries`-based behavior.

use std::collections::BTreeMap;
use std::sync::OnceLock;

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

// ===========================================================================
// Command catalog
// ===========================================================================

#[derive(
    Debug,
    Clone,
    Copy,
    PartialEq,
    Eq,
    Hash,
    PartialOrd,
    Ord,
    Serialize,
    Deserialize,
    schemars::JsonSchema,
)]
pub enum CommandId {
    #[serde(rename = "composer.focus")]
    ComposerFocus,
    #[serde(rename = "dictation.toggle")]
    DictationToggle,
    #[serde(rename = "assistant.open")]
    AssistantOpen,
    #[serde(rename = "commandPalette.toggle")]
    CommandPaletteToggle,
    #[serde(rename = "chat.new")]
    ChatNew,
    #[serde(rename = "chat.search")]
    ChatSearch,
    #[serde(rename = "chat.previous")]
    ChatPrevious,
    #[serde(rename = "chat.next")]
    ChatNext,
    #[serde(rename = "chat.jump.1")]
    ChatJump1,
    #[serde(rename = "chat.jump.2")]
    ChatJump2,
    #[serde(rename = "chat.jump.3")]
    ChatJump3,
    #[serde(rename = "chat.jump.4")]
    ChatJump4,
    #[serde(rename = "chat.jump.5")]
    ChatJump5,
    #[serde(rename = "chat.jump.6")]
    ChatJump6,
    #[serde(rename = "chat.jump.7")]
    ChatJump7,
    #[serde(rename = "chat.jump.8")]
    ChatJump8,
    #[serde(rename = "chat.jump.9")]
    ChatJump9,
    #[serde(rename = "model.change")]
    ModelChange,
    #[serde(rename = "provider.manage")]
    ProviderManage,
    #[serde(rename = "settings.search")]
    SettingsSearch,
    #[serde(rename = "settings.open")]
    SettingsOpen,
    #[serde(rename = "workspace.openPreferredEditor")]
    WorkspaceOpenPreferredEditor,
    #[serde(rename = "sidebar.toggle")]
    SidebarToggle,
    #[serde(rename = "terminal.toggle")]
    TerminalToggle,
    #[serde(rename = "environment.toggle")]
    EnvironmentToggle,
    #[serde(rename = "file.save")]
    FileSave,
}

pub const COMMAND_IDS: &[CommandId] = &[
    CommandId::ComposerFocus,
    CommandId::DictationToggle,
    CommandId::AssistantOpen,
    CommandId::CommandPaletteToggle,
    CommandId::ChatNew,
    CommandId::ChatSearch,
    CommandId::ChatPrevious,
    CommandId::ChatNext,
    CommandId::ChatJump1,
    CommandId::ChatJump2,
    CommandId::ChatJump3,
    CommandId::ChatJump4,
    CommandId::ChatJump5,
    CommandId::ChatJump6,
    CommandId::ChatJump7,
    CommandId::ChatJump8,
    CommandId::ChatJump9,
    CommandId::ModelChange,
    CommandId::ProviderManage,
    CommandId::SettingsSearch,
    CommandId::SettingsOpen,
    CommandId::WorkspaceOpenPreferredEditor,
    CommandId::SidebarToggle,
    CommandId::TerminalToggle,
    CommandId::EnvironmentToggle,
    CommandId::FileSave,
];

impl CommandId {
    pub fn as_str(self) -> &'static str {
        match self {
            CommandId::ComposerFocus => "composer.focus",
            CommandId::DictationToggle => "dictation.toggle",
            CommandId::AssistantOpen => "assistant.open",
            CommandId::CommandPaletteToggle => "commandPalette.toggle",
            CommandId::ChatNew => "chat.new",
            CommandId::ChatSearch => "chat.search",
            CommandId::ChatPrevious => "chat.previous",
            CommandId::ChatNext => "chat.next",
            CommandId::ChatJump1 => "chat.jump.1",
            CommandId::ChatJump2 => "chat.jump.2",
            CommandId::ChatJump3 => "chat.jump.3",
            CommandId::ChatJump4 => "chat.jump.4",
            CommandId::ChatJump5 => "chat.jump.5",
            CommandId::ChatJump6 => "chat.jump.6",
            CommandId::ChatJump7 => "chat.jump.7",
            CommandId::ChatJump8 => "chat.jump.8",
            CommandId::ChatJump9 => "chat.jump.9",
            CommandId::ModelChange => "model.change",
            CommandId::ProviderManage => "provider.manage",
            CommandId::SettingsSearch => "settings.search",
            CommandId::SettingsOpen => "settings.open",
            CommandId::WorkspaceOpenPreferredEditor => "workspace.openPreferredEditor",
            CommandId::SidebarToggle => "sidebar.toggle",
            CommandId::TerminalToggle => "terminal.toggle",
            CommandId::EnvironmentToggle => "environment.toggle",
            CommandId::FileSave => "file.save",
        }
    }

    pub fn from_str(value: &str) -> Option<Self> {
        COMMAND_IDS.iter().copied().find(|id| id.as_str() == value)
    }
}

pub fn is_command_id(value: &str) -> bool {
    CommandId::from_str(value).is_some()
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
pub enum CommandCategory {
    #[serde(rename = "Aiden")]
    Aiden,
    #[serde(rename = "Chat")]
    Chat,
    #[serde(rename = "Navigate")]
    Navigate,
    #[serde(rename = "Tools")]
    Tools,
    #[serde(rename = "Settings")]
    Settings,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum CommandScope {
    Global,
    App,
    Chat,
    FileEditor,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct CommandDefinition {
    pub id: CommandId,
    pub title: String,
    pub description: String,
    pub category: CommandCategory,
    pub keywords: Vec<String>,
    pub default_binding: Option<String>,
    #[serde(skip_serializing_if = "is_true", default = "default_true")]
    pub default_enabled: bool,
    pub scope: CommandScope,
    pub global: bool,
    #[serde(skip_serializing_if = "is_false", default = "default_false")]
    pub allow_in_editable: bool,
    #[serde(skip_serializing_if = "is_false", default = "default_false")]
    pub allow_repeat: bool,
    #[serde(skip_serializing_if = "is_false", default = "default_false")]
    pub native_menu: bool,
    pub show_in_palette: bool,
    pub show_in_settings: bool,
}

fn is_true(value: &bool) -> bool {
    *value
}

fn is_false(value: &bool) -> bool {
    !*value
}

fn default_true() -> bool {
    true
}

fn default_false() -> bool {
    false
}

#[allow(clippy::too_many_arguments)]
fn command(
    id: CommandId,
    title: &str,
    description: &str,
    category: CommandCategory,
    keywords: &[&str],
    default_binding: Option<&str>,
    scope: CommandScope,
    global: bool,
    allow_in_editable: bool,
    native_menu: bool,
    show_in_palette: bool,
    show_in_settings: bool,
) -> CommandDefinition {
    CommandDefinition {
        id,
        title: title.to_string(),
        description: description.to_string(),
        category,
        keywords: keywords.iter().map(|s| s.to_string()).collect(),
        default_binding: default_binding.map(str::to_string),
        default_enabled: true,
        scope,
        global,
        allow_in_editable,
        allow_repeat: false,
        native_menu,
        show_in_palette,
        show_in_settings,
    }
}

fn commands() -> &'static [CommandDefinition] {
    static COMMANDS: OnceLock<Vec<CommandDefinition>> = OnceLock::new();
    COMMANDS.get_or_init(|| {
        let chat_jump = |index: u32| {
            command(
                match index {
                    1 => CommandId::ChatJump1,
                    2 => CommandId::ChatJump2,
                    3 => CommandId::ChatJump3,
                    4 => CommandId::ChatJump4,
                    5 => CommandId::ChatJump5,
                    6 => CommandId::ChatJump6,
                    7 => CommandId::ChatJump7,
                    8 => CommandId::ChatJump8,
                    _ => CommandId::ChatJump9,
                },
                &format!("Open chat {index}"),
                &format!("Open chat {index} in the sidebar."),
                CommandCategory::Chat,
                &["recent", "sidebar"],
                Some(&format!("Command+{index}")),
                CommandScope::Chat,
                false,
                false,
                false,
                false,
                true,
            )
        };
        vec![
            command(
                CommandId::ComposerFocus,
                "Focus composer",
                "Bring Aiden forward and focus the message composer.",
                CommandCategory::Aiden,
                &["write", "message", "input"],
                Some("Command+Alt+Space"),
                CommandScope::Global,
                true,
                true,
                false,
                true,
                true,
            ),
            CommandDefinition {
                default_enabled: false,
                ..command(
                    CommandId::DictationToggle,
                    "Start or stop dictation",
                    "Dictate into the focused app.",
                    CommandCategory::Aiden,
                    &["voice", "microphone", "transcribe"],
                    Some("Command+Shift+D"),
                    CommandScope::Global,
                    true,
                    true,
                    false,
                    false,
                    true,
                )
            },
            command(
                CommandId::AssistantOpen,
                "Open Aiden",
                "Open the docked Aiden assistant.",
                CommandCategory::Aiden,
                &["assistant", "companion", "dock"],
                Some("Command+Alt+A"),
                CommandScope::Global,
                true,
                true,
                false,
                true,
                true,
            ),
            command(
                CommandId::CommandPaletteToggle,
                "Open command palette",
                "Search commands, chats, models, providers, and settings.",
                CommandCategory::Navigate,
                &["search", "quick", "actions"],
                Some("Command+K"),
                CommandScope::App,
                false,
                true,
                true,
                false,
                true,
            ),
            command(
                CommandId::ChatNew,
                "New chat",
                "Start a new chat in the active workspace.",
                CommandCategory::Chat,
                &["conversation", "compose"],
                Some("Command+N"),
                CommandScope::App,
                false,
                false,
                true,
                true,
                true,
            ),
            command(
                CommandId::ChatSearch,
                "Search chats",
                "Open the palette in chat search.",
                CommandCategory::Chat,
                &["history", "conversation", "find"],
                Some("Command+Shift+F"),
                CommandScope::App,
                false,
                false,
                false,
                true,
                true,
            ),
            command(
                CommandId::ChatPrevious,
                "Previous chat",
                "Open the previous chat in the sidebar.",
                CommandCategory::Chat,
                &["back", "older"],
                Some("Command+Shift+["),
                CommandScope::Chat,
                false,
                false,
                false,
                true,
                true,
            ),
            command(
                CommandId::ChatNext,
                "Next chat",
                "Open the next chat in the sidebar.",
                CommandCategory::Chat,
                &["forward", "newer"],
                Some("Command+Shift+]"),
                CommandScope::Chat,
                false,
                false,
                false,
                true,
                true,
            ),
            chat_jump(1),
            chat_jump(2),
            chat_jump(3),
            chat_jump(4),
            chat_jump(5),
            chat_jump(6),
            chat_jump(7),
            chat_jump(8),
            chat_jump(9),
            command(
                CommandId::ModelChange,
                "Change model",
                "Choose the active provider and model.",
                CommandCategory::Navigate,
                &["llm", "provider", "select"],
                None,
                CommandScope::App,
                false,
                false,
                false,
                true,
                true,
            ),
            command(
                CommandId::ProviderManage,
                "Manage providers",
                "Review providers and refresh their model catalogs.",
                CommandCategory::Settings,
                &["api", "connection", "models"],
                None,
                CommandScope::App,
                false,
                false,
                false,
                true,
                true,
            ),
            command(
                CommandId::SettingsSearch,
                "Search settings",
                "Open quick settings search.",
                CommandCategory::Settings,
                &["preferences", "configure"],
                None,
                CommandScope::App,
                false,
                false,
                false,
                true,
                true,
            ),
            command(
                CommandId::SettingsOpen,
                "Open Settings",
                "Open Aiden settings.",
                CommandCategory::Settings,
                &["preferences", "configure"],
                Some("Command+,"),
                CommandScope::App,
                false,
                false,
                true,
                true,
                true,
            ),
            command(
                CommandId::WorkspaceOpenPreferredEditor,
                "Open workspace in preferred editor",
                "Open the active workspace in its preferred editor.",
                CommandCategory::Tools,
                &["vscode", "cursor", "finder", "folder"],
                Some("Command+O"),
                CommandScope::App,
                false,
                false,
                true,
                true,
                true,
            ),
            command(
                CommandId::SidebarToggle,
                "Toggle sidebar",
                "Show or hide the leading sidebar.",
                CommandCategory::Navigate,
                &["collapse", "navigation"],
                Some("Command+Control+S"),
                CommandScope::App,
                false,
                false,
                false,
                true,
                true,
            ),
            command(
                CommandId::TerminalToggle,
                "Toggle terminal",
                "Show or hide the workspace terminal.",
                CommandCategory::Tools,
                &["shell", "console"],
                Some("Command+J"),
                CommandScope::App,
                false,
                false,
                false,
                true,
                true,
            ),
            command(
                CommandId::EnvironmentToggle,
                "Toggle environment panel",
                "Show or hide files and Git tools.",
                CommandCategory::Tools,
                &["files", "git", "changes"],
                Some("Command+Shift+E"),
                CommandScope::App,
                false,
                false,
                false,
                true,
                true,
            ),
            command(
                CommandId::FileSave,
                "Save file",
                "Save the active file editor.",
                CommandCategory::Tools,
                &["write", "editor"],
                Some("Command+S"),
                CommandScope::FileEditor,
                false,
                true,
                false,
                false,
                true,
            ),
        ]
    })
}

fn command_definition(id: CommandId) -> &'static CommandDefinition {
    commands()
        .iter()
        .find(|definition| definition.id == id)
        .unwrap_or_else(|| panic!("unknown command id {id:?}"))
}

// ===========================================================================
// Accelerator normalization
// ===========================================================================

const MODIFIER_ALIASES: &[(&str, Modifier)] = &[
    ("command", Modifier::Command),
    ("commandorcontrol", Modifier::Command),
    ("cmd", Modifier::Command),
    ("meta", Modifier::Command),
    ("control", Modifier::Control),
    ("ctrl", Modifier::Control),
    ("alt", Modifier::Alt),
    ("option", Modifier::Alt),
    ("shift", Modifier::Shift),
];

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
enum Modifier {
    Command,
    Control,
    Alt,
    Shift,
}

impl Modifier {
    fn as_str(self) -> &'static str {
        match self {
            Modifier::Command => "Command",
            Modifier::Control => "Control",
            Modifier::Alt => "Alt",
            Modifier::Shift => "Shift",
        }
    }
}

fn normalize_base_key(raw: &str) -> Option<String> {
    let lower = raw.trim().to_ascii_lowercase();
    let aliased = match lower.as_str() {
        " " | "space" => "Space",
        "return" | "enter" => "Return",
        "escape" | "esc" => "Escape",
        "arrowup" | "up" => "Up",
        "arrowdown" | "down" => "Down",
        "arrowleft" | "left" => "Left",
        "arrowright" | "right" => "Right",
        "comma" => ",",
        "bracketleft" => "[",
        "bracketright" => "]",
        _ => "",
    };
    if !aliased.is_empty() {
        return Some(aliased.to_string());
    }
    let chars: Vec<char> = lower.chars().collect();
    if chars.len() == 1 && chars[0].is_ascii_lowercase() {
        return Some(chars[0].to_ascii_uppercase().to_string());
    }
    if chars.len() == 1 && chars[0].is_ascii_digit() {
        return Some(chars[0].to_string());
    }
    if lower.len() >= 2
        && lower.starts_with('f')
        && lower[1..]
            .parse::<u32>()
            .map(|n| (1..=24).contains(&n))
            .unwrap_or(false)
    {
        return Some(lower.to_ascii_uppercase());
    }
    if matches!(
        raw.trim(),
        "," | "." | "/" | ";" | "'" | "[" | "]" | "\\" | "-" | "=" | "`"
    ) {
        return Some(raw.trim().to_string());
    }
    None
}

/// Normalize a raw accelerator string (or reject it).
pub fn normalize_accelerator(raw: &str) -> Option<String> {
    if raw.trim().is_empty() {
        return None;
    }
    let tokens: Vec<&str> = raw
        .split('+')
        .map(|token| token.trim())
        .filter(|t| !t.is_empty())
        .collect();
    if tokens.len() < 2 {
        return None;
    }
    let mut modifiers: Vec<Modifier> = Vec::new();
    let mut key: Option<String> = None;
    for token in &tokens {
        if let Some((_, modifier)) = MODIFIER_ALIASES
            .iter()
            .find(|(alias, _)| *alias == token.to_ascii_lowercase())
        {
            if !modifiers.contains(modifier) {
                modifiers.push(*modifier);
            }
            continue;
        }
        if key.is_some() {
            return None;
        }
        key = Some(normalize_base_key(token)?);
    }
    if key.is_none() || modifiers.is_empty() {
        return None;
    }
    modifiers.sort();
    let mut parts: Vec<&str> = modifiers.iter().map(|m| m.as_str()).collect();
    parts.push(key.as_deref().unwrap());
    Some(parts.join("+"))
}

fn normalize_accelerator_value(value: &Value) -> Option<String> {
    match value.as_str() {
        Some(raw) => normalize_accelerator(raw),
        None => None,
    }
}

const SYMBOLS: &[(&str, &str)] = &[
    ("Command", "⌘"),
    ("Control", "⌃"),
    ("Alt", "⌥"),
    ("Shift", "⇧"),
    ("Space", "Space"),
    ("Return", "↩"),
    ("Escape", "Esc"),
    ("Up", "↑"),
    ("Down", "↓"),
    ("Left", "←"),
    ("Right", "→"),
];

pub fn pretty_accelerator(value: Option<&str>) -> String {
    let Some(value) = value else {
        return "Unassigned".to_string();
    };
    let normalized = normalize_accelerator(value).unwrap_or_else(|| value.to_string());
    normalized
        .split('+')
        .map(|part| {
            SYMBOLS
                .iter()
                .find(|(name, _)| *name == part)
                .map(|(_, symbol)| *symbol)
                .unwrap_or(part)
        })
        .collect::<String>()
}

pub fn aria_key_shortcut(value: Option<&str>) -> Option<String> {
    let normalized = value.and_then(normalize_accelerator)?;
    let replaced = normalized
        .replace("Command", "Meta")
        .replace("Return", "Enter")
        .replace("Up", "ArrowUp")
        .replace("Down", "ArrowDown")
        .replace("Left", "ArrowLeft")
        .replace("Right", "ArrowRight");
    Some(replaced)
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct KeyboardEventLike {
    pub key: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub code: Option<String>,
    pub meta_key: bool,
    pub ctrl_key: bool,
    pub alt_key: bool,
    pub shift_key: bool,
}

pub fn accelerator_from_keyboard_event(event: &KeyboardEventLike) -> Option<String> {
    let key = if event.code.as_deref() == Some("Space") || event.key == " " {
        Some("Space".to_string())
    } else if let Some(code) = event.code.as_deref() {
        if let Some(rest) = code.strip_prefix("Key") {
            if rest.chars().count() == 1 {
                Some(rest.to_string())
            } else {
                None
            }
        } else if let Some(digit) = code.strip_prefix("Digit") {
            if digit.chars().count() == 1 && digit.chars().next().unwrap().is_ascii_digit() {
                Some(digit.to_string())
            } else {
                None
            }
        } else {
            match code {
                "BracketLeft" => Some("[".to_string()),
                "BracketRight" => Some("]".to_string()),
                "Comma" => Some(",".to_string()),
                "Period" => Some(".".to_string()),
                "Slash" => Some("/".to_string()),
                "Semicolon" => Some(";".to_string()),
                "Quote" => Some("'".to_string()),
                "Backslash" => Some("\\".to_string()),
                "Minus" => Some("-".to_string()),
                "Equal" => Some("=".to_string()),
                "Backquote" => Some("`".to_string()),
                _ => None,
            }
        }
    } else {
        None
    };
    let key = key.or_else(|| normalize_base_key(&event.key))?;
    let mut modifiers: Vec<&'static str> = Vec::new();
    if event.meta_key {
        modifiers.push("Command");
    }
    if event.ctrl_key {
        modifiers.push("Control");
    }
    if event.alt_key {
        modifiers.push("Alt");
    }
    if event.shift_key {
        modifiers.push("Shift");
    }
    if modifiers.is_empty() {
        return None;
    }
    let mut parts: Vec<String> = modifiers.iter().map(|m| m.to_string()).collect();
    parts.push(key);
    Some(parts.join("+"))
}

pub fn matches_accelerator(event: &KeyboardEventLike, accelerator: &str) -> bool {
    accelerator_from_keyboard_event(event) == normalize_accelerator(accelerator)
}

// ===========================================================================
// Override document model
// ===========================================================================

#[derive(Debug, Clone, PartialEq, Serialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct KeybindingOverride {
    /// `None` = key absent; `Some(None)` = explicit `null`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub binding: Option<Option<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub disabled: Option<bool>,
    /// Unknown fields written by newer builds, preserved verbatim.
    #[serde(flatten)]
    pub future: BTreeMap<String, Value>,
}

/// `binding: null` must round-trip as an explicit null (distinct from an
/// absent key), which serde's built-in `Option` visitor would collapse.
impl<'de> Deserialize<'de> for KeybindingOverride {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase")]
        struct De {
            #[serde(default, deserialize_with = "deserialize_nullable_binding")]
            binding: Option<Option<String>>,
            #[serde(default)]
            disabled: Option<bool>,
            #[serde(flatten)]
            future: BTreeMap<String, Value>,
        }
        fn deserialize_nullable_binding<'de, D>(
            deserializer: D,
        ) -> Result<Option<Option<String>>, D::Error>
        where
            D: serde::Deserializer<'de>,
        {
            Ok(match Value::deserialize(deserializer)? {
                Value::Null => Some(None),
                Value::String(binding) => Some(Some(binding)),
                _ => None,
            })
        }
        let de = De::deserialize(deserializer)?;
        Ok(KeybindingOverride {
            binding: de.binding,
            disabled: de.disabled,
            future: de.future,
        })
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct KeybindingOverridesV1 {
    pub version: u8,
    /// Command id strings; unknown ids are preserved as opaque entries.
    pub commands: BTreeMap<String, KeybindingOverride>,
}

/// The pre-canonical legacy global shortcut preferences.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct LegacyGlobalKeybindings {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub shortcut_enabled: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub shortcut_accelerator: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub dictation_enabled: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub dictation_accelerator: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub assistant: Option<LegacyAssistantKeybindings>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct LegacyAssistantKeybindings {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub hotkey_enabled: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub hotkey_accelerator: Option<String>,
}

impl LegacyGlobalKeybindings {
    pub fn from_value(value: &Value) -> Option<Self> {
        serde_json::from_value(value.clone()).ok()
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum GlobalShortcutState {
    Active,
    Disabled,
    Unavailable,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct GlobalShortcutStatus {
    pub command_id: CommandId,
    pub binding: Option<String>,
    pub state: GlobalShortcutState,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct KeybindingSnapshot {
    pub overrides: KeybindingOverridesV1,
    pub effective: BTreeMap<String, Option<String>>,
    pub global: Vec<GlobalShortcutStatus>,
}

#[derive(Debug, Clone, PartialEq)]
pub enum KeybindingMutation {
    SetBinding {
        command_id: CommandId,
        binding: String,
        replace: bool,
    },
    Disable {
        command_id: CommandId,
        disabled: bool,
    },
    Reset {
        command_id: CommandId,
    },
}

impl KeybindingMutation {
    pub fn command_id(&self) -> CommandId {
        match self {
            KeybindingMutation::SetBinding { command_id, .. }
            | KeybindingMutation::Disable { command_id, .. }
            | KeybindingMutation::Reset { command_id } => *command_id,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum KeybindingErrorCode {
    Invalid,
    Reserved,
    Conflict,
    Registration,
    FutureVersion,
}

impl KeybindingErrorCode {
    pub fn as_str(self) -> &'static str {
        match self {
            KeybindingErrorCode::Invalid => "invalid",
            KeybindingErrorCode::Reserved => "reserved",
            KeybindingErrorCode::Conflict => "conflict",
            KeybindingErrorCode::Registration => "registration",
            KeybindingErrorCode::FutureVersion => "future-version",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("{message}")]
pub struct KeybindingError {
    pub code: KeybindingErrorCode,
    pub message: String,
    pub command_id: Option<CommandId>,
}

impl KeybindingError {
    fn new(
        code: KeybindingErrorCode,
        message: impl Into<String>,
        command_id: Option<CommandId>,
    ) -> Self {
        Self {
            code,
            message: message.into(),
            command_id,
        }
    }
}

// ===========================================================================
// Override document functions
// ===========================================================================

fn future_keybinding_fields(item: &Value) -> Value {
    match item.as_object() {
        Some(object) => Value::Object(
            object
                .iter()
                .filter(|(key, _)| key.as_str() != "binding" && key.as_str() != "disabled")
                .map(|(key, value)| (key.clone(), value.clone()))
                .collect(),
        ),
        None => Value::Object(Map::new()),
    }
}

fn future_keybinding_root_fields(record: &Value) -> Value {
    match record.as_object() {
        Some(object) => Value::Object(
            object
                .iter()
                .filter(|(key, _)| key.as_str() != "version" && key.as_str() != "commands")
                .map(|(key, value)| (key.clone(), value.clone()))
                .collect(),
        ),
        None => Value::Object(Map::new()),
    }
}

fn object(entries: Vec<(&str, Value)>) -> Value {
    let mut map = Map::new();
    for (key, value) in entries {
        map.insert(key.to_string(), value);
    }
    Value::Object(map)
}

/// Normalize an unknown override document into the canonical V1 shape,
/// preserving unknown root and command fields byte-for-byte.
pub fn normalize_keybinding_overrides(value: &Value) -> Value {
    if !value.is_object() {
        return object(vec![
            ("version", Value::from(1)),
            ("commands", Value::Object(Map::new())),
        ]);
    }
    let record = value.as_object().unwrap();
    let mut result = match future_keybinding_root_fields(value) {
        Value::Object(map) => map,
        _ => Map::new(),
    };
    result.insert("version".to_string(), Value::from(1));
    let mut commands = Map::new();
    let version_ok = record.get("version") == Some(&Value::from(1));
    let commands_ok = matches!(record.get("commands"), Some(Value::Object(_)));
    if version_ok && commands_ok {
        let raw_commands = record["commands"].as_object().unwrap();
        for (id, raw) in raw_commands {
            if !is_command_id(id) {
                // Preserve future commands byte-for-byte.
                commands.insert(id.clone(), raw.clone());
                continue;
            }
            let Some(item) = raw.as_object() else {
                continue;
            };
            let binding = match item.get("binding") {
                Some(Value::Null) => Some(None),
                Some(other) => normalize_accelerator_value(other).map(Some),
                None => None,
            };
            let disabled = item.get("disabled") == Some(&Value::Bool(true));
            let future_fields = future_keybinding_fields(raw);
            let future_empty = future_fields
                .as_object()
                .map(|m| m.is_empty())
                .unwrap_or(false);
            if binding.is_some()
                || item.get("binding") == Some(&Value::Null)
                || disabled
                || !future_empty
            {
                let mut entry = match future_fields {
                    Value::Object(map) => map,
                    _ => Map::new(),
                };
                if binding.is_some() || item.get("binding") == Some(&Value::Null) {
                    entry.insert(
                        "binding".to_string(),
                        binding
                            .unwrap_or(None)
                            .map(Value::String)
                            .unwrap_or(Value::Null),
                    );
                }
                if disabled {
                    entry.insert("disabled".to_string(), Value::Bool(true));
                }
                commands.insert(id.clone(), Value::Object(entry));
            }
        }
    }
    result.insert("commands".to_string(), Value::Object(commands));
    Value::Object(result)
}

pub fn has_canonical_keybindings(value: &Value) -> bool {
    let Some(record) = value.as_object() else {
        return false;
    };
    record.get("version") == Some(&Value::from(1))
        && matches!(record.get("commands"), Some(Value::Object(_)))
}

/// A document from a newer Aiden must remain owned byte-for-byte by that
/// version.
pub fn has_future_keybindings(value: &Value) -> bool {
    let Some(version) = value.as_object().and_then(|record| record.get("version")) else {
        return false;
    };
    match version.as_u64() {
        Some(version) => version > 1,
        None => false,
    }
}

pub fn should_persist_canonical_keybindings(stored: &Value, canonical: &Value) -> bool {
    if has_future_keybindings(stored) {
        return false;
    }
    if !has_canonical_keybindings(stored) {
        return true;
    }
    normalize_keybinding_overrides(stored) != *canonical
}

fn legacy_binding(
    command_id: CommandId,
    legacy: Option<&LegacyGlobalKeybindings>,
) -> Option<Value> {
    let legacy = legacy?;
    let mut entry = Map::new();
    match command_id {
        CommandId::ComposerFocus => {
            if let Some(binding) = legacy
                .shortcut_accelerator
                .as_deref()
                .and_then(normalize_accelerator)
            {
                entry.insert("binding".to_string(), Value::String(binding));
            }
            if legacy.shortcut_enabled == Some(false) {
                entry.insert("disabled".to_string(), Value::Bool(true));
            }
        }
        CommandId::DictationToggle => {
            if let Some(binding) = legacy
                .dictation_accelerator
                .as_deref()
                .and_then(normalize_accelerator)
            {
                entry.insert("binding".to_string(), Value::String(binding));
            }
            if legacy.dictation_enabled != Some(true) {
                entry.insert("disabled".to_string(), Value::Bool(true));
            }
        }
        CommandId::AssistantOpen => {
            if let Some(binding) = legacy
                .assistant
                .as_ref()
                .and_then(|assistant| assistant.hotkey_accelerator.as_deref())
                .and_then(normalize_accelerator)
            {
                entry.insert("binding".to_string(), Value::String(binding));
            }
            if legacy
                .assistant
                .as_ref()
                .and_then(|assistant| assistant.hotkey_enabled)
                == Some(false)
            {
                entry.insert("disabled".to_string(), Value::Bool(true));
            }
        }
        _ => return None,
    }
    Some(Value::Object(entry))
}

/// Catalog default for a command, honoring `defaultEnabled: false`.
fn default_binding(command_id: CommandId) -> Option<String> {
    let definition = command_definition(command_id);
    if !definition.default_enabled {
        return None;
    }
    definition.default_binding.clone()
}

fn effective_binding_from_normalized(
    command_id: CommandId,
    overrides: Option<&Value>,
    legacy: Option<&LegacyGlobalKeybindings>,
) -> Option<String> {
    let override_entry = match overrides {
        Some(document) => document
            .get("commands")
            .and_then(|commands| commands.get(command_id.as_str()))
            .cloned(),
        None => legacy_binding(command_id, legacy),
    };
    let Some(entry) = override_entry else {
        return default_binding(command_id);
    };
    if entry.get("disabled") == Some(&Value::Bool(true)) {
        return None;
    }
    if entry.get("binding").is_some() {
        return match entry.get("binding") {
            Some(Value::String(binding)) => Some(binding.clone()),
            _ => None,
        };
    }
    command_definition(command_id).default_binding.clone()
}

pub fn effective_binding(
    command_id: CommandId,
    overrides: &Value,
    legacy: Option<&LegacyGlobalKeybindings>,
) -> Option<String> {
    let normalized = if has_canonical_keybindings(overrides) {
        Some(normalize_keybinding_overrides(overrides))
    } else {
        None
    };
    effective_binding_from_normalized(command_id, normalized.as_ref(), legacy)
}

pub fn effective_bindings(
    overrides: &Value,
    legacy: Option<&LegacyGlobalKeybindings>,
) -> BTreeMap<String, Option<String>> {
    let normalized = if has_canonical_keybindings(overrides) {
        Some(normalize_keybinding_overrides(overrides))
    } else {
        None
    };
    COMMAND_IDS
        .iter()
        .map(|id| {
            (
                id.as_str().to_string(),
                effective_binding_from_normalized(*id, normalized.as_ref(), legacy),
            )
        })
        .collect()
}

const RESERVED_BINDINGS: &[&str] = &[
    "Command+A",
    "Command+C",
    "Command+Q",
    "Command+H",
    "Command+Alt+H",
    "Command+Alt+I",
    "Command+M",
    "Command+W",
    "Command+X",
    "Command+V",
    "Command+Shift+V",
    "Command+Alt+Shift+V",
    "Command+Z",
    "Command+Shift+Z",
    "Command+0",
    "Command+=",
    "Command+Shift+=",
    "Command+-",
    "Command+R",
    "Command+Shift+R",
    "Command+Control+F",
    "Command+`",
];

pub fn command_scopes_overlap(left: &CommandDefinition, right: &CommandDefinition) -> bool {
    if left.global || right.global {
        return true;
    }
    // Electron menu accelerators are resolved before the renderer sees the
    // key, so they cannot participate in editable/file-editor scoping.
    if left.native_menu || right.native_menu {
        return true;
    }
    if left.scope == right.scope {
        return true;
    }
    let app_command = if left.scope == CommandScope::App {
        Some(left)
    } else if right.scope == CommandScope::App {
        Some(right)
    } else {
        None
    };
    if let Some(app_command) = app_command {
        let other = if std::ptr::eq(app_command, left) {
            right
        } else {
            left
        };
        if other.scope == CommandScope::FileEditor {
            return app_command.allow_in_editable;
        }
        return true;
    }
    let chat_command = if left.scope == CommandScope::Chat {
        Some(left)
    } else if right.scope == CommandScope::Chat {
        Some(right)
    } else {
        None
    };
    if let Some(chat_command) = chat_command {
        let file_command = if std::ptr::eq(chat_command, left) {
            right
        } else {
            left
        };
        if file_command.scope == CommandScope::FileEditor {
            return chat_command.allow_in_editable;
        }
    }
    false
}

pub fn validate_effective_bindings(
    bindings: &BTreeMap<String, Option<String>>,
) -> Result<(), KeybindingError> {
    let mut owners: BTreeMap<String, Vec<CommandId>> = BTreeMap::new();
    for id in COMMAND_IDS {
        let Some(binding) = bindings
            .get(id.as_str())
            .and_then(|binding| binding.as_ref())
        else {
            continue;
        };
        let Some(normalized) = normalize_accelerator(binding) else {
            return Err(KeybindingError::new(
                KeybindingErrorCode::Invalid,
                format!("\u{201c}{binding}\u{201d} is not a valid shortcut."),
                Some(*id),
            ));
        };
        if RESERVED_BINDINGS.contains(&normalized.as_str()) {
            return Err(KeybindingError::new(
                KeybindingErrorCode::Reserved,
                format!(
                    "{} is reserved by Aiden or macOS.",
                    pretty_accelerator(Some(&normalized))
                ),
                Some(*id),
            ));
        }
        let conflicting = owners
            .get(&normalized)
            .and_then(|existing| {
                existing.iter().find(|existing| {
                    command_scopes_overlap(command_definition(*id), command_definition(**existing))
                })
            })
            .copied();
        if let Some(conflicting) = conflicting {
            return Err(KeybindingError::new(
                KeybindingErrorCode::Conflict,
                format!(
                    "{} is already used by {}.",
                    pretty_accelerator(Some(&normalized)),
                    command_definition(conflicting).title
                ),
                Some(*id),
            ));
        }
        owners.entry(normalized).or_default().push(*id);
    }
    Ok(())
}

fn set_command_entry(commands: &mut Map<String, Value>, id: CommandId, entry: Value) {
    commands.insert(id.as_str().to_string(), entry);
}

fn delete_command_entry(commands: &mut Map<String, Value>, id: CommandId) {
    commands.remove(id.as_str());
}

/// Materialize the three legacy global preferences into the canonical V1 map.
/// The result is idempotent and stops consulting legacy fields.
pub fn migrate_legacy_keybindings(
    current: &Value,
    legacy: Option<&LegacyGlobalKeybindings>,
) -> Result<Value, KeybindingError> {
    if has_canonical_keybindings(current) {
        return repair_keybinding_overrides(current);
    }
    let mut next = normalize_keybinding_overrides(current);
    let mut claimed: BTreeMap<String, CommandId> = BTreeMap::new();

    for definition in commands().iter().filter(|definition| definition.global) {
        let mut binding = effective_binding_from_normalized(definition.id, None, legacy);
        if let Some(current) = &binding {
            if RESERVED_BINDINGS.contains(&current.as_str()) || claimed.contains_key(current) {
                let fallback = default_binding(definition.id);
                binding = match fallback {
                    Some(fallback)
                        if !RESERVED_BINDINGS.contains(&fallback.as_str())
                            && !claimed.contains_key(&fallback) =>
                    {
                        Some(fallback)
                    }
                    _ => None,
                };
            }
        }
        let next_commands = next.get_mut("commands").unwrap().as_object_mut().unwrap();
        match &binding {
            Some(binding) => {
                set_command_entry(
                    next_commands,
                    definition.id,
                    object(vec![
                        ("binding", Value::String(binding.clone())),
                        ("disabled", Value::Bool(false)),
                    ]),
                );
                claimed.insert(binding.clone(), definition.id);
            }
            None => {
                set_command_entry(
                    next_commands,
                    definition.id,
                    object(vec![("disabled", Value::Bool(true))]),
                );
            }
        }
    }

    for definition in commands().iter().filter(|definition| !definition.global) {
        let binding = default_binding(definition.id);
        if let Some(binding) = binding {
            if claimed.contains_key(&binding) {
                let next_commands = next.get_mut("commands").unwrap().as_object_mut().unwrap();
                set_command_entry(
                    next_commands,
                    definition.id,
                    object(vec![("disabled", Value::Bool(true))]),
                );
            }
        }
    }

    validate_effective_bindings(&effective_bindings(&next, None))?;
    Ok(next)
}

/// Repair persisted V1 values whose semantics became unsafe as more command
/// consumers moved into Electron's context-free native menu.
pub fn repair_keybinding_overrides(value: &Value) -> Result<Value, KeybindingError> {
    let mut next = normalize_keybinding_overrides(value);

    let reset_or_disable = |next: &mut Value, command_id: CommandId, binding: &str| {
        let default = default_binding(command_id);
        let next_commands = next.get_mut("commands").unwrap().as_object_mut().unwrap();
        if binding != default.as_deref().unwrap_or_default() {
            let future_fields = future_keybinding_fields(
                next_commands
                    .get(command_id.as_str())
                    .unwrap_or(&Value::Null),
            );
            let future_empty = future_fields
                .as_object()
                .map(|map| map.is_empty())
                .unwrap_or(false);
            if future_empty {
                delete_command_entry(next_commands, command_id);
            } else {
                set_command_entry(next_commands, command_id, future_fields);
            }
        } else {
            let previous = next_commands
                .get(command_id.as_str())
                .cloned()
                .unwrap_or(Value::Object(Map::new()));
            let mut entry = previous.as_object().cloned().unwrap_or_default();
            entry.insert("disabled".to_string(), Value::Bool(true));
            set_command_entry(next_commands, command_id, Value::Object(entry));
        }
    };

    for _pass in 0..COMMAND_IDS.len() * 2 {
        let bindings = effective_bindings(&next, None);
        let reserved = COMMAND_IDS.iter().copied().find(|id| {
            bindings
                .get(id.as_str())
                .and_then(|binding| binding.as_ref())
                .map(|binding| RESERVED_BINDINGS.contains(&binding.as_str()))
                .unwrap_or(false)
        });
        if let Some(reserved) = reserved {
            let binding = bindings.get(reserved.as_str()).cloned().flatten().unwrap();
            reset_or_disable(&mut next, reserved, &binding);
            continue;
        }

        let mut conflict: Option<(CommandId, CommandId)> = None;
        'outer: for (left_index, left_id) in COMMAND_IDS.iter().enumerate() {
            let Some(left_binding) = bindings
                .get(left_id.as_str())
                .and_then(|binding| binding.as_ref())
            else {
                continue;
            };
            for right_id in &COMMAND_IDS[left_index + 1..] {
                let right_binding = bindings
                    .get(right_id.as_str())
                    .and_then(|binding| binding.as_ref());
                if right_binding.map(|binding| binding.as_str()) == Some(left_binding.as_str())
                    && command_scopes_overlap(
                        command_definition(*left_id),
                        command_definition(*right_id),
                    )
                {
                    conflict = Some((*left_id, *right_id));
                    break 'outer;
                }
            }
        }
        let Some((left_id, right_id)) = conflict else {
            validate_effective_bindings(&bindings)?;
            return Ok(next);
        };

        let left_binding = bindings.get(left_id.as_str()).cloned().flatten().unwrap();
        let right_binding = bindings.get(right_id.as_str()).cloned().flatten().unwrap();
        let left_global = command_definition(left_id).global;
        let right_global = command_definition(right_id).global;
        let left_custom = left_binding != default_binding(left_id).unwrap_or_default();
        let right_custom = right_binding != default_binding(right_id).unwrap_or_default();
        let loser = if left_global != right_global {
            if left_global {
                right_id
            } else {
                left_id
            }
        } else if left_custom != right_custom {
            if left_custom {
                left_id
            } else {
                right_id
            }
        } else {
            right_id
        };
        let loser_binding = if loser == left_id {
            left_binding
        } else {
            right_binding
        };
        reset_or_disable(&mut next, loser, &loser_binding);
    }

    Err(KeybindingError::new(
        KeybindingErrorCode::Conflict,
        "Saved shortcuts could not be repaired safely.",
        None,
    ))
}

pub fn apply_keybinding_mutation(
    current: &Value,
    mutation: &KeybindingMutation,
    legacy: Option<&LegacyGlobalKeybindings>,
) -> Result<Value, KeybindingError> {
    if has_future_keybindings(current) {
        return Err(KeybindingError::new(
            KeybindingErrorCode::FutureVersion,
            "This shortcut document was created by a newer Aiden version and cannot be edited safely.",
            Some(mutation.command_id()),
        ));
    }
    let current = migrate_legacy_keybindings(current, legacy)?;
    let mut next = current.clone();

    match mutation {
        KeybindingMutation::Reset { command_id } => {
            let next_commands = next.get_mut("commands").unwrap().as_object_mut().unwrap();
            let future_fields = future_keybinding_fields(
                next_commands
                    .get(command_id.as_str())
                    .unwrap_or(&Value::Null),
            );
            let future_empty = future_fields
                .as_object()
                .map(|map| map.is_empty())
                .unwrap_or(false);
            if future_empty {
                delete_command_entry(next_commands, *command_id);
            } else {
                set_command_entry(next_commands, *command_id, future_fields);
            }
        }
        KeybindingMutation::SetBinding {
            command_id,
            binding,
            replace,
        } => {
            let Some(binding) = normalize_accelerator(binding) else {
                return Err(KeybindingError::new(
                    KeybindingErrorCode::Invalid,
                    "Use at least one modifier and one letter, number, function key, arrow, Return, or Space.",
                    Some(*command_id),
                ));
            };
            if *replace {
                let bindings = effective_bindings(&next, None);
                let mut to_disable: Vec<CommandId> = Vec::new();
                for id in COMMAND_IDS {
                    if *id == *command_id {
                        continue;
                    }
                    let other_binding = bindings.get(id.as_str()).and_then(|b| b.as_ref());
                    if other_binding.map(|b| b.as_str()) == Some(binding.as_str())
                        && command_scopes_overlap(
                            command_definition(*command_id),
                            command_definition(*id),
                        )
                    {
                        to_disable.push(*id);
                    }
                }
                let next_commands = next.get_mut("commands").unwrap().as_object_mut().unwrap();
                for id in to_disable {
                    let previous = next_commands
                        .get(id.as_str())
                        .cloned()
                        .unwrap_or(Value::Object(Map::new()));
                    let mut entry = previous.as_object().cloned().unwrap_or_default();
                    entry.insert("disabled".to_string(), Value::Bool(true));
                    set_command_entry(next_commands, id, Value::Object(entry));
                }
            }
            let next_commands = next.get_mut("commands").unwrap().as_object_mut().unwrap();
            let previous = next_commands
                .get(command_id.as_str())
                .cloned()
                .unwrap_or(Value::Object(Map::new()));
            let mut entry = previous.as_object().cloned().unwrap_or_default();
            entry.insert("binding".to_string(), Value::String(binding));
            entry.insert("disabled".to_string(), Value::Bool(false));
            set_command_entry(next_commands, *command_id, Value::Object(entry));
        }
        KeybindingMutation::Disable {
            command_id,
            disabled,
        } => {
            let next_commands = next.get_mut("commands").unwrap().as_object_mut().unwrap();
            let previous = next_commands
                .get(command_id.as_str())
                .cloned()
                .unwrap_or(Value::Object(Map::new()));
            let definition = command_definition(*command_id);
            let mut entry = previous.as_object().cloned().unwrap_or_default();
            let binding_absent_or_null = entry
                .get("binding")
                .map(|binding| binding.is_null())
                .unwrap_or(true);
            if !disabled && binding_absent_or_null && definition.default_binding.is_some() {
                entry.insert(
                    "binding".to_string(),
                    Value::String(definition.default_binding.clone().unwrap()),
                );
            }
            entry.insert("disabled".to_string(), Value::Bool(*disabled));
            set_command_entry(next_commands, *command_id, Value::Object(entry));
        }
    }

    let bindings = effective_bindings(&next, None);
    validate_effective_bindings(&bindings)?;
    Ok(next)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn future_keybinding_documents_are_used_defensively_without_being_downgraded() {
        let future =
            json!({ "version": 2, "commands": { "chat.new": { "binding": "Command+J" } } });
        let canonical = migrate_legacy_keybindings(
            &future,
            Some(&LegacyGlobalKeybindings {
                shortcut_accelerator: Some("Command+Shift+Space".into()),
                ..Default::default()
            }),
        )
        .unwrap();

        assert!(has_future_keybindings(&future));
        assert!(!has_future_keybindings(
            &json!({ "version": 1, "commands": {} })
        ));
        assert!(!has_future_keybindings(
            &json!({ "version": 1.5, "commands": {} })
        ));
        assert!(!has_future_keybindings(
            &json!({ "version": "2", "commands": {} })
        ));
        assert!(!should_persist_canonical_keybindings(&future, &canonical));
        assert!(should_persist_canonical_keybindings(
            &Value::Null,
            &canonical
        ));
        let err = apply_keybinding_mutation(
            &future,
            &KeybindingMutation::SetBinding {
                command_id: CommandId::ChatNew,
                binding: "Command+Shift+N".into(),
                replace: false,
            },
            None,
        )
        .unwrap_err();
        assert_eq!(err.code, KeybindingErrorCode::FutureVersion);
    }

    #[test]
    fn normalizes_aliases_modifier_order_and_punctuation() {
        assert_eq!(
            normalize_accelerator("shift+cmd+[").unwrap(),
            "Command+Shift+["
        );
        assert_eq!(
            normalize_accelerator("option+control+space").unwrap(),
            "Control+Alt+Space"
        );
        assert_eq!(normalize_accelerator("K"), None);
        assert_eq!(pretty_accelerator(Some("Command+Alt+Space")), "⌘⌥Space");
        assert_eq!(pretty_accelerator(None), "Unassigned");
    }

    #[test]
    fn records_physical_letter_and_exact_modifiers() {
        assert_eq!(
            accelerator_from_keyboard_event(&KeyboardEventLike {
                key: "k".into(),
                code: Some("KeyK".into()),
                meta_key: true,
                ctrl_key: false,
                alt_key: false,
                shift_key: false,
            })
            .unwrap(),
            "Command+K"
        );
        assert_eq!(
            accelerator_from_keyboard_event(&KeyboardEventLike {
                key: "{".into(),
                code: Some("BracketLeft".into()),
                meta_key: true,
                ctrl_key: false,
                alt_key: false,
                shift_key: true,
            })
            .unwrap(),
            "Command+Shift+["
        );
        assert_eq!(
            accelerator_from_keyboard_event(&KeyboardEventLike {
                key: "+".into(),
                code: Some("Equal".into()),
                meta_key: true,
                ctrl_key: false,
                alt_key: false,
                shift_key: true,
            })
            .unwrap(),
            "Command+Shift+="
        );
    }

    #[test]
    fn legacy_global_settings_remain_effective_until_overridden() {
        assert_eq!(
            effective_binding(
                CommandId::ComposerFocus,
                &Value::Null,
                Some(&LegacyGlobalKeybindings::default())
            ),
            Some("Command+Alt+Space".into())
        );
        assert_eq!(
            effective_binding(
                CommandId::AssistantOpen,
                &Value::Null,
                Some(&LegacyGlobalKeybindings::default())
            ),
            Some("Command+Alt+A".into())
        );
        assert_eq!(
            effective_binding(
                CommandId::ComposerFocus,
                &Value::Null,
                Some(&LegacyGlobalKeybindings {
                    shortcut_enabled: Some(true),
                    shortcut_accelerator: Some("Command+Shift+Space".into()),
                    ..Default::default()
                }),
            ),
            Some("Command+Shift+Space".into())
        );
        assert_eq!(
            effective_binding(
                CommandId::DictationToggle,
                &Value::Null,
                Some(&LegacyGlobalKeybindings {
                    dictation_enabled: Some(false),
                    ..Default::default()
                }),
            ),
            None
        );
        assert_eq!(
            effective_binding(
                CommandId::DictationToggle,
                &Value::Null,
                Some(&LegacyGlobalKeybindings::default())
            ),
            None
        );
        assert_eq!(
            effective_binding(
                CommandId::DictationToggle,
                &Value::Null,
                Some(&LegacyGlobalKeybindings {
                    dictation_enabled: Some(true),
                    ..Default::default()
                }),
            ),
            Some("Command+Shift+D".into())
        );
    }

    #[test]
    fn rejects_conflicts_and_reserved_bindings_without_mutating_the_prior_value() {
        let current = normalize_keybinding_overrides(&Value::Null);
        let err = apply_keybinding_mutation(
            &current,
            &KeybindingMutation::SetBinding {
                command_id: CommandId::ChatNew,
                binding: "Command+K".into(),
                replace: false,
            },
            None,
        )
        .unwrap_err();
        assert_eq!(err.code, KeybindingErrorCode::Conflict);
        for reserved in ["Command+Q", "Command+C", "Command+Shift+="] {
            let err = apply_keybinding_mutation(
                &current,
                &KeybindingMutation::SetBinding {
                    command_id: CommandId::ChatNew,
                    binding: reserved.into(),
                    replace: false,
                },
                None,
            )
            .unwrap_err();
            assert_eq!(err.code, KeybindingErrorCode::Reserved, "{reserved}");
        }
        let bindings = effective_bindings(&current, None);
        assert_eq!(bindings["chat.new"].as_deref(), Some("Command+N"));
    }

    #[test]
    fn catalog_defaults_remain_conflict_free_and_avoid_native_role_accelerators() {
        validate_effective_bindings(&effective_bindings(&Value::Null, None)).unwrap();
    }

    #[test]
    fn reset_removes_only_the_selected_override() {
        let changed = apply_keybinding_mutation(
            &Value::Null,
            &KeybindingMutation::SetBinding {
                command_id: CommandId::ChatNew,
                binding: "Command+Shift+N".into(),
                replace: false,
            },
            None,
        )
        .unwrap();
        let reset = apply_keybinding_mutation(
            &changed,
            &KeybindingMutation::Reset {
                command_id: CommandId::ChatNew,
            },
            None,
        )
        .unwrap();
        assert_eq!(reset["commands"]["chat.new"], Value::Null);
        assert_eq!(
            effective_binding(CommandId::ChatNew, &reset, None),
            Some("Command+N".into())
        );
    }

    #[test]
    fn first_mutation_atomically_migrates_and_preserves_legacy_global_settings() {
        let legacy = LegacyGlobalKeybindings {
            shortcut_enabled: Some(true),
            shortcut_accelerator: Some("Command+Shift+Space".into()),
            dictation_enabled: Some(false),
            assistant: Some(crate::keybindings::LegacyAssistantKeybindings {
                hotkey_enabled: Some(true),
                hotkey_accelerator: Some("Command+Shift+A".into()),
            }),
            ..Default::default()
        };
        let changed = apply_keybinding_mutation(
            &Value::Null,
            &KeybindingMutation::SetBinding {
                command_id: CommandId::TerminalToggle,
                binding: "Command+Control+T".into(),
                replace: false,
            },
            Some(&legacy),
        )
        .unwrap();

        assert_eq!(
            effective_binding(CommandId::ComposerFocus, &changed, None),
            Some("Command+Shift+Space".into())
        );
        assert_eq!(
            effective_binding(CommandId::DictationToggle, &changed, None),
            None
        );
        assert_eq!(
            effective_binding(CommandId::AssistantOpen, &changed, None),
            Some("Command+Shift+A".into())
        );
        assert_eq!(
            effective_binding(CommandId::TerminalToggle, &changed, None),
            Some("Command+Control+T".into())
        );
    }

    #[test]
    fn reset_after_migration_returns_the_catalog_default_instead_of_the_legacy_value() {
        let legacy = LegacyGlobalKeybindings {
            shortcut_enabled: Some(true),
            shortcut_accelerator: Some("Command+Shift+Space".into()),
            ..Default::default()
        };
        let migrated = migrate_legacy_keybindings(&Value::Null, Some(&legacy)).unwrap();
        let changed = apply_keybinding_mutation(
            &migrated,
            &KeybindingMutation::SetBinding {
                command_id: CommandId::ComposerFocus,
                binding: "Command+Control+Space".into(),
                replace: false,
            },
            None,
        )
        .unwrap();
        let reset = apply_keybinding_mutation(
            &changed,
            &KeybindingMutation::Reset {
                command_id: CommandId::ComposerFocus,
            },
            None,
        )
        .unwrap();
        assert_eq!(
            effective_binding(CommandId::ComposerFocus, &reset, None),
            Some("Command+Alt+Space".into())
        );
    }

    #[test]
    fn migration_preserves_a_legacy_global_collision_by_disabling_the_new_local_default() {
        let migrated = migrate_legacy_keybindings(
            &Value::Null,
            Some(&LegacyGlobalKeybindings {
                shortcut_enabled: Some(true),
                shortcut_accelerator: Some("Command+N".into()),
                ..Default::default()
            }),
        )
        .unwrap();
        assert_eq!(
            effective_binding(CommandId::ComposerFocus, &migrated, None),
            Some("Command+N".into())
        );
        assert_eq!(effective_binding(CommandId::ChatNew, &migrated, None), None);
    }

    #[test]
    fn normalization_tolerates_malformed_canonical_data_and_preserves_future_commands() {
        assert_eq!(
            effective_binding(CommandId::ChatNew, &json!({ "version": 1 }), None),
            Some("Command+N".into())
        );

        let normalized = normalize_keybinding_overrides(&json!({
            "version": 1,
            "commands": {
                "future.command": { "binding": "Command+Shift+U", "metadata": { "source": "future" } },
                "chat.new": { "binding": "Command+N", "futurePolicy": { "mode": "future" } },
            },
        }));
        let changed = apply_keybinding_mutation(
            &normalized,
            &KeybindingMutation::SetBinding {
                command_id: CommandId::TerminalToggle,
                binding: "Command+Control+T".into(),
                replace: false,
            },
            None,
        )
        .unwrap();
        assert_eq!(
            changed["commands"]["future.command"],
            json!({ "binding": "Command+Shift+U", "metadata": { "source": "future" } })
        );
        assert_eq!(
            changed["commands"]["chat.new"],
            json!({ "futurePolicy": { "mode": "future" }, "binding": "Command+N" })
        );
        let rebound_known = apply_keybinding_mutation(
            &changed,
            &KeybindingMutation::SetBinding {
                command_id: CommandId::ChatNew,
                binding: "Command+Shift+N".into(),
                replace: false,
            },
            None,
        )
        .unwrap();
        assert_eq!(
            rebound_known["commands"]["chat.new"],
            json!({ "futurePolicy": { "mode": "future" }, "binding": "Command+Shift+N", "disabled": false })
        );
        let reset_known = apply_keybinding_mutation(
            &rebound_known,
            &KeybindingMutation::Reset {
                command_id: CommandId::ChatNew,
            },
            None,
        )
        .unwrap();
        assert_eq!(
            reset_known["commands"]["chat.new"],
            json!({ "futurePolicy": { "mode": "future" } })
        );
        let prototype_safe = normalize_keybinding_overrides(&json!({
            "version": 1,
            "commands": { "__proto__": { "settings.open": { "binding": "NotAnAccelerator" } } },
        }));
        assert_eq!(
            prototype_safe["commands"]["__proto__"],
            json!({ "settings.open": { "binding": "NotAnAccelerator" } })
        );
        assert_eq!(
            effective_binding(CommandId::SettingsOpen, &prototype_safe, None),
            Some("Command+,".into())
        );
    }

    #[test]
    fn current_keybinding_edits_resets_and_repairs_preserve_unknown_root_fields() {
        let source = json!({
            "version": 1,
            "futurePolicy": { "owner": "newer-build", "revision": 3 },
            "commands": { "chat.new": { "binding": "Command+Shift+N" } },
        });
        let normalized = normalize_keybinding_overrides(&source);
        let edited = apply_keybinding_mutation(
            &normalized,
            &KeybindingMutation::SetBinding {
                command_id: CommandId::TerminalToggle,
                binding: "Command+Control+T".into(),
                replace: false,
            },
            None,
        )
        .unwrap();
        let reset = apply_keybinding_mutation(
            &edited,
            &KeybindingMutation::Reset {
                command_id: CommandId::TerminalToggle,
            },
            None,
        )
        .unwrap();
        let repaired = repair_keybinding_overrides(&json!({
            "version": 1,
            "futurePolicy": { "owner": "newer-build", "revision": 3 },
            "commands": { "chat.new": { "binding": "Command+C" } },
        }))
        .unwrap();
        for document in [&normalized, &edited, &reset, &repaired] {
            assert_eq!(
                document["futurePolicy"],
                json!({ "owner": "newer-build", "revision": 3 })
            );
        }
    }

    #[test]
    fn an_assigned_default_unbound_command_can_be_disabled_and_reenabled() {
        let assigned = apply_keybinding_mutation(
            &Value::Null,
            &KeybindingMutation::SetBinding {
                command_id: CommandId::ModelChange,
                binding: "Command+Shift+M".into(),
                replace: false,
            },
            None,
        )
        .unwrap();
        let disabled = apply_keybinding_mutation(
            &assigned,
            &KeybindingMutation::Disable {
                command_id: CommandId::ModelChange,
                disabled: true,
            },
            None,
        )
        .unwrap();
        let reenabled = apply_keybinding_mutation(
            &disabled,
            &KeybindingMutation::Disable {
                command_id: CommandId::ModelChange,
                disabled: false,
            },
            None,
        )
        .unwrap();
        assert_eq!(
            effective_binding(CommandId::ModelChange, &disabled, None),
            None
        );
        assert_eq!(
            effective_binding(CommandId::ModelChange, &reenabled, None),
            Some("Command+Shift+M".into())
        );
    }

    #[test]
    fn explicitly_enabling_dictation_uses_its_opt_in_default_binding() {
        let enabled = apply_keybinding_mutation(
            &Value::Null,
            &KeybindingMutation::Disable {
                command_id: CommandId::DictationToggle,
                disabled: false,
            },
            None,
        )
        .unwrap();
        assert_eq!(
            effective_binding(CommandId::DictationToggle, &enabled, None),
            Some("Command+Shift+D".into())
        );
        let round_tripped = normalize_keybinding_overrides(&enabled);
        assert_eq!(
            effective_binding(CommandId::DictationToggle, &round_tripped, None),
            Some("Command+Shift+D".into())
        );
    }

    #[test]
    fn enabling_a_persisted_null_binding_restores_its_catalog_default() {
        let enabled = apply_keybinding_mutation(
            &json!({ "version": 1, "commands": { "chat.new": { "binding": null } } }),
            &KeybindingMutation::Disable {
                command_id: CommandId::ChatNew,
                disabled: false,
            },
            None,
        )
        .unwrap();
        assert_eq!(
            effective_binding(CommandId::ChatNew, &enabled, None),
            Some("Command+N".into())
        );
        assert_eq!(enabled["commands"]["chat.new"]["binding"], "Command+N");
    }

    #[test]
    fn disjoint_renderer_scopes_can_share_a_binding_safely() {
        let shared = apply_keybinding_mutation(
            &Value::Null,
            &KeybindingMutation::SetBinding {
                command_id: CommandId::TerminalToggle,
                binding: "Command+S".into(),
                replace: false,
            },
            None,
        )
        .unwrap();
        assert_eq!(
            effective_binding(CommandId::TerminalToggle, &shared, None),
            Some("Command+S".into())
        );
        assert_eq!(
            effective_binding(CommandId::FileSave, &shared, None),
            Some("Command+S".into())
        );
    }

    #[test]
    fn native_menu_accelerators_cannot_share_a_renderer_scoped_binding() {
        let err = apply_keybinding_mutation(
            &Value::Null,
            &KeybindingMutation::SetBinding {
                command_id: CommandId::ChatNew,
                binding: "Command+S".into(),
                replace: false,
            },
            None,
        )
        .unwrap_err();
        assert_eq!(err.code, KeybindingErrorCode::Conflict);
    }

    #[test]
    fn repairs_v1_bindings_accepted_before_native_menu_scope_and_role_reservations() {
        let scoped_conflict = repair_keybinding_overrides(&json!({
            "version": 1,
            "commands": { "chat.new": { "binding": "Command+S", "futurePolicy": { "version": 2 } } },
        }))
        .unwrap();
        assert_eq!(
            effective_binding(CommandId::ChatNew, &scoped_conflict, None),
            Some("Command+N".into())
        );
        assert_eq!(
            effective_binding(CommandId::FileSave, &scoped_conflict, None),
            Some("Command+S".into())
        );
        assert_eq!(
            scoped_conflict["commands"]["chat.new"],
            json!({ "futurePolicy": { "version": 2 } })
        );

        let role_conflict = migrate_legacy_keybindings(
            &json!({
                "version": 1,
                "commands": { "chat.new": { "binding": "Command+C" }, "future.command": { "binding": "Command+Shift+U" } },
            }),
            None,
        )
        .unwrap();
        assert_eq!(
            effective_binding(CommandId::ChatNew, &role_conflict, None),
            Some("Command+N".into())
        );
        assert_eq!(
            role_conflict["commands"]["future.command"],
            json!({ "binding": "Command+Shift+U" })
        );
        validate_effective_bindings(&effective_bindings(&role_conflict, None)).unwrap();
    }

    #[test]
    fn explicit_replacement_disables_the_previous_owner_atomically() {
        let replaced = apply_keybinding_mutation(
            &Value::Null,
            &KeybindingMutation::SetBinding {
                command_id: CommandId::TerminalToggle,
                binding: "Command+N".into(),
                replace: true,
            },
            None,
        )
        .unwrap();
        assert_eq!(
            effective_binding(CommandId::TerminalToggle, &replaced, None),
            Some("Command+N".into())
        );
        assert_eq!(effective_binding(CommandId::ChatNew, &replaced, None), None);
    }

    #[test]
    fn typed_override_documents_round_trip_exactly() {
        let document = KeybindingOverridesV1 {
            version: 1,
            commands: BTreeMap::from([
                (
                    "chat.new".to_string(),
                    KeybindingOverride {
                        binding: Some(Some("Command+Shift+N".into())),
                        disabled: None,
                        future: BTreeMap::from([("futurePolicy".into(), json!({ "version": 2 }))]),
                    },
                ),
                (
                    "model.change".to_string(),
                    KeybindingOverride {
                        binding: Some(None),
                        disabled: None,
                        future: BTreeMap::new(),
                    },
                ),
            ]),
        };
        let value = serde_json::to_value(&document).unwrap();
        let back: KeybindingOverridesV1 = serde_json::from_value(value.clone()).unwrap();
        assert_eq!(back, document);
        assert_eq!(value["commands"]["model.change"]["binding"], Value::Null);
    }
}
