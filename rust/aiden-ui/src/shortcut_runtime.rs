//! App-lifetime keyboard shortcut truth.
//!
//! The pure engine reconciles the three OS-global registrations. The GPUI
//! entity layers serialized apply → persist → rollback transactions on top and
//! rebuilds application key bindings while preserving gpui-component's
//! baseline bindings.

use std::collections::{BTreeMap, VecDeque};
use std::sync::Arc;

use aiden_core::keybindings::{
    apply_keybinding_mutation, effective_bindings, has_canonical_keybindings,
    has_future_keybindings, migrate_legacy_keybindings, normalize_accelerator, GlobalShortcutState,
    GlobalShortcutStatus, KeybindingError, KeybindingMutation, KeybindingOverridesV1,
    KeybindingSnapshot, LegacyGlobalKeybindings, COMMAND_IDS,
};
use aiden_core::CommandId;
use aiden_data::config_store::ConfigStore;
use aiden_mac::hotkey::{
    reconcile_global_shortcuts, DesiredGlobalShortcut, RegisteredGlobalShortcut,
    ShortcutRegistrationPort,
};
use gpui::{App, AppContext as _, Context, Entity, EventEmitter, Global, KeyBinding};
use serde_json::Value;

use crate::app;

pub const KEYBINDINGS_SETTINGS_KEY: &str = "keybindings";
pub const GLOBAL_COMMANDS: &[CommandId] = &[
    CommandId::ComposerFocus,
    CommandId::DictationToggle,
    CommandId::AssistantOpen,
];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ActionRoute {
    FocusComposer,
    ToggleDictation,
    OpenAssistant,
    ToggleCommandPalette,
    NewChat,
    SearchChats,
    PreviousChat,
    NextChat,
    JumpChat(u8),
    ChangeModel,
    ManageProviders,
    SearchSettings,
    OpenSettings,
    OpenPreferredEditor,
    ToggleSidebar,
    ToggleTerminal,
    ToggleEnvironment,
    SaveFile,
}

pub const fn action_route(command: CommandId) -> ActionRoute {
    match command {
        CommandId::ComposerFocus => ActionRoute::FocusComposer,
        CommandId::DictationToggle => ActionRoute::ToggleDictation,
        CommandId::AssistantOpen => ActionRoute::OpenAssistant,
        CommandId::CommandPaletteToggle => ActionRoute::ToggleCommandPalette,
        CommandId::ChatNew => ActionRoute::NewChat,
        CommandId::ChatSearch => ActionRoute::SearchChats,
        CommandId::ChatPrevious => ActionRoute::PreviousChat,
        CommandId::ChatNext => ActionRoute::NextChat,
        CommandId::ChatJump1 => ActionRoute::JumpChat(1),
        CommandId::ChatJump2 => ActionRoute::JumpChat(2),
        CommandId::ChatJump3 => ActionRoute::JumpChat(3),
        CommandId::ChatJump4 => ActionRoute::JumpChat(4),
        CommandId::ChatJump5 => ActionRoute::JumpChat(5),
        CommandId::ChatJump6 => ActionRoute::JumpChat(6),
        CommandId::ChatJump7 => ActionRoute::JumpChat(7),
        CommandId::ChatJump8 => ActionRoute::JumpChat(8),
        CommandId::ChatJump9 => ActionRoute::JumpChat(9),
        CommandId::ModelChange => ActionRoute::ChangeModel,
        CommandId::ProviderManage => ActionRoute::ManageProviders,
        CommandId::SettingsSearch => ActionRoute::SearchSettings,
        CommandId::SettingsOpen => ActionRoute::OpenSettings,
        CommandId::WorkspaceOpenPreferredEditor => ActionRoute::OpenPreferredEditor,
        CommandId::SidebarToggle => ActionRoute::ToggleSidebar,
        CommandId::TerminalToggle => ActionRoute::ToggleTerminal,
        CommandId::EnvironmentToggle => ActionRoute::ToggleEnvironment,
        CommandId::FileSave => ActionRoute::SaveFile,
    }
}

pub const fn command_context(command: CommandId) -> &'static str {
    match command {
        CommandId::FileSave => "FilesEditor",
        _ => "App",
    }
}

/// Convert the shared Electron-style normalized accelerator into GPUI syntax.
pub fn accelerator_to_gpui(accelerator: &str) -> Option<String> {
    let normalized = normalize_accelerator(accelerator)?;
    let mut result = Vec::new();
    for token in normalized.split('+') {
        result.push(match token {
            "Command" => "cmd".to_string(),
            "Control" => "ctrl".to_string(),
            "Alt" => "alt".to_string(),
            "Shift" => "shift".to_string(),
            "Return" => "enter".to_string(),
            "Escape" => "escape".to_string(),
            "Space" => "space".to_string(),
            "Up" | "Down" | "Left" | "Right" => token.to_ascii_lowercase(),
            key => key.to_ascii_lowercase(),
        });
    }
    Some(result.join("-"))
}

