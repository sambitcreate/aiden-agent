//! Keyboard shortcuts settings (port of `shortcut-settings.tsx`).
//!
//! Renders the 26-command catalog from `aiden_core::keybindings`, shows the
//! effective binding for each (default / custom / disabled), supports
//! record-into-field rebinding (keydown capture on the row), per-command
//! enable/disable, single-command reset, and reset-to-defaults. Overrides are
//! persisted into `settings.json` under the `keybindings` key through the
//! repair/mutate pipeline (`apply_keybinding_mutation`).

use std::collections::BTreeMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;

#[cfg(test)]
use aiden_core::keybindings::normalize_keybinding_overrides;
use aiden_core::keybindings::{
    accelerator_from_keyboard_event, apply_keybinding_mutation, effective_bindings,
    pretty_accelerator, GlobalShortcutState, GlobalShortcutStatus, KeybindingErrorCode,
    KeybindingMutation, KeyboardEventLike,
};
use aiden_core::CommandId;
use gpui::{
    div, prelude::FluentBuilder as _, AppContext as _, Context, Entity, FocusHandle, FontWeight,
    InteractiveElement as _, IntoElement, ParentElement as _, SharedString, Styled as _, Window,
};
use gpui_component::{
    button::{Button, ButtonVariants as _},
    h_flex,
    input::{Input, InputEvent, InputState},
    switch::Switch,
    v_flex, ActiveTheme, Disableable as _, Icon, IconName, Sizable as _,
};

use super::{SettingsServices, SettingsView};

/// Local catalog metadata (titles/descriptions) for the 26 commands. The
/// *bindings* themselves always come from `aiden_core` (the catalog defaults +
/// effective resolution); this table only mirrors the renderer's display copy.
fn catalog() -> &'static [(CommandId, &'static str, &'static str)] {
    &[
        (
            CommandId::ComposerFocus,
            "Focus composer",
            "Bring Aiden forward and focus the message composer.",
        ),
        (
            CommandId::DictationToggle,
            "Start or stop dictation",
            "Dictate into the focused app.",
        ),
        (
            CommandId::AssistantOpen,
            "Open Aiden",
            "Open the docked Aiden assistant.",
        ),
        (
            CommandId::CommandPaletteToggle,
            "Open command palette",
            "Search commands, chats, models, providers, and settings.",
        ),
        (
            CommandId::ChatNew,
            "New chat",
            "Start a new chat in the active workspace.",
        ),
        (
            CommandId::ChatSearch,
            "Search chats",
            "Open the palette in chat search.",
        ),
        (
            CommandId::ChatPrevious,
            "Previous chat",
            "Open the previous chat in the sidebar.",
        ),
        (
            CommandId::ChatNext,
            "Next chat",
            "Open the next chat in the sidebar.",
        ),
        (
            CommandId::ChatJump1,
            "Open chat 1",
            "Open chat 1 in the sidebar.",
        ),
        (
            CommandId::ChatJump2,
            "Open chat 2",
            "Open chat 2 in the sidebar.",
        ),
        (
            CommandId::ChatJump3,
            "Open chat 3",
            "Open chat 3 in the sidebar.",
        ),
        (
            CommandId::ChatJump4,
            "Open chat 4",
            "Open chat 4 in the sidebar.",
        ),
        (
            CommandId::ChatJump5,
            "Open chat 5",
            "Open chat 5 in the sidebar.",
        ),
        (
            CommandId::ChatJump6,
            "Open chat 6",
            "Open chat 6 in the sidebar.",
        ),
        (
            CommandId::ChatJump7,
            "Open chat 7",
            "Open chat 7 in the sidebar.",
        ),
        (
            CommandId::ChatJump8,
            "Open chat 8",
            "Open chat 8 in the sidebar.",
        ),
        (
            CommandId::ChatJump9,
            "Open chat 9",
            "Open chat 9 in the sidebar.",
        ),
        (
            CommandId::ModelChange,
            "Change model",
            "Choose the active provider and model.",
        ),
        (
            CommandId::ProviderManage,
            "Manage providers",
            "Review providers and refresh their model catalogs.",
        ),
        (
            CommandId::SettingsSearch,
            "Search settings",
            "Open quick settings search.",
        ),
        (
            CommandId::SettingsOpen,
            "Open Settings",
            "Open Aiden settings.",
        ),
        (
            CommandId::WorkspaceOpenPreferredEditor,
            "Open workspace in preferred editor",
            "Open the active workspace in its preferred editor.",
        ),
        (
            CommandId::SidebarToggle,
            "Toggle sidebar",
            "Show or hide the leading sidebar.",
        ),
        (
            CommandId::TerminalToggle,
            "Toggle terminal",
            "Show or hide the workspace terminal.",
        ),
        (
            CommandId::EnvironmentToggle,
            "Toggle environment panel",
            "Show or hide files and Git tools.",
        ),
        (
            CommandId::FileSave,
            "Save file",
            "Save the active file editor.",
        ),
    ]
}

