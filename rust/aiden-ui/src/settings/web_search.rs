//! Web search settings (port of `web-search-settings.tsx`).
//!
//! The Exa API key lives in the same keychain-backed provider-keys store as
//! the provider credentials (`provider-keys.json` + macOS Keychain, account
//! `exa`), and the enable flag lives in `settings.json` under `exaEnabled`.
//! Enabling web search adds the `web_search` tool to the assistant.
//!
//! All keychain/config I/O runs on the background executor. The "Test key"
//! action verifies the *stored* key locally (presence + decryptability) — it
//! never contacts Exa; search requests happen only when the assistant uses the
//! tool.

use gpui::{
    div, prelude::FluentBuilder as _, AppContext as _, Context, Entity, FontWeight,
    InteractiveElement as _, IntoElement, ParentElement as _, Styled as _, Window,
};
use gpui_component::{
    button::{Button, ButtonVariants as _},
    h_flex,
    input::{Input, InputEvent, InputState},
    switch::Switch,
    v_flex, ActiveTheme, Disableable as _, IconName, Sizable as _,
};

use super::{SettingsServices, SettingsView};

/// The settings key holding the enable flag.
pub const EXA_ENABLED_KEY: &str = "exaEnabled";
/// The keychain account under which the Exa key is stored.
pub const EXA_KEYCHAIN_ID: &str = "exa";

/// Read the persisted enable flag from the settings map.
pub fn exa_enabled_from_settings(settings: &serde_json::Map<String, serde_json::Value>) -> bool {
    settings
        .get(EXA_ENABLED_KEY)
        .and_then(|value| value.as_bool())
        .unwrap_or(false)
}