fn action_for(route: ActionRoute) -> Box<dyn gpui::Action> {
    match route {
        ActionRoute::FocusComposer => Box::new(app::FocusComposer),
        ActionRoute::ToggleDictation => Box::new(app::TogglePill),
        ActionRoute::OpenAssistant => Box::new(app::OpenAssistant),
        ActionRoute::ToggleCommandPalette => Box::new(app::TogglePalette),
        ActionRoute::NewChat => Box::new(app::NewChat),
        ActionRoute::SearchChats => Box::new(app::SearchChats),
        ActionRoute::PreviousChat => Box::new(app::PreviousChat),
        ActionRoute::NextChat => Box::new(app::NextChat),
        ActionRoute::JumpChat(1) => Box::new(app::ChatJump1),
        ActionRoute::JumpChat(2) => Box::new(app::ChatJump2),
        ActionRoute::JumpChat(3) => Box::new(app::ChatJump3),
        ActionRoute::JumpChat(4) => Box::new(app::ChatJump4),
        ActionRoute::JumpChat(5) => Box::new(app::ChatJump5),
        ActionRoute::JumpChat(6) => Box::new(app::ChatJump6),
        ActionRoute::JumpChat(7) => Box::new(app::ChatJump7),
        ActionRoute::JumpChat(8) => Box::new(app::ChatJump8),
        ActionRoute::JumpChat(9) => Box::new(app::ChatJump9),
        ActionRoute::JumpChat(_) => unreachable!("catalog chat jumps are 1 through 9"),
        ActionRoute::ChangeModel => Box::new(app::ChangeModel),
        ActionRoute::ManageProviders => Box::new(app::ManageProviders),
        ActionRoute::SearchSettings => Box::new(app::SearchSettings),
        ActionRoute::OpenSettings => Box::new(app::OpenSettings),
        ActionRoute::OpenPreferredEditor => Box::new(app::OpenInEditor),
        ActionRoute::ToggleSidebar => Box::new(app::ToggleSidebar),
        ActionRoute::ToggleTerminal => Box::new(app::ToggleTerminal),
        ActionRoute::ToggleEnvironment => Box::new(app::ToggleEnvironment),
        ActionRoute::SaveFile => Box::new(app::SaveFile),
    }
}

fn key_binding(command: CommandId, accelerator: &str) -> Option<KeyBinding> {
    let keystroke = accelerator_to_gpui(accelerator)?;
    let context = Some(command_context(command));
    Some(match action_route(command) {
        ActionRoute::FocusComposer => KeyBinding::new(&keystroke, app::FocusComposer, context),
        ActionRoute::ToggleDictation => KeyBinding::new(&keystroke, app::TogglePill, context),
        ActionRoute::OpenAssistant => KeyBinding::new(&keystroke, app::OpenAssistant, context),
        ActionRoute::ToggleCommandPalette => {
            KeyBinding::new(&keystroke, app::TogglePalette, context)
        }
        ActionRoute::NewChat => KeyBinding::new(&keystroke, app::NewChat, context),
        ActionRoute::SearchChats => KeyBinding::new(&keystroke, app::SearchChats, context),
        ActionRoute::PreviousChat => KeyBinding::new(&keystroke, app::PreviousChat, context),
        ActionRoute::NextChat => KeyBinding::new(&keystroke, app::NextChat, context),
        ActionRoute::JumpChat(1) => KeyBinding::new(&keystroke, app::ChatJump1, context),
        ActionRoute::JumpChat(2) => KeyBinding::new(&keystroke, app::ChatJump2, context),
        ActionRoute::JumpChat(3) => KeyBinding::new(&keystroke, app::ChatJump3, context),
        ActionRoute::JumpChat(4) => KeyBinding::new(&keystroke, app::ChatJump4, context),
        ActionRoute::JumpChat(5) => KeyBinding::new(&keystroke, app::ChatJump5, context),
        ActionRoute::JumpChat(6) => KeyBinding::new(&keystroke, app::ChatJump6, context),
        ActionRoute::JumpChat(7) => KeyBinding::new(&keystroke, app::ChatJump7, context),
        ActionRoute::JumpChat(8) => KeyBinding::new(&keystroke, app::ChatJump8, context),
        ActionRoute::JumpChat(9) => KeyBinding::new(&keystroke, app::ChatJump9, context),
        ActionRoute::JumpChat(_) => unreachable!("catalog chat jumps are 1 through 9"),
        ActionRoute::ChangeModel => KeyBinding::new(&keystroke, app::ChangeModel, context),
        ActionRoute::ManageProviders => KeyBinding::new(&keystroke, app::ManageProviders, context),
        ActionRoute::SearchSettings => KeyBinding::new(&keystroke, app::SearchSettings, context),
        ActionRoute::OpenSettings => KeyBinding::new(&keystroke, app::OpenSettings, context),
        ActionRoute::OpenPreferredEditor => KeyBinding::new(&keystroke, app::OpenInEditor, context),
        ActionRoute::ToggleSidebar => KeyBinding::new(&keystroke, app::ToggleSidebar, context),
        ActionRoute::ToggleTerminal => KeyBinding::new(&keystroke, app::ToggleTerminal, context),
        ActionRoute::ToggleEnvironment => {
            KeyBinding::new(&keystroke, app::ToggleEnvironment, context)
        }
        ActionRoute::SaveFile => KeyBinding::new(&keystroke, app::SaveFile, context),
    })
}

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum ShortcutRuntimeError {
    #[error("{0}")]
    Keybinding(String),
    #[error("{0}")]
    Registration(String),
}

impl From<KeybindingError> for ShortcutRuntimeError {
    fn from(error: KeybindingError) -> Self {
        Self::Keybinding(error.message)
    }
}

pub struct ShortcutEngine {
    port: Arc<dyn ShortcutRegistrationPort>,
    overrides: Value,
    effective: BTreeMap<String, Option<String>>,
    registered: BTreeMap<CommandId, RegisteredGlobalShortcut>,
    suspended_claims: Option<BTreeMap<CommandId, RegisteredGlobalShortcut>>,
    read_only: bool,
    error: Option<String>,
}

impl ShortcutEngine {
    fn load_failure(port: Arc<dyn ShortcutRegistrationPort>, message: impl Into<String>) -> Self {
        let overrides = fail_closed_document();
        let effective = effective_bindings(&overrides, None);
        Self {
            port,
            overrides,
            effective,
            registered: BTreeMap::new(),
            suspended_claims: None,
            read_only: true,
            error: Some(message.into()),
        }
    }