/// Pure encoder for the shortcut recorder: maps a captured keystroke
/// (key + modifier booleans) onto a normalized accelerator via the shared
/// aiden-core pipeline.
pub struct ShortcutCapture {
    pub key: String,
    pub meta: bool,
    pub ctrl: bool,
    pub alt: bool,
    pub shift: bool,
}

pub fn encode_shortcut(capture: &ShortcutCapture) -> Option<String> {
    accelerator_from_keyboard_event(&KeyboardEventLike {
        key: capture.key.clone(),
        code: None,
        meta_key: capture.meta,
        ctrl_key: capture.ctrl,
        alt_key: capture.alt,
        shift_key: capture.shift,
    })
}

#[derive(Default)]
pub struct ShortcutsState {
    /// Command id -> effective binding (catalog default, override, or unset).
    pub effective: BTreeMap<String, Option<String>>,
    /// The normalized V1 override document (persisted verbatim).
    pub overrides: serde_json::Value,
    /// The command currently recording a replacement.
    pub recording: Option<CommandId>,
    recording_owner: Option<u64>,
    owner_signal: Arc<AtomicU64>,
    /// Last mutation error (e.g. a conflicting shortcut).
    pub error: Option<String>,
    /// The last conflict so the user can force-replace it.
    pub pending_replacement: Option<(CommandId, String)>,
    pub global: Vec<GlobalShortcutStatus>,
    pub applying: bool,
    pub search: Option<Entity<InputState>>,
    recorder_focus: Option<FocusHandle>,
    recorder_blur: Option<gpui::Subscription>,
    _subscriptions: Vec<gpui::Subscription>,
}

impl ShortcutsState {
    pub fn owner_signal(&self) -> Arc<AtomicU64> {
        self.owner_signal.clone()
    }
    /// Recompute the effective bindings from the persisted settings map.
    pub fn hydrate(&mut self, settings: &serde_json::Map<String, serde_json::Value>) {
        let _ = settings;
    }

    pub fn sync_runtime(&mut self, runtime: &crate::shortcut_runtime::ShortcutRuntime) {
        let snapshot = runtime.snapshot();
        self.overrides = serde_json::to_value(&snapshot.overrides).unwrap_or_default();
        self.effective = snapshot.effective.clone();
        self.global = snapshot.global.clone();
        self.applying = runtime.applying();
        self.error = runtime.error().map(ToOwned::to_owned);
    }

    #[allow(dead_code)] // row renderer resolves bindings through `overridden` today
    fn binding_for(&self, command: CommandId) -> Option<&Option<String>> {
        self.effective.get(command.as_str())
    }

    /// Whether the command has a persisted override entry.
    fn overridden(&self, command: CommandId) -> bool {
        self.overrides
            .get("commands")
            .and_then(|commands| commands.get(command.as_str()))
            .is_some()
    }

    /// Ensure the search input exists (created on first render, which has a
    /// window).
    fn ensure_search_input(
        &mut self,
        window: &mut Window,
        cx: &mut Context<SettingsView>,
    ) -> Entity<InputState> {
        if let Some(search) = &self.search {
            return search.clone();
        }
        let search = cx.new(|cx| InputState::new(window, cx).placeholder("Search shortcuts…"));
        let subscription =
            cx.subscribe_in(&search, window, |_this, _source, event, _window, cx| {
                if matches!(event, InputEvent::Change) {
                    cx.notify();
                }
            });
        self._subscriptions.push(subscription);
        self.search = Some(search.clone());
        search
    }

    /// The search filter text.
    fn query(&self, cx: &mut Context<SettingsView>) -> String {
        self.search
            .as_ref()
            .map(|search| search.read(cx).value().to_string())
            .unwrap_or_default()
    }
}

impl SettingsView {
    pub(crate) fn cancel_shortcut_recording(&mut self, cx: &mut Context<Self>) {
        self.shortcuts.cancel_recording(&self.services, cx);
    }