/// Return whether an asynchronous completion still belongs to the current
/// settings lifecycle. Settings can be rehydrated while a keychain/config
/// operation is in flight, so the operation revision alone is not sufficient.
fn operation_is_current(
    current_operation_revision: u64,
    expected_operation_revision: u64,
    current_lifecycle_revision: u64,
    expected_lifecycle_revision: u64,
) -> bool {
    current_operation_revision == expected_operation_revision
        && current_lifecycle_revision == expected_lifecycle_revision
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct WebSearchFence {
    operation_revision: u64,
    lifecycle_revision: u64,
    busy_revision: u64,
    editor_revision: u64,
    editor_id: Option<u64>,
}

/// Return whether a key-save completion still belongs to the exact editor
/// that submitted it. A reopened editor gets a new entity id and revision.
fn key_editor_operation_is_current(current: WebSearchFence, expected: WebSearchFence) -> bool {
    operation_is_current(
        current.operation_revision,
        expected.operation_revision,
        current.lifecycle_revision,
        expected.lifecycle_revision,
    ) && current.busy_revision == expected.busy_revision
        && current.editor_revision == expected.editor_revision
        && current.editor_id == expected.editor_id
}

/// Keep an optimistic toggle truthful when the durable write fails.
fn enabled_after_write(previous: bool, requested: bool, persisted: bool) -> bool {
    if persisted {
        requested
    } else {
        previous
    }
}

#[derive(Default)]
pub struct WebSearchState {
    pub enabled: bool,
    /// Whether a key is stored in the keychain (None = still checking).
    pub has_key: Option<bool>,
    /// A short result line for the test/remove actions.
    pub notice: Option<String>,
    pub busy: bool,
    /// The key editor (opened by the user).
    pub key_editor: Option<Entity<InputState>>,
    /// Monotonic settings-write revision. Completions from an older toggle
    /// must never publish over a newer settings snapshot.
    settings_revision: u64,
    /// Monotonic keychain/load revision. This invalidates an older keychain
    /// probe as soon as a save/remove or a newer probe begins.
    key_revision: u64,
    /// Monotonic editor lifecycle revision. Opening or completing an editor
    /// creates a new identity so late callbacks cannot clear a reopened draft.
    editor_revision: u64,
    /// Identifies the one foreground key/config operation allowed at a time.
    /// Lifecycle rehydration invalidates publication but never permits a second
    /// write to overlap the first one.
    busy_revision: u64,
    /// Bumped when settings are rehydrated, fencing callbacks started against
    /// an older section/navigation lifecycle.
    lifecycle_revision: u64,
    _subscriptions: Vec<gpui::Subscription>,
}

impl WebSearchState {
    pub fn hydrate(&mut self, settings: &serde_json::Map<String, serde_json::Value>) {
        self.lifecycle_revision = self.lifecycle_revision.wrapping_add(1);
        self.busy_revision = self.busy_revision.wrapping_add(1);
        self.busy = false;
        self.enabled = exa_enabled_from_settings(settings);
    }

    /// Invalidate work owned by a section that is no longer visible. The
    /// background operation may still finish, but it must not publish into a
    /// later visit or clear a newly opened key editor.
    pub(crate) fn leave_section(&mut self) {
        self.lifecycle_revision = self.lifecycle_revision.wrapping_add(1);
        self.key_revision = self.key_revision.wrapping_add(1);
        self.settings_revision = self.settings_revision.wrapping_add(1);
        self.busy_revision = self.busy_revision.wrapping_add(1);
        self.editor_revision = self.editor_revision.wrapping_add(1);
        self.busy = false;
        self.key_editor = None;
        self.notice = None;
    }

    /// Read the keychain presence on the background executor.
    pub(crate) fn load_key_state(
        &mut self,
        services: &SettingsServices,
        cx: &mut Context<SettingsView>,
    ) {
        if self.busy {
            return;
        }
        self.key_revision = self.key_revision.wrapping_add(1);
        let key_revision = self.key_revision;
        let lifecycle_revision = self.lifecycle_revision;
        self.has_key = None;
        let services = services.clone();
        cx.spawn(async move |this, cx| {
            let has_key = cx
                .background_spawn(async move { services.keys.has_key(EXA_KEYCHAIN_ID).ok() })
                .await;
            this.update(cx, |this, cx| {
                if this.web_search.key_revision != key_revision
                    || this.web_search.lifecycle_revision != lifecycle_revision
                {
                    return;
                }
                this.web_search.has_key = has_key;
                cx.notify();
            })
            .ok();
        })
        .detach();
    }

    /// Open the key editor input.
    fn open_key_editor(&mut self, window: &mut Window, cx: &mut Context<SettingsView>) {
        let editor = cx.new(|cx| {
            InputState::new(window, cx)
                .placeholder("Paste your Exa API key")
                .masked(true)
        });
        let subscription =
            cx.subscribe_in(&editor, window, |_this, _source, event, _window, cx| {
                if matches!(event, InputEvent::Change) {
                    cx.notify();
                }
            });
        self._subscriptions.push(subscription);
        self.editor_revision = self.editor_revision.wrapping_add(1);
        self.key_editor = Some(editor);
        self.notice = None;
        cx.notify();
    }

    /// Save (or clear, when empty) the Exa key. Removing the key also
    /// disables web search (TS parity).
    fn save_key(&mut self, services: &SettingsServices, cx: &mut Context<SettingsView>) {
        if self.busy {
            return;
        }
        let Some(editor) = self.key_editor.as_ref() else {
            return;
        };
        let value = editor.read(cx).value().trim().to_string();
        let editor_id = editor.entity_id().as_u64();
        let editor_revision = self.editor_revision;
        let lifecycle_revision = self.lifecycle_revision;
        self.key_revision = self.key_revision.wrapping_add(1);
        let key_revision = self.key_revision;
        self.busy_revision = self.busy_revision.wrapping_add(1);
        let busy_revision = self.busy_revision;
        self.busy = true;
        let services = services.clone();
        cx.spawn(async move |this, cx| {
            let result = cx
                .background_spawn(async move {
                    let has_key = if value.is_empty() {
                        services.keys.delete(EXA_KEYCHAIN_ID).map(|_| false)
                    } else {
                        services.keys.set(EXA_KEYCHAIN_ID, &value).map(|_| true)
                    }
                    .map_err(|_| ())?;
                    let disabled_persisted = if !has_key {
                        let mut patch = serde_json::Map::new();
                        patch.insert(EXA_ENABLED_KEY.to_string(), serde_json::json!(false));
                        services.config.set_settings(&patch, &|| true).is_ok()
                    } else {
                        true
                    };
                    Ok::<_, ()>((has_key, disabled_persisted))
                })
                .await;
            this.update(cx, |this, cx| {
                if !key_editor_operation_is_current(
                    WebSearchFence {
                        operation_revision: this.web_search.key_revision,
                        lifecycle_revision: this.web_search.lifecycle_revision,
                        busy_revision: this.web_search.busy_revision,
                        editor_revision: this.web_search.editor_revision,
                        editor_id: this
                            .web_search
                            .key_editor
                            .as_ref()
                            .map(|editor| editor.entity_id().as_u64()),
                    },
                    WebSearchFence {
                        operation_revision: key_revision,
                        lifecycle_revision,
                        busy_revision,
                        editor_revision,
                        editor_id: Some(editor_id),
                    },
                ) {
                    if this.web_search.busy_revision == busy_revision {
                        this.web_search.busy = false;
                    }
                    return;
                }
                this.web_search.busy = false;
                match result {
                    Ok((has_key, disabled_persisted)) => {
                        this.web_search.key_editor = None;
                        this.web_search.editor_revision =
                            this.web_search.editor_revision.wrapping_add(1);
                        this.web_search.has_key = Some(has_key);
                        if !has_key {
                            this.web_search.enabled = false;
                        }
                        this.web_search.notice = Some(if has_key {
                            "Exa API key saved.".to_string()
                        } else if !disabled_persisted {
                            "Exa API key removed, but web search could not be disabled durably; retry the settings change.".to_string()
                        } else {
                            "Exa API key removed; web search is disabled.".to_string()
                        });
                    }
                    Err(_) => {
                        this.web_search.notice = Some(
                            "The Exa API key could not be written to the keychain.".to_string(),
                        );
                    }
                }
                cx.notify();
            })
            .ok();
        })
        .detach();
        cx.notify();
    }

    /// Verify the stored key locally (presence + decryptability; no network).
    fn test_key(&mut self, services: &SettingsServices, cx: &mut Context<SettingsView>) {
        if self.busy {
            return;
        }
        self.busy = true;
        self.key_revision = self.key_revision.wrapping_add(1);
        let key_revision = self.key_revision;
        let lifecycle_revision = self.lifecycle_revision;
        self.busy_revision = self.busy_revision.wrapping_add(1);
        let busy_revision = self.busy_revision;
        self.notice = None;
        let services = services.clone();
        cx.spawn(async move |this, cx| {
            let result = cx
                .background_spawn(async move {
                    services.keys.get(EXA_KEYCHAIN_ID).map(|key| key.is_some())
                })
                .await;
            this.update(cx, |this, cx| {
                if !operation_is_current(
                    this.web_search.key_revision,
                    key_revision,
                    this.web_search.lifecycle_revision,
                    lifecycle_revision,
                ) {
                    if this.web_search.busy_revision == busy_revision {
                        this.web_search.busy = false;
                    }
                    return;
                }
                this.web_search.busy = false;
                this.web_search.notice = Some(match result {
                    Ok(true) => {
                        "Key is saved on this Mac and ready to use. Search requests go to Exa \
                         only when the assistant uses the tool."
                            .to_string()
                    }
                    Ok(false) => "No Exa API key is stored yet.".to_string(),
                    Err(_) => "The stored Exa API key could not be read (legacy blob or keychain \
                         error); re-enter it to rotate."
                        .to_string(),
                });
                cx.notify();
            })
            .ok();
        })
        .detach();
    }

    /// Persist the enable flag.
    fn set_enabled(
        &mut self,
        enabled: bool,
        services: &SettingsServices,
        cx: &mut Context<SettingsView>,
    ) {
        if self.busy {
            return;
        }
        let previous_enabled = self.enabled;
        self.settings_revision = self.settings_revision.wrapping_add(1);
        let settings_revision = self.settings_revision;
        let lifecycle_revision = self.lifecycle_revision;
        self.busy_revision = self.busy_revision.wrapping_add(1);
        let busy_revision = self.busy_revision;
        self.busy = true;
        self.enabled = enabled;
        self.notice = None;
        let services = services.clone();
        cx.spawn(async move |this, cx| {
            let result = cx
                .background_spawn(async move {
                    let mut patch = serde_json::Map::new();
                    patch.insert(EXA_ENABLED_KEY.to_string(), serde_json::json!(enabled));
                    services.config.set_settings(&patch, &|| true).is_ok()
                })
                .await;
            this.update(cx, |this, cx| {
                if !operation_is_current(
                    this.web_search.settings_revision,
                    settings_revision,
                    this.web_search.lifecycle_revision,
                    lifecycle_revision,
                ) {
                    if this.web_search.busy_revision == busy_revision {
                        this.web_search.busy = false;
                    }
                    return;
                }
                this.web_search.busy = false;
                this.web_search.enabled = enabled_after_write(previous_enabled, enabled, result);
                if !result && this.active == super::SettingsSection::WebSearch {
                    this.web_search.notice =
                        Some("Web search settings could not be saved.".to_string());
                }
                cx.notify();
            })
            .ok();
        })
        .detach();
        cx.notify();
    }
}

impl SettingsView {
    /// The Web search section: enable toggle + Exa key.
    pub(crate) fn web_search_section(
        &self,
        _window: &mut Window,
        cx: &mut Context<Self>,
    ) -> impl IntoElement {
        let theme = cx.theme();
        let state = &self.web_search;
        let has_key = state.has_key.unwrap_or(false);
        let checking = state.has_key.is_none();
        v_flex()
            .id("web-search-section")
            .w_full()
            .gap_4()
            .child(
                v_flex()
                    .child(
                        div()
                            .text_lg()
                            .font_weight(FontWeight::SEMIBOLD)
                            .child("Web search"),
                    )
                    .child(
                        div()
                            .text_sm()
                            .text_color(theme.muted_foreground)
                            .mt_0p5()
                            .child(
                                "When enabled, the assistant gets a web_search tool backed by \
                                 Exa. Search queries are sent to Exa only when the assistant \
                                 uses it.",
                            ),
                    ),
            )
            .child(
                v_flex()
                    .w_full()
                    .gap_3()
                    .rounded_lg()
                    .border_1()
                    .border_color(theme.border)
                    .px_4()
                    .py_3()
                    .child(
                        h_flex()
                            .w_full()
                            .items_center()
                            .justify_between()
                            .child(
                                v_flex()
                                    .gap_0p5()
                                    .child(
                                        div()
                                            .text_sm()
                                            .font_weight(FontWeight::SEMIBOLD)
                                            .child("Enable web search"),
                                    )
                                    .child(
                                        div().text_xs().text_color(theme.muted_foreground).child(
                                            if checking {
                                                "Checking the saved key…".to_string()
                                            } else if has_key {
                                                "Adds an Exa search tool. Search queries are \
                                                 sent to Exa when the assistant uses it."
                                                    .to_string()
                                            } else {
                                                "Add an Exa API key below before enabling search."
                                                    .to_string()
                                            },
                                        ),
                                    ),
                            )
                            .child(
                                Switch::new("web-search-enabled")
                                    .checked(state.enabled)
                                    .label(if state.enabled { "On" } else { "Off" })
                                    .disabled(checking || !has_key || state.busy)
                                    .on_click(cx.listener(|this, checked, _window, cx| {
                                        this.web_search.set_enabled(*checked, &this.services, cx);
                                    })),
                            ),
                    )
                    .child(
                        h_flex()
                            .w_full()
                            .items_center()
                            .justify_between()
                            .child(
                                v_flex()
                                    .gap_0p5()
                                    .child(
                                        div()
                                            .text_sm()
                                            .font_weight(FontWeight::SEMIBOLD)
                                            .child("Exa API key"),
                                    )
                                    .child(
                                        div().text_xs().text_color(theme.muted_foreground).child(
                                            if checking {
                                                "Checking the keychain…".to_string()
                                            } else if has_key {
                                                "A key is saved. Enter a new value to replace it."
                                                    .to_string()
                                            } else {
                                                "Get a key at exa.ai. Stored encrypted on this \
                                                 device."
                                                    .to_string()
                                            },
                                        ),
                                    ),
                            )
                            .child(
                                h_flex()
                                    .gap_2()
                                    .child(
                                        Button::new("web-search-test-key")
                                            .small()
                                            .ghost()
                                            .icon(IconName::CircleCheck)
                                            .label("Test key")
                                            .disabled(checking || !has_key || state.busy)
                                            .on_click(cx.listener(|this, _event, _window, cx| {
                                                this.web_search.test_key(&this.services, cx);
                                            })),
                                    )
                                    .child(
                                        Button::new("web-search-edit-key")
                                            .small()
                                            .icon(IconName::Settings2)
                                            .label(if has_key { "Replace" } else { "Enter key" })
                                            .disabled(checking || state.busy)
                                            .on_click(cx.listener(|this, _event, window, cx| {
                                                this.web_search.open_key_editor(window, cx);
                                            })),
                                    ),
                            ),
                    )
                    .when_some(state.key_editor.as_ref(), |el, editor| {
                        el.child(
                            h_flex()
                                .w_full()
                                .gap_2()
                                .child(Input::new(editor).small())
                                .child(
                                    Button::new("web-search-save-key")
                                        .small()
                                        .primary()
                                        .label("Save")
                                        .disabled(state.busy)
                                        .on_click(cx.listener(|this, _event, _window, cx| {
                                            this.web_search.save_key(&this.services, cx);
                                        })),
                                ),
                        )
                    })
                    .when_some(state.notice.clone(), |el, notice| {
                        el.child(
                            div()
                                .w_full()
                                .text_xs()
                                .text_color(theme.muted_foreground)
                                .child(notice),
                        )
                    }),
            )
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn exa_enabled_reads_the_flat_flag() {
        let mut settings = serde_json::Map::new();
        assert!(!exa_enabled_from_settings(&settings));
        settings.insert(EXA_ENABLED_KEY.to_string(), serde_json::json!(true));
        assert!(exa_enabled_from_settings(&settings));
        settings.insert(EXA_ENABLED_KEY.to_string(), serde_json::json!("yes"));
        assert!(!exa_enabled_from_settings(&settings));
    }

    #[test]
    fn stale_completion_is_rejected_after_a_newer_operation_or_hydration() {
        assert!(operation_is_current(4, 4, 9, 9));
        assert!(!operation_is_current(5, 4, 9, 9));
        assert!(!operation_is_current(4, 4, 10, 9));
    }

    #[test]
    fn key_save_completion_requires_the_same_editor_instance() {
        let current = WebSearchFence {
            operation_revision: 7,
            lifecycle_revision: 2,
            busy_revision: 5,
            editor_revision: 3,
            editor_id: Some(41),
        };
        assert!(key_editor_operation_is_current(current, current));
        assert!(!key_editor_operation_is_current(
            WebSearchFence {
                editor_revision: 4,
                ..current
            },
            current,
        ));
        assert!(!key_editor_operation_is_current(
            WebSearchFence {
                editor_id: Some(42),
                ..current
            },
            current,
        ));
        assert!(!key_editor_operation_is_current(
            WebSearchFence {
                editor_id: None,
                ..current
            },
            current,
        ));
    }

    #[test]
    fn failed_enable_write_restores_the_previous_persisted_state() {
        assert!(enabled_after_write(true, false, false));
        assert!(!enabled_after_write(false, true, false));
        assert!(enabled_after_write(false, true, true));
        assert!(!enabled_after_write(true, false, true));
    }

    #[test]
    fn hydration_invalidates_busy_state_and_fails_closed() {
        let mut state = WebSearchState {
            enabled: true,
            busy: true,
            ..WebSearchState::default()
        };
        let lifecycle_before = state.lifecycle_revision;
        state.hydrate(&serde_json::Map::new());
        assert!(!state.enabled);
        assert!(!state.busy);
        assert!(state.lifecycle_revision > lifecycle_before);
    }

    #[test]
    fn leaving_the_section_invalidates_editor_and_in_flight_work() {
        let mut state = WebSearchState {
            busy: true,
            notice: Some("stale".into()),
            key_editor: None,
            ..WebSearchState::default()
        };
        let before = (
            state.lifecycle_revision,
            state.key_revision,
            state.settings_revision,
            state.busy_revision,
            state.editor_revision,
        );
        state.leave_section();
        assert!(!state.busy);
        assert!(state.notice.is_none());
        assert_eq!(state.key_editor, None);
        assert!(state.lifecycle_revision > before.0);
        assert!(state.key_revision > before.1);
        assert!(state.settings_revision > before.2);
        assert!(state.busy_revision > before.3);
        assert!(state.editor_revision > before.4);
    }
}