    pub fn new(
        port: Arc<dyn ShortcutRegistrationPort>,
        overrides: &Value,
        legacy: Option<&LegacyGlobalKeybindings>,
    ) -> Self {
        let future_document = has_future_keybindings(overrides);
        let invalid_document =
            !overrides.is_null() && !future_document && !has_canonical_keybindings(overrides);
        let (overrides, read_only, load_error) = if future_document {
            (
                fail_closed_document(),
                true,
                Some("Saved shortcuts were created by a newer Aiden version. They were preserved and are read-only until you reset them.".to_string()),
            )
        } else if invalid_document {
            (
                fail_closed_document(),
                true,
                Some("Saved shortcuts were invalid. They were preserved and are read-only until you reset them.".to_string()),
            )
        } else {
            match migrate_legacy_keybindings(overrides, legacy) {
                Ok(overrides) => (overrides, false, None),
                Err(error) => (
                    fail_closed_document(),
                    true,
                    Some(format!("Saved shortcuts could not be loaded safely and were preserved: {error}. Reset all shortcuts to repair them.")),
                ),
            }
        };
        let effective = effective_bindings(&overrides, None);
        let mut this = Self {
            port,
            overrides,
            effective,
            registered: BTreeMap::new(),
            suspended_claims: None,
            read_only,
            error: load_error,
        };
        let startup_error = this.error.clone();
        let _ = this.reconcile_current();
        if startup_error.is_some() && this.error.is_none() {
            this.error = startup_error;
        }
        this
    }

    pub fn prepare_mutation(
        &self,
        mutation: &KeybindingMutation,
    ) -> Result<Value, ShortcutRuntimeError> {
        if self.read_only {
            return Err(ShortcutRuntimeError::Keybinding(
                "Saved shortcuts are read-only here. Reset all shortcuts to repair them."
                    .to_string(),
            ));
        }
        Ok(apply_keybinding_mutation(&self.overrides, mutation, None)?)
    }

    pub fn prepare_reset_all(&self) -> Result<Value, ShortcutRuntimeError> {
        let mut next = aiden_core::keybindings::normalize_keybinding_overrides(&Value::Null);
        for command_id in COMMAND_IDS {
            next = apply_keybinding_mutation(
                &next,
                &KeybindingMutation::Reset {
                    command_id: *command_id,
                },
                None,
            )?;
        }
        Ok(next)
    }

    pub fn apply_document(&mut self, next: Value) -> Result<(), ShortcutRuntimeError> {
        let next_effective = effective_bindings(&next, None);
        let desired = desired_globals(&next_effective, self.suspended_claims.is_some());
        let result = reconcile_global_shortcuts(self.port.as_ref(), &self.registered, &desired);
        if !result.ok {
            let message = registration_failure(&result);
            self.registered = result.registered;
            self.error = Some(message.clone());
            return Err(ShortcutRuntimeError::Registration(message));
        }
        self.registered = result.registered;
        self.overrides = next;
        self.effective = next_effective;
        self.read_only = false;
        self.error = None;
        Ok(())
    }

    pub fn suspend_all(&mut self) -> Result<(), ShortcutRuntimeError> {
        if self.suspended_claims.is_none() {
            self.suspended_claims = Some(self.registered.clone());
        }
        self.reconcile_current()
    }

    pub fn resume_all(&mut self) -> Result<(), ShortcutRuntimeError> {
        let Some(previous) = self.suspended_claims.take() else {
            return Ok(());
        };
        let desired = GLOBAL_COMMANDS
            .iter()
            .copied()
            .map(|command_id| DesiredGlobalShortcut {
                command_id,
                accelerator: previous
                    .get(&command_id)
                    .map(|registered| registered.accelerator.clone()),
            })
            .collect::<Vec<_>>();
        let result = reconcile_global_shortcuts(self.port.as_ref(), &self.registered, &desired);
        if result.ok {
            self.registered = result.registered;
            self.error = None;
            Ok(())
        } else {
            let message = registration_failure(&result);
            self.registered = result.registered;
            self.error = Some(message.clone());
            Err(ShortcutRuntimeError::Registration(message))
        }
    }

    pub fn retry(&mut self) -> Result<(), ShortcutRuntimeError> {
        self.reconcile_current()
    }

    fn reconcile_current(&mut self) -> Result<(), ShortcutRuntimeError> {
        let desired = desired_globals(&self.effective, self.suspended_claims.is_some());
        let result = reconcile_global_shortcuts(self.port.as_ref(), &self.registered, &desired);
        if result.ok {
            self.registered = result.registered;
            self.error = None;
            Ok(())
        } else {
            let message = registration_failure(&result);
            self.registered = result.registered;
            self.error = Some(message.clone());
            Err(ShortcutRuntimeError::Registration(message))
        }
    }

    pub fn overrides(&self) -> &Value {
        &self.overrides
    }

    #[cfg(test)]
    pub fn command_for_accelerator(&self, accelerator: &str) -> Option<CommandId> {
        let accelerator = normalize_accelerator(accelerator)?;
        self.registered.values().find_map(|registered| {
            (registered.accelerator == accelerator).then_some(registered.command_id)
        })
    }

    pub fn snapshot(&self) -> KeybindingSnapshot {
        let overrides = serde_json::from_value::<KeybindingOverridesV1>(self.overrides.clone())
            .expect("canonical keybindings always deserialize");
        KeybindingSnapshot {
            overrides,
            effective: self.effective.clone(),
            global: GLOBAL_COMMANDS
                .iter()
                .copied()
                .map(|command| self.status(command))
                .collect(),
        }
    }