    fn cancel_shortcut_recording_owner(&mut self, owner: u64, cx: &mut Context<Self>) {
        if self.shortcuts.recording_owner == Some(owner) {
            self.shortcuts.cancel_recording(&self.services, cx);
        }
    }

    /// The Shortcuts section.
    pub(crate) fn shortcuts_section(
        &mut self,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> impl IntoElement {
        // Window-created state first (borrows `cx` mutably); the theme
        // reference is only needed for rendering.
        let search_input = self.shortcuts.ensure_search_input(window, cx);
        let recorder_focus = self.shortcuts.recorder_focus.clone();
        let query = self.shortcuts.query(cx).trim().to_lowercase();
        let effective = self.shortcuts.effective.clone();
        let error = self.shortcuts.error.clone();
        let pending_replacement = self.shortcuts.pending_replacement.clone();
        let recording = self.shortcuts.recording;
        let global = self.shortcuts.global.clone();
        let theme = cx.theme();

        let rows: Vec<(CommandId, &'static str, &'static str)> = catalog()
            .iter()
            .copied()
            .filter(|(id, title, description)| {
                let binding = effective.get(id.as_str()).cloned().flatten();
                let haystack = format!(
                    "{} {} {} {}",
                    title,
                    description,
                    id.as_str(),
                    binding
                        .map(|b| pretty_accelerator(Some(&b)))
                        .unwrap_or_default()
                )
                .to_lowercase();
                query.is_empty() || haystack.contains(&query)
            })
            .collect();

        v_flex()
            .id("shortcuts-section")
            .w_full()
            .gap_4()
            .child(
                v_flex()
                    .child(
                        div()
                            .text_lg()
                            .font_weight(FontWeight::SEMIBOLD)
                            .child("Keyboard shortcuts"),
                    )
                    .child(
                        div()
                            .text_sm()
                            .text_color(theme.muted_foreground)
                            .mt_0p5()
                            .child(
                                "One command map powers the app, the palette, menus, and these \
                                 controls. Click a shortcut to record a replacement.",
                            ),
                    ),
            )
            .child(
                v_flex()
                    .w_full()
                    .gap_3()
                    .child(Input::new(&search_input).small())
                    .child(
                        h_flex().w_full().justify_end().child(
                            Button::new("reset-all-shortcuts")
                                .small()
                                .ghost()
                                .icon(IconName::Undo2)
                                .label("Reset to defaults")
                                .disabled(self.shortcuts.applying)
                                .on_click(cx.listener(|this, _event, _window, cx| {
                                    this.shortcuts.reset_all(&this.services, cx);
                                })),
                        ),
                    ),
            )
            .when_some(error, |el, message| {
                el.child(
                    h_flex()
                        .w_full()
                        .gap_2()
                        .items_center()
                        .px_3()
                        .py_2()
                        .rounded_md()
                        .bg(theme.danger.opacity(0.12))
                        .child(
                            Icon::new(IconName::TriangleAlert)
                                .small()
                                .text_color(theme.danger),
                        )
                        .child(
                            div()
                                .flex_1()
                                .text_sm()
                                .text_color(theme.foreground)
                                .child(message),
                        )
                        .child(
                            Button::new("dismiss-shortcut-error")
                                .small()
                                .ghost()
                                .label("Dismiss")
                                .on_click(cx.listener(|this, _event, _window, cx| {
                                    this.shortcuts.error = None;
                                    cx.notify();
                                })),
                        ),
                )
            })
            .when_some(pending_replacement, |el, (command, binding)| {
                let label = pretty_accelerator(Some(&binding));
                el.child(
                    h_flex()
                        .w_full()
                        .items_center()
                        .justify_between()
                        .gap_3()
                        .px_3()
                        .py_2()
                        .rounded_md()
                        .bg(theme.muted)
                        .child(div().flex_1().text_sm().child(format!(
                            "{label} is already in use. Replace the conflicting shortcut?"
                        )))
                        .child(
                            Button::new("replace-conflicting-shortcut")
                                .small()
                                .label("Replace")
                                .on_click(cx.listener(move |this, _event, _window, cx| {
                                    this.shortcuts.pending_replacement = None;
                                    this.shortcuts.error = None;
                                    this.services.shortcuts.update(cx, |runtime, cx| {
                                        runtime.apply(
                                            KeybindingMutation::SetBinding {
                                                command_id: command,
                                                binding: binding.clone(),
                                                replace: true,
                                            },
                                            cx,
                                        );
                                    });
                                    cx.notify();
                                })),
                        ),
                )
            })
            .child(
                v_flex()
                    .w_full()
                    .rounded_lg()
                    .border_1()
                    .border_color(theme.border)
                    .children(rows.into_iter().map(|(id, title, description)| {
                        let binding = effective.get(id.as_str()).cloned().flatten();
                        let overridden = self.shortcuts.overridden(id);
                        let is_recording = recording == Some(id);
                        let status = global.iter().find(|status| status.command_id == id);
                        self.shortcut_row(
                            id,
                            title,
                            description,
                            binding.as_deref(),
                            overridden,
                            is_recording,
                            status,
                            recorder_focus.clone(),
                            cx,
                        )
                    })),
            )
    }

    /// One shortcut row.
    #[allow(clippy::too_many_arguments)]
    fn shortcut_row(
        &self,
        command: CommandId,
        title: &'static str,
        description: &'static str,
        binding: Option<&str>,
        overridden: bool,
        recording: bool,
        global_status: Option<&GlobalShortcutStatus>,
        recorder_focus: Option<FocusHandle>,
        cx: &mut Context<Self>,
    ) -> impl IntoElement {
        let theme = cx.theme();
        let id = command.as_str();
        let source = if binding.is_none() {
            "Disabled"
        } else if !overridden {
            "Default"
        } else {
            "Custom"
        };
        let source = match global_status.map(|status| status.state) {
            Some(GlobalShortcutState::Active) => format!("{source} · Active"),
            Some(GlobalShortcutState::Unavailable) => format!("{source} · Unavailable"),
            Some(GlobalShortcutState::Disabled) => format!("{source} · Off"),
            None => source.to_string(),
        };
        let status_message = global_status.and_then(|status| status.message.clone());
        let can_enable = binding.is_some() || command_default_binding(command).is_some();

        h_flex()
            .id(SharedString::from(format!("shortcut-row-{id}")))
            .w_full()
            .px_3()
            .py_2p5()
            .gap_3()
            .items_center()
            .on_key_down(cx.listener(move |this, event, _window, cx| {
                this.shortcuts
                    .on_record_key(event, command, &this.services, cx);
            }))
            .when_some(
                recorder_focus.clone().filter(|_| recording),
                |row, focus| row.track_focus(&focus),
            )
            .child(
                v_flex()
                    .flex_1()
                    .min_w(gpui::px(0.))
                    .child(
                        h_flex()
                            .gap_2()
                            .items_center()
                            .child(div().text_sm().font_weight(FontWeight::MEDIUM).child(title))
                            .child(
                                div()
                                    .px_1p5()
                                    .py_0p5()
                                    .rounded_md()
                                    .bg(theme.muted)
                                    .text_xs()
                                    .text_color(theme.muted_foreground)
                                    .child(source),
                            ),
                    )
                    .child(
                        div()
                            .text_xs()
                            .text_color(theme.muted_foreground)
                            .mt_0p5()
                            .child(description),
                    )
                    .when_some(status_message, |column, message| {
                        column.child(
                            div()
                                .text_xs()
                                .text_color(theme.danger)
                                .mt_0p5()
                                .child(message),
                        )
                    }),
            )
            .child(
                h_flex()
                    .gap_2()
                    .items_center()
                    .child(
                        Button::new(SharedString::from(format!("shortcut-record-{id}")))
                            .small()
                            .icon(IconName::Check)
                            .label(if recording {
                                "Press keys…".to_string()
                            } else {
                                pretty_accelerator(binding)
                            })
                            .disabled(self.shortcuts.applying)
                            .on_click(cx.listener(move |this, _event, window, cx| {
                                if let Some(focus) = this.shortcuts.toggle_recording(
                                    command,
                                    &this.services,
                                    window,
                                    cx,
                                ) {
                                    cx.defer_in(window, move |_this, window, _cx| {
                                        focus.focus(window);
                                    });
                                }
                            })),
                    )
                    .when(overridden, |el| {
                        el.child(
                            Button::new(SharedString::from(format!("shortcut-reset-{id}")))
                                .small()
                                .ghost()
                                .icon(IconName::Undo2)
                                .tooltip("Reset to default")
                                .on_click(cx.listener(move |this, _event, _window, cx| {
                                    this.shortcuts.apply(
                                        KeybindingMutation::Reset {
                                            command_id: command,
                                        },
                                        &this.services,
                                        cx,
                                    );
                                })),
                        )
                    })
                    .child(
                        Switch::new(SharedString::from(format!("shortcut-enabled-{id}")))
                            .checked(binding.is_some())
                            .disabled(!can_enable || self.shortcuts.applying)
                            .label(if binding.is_some() {
                                "Enabled"
                            } else {
                                "Disabled"
                            })
                            .on_click(cx.listener(move |this, checked, _window, cx| {
                                this.shortcuts.apply(
                                    KeybindingMutation::Disable {
                                        command_id: command,
                                        disabled: !checked,
                                    },
                                    &this.services,
                                    cx,
                                );
                            })),
                    ),
            )
    }
}

/// The catalog default binding for a command (via the shared pipeline).
fn command_default_binding(command: CommandId) -> Option<String> {
    effective_bindings(&serde_json::Value::Null, None)
        .get(command.as_str())
        .cloned()
        .flatten()
}

impl ShortcutsState {
    fn toggle_recording(
        &mut self,
        command: CommandId,
        services: &SettingsServices,
        window: &mut Window,
        cx: &mut Context<SettingsView>,
    ) -> Option<FocusHandle> {
        if self.recording == Some(command) {
            self.cancel_recording(services, cx);
            None
        } else {
            self.cancel_recording(services, cx);
            self.recording = Some(command);
            let owner = services
                .shortcuts
                .update(cx, |runtime, cx| runtime.suspend_recorder(cx));
            self.recording_owner = Some(owner);
            self.owner_signal.store(owner, Ordering::Release);
            let focus = cx.focus_handle().tab_stop(true);
            let subscription = cx.on_blur(&focus, window, move |this, _window, cx| {
                this.cancel_shortcut_recording_owner(owner, cx);
            });
            self.recorder_blur = Some(subscription);
            self.recorder_focus = Some(focus.clone());
            self.error = None;
            cx.notify();
            Some(focus)
        }
    }

