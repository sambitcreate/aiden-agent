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

use super::SettingsView;

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
    _subscriptions: Vec<gpui::Subscription>,
}

impl WebSearchState {
    pub fn hydrate(&mut self, settings: &serde_json::Map<String, serde_json::Value>) {
        self.enabled = exa_enabled_from_settings(settings);
    }

    fn services(&self, cx: &mut Context<SettingsView>) -> super::SettingsServices {
        cx.entity().read(cx).services.clone()
    }

    /// Read the keychain presence on the background executor.
    pub(crate) fn load_key_state(&mut self, cx: &mut Context<SettingsView>) {
        let services = self.services(cx);
        cx.spawn(async move |this, cx| {
            let has_key = cx
                .background_spawn(async move { services.keys.has_key(EXA_KEYCHAIN_ID).ok() })
                .await;
            this.update(cx, |this, cx| {
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
        self.key_editor = Some(editor);
        self.notice = None;
        cx.notify();
    }

    /// Save (or clear, when empty) the Exa key. Removing the key also
    /// disables web search (TS parity).
    fn save_key(&mut self, cx: &mut Context<SettingsView>) {
        if self.busy {
            return;
        }
        let Some(editor) = self.key_editor.as_ref() else {
            return;
        };
        let value = editor.read(cx).value().trim().to_string();
        self.busy = true;
        let services = self.services(cx);
        cx.spawn(async move |this, cx| {
            let result = cx
                .background_spawn(async move {
                    let wrote = if value.is_empty() {
                        services.keys.delete(EXA_KEYCHAIN_ID).map(|_| false)
                    } else {
                        services.keys.set(EXA_KEYCHAIN_ID, &value).map(|_| true)
                    };
                    if wrote.as_ref().is_ok_and(|has_key| !*has_key) {
                        let mut patch = serde_json::Map::new();
                        patch.insert(EXA_ENABLED_KEY.to_string(), serde_json::json!(false));
                        let _ = services.config.set_settings(&patch, &|| true);
                    }
                    wrote
                })
                .await;
            this.update(cx, |this, cx| {
                this.web_search.busy = false;
                this.web_search.key_editor = None;
                match result {
                    Ok(has_key) => {
                        this.web_search.has_key = Some(has_key);
                        if !has_key {
                            this.web_search.enabled = false;
                        }
                        this.web_search.notice = Some(if has_key {
                            "Exa API key saved.".to_string()
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
    fn test_key(&mut self, cx: &mut Context<SettingsView>) {
        if self.busy {
            return;
        }
        self.busy = true;
        self.notice = None;
        let services = self.services(cx);
        cx.spawn(async move |this, cx| {
            let result = cx
                .background_spawn(async move {
                    services.keys.get(EXA_KEYCHAIN_ID).map(|key| key.is_some())
                })
                .await;
            this.update(cx, |this, cx| {
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
    fn set_enabled(&mut self, enabled: bool, cx: &mut Context<SettingsView>) {
        if self.busy {
            return;
        }
        self.enabled = enabled;
        let services = self.services(cx);
        cx.spawn(async move |this, cx| {
            let result = cx
                .background_spawn(async move {
                    let mut patch = serde_json::Map::new();
                    patch.insert(EXA_ENABLED_KEY.to_string(), serde_json::json!(enabled));
                    services.config.set_settings(&patch, &|| true).is_ok()
                })
                .await;
            this.update(cx, |this, cx| {
                if !result {
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
                                        this.web_search.set_enabled(*checked, cx);
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
                                                this.web_search.test_key(cx);
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
                                            this.web_search.save_key(cx);
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
}