    fn status(&self, command: CommandId) -> GlobalShortcutStatus {
        let binding = self.effective.get(command.as_str()).cloned().flatten();
        let (state, message) = match binding.as_deref() {
            None => (GlobalShortcutState::Disabled, None),
            Some(_) if self.suspended_claims.is_some() => (
                GlobalShortcutState::Unavailable,
                Some("Temporarily paused while recording a shortcut.".to_string()),
            ),
            Some(binding)
                if self
                    .registered
                    .get(&command)
                    .is_some_and(|registered| registered.accelerator == binding) =>
            {
                (GlobalShortcutState::Active, None)
            }
            Some(_) => (
                GlobalShortcutState::Unavailable,
                Some(
                    self.error
                        .clone()
                        .unwrap_or_else(|| "The global shortcut is not registered.".to_string()),
                ),
            ),
        };
        GlobalShortcutStatus {
            command_id: command,
            binding,
            state,
            message,
        }
    }
}

fn fail_closed_document() -> Value {
    let mut overrides = aiden_core::keybindings::normalize_keybinding_overrides(&Value::Null);
    for command_id in COMMAND_IDS {
        overrides = apply_keybinding_mutation(
            &overrides,
            &KeybindingMutation::Disable {
                command_id: *command_id,
                disabled: true,
            },
            None,
        )
        .expect("disabling a catalog command is always valid");
    }
    overrides
}

fn desired_globals(
    effective: &BTreeMap<String, Option<String>>,
    suspended: bool,
) -> Vec<DesiredGlobalShortcut> {
    GLOBAL_COMMANDS
        .iter()
        .copied()
        .map(|command_id| DesiredGlobalShortcut {
            command_id,
            accelerator: if suspended {
                None
            } else {
                effective.get(command_id.as_str()).cloned().flatten()
            },
        })
        .collect()
}

fn registration_failure(result: &aiden_mac::hotkey::ShortcutReconcileResult) -> String {
    let accelerator = result.failed_accelerator.as_deref().unwrap_or("shortcut");
    if result.rollback_failed == Some(true) {
        format!("Could not register {accelerator}, and one previous shortcut could not be restored. Retry before changing shortcuts again.")
    } else {
        format!("Could not register {accelerator}. Another app or macOS may already use it.")
    }
}

#[derive(Clone)]
pub struct ShortcutRuntimeChanged;

pub struct ShortcutRuntime {
    engine: ShortcutEngine,
    visible: KeybindingSnapshot,
    preserved_bindings: Vec<KeyBinding>,
    config: Arc<ConfigStore>,
    applying: bool,
    queue: VecDeque<RuntimeRequest>,
    error: Option<String>,
    recorder_generation: u64,
    recorder_owner: Option<u64>,
}

#[derive(Debug, Clone)]
enum RuntimeRequest {
    Mutation(KeybindingMutation),
    ResetAll,
}

impl EventEmitter<ShortcutRuntimeChanged> for ShortcutRuntime {}

impl ShortcutRuntime {
    pub fn new(
        config: Arc<ConfigStore>,
        port: Arc<dyn ShortcutRegistrationPort>,
        cx: &mut Context<Self>,
    ) -> Self {
        let engine = match config.get_settings() {
            Ok(settings) => {
                let stored = settings
                    .get(KEYBINDINGS_SETTINGS_KEY)
                    .cloned()
                    .unwrap_or(Value::Null);
                let legacy = LegacyGlobalKeybindings::from_value(&Value::Object(settings));
                ShortcutEngine::new(port, &stored, legacy.as_ref())
            }
            Err(error) => ShortcutEngine::load_failure(
                port,
                format!("Shortcuts could not be read and all global shortcuts are off: {error}. Reset all shortcuts after settings become available."),
            ),
        };
        let visible = engine.snapshot();
        let error = engine.error.clone();
        let preserved_bindings = cx.key_bindings().borrow().bindings().cloned().collect();
        let mut this = Self {
            engine,
            visible,
            preserved_bindings,
            config,
            applying: false,
            queue: VecDeque::new(),
            error,
            recorder_generation: 0,
            recorder_owner: None,
        };
        this.rebuild_bindings(cx);
        this
    }

    pub fn snapshot(&self) -> &KeybindingSnapshot {
        &self.visible
    }

    pub fn error(&self) -> Option<&str> {
        self.error.as_deref()
    }

    pub fn applying(&self) -> bool {
        self.applying
    }

    pub fn apply(&mut self, mutation: KeybindingMutation, cx: &mut Context<Self>) {
        self.queue.push_back(RuntimeRequest::Mutation(mutation));
        self.start_next(cx);
    }

    pub fn reset_all(&mut self, cx: &mut Context<Self>) {
        self.queue.push_back(RuntimeRequest::ResetAll);
        self.start_next(cx);
    }