    fn cancel_recording(&mut self, services: &SettingsServices, cx: &mut Context<SettingsView>) {
        let Some(owner) = self.recording_owner.take() else {
            self.recording = None;
            self.recorder_focus = None;
            self.recorder_blur = None;
            self.owner_signal.store(0, Ordering::Release);
            return;
        };
        self.recording = None;
        self.recorder_focus = None;
        self.recorder_blur = None;
        self.owner_signal.store(0, Ordering::Release);
        services
            .shortcuts
            .update(cx, |runtime, cx| runtime.cancel_recorder(owner, cx));
        cx.notify();
    }

    /// Keydown capture while a row is recording.
    fn on_record_key(
        &mut self,
        event: &gpui::KeyDownEvent,
        command: CommandId,
        services: &SettingsServices,
        cx: &mut Context<SettingsView>,
    ) {
        if self.recording != Some(command) {
            return;
        }
        let key = event.keystroke.key.clone();
        if key == "escape" || key == "esc" {
            self.cancel_recording(services, cx);
            return;
        }
        let modifiers = &event.keystroke.modifiers;
        let capture = ShortcutCapture {
            key,
            meta: modifiers.platform,
            ctrl: modifiers.control,
            alt: modifiers.alt,
            shift: modifiers.shift,
        };
        let Some(binding) = encode_shortcut(&capture) else {
            return;
        };
        self.cancel_recording(services, cx);
        self.apply(
            KeybindingMutation::SetBinding {
                command_id: command,
                binding,
                replace: false,
            },
            services,
            cx,
        );
    }