    fn start_next(&mut self, cx: &mut Context<Self>) {
        if self.applying {
            return;
        }
        let Some(request) = self.queue.pop_front() else {
            return;
        };
        let reset_all = matches!(request, RuntimeRequest::ResetAll);
        let previous = self.engine.overrides().clone();
        let previous_read_only = self.engine.read_only;
        let previous_engine_error = self.engine.error.clone();
        let next = match &request {
            RuntimeRequest::Mutation(mutation) => self.engine.prepare_mutation(mutation),
            RuntimeRequest::ResetAll => self.engine.prepare_reset_all(),
        };
        let next = match next {
            Ok(next) => next,
            Err(error) => {
                self.error = Some(error.to_string());
                if reset_all {
                    self.queue.clear();
                }
                cx.emit(ShortcutRuntimeChanged);
                cx.notify();
                self.start_next(cx);
                return;
            }
        };
        if let Err(error) = self.engine.apply_document(next.clone()) {
            self.error = Some(error.to_string());
            if reset_all {
                self.queue.clear();
            }
            self.visible = self.engine.snapshot();
            cx.emit(ShortcutRuntimeChanged);
            cx.notify();
            self.start_next(cx);
            return;
        }
        self.rebuild_bindings(cx);
        self.applying = true;
        self.error = None;
        cx.emit(ShortcutRuntimeChanged);
        cx.notify();

        let config = self.config.clone();
        cx.spawn(async move |this, cx| {
            let persistence = cx
                .background_spawn(async move {
                    let mut patch = serde_json::Map::new();
                    patch.insert(KEYBINDINGS_SETTINGS_KEY.to_string(), next);
                    config
                        .set_settings(&patch, &|| true)
                        .map_err(|error| error.to_string())
                })
                .await;
            this.update(cx, |this, cx| {
                this.applying = false;
                match persistence {
                    Ok(_) => {
                        this.visible = this.engine.snapshot();
                    }
                    Err(error) => {
                        let rollback = this.engine.apply_document(previous);
                        if rollback.is_ok() {
                            this.engine.read_only = previous_read_only;
                            this.engine.error = previous_engine_error;
                        }
                        this.rebuild_bindings(cx);
                        this.visible = this.engine.snapshot();
                        this.error = Some(match rollback {
                            Ok(()) => format!("Shortcut changes were not saved: {error}"),
                            Err(rollback) => format!("Shortcut changes were not saved ({error}), and the previous shortcuts could not be restored ({rollback}). Restart Aiden before editing shortcuts again."),
                        });
                        if reset_all {
                            this.queue.clear();
                        }
                    }
                }
                cx.emit(ShortcutRuntimeChanged);
                cx.notify();
                this.start_next(cx);
            })
            .ok();
        })
        .detach();
    }

    pub fn suspend_recorder(&mut self, cx: &mut Context<Self>) -> u64 {
        self.recorder_generation = self.recorder_generation.wrapping_add(1);
        let owner = self.recorder_generation;
        self.recorder_owner = Some(owner);
        if let Err(error) = self.engine.suspend_all() {
            self.error = Some(error.to_string());
        }
        self.visible = self.engine.snapshot();
        cx.emit(ShortcutRuntimeChanged);
        cx.notify();
        owner
    }

    pub fn cancel_recorder(&mut self, owner: u64, cx: &mut Context<Self>) {
        if !recorder_owner_matches(self.recorder_owner, owner) {
            return;
        }
        self.recorder_owner = None;
        if let Err(error) = self.engine.resume_all() {
            self.error = Some(error.to_string());
        }
        self.visible = self.engine.snapshot();
        cx.emit(ShortcutRuntimeChanged);
        cx.notify();
    }

    pub fn retry_globals(&mut self, cx: &mut Context<Self>) {
        if let Err(error) = self.engine.retry() {
            self.error = Some(error.to_string());
        } else if self.engine.read_only {
            self.error =
                Some("Saved shortcuts remain read-only until you reset all shortcuts.".to_string());
        } else {
            self.error = None;
        }
        self.visible = self.engine.snapshot();
        cx.emit(ShortcutRuntimeChanged);
        cx.notify();
    }

    fn rebuild_bindings(&mut self, cx: &mut App) {
        // Preserve gpui-component's baseline and any later surface-local
        // bindings (for example the dictation pill's Escape action). Only
        // bindings owned by this runtime are replaced.
        self.preserved_bindings = cx
            .key_bindings()
            .borrow()
            .bindings()
            .filter(|binding| !is_runtime_managed_action(binding.action()))
            .cloned()
            .collect();
        cx.clear_key_bindings();
        cx.bind_keys(self.preserved_bindings.iter().cloned());
        cx.bind_keys(supplemental_bindings());
        cx.bind_keys(COMMAND_IDS.iter().copied().filter_map(|command| {
            self.engine
                .effective
                .get(command.as_str())
                .and_then(|binding| binding.as_deref())
                .and_then(|binding| key_binding(command, binding))
        }));
    }
}

fn recorder_owner_matches(current: Option<u64>, requested: u64) -> bool {
    current == Some(requested)
}

fn is_runtime_managed_action(action: &dyn gpui::Action) -> bool {
    let action = action.as_any();
    action.is::<app::FocusComposer>()
        || action.is::<app::TogglePill>()
        || action.is::<app::OpenAssistant>()
        || action.is::<app::TogglePalette>()
        || action.is::<app::NewChat>()
        || action.is::<app::SearchChats>()
        || action.is::<app::PreviousChat>()
        || action.is::<app::NextChat>()
        || action.is::<app::ChatJump1>()
        || action.is::<app::ChatJump2>()
        || action.is::<app::ChatJump3>()
        || action.is::<app::ChatJump4>()
        || action.is::<app::ChatJump5>()
        || action.is::<app::ChatJump6>()
        || action.is::<app::ChatJump7>()
        || action.is::<app::ChatJump8>()
        || action.is::<app::ChatJump9>()
        || action.is::<app::ChangeModel>()
        || action.is::<app::ManageProviders>()
        || action.is::<app::SearchSettings>()
        || action.is::<app::OpenSettings>()
        || action.is::<app::OpenInEditor>()
        || action.is::<app::ToggleSidebar>()
        || action.is::<app::ToggleTerminal>()
        || action.is::<app::ToggleEnvironment>()
        || action.is::<app::SaveFile>()
        || action.is::<app::Quit>()
        || action.is::<app::CloseWindow>()
        || action.is::<app::SendMessage>()
        || action.is::<app::ToggleSubagents>()
        || action.is::<app::ToggleUsage>()
}

fn supplemental_bindings() -> Vec<KeyBinding> {
    vec![
        KeyBinding::new("cmd-q", app::Quit, Some("App")),
        KeyBinding::new("cmd-w", app::CloseWindow, Some("App")),
        KeyBinding::new("cmd-enter", app::SendMessage, Some("App")),
        KeyBinding::new("cmd-shift-s", app::ToggleSubagents, Some("App")),
        KeyBinding::new("cmd-shift-u", app::ToggleUsage, Some("App")),
    ]
}

pub struct ShortcutRuntimeGlobal(pub Entity<ShortcutRuntime>);
impl Global for ShortcutRuntimeGlobal {}

pub fn runtime(cx: &App) -> Option<Entity<ShortcutRuntime>> {
    cx.try_global::<ShortcutRuntimeGlobal>()
        .map(|global| global.0.clone())
}

/// Global commands that target an external application must not prepare or
/// activate Aiden first. Dictation is intentionally non-activating: its pill
/// records over the frontmost app and the eventual paste is delivered back to
/// that same app. Other global commands retain the normal app-window behavior.
pub const fn global_command_requires_main_window(command: CommandId) -> bool {
    !matches!(command, CommandId::DictationToggle)
}

pub const fn global_command_activates_app(command: CommandId) -> bool {
    !matches!(command, CommandId::DictationToggle)
}

pub fn dispatch_global_command(command: CommandId, cx: &mut App) {
    if command == CommandId::DictationToggle && crate::app::toggle_global_dictation(cx) {
        return;
    }
    if global_command_activates_app(command) {
        cx.activate(true);
    }
    cx.dispatch_action(action_for(action_route(command)).as_ref());
}