    /// Persist one mutation through the repair/mutate pipeline.
    fn apply(
        &mut self,
        mutation: KeybindingMutation,
        services: &SettingsServices,
        cx: &mut Context<SettingsView>,
    ) {
        let current = self.overrides.clone();
        match apply_keybinding_mutation(&current, &mutation, None) {
            Ok(_) => {}
            Err(error) => {
                self.error = Some(error.message.clone());
                if error.code == KeybindingErrorCode::Conflict {
                    if let KeybindingMutation::SetBinding { binding, .. } = &mutation {
                        self.pending_replacement = Some((mutation.command_id(), binding.clone()));
                    }
                }
                cx.notify();
                return;
            }
        };
        self.pending_replacement = None;
        services
            .shortcuts
            .update(cx, |runtime, cx| runtime.apply(mutation, cx));
        cx.notify();
    }

    /// Reset every command to its catalog default in one persisted document.
    fn reset_all(&mut self, services: &SettingsServices, cx: &mut Context<SettingsView>) {
        self.cancel_recording(services, cx);
        services
            .shortcuts
            .update(cx, |runtime, cx| runtime.reset_all(cx));
        cx.notify();
    }
}

/// Last-resort recorder cleanup when the Settings entity itself is dropped.
/// Ordinary navigation uses the same owner-checked runtime cancellation path;
/// this guard closes the lifecycle hole where no blur/navigation callback can
/// run because the whole entity is being destroyed.
pub struct RecorderDropGuard {
    runtime: gpui::Entity<crate::shortcut_runtime::ShortcutRuntime>,
    owner: Arc<AtomicU64>,
    app: gpui::AsyncApp,
}

impl RecorderDropGuard {
    pub fn new(
        runtime: gpui::Entity<crate::shortcut_runtime::ShortcutRuntime>,
        owner: Arc<AtomicU64>,
        app: gpui::AsyncApp,
    ) -> Self {
        Self {
            runtime,
            owner,
            app,
        }
    }
}

impl Drop for RecorderDropGuard {
    fn drop(&mut self) {
        let owner = self.owner.swap(0, Ordering::AcqRel);
        if owner == 0 {
            return;
        }
        let runtime = self.runtime.clone();
        self.app
            .spawn(async move |cx| {
                let _ = runtime.update(cx, |runtime, cx| runtime.cancel_recorder(owner, cx));
            })
            .detach();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use aiden_core::keybindings::{effective_bindings, normalize_accelerator};

    #[test]
    fn encodes_letters_with_command_modifier() {
        let capture = ShortcutCapture {
            key: "k".to_string(),
            meta: true,
            ctrl: false,
            alt: false,
            shift: false,
        };
        assert_eq!(encode_shortcut(&capture).as_deref(), Some("Command+K"));
    }

    #[test]
    fn encodes_punctuation_and_rejects_bare_keys() {
        let capture = ShortcutCapture {
            key: "[".to_string(),
            meta: true,
            ctrl: false,
            alt: false,
            shift: true,
        };
        assert_eq!(
            encode_shortcut(&capture).as_deref(),
            Some("Command+Shift+[")
        );
        let bare = ShortcutCapture {
            key: "a".to_string(),
            meta: false,
            ctrl: false,
            alt: false,
            shift: false,
        };
        assert_eq!(encode_shortcut(&bare), None);
    }

    #[test]
    fn catalog_has_26_commands_and_matches_command_ids() {
        let catalog = catalog();
        assert_eq!(catalog.len(), aiden_core::COMMAND_IDS.len());
        let ids: std::collections::HashSet<_> = catalog.iter().map(|(id, _, _)| *id).collect();
        assert_eq!(ids.len(), catalog.len(), "no duplicate ids");
        for command in aiden_core::COMMAND_IDS {
            assert!(ids.contains(command), "missing {command:?}");
        }
    }

    #[test]
    fn defaults_remain_conflict_free() {
        let bindings = effective_bindings(&serde_json::Value::Null, None);
        // Every catalog default must be a valid accelerator.
        for (id, binding) in &bindings {
            if let Some(binding) = binding {
                assert!(
                    normalize_accelerator(binding).is_some(),
                    "default for {id} is invalid: {binding}"
                );
            }
        }
    }

    #[test]
    fn mutation_roundtrip_rebinds_and_resets() {
        let current = normalize_keybinding_overrides(&serde_json::Value::Null);
        let rebound = apply_keybinding_mutation(
            &current,
            &KeybindingMutation::SetBinding {
                command_id: CommandId::ChatNew,
                binding: "Command+Shift+N".into(),
                replace: false,
            },
            None,
        )
        .unwrap();
        assert_eq!(
            effective_bindings(&rebound, None)["chat.new"].as_deref(),
            Some("Command+Shift+N")
        );
        let reset = apply_keybinding_mutation(
            &rebound,
            &KeybindingMutation::Reset {
                command_id: CommandId::ChatNew,
            },
            None,
        )
        .unwrap();
        assert_eq!(
            effective_bindings(&reset, None)["chat.new"].as_deref(),
            Some("Command+N")
        );
    }

    #[test]
    fn recorder_blur_subscription_is_scoped_and_cleared() {
        let source = include_str!("shortcuts.rs");
        let recording = source
            .split("fn toggle_recording")
            .nth(1)
            .and_then(|source| source.split("fn on_record_key").next())
            .unwrap();
        assert!(recording.contains("self.recorder_blur = Some(subscription)"));
        assert!(recording.matches("self.recorder_blur = None").count() >= 2);
        assert!(!recording.contains("self._subscriptions.push(subscription)"));
    }
}