#[cfg(test)]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum GlobalDispatchStep {
    OpenWindow,
    Dispatch,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MainWindowLifecycle {
    Onboarding,
    Ready,
    Windowless,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MainWindowPreparation {
    Ignore,
    Ready,
    Open,
}

pub const fn main_window_preparation(state: MainWindowLifecycle) -> MainWindowPreparation {
    match state {
        MainWindowLifecycle::Onboarding => MainWindowPreparation::Ignore,
        MainWindowLifecycle::Ready => MainWindowPreparation::Ready,
        MainWindowLifecycle::Windowless => MainWindowPreparation::Open,
    }
}

#[cfg(test)]
fn global_dispatch_plan(state: MainWindowLifecycle) -> Vec<GlobalDispatchStep> {
    match state {
        MainWindowLifecycle::Onboarding => Vec::new(),
        MainWindowLifecycle::Ready => vec![GlobalDispatchStep::Dispatch],
        MainWindowLifecycle::Windowless => {
            vec![GlobalDispatchStep::OpenWindow, GlobalDispatchStep::Dispatch]
        }
    }
}

struct UnavailablePort;
impl ShortcutRegistrationPort for UnavailablePort {
    fn register(&self, _accelerator: &str) -> bool {
        false
    }
    fn unregister(&self, _accelerator: &str) {}
}

pub fn platform_port() -> Arc<dyn ShortcutRegistrationPort> {
    #[cfg(target_os = "macos")]
    {
        match aiden_mac::hotkey::GlobalHotkeyManager::initialize() {
            Ok(manager) => Arc::new(aiden_mac::hotkey::MacHotkeyPort::new(manager)),
            Err(error) => {
                tracing::warn!("global shortcuts unavailable: {error}");
                Arc::new(UnavailablePort)
            }
        }
    }
    #[cfg(not(target_os = "macos"))]
    {
        Arc::new(UnavailablePort)
    }
}

#[cfg(target_os = "macos")]
impl ShortcutRuntime {
    fn command_for_hotkey_id(&self, id: u32) -> Option<CommandId> {
        self.engine.registered.values().find_map(|registered| {
            registered
                .accelerator
                .parse::<global_hotkey::hotkey::HotKey>()
                .ok()
                .filter(|hotkey| hotkey.id() == id)
                .map(|_| registered.command_id)
        })
    }
}

/// Bridge the process-wide hotkey receiver onto GPUI's foreground before
/// dispatching the action. The runtime entity remains the registration truth.
#[cfg(target_os = "macos")]
fn prepare_for_global_command(
    command: CommandId,
    prepare_main_window: &dyn Fn(&mut App) -> bool,
    app: &mut App,
) -> bool {
    if global_command_requires_main_window(command) {
        prepare_main_window(app)
    } else {
        true
    }
}

#[cfg(target_os = "macos")]
pub fn install_global_listener(
    runtime: Entity<ShortcutRuntime>,
    prepare_main_window: Arc<dyn Fn(&mut App) -> bool + Send + Sync>,
    cx: &mut App,
) {
    use global_hotkey::{GlobalHotKeyEvent, HotKeyState};

    let (sender, mut receiver) = tokio::sync::mpsc::unbounded_channel::<u32>();
    let scaffold = cx.new(|_| ());
    cx.update_entity(&scaffold, |_, inner| {
        gpui_tokio_bridge::Tokio::spawn(inner, async move {
            loop {
                let event = tokio::task::spawn_blocking(|| {
                    GlobalHotKeyEvent::receiver()
                        .recv_timeout(std::time::Duration::from_millis(250))
                })
                .await;
                match event {
                    Ok(Ok(event)) if event.state == HotKeyState::Pressed => {
                        if sender.send(event.id).is_err() {
                            break;
                        }
                    }
                    Ok(Ok(_)) | Ok(Err(_)) => {}
                    Err(_) => break,
                }
            }
        })
        .detach();
        inner
            .spawn(async move |_, cx| {
                while let Some(id) = receiver.recv().await {
                    let Ok(command) =
                        runtime.read_with(cx, |runtime, _| runtime.command_for_hotkey_id(id))
                    else {
                        break;
                    };
                    if let Some(command) = command {
                        if cx
                            .update({
                                let prepare_main_window = prepare_main_window.clone();
                                move |app| {
                                    if prepare_for_global_command(
                                        command,
                                        prepare_main_window.as_ref(),
                                        app,
                                    ) {
                                        dispatch_global_command(command, app);
                                    } else {
                                        tracing::debug!(
                                            "global shortcut ignored until the main window is ready"
                                        );
                                    }
                                }
                            })
                            .is_err()
                        {
                            break;
                        }
                    }
                }
            })
            .detach();
    });
}

#[cfg(not(target_os = "macos"))]
pub fn install_global_listener(
    _runtime: Entity<ShortcutRuntime>,
    _prepare_main_window: Arc<dyn Fn(&mut App) -> bool + Send + Sync>,
    _cx: &mut App,
) {
}

#[cfg(test)]
mod tests {
    use std::collections::HashSet;
    use std::sync::Mutex;

    use super::*;

    #[derive(Default)]
    struct FakePort {
        active: Mutex<HashSet<String>>,
        blocked: Mutex<HashSet<String>>,
    }

    impl FakePort {
        fn block(&self, accelerator: &str) {
            self.blocked.lock().unwrap().insert(accelerator.to_string());
        }
        fn active(&self, accelerator: &str) -> bool {
            self.active.lock().unwrap().contains(accelerator)
        }
    }

    impl ShortcutRegistrationPort for FakePort {
        fn register(&self, accelerator: &str) -> bool {
            if self.blocked.lock().unwrap().contains(accelerator) {
                return false;
            }
            self.active.lock().unwrap().insert(accelerator.to_string())
        }
        fn unregister(&self, accelerator: &str) {
            self.active.lock().unwrap().remove(accelerator);
        }
    }

    fn engine(port: Arc<FakePort>) -> ShortcutEngine {
        ShortcutEngine::new(port, &Value::Null, None)
    }

    #[test]
    fn accelerator_conversion_is_normalized_for_gpui() {
        assert_eq!(
            accelerator_to_gpui("Shift+Command+D").as_deref(),
            Some("cmd-shift-d")
        );
        assert_eq!(
            accelerator_to_gpui("Command+Alt+Space").as_deref(),
            Some("cmd-alt-space")
        );
        assert_eq!(
            accelerator_to_gpui("Command+Return").as_deref(),
            Some("cmd-enter")
        );
        assert_eq!(accelerator_to_gpui("D"), None);
    }

    #[test]
    fn windowless_global_dispatch_opens_before_dispatching() {
        assert_eq!(
            global_dispatch_plan(MainWindowLifecycle::Windowless),
            vec![GlobalDispatchStep::OpenWindow, GlobalDispatchStep::Dispatch]
        );
        assert_eq!(
            global_dispatch_plan(MainWindowLifecycle::Ready),
            vec![GlobalDispatchStep::Dispatch]
        );
        assert!(global_dispatch_plan(MainWindowLifecycle::Onboarding).is_empty());
        assert_eq!(
            main_window_preparation(MainWindowLifecycle::Onboarding),
            MainWindowPreparation::Ignore
        );
        assert_eq!(
            main_window_preparation(MainWindowLifecycle::Ready),
            MainWindowPreparation::Ready
        );
        assert_eq!(
            main_window_preparation(MainWindowLifecycle::Windowless),
            MainWindowPreparation::Open
        );
    }

    #[test]
    fn dictation_global_dispatch_never_prepares_or_activates_a_window() {
        assert!(!global_command_requires_main_window(
            CommandId::DictationToggle
        ));
        assert!(!global_command_activates_app(CommandId::DictationToggle));

        // Commands whose destination is Aiden itself retain the normal
        // window/activation contract.
        for command in [CommandId::ComposerFocus, CommandId::AssistantOpen] {
            assert!(global_command_requires_main_window(command));
            assert!(global_command_activates_app(command));
        }
    }

    #[test]
    fn command_mapping_and_context_are_exhaustive() {
        for command in COMMAND_IDS {
            let _ = action_route(*command);
            assert!(matches!(command_context(*command), "App" | "FilesEditor"));
        }
        assert_eq!(command_context(CommandId::FileSave), "FilesEditor");
    }

    #[test]
    fn startup_registers_enabled_globals_but_not_default_disabled_dictation() {
        let port = Arc::new(FakePort::default());
        let engine = engine(port.clone());
        assert!(port.active("Command+Alt+Space"));
        assert!(port.active("Command+Alt+A"));
        assert!(!port.active("Command+Shift+D"));
        assert_eq!(
            engine.snapshot().global[1].state,
            GlobalShortcutState::Disabled
        );
    }

    #[test]
    fn malformed_and_future_documents_never_panic_or_overwrite_saved_data() {
        let malformed = ShortcutEngine::new(
            Arc::new(FakePort::default()),
            &serde_json::json!(["not", "a", "document"]),
            None,
        );
        assert!(malformed.read_only);
        assert!(malformed
            .error
            .as_deref()
            .is_some_and(|error| error.contains("invalid")));
        assert_eq!(
            malformed.snapshot().effective[CommandId::DictationToggle.as_str()],
            None
        );
        assert_eq!(
            malformed.snapshot().effective[CommandId::ChatNew.as_str()],
            None
        );
        assert!(malformed.registered.is_empty());

        let future = ShortcutEngine::new(
            Arc::new(FakePort::default()),
            &serde_json::json!({"version": 2, "commands": {"future.command": {"binding": "Command+Y"}}}),
            None,
        );
        assert!(future.read_only);
        assert!(future
            .error
            .as_deref()
            .is_some_and(|error| error.contains("preserved")));
        assert!(future
            .prepare_mutation(&KeybindingMutation::Reset {
                command_id: CommandId::ChatNew,
            })
            .is_err());
        assert!(future.prepare_reset_all().is_ok());
        assert!(future.registered.is_empty());
        assert!(future.snapshot().effective.values().all(Option::is_none));
    }

    #[test]
    fn settings_read_failure_is_read_only_and_claims_no_global_shortcuts() {
        let port = Arc::new(FakePort::default());
        let engine = ShortcutEngine::load_failure(port.clone(), "settings unavailable");
        assert!(engine.read_only);
        assert!(engine
            .error
            .as_deref()
            .is_some_and(|error| error.contains("unavailable")));
        assert!(!port.active("Command+Alt+Space"));
        assert!(!port.active("Command+Alt+A"));
        assert!(engine
            .snapshot()
            .global
            .iter()
            .all(|status| status.state == GlobalShortcutState::Disabled));
        assert!(engine.snapshot().effective.values().all(Option::is_none));
    }

    #[test]
    fn custom_disabled_and_dispatch_follow_committed_registration() {
        let port = Arc::new(FakePort::default());
        let mut engine = engine(port.clone());
        let custom = engine
            .prepare_mutation(&KeybindingMutation::SetBinding {
                command_id: CommandId::ComposerFocus,
                binding: "Command+Control+Space".to_string(),
                replace: false,
            })
            .unwrap();
        engine.apply_document(custom).unwrap();
        assert_eq!(
            engine.command_for_accelerator("Control+Command+Space"),
            Some(CommandId::ComposerFocus)
        );
        let disabled = engine
            .prepare_mutation(&KeybindingMutation::Disable {
                command_id: CommandId::ComposerFocus,
                disabled: true,
            })
            .unwrap();
        engine.apply_document(disabled).unwrap();
        assert_eq!(
            engine.command_for_accelerator("Command+Control+Space"),
            None
        );
    }

    #[test]
    fn failed_registration_restores_previous_claim_and_reports_unavailable_only_if_needed() {
        let port = Arc::new(FakePort::default());
        let mut engine = engine(port.clone());
        port.block("Command+Control+Space");
        let next = engine
            .prepare_mutation(&KeybindingMutation::SetBinding {
                command_id: CommandId::ComposerFocus,
                binding: "Command+Control+Space".to_string(),
                replace: false,
            })
            .unwrap();
        assert!(engine.apply_document(next).is_err());
        assert!(port.active("Command+Alt+Space"));
        assert_eq!(
            engine.snapshot().global[0].state,
            GlobalShortcutState::Active
        );
    }

    #[test]
    fn recorder_suspends_all_globals_and_restores_exact_previous_claims() {
        let port = Arc::new(FakePort::default());
        let mut engine = engine(port.clone());
        engine.suspend_all().unwrap();
        assert!(!port.active("Command+Alt+Space"));
        assert!(!port.active("Command+Alt+A"));
        assert_eq!(
            engine.snapshot().global[0].state,
            GlobalShortcutState::Unavailable
        );
        assert_eq!(
            engine.snapshot().global[2].state,
            GlobalShortcutState::Unavailable
        );
        engine.resume_all().unwrap();
        assert!(port.active("Command+Alt+Space"));
        assert!(port.active("Command+Alt+A"));
        assert!(!port.active("Command+Shift+D"));
        assert_eq!(
            engine.snapshot().global[2].state,
            GlobalShortcutState::Active
        );
    }

    #[test]
    fn persistence_failure_path_restores_the_previous_runtime_document() {
        let port = Arc::new(FakePort::default());
        let mut engine = engine(port.clone());
        let previous = engine.overrides().clone();
        let next = engine
            .prepare_mutation(&KeybindingMutation::SetBinding {
                command_id: CommandId::AssistantOpen,
                binding: "Command+Control+A".to_string(),
                replace: false,
            })
            .unwrap();

        engine.apply_document(next).unwrap();
        assert!(port.active("Command+Control+A"));
        // A failed persistence result drives the same rollback operation used
        // by ShortcutRuntime's serialized transaction callback.
        engine.apply_document(previous).unwrap();

        assert!(port.active("Command+Alt+A"));
        assert!(!port.active("Command+Control+A"));
        assert_eq!(
            engine.snapshot().global[2].state,
            GlobalShortcutState::Active
        );
    }

    #[test]
    fn abandoned_recorder_owner_cannot_cancel_a_newer_recording() {
        assert!(!recorder_owner_matches(Some(2), 1));
        assert!(recorder_owner_matches(Some(2), 2));
        assert!(!recorder_owner_matches(None, 2));
    }

    #[test]
    fn reset_all_prepares_one_complete_document_without_mutating_the_previous_map() {
        let port = Arc::new(FakePort::default());
        let mut engine = engine(port);
        let custom = engine
            .prepare_mutation(&KeybindingMutation::SetBinding {
                command_id: CommandId::ChatNew,
                binding: "Command+Shift+N".to_string(),
                replace: false,
            })
            .unwrap();
        engine.apply_document(custom).unwrap();
        let previous = engine.overrides().clone();
        let reset = engine.prepare_reset_all().unwrap();

        assert_eq!(engine.overrides(), &previous);
        assert_eq!(
            effective_bindings(&reset, None)[CommandId::ChatNew.as_str()].as_deref(),
            Some("Command+N")
        );
        assert_eq!(
            effective_bindings(&reset, None)[CommandId::DictationToggle.as_str()],
            None
        );
    }
}
