//! Providers settings (port of `providers-settings.tsx` + `provider-editor.tsx`).
//!
//! Lists every configured provider (built-in and custom) from the portable
//! config, and lets the user add/edit/remove OpenAI-compatible custom
//! connections: name, base URL, model list, API key (written to the keychain
//! on the background executor — never displayed, only `hasKey` state), a
//! per-provider thinking-level select for Anthropic connections, and a default
//! model persisted into `settings.json` under `modelSelection`.

use std::sync::Arc;

use aiden_data::config_store::Provider as StoredProviderRow;
use aiden_data::portable_config::{ProviderDeployment, ProviderKind, StoredProvider};
use aiden_providers::model_capabilities::{lookup_provider, ModelCapabilitiesCatalog};
use gpui::{
    div, prelude::FluentBuilder as _, px, AppContext as _, Context, ElementId, Entity, FontWeight,
    InteractiveElement as _, IntoElement, ParentElement as _, SharedString, Styled as _, Window,
};
use gpui_component::{
    button::{Button, ButtonVariants as _},
    h_flex,
    input::{Input, InputEvent, InputState},
    v_flex, ActiveTheme, Disableable as _, Icon, IconName, Sizable as _,
};

use super::{SettingsServices, SettingsView};
use crate::services::provider_kit::ModelSelection;

/// The settings key for the persisted provider+model selection.
const MODEL_SELECTION_KEY: &str = "modelSelection";
/// The settings key holding the anthropic per-model thinking preferences.
const ANTHROPIC_THINKING_KEY: &str = "anthropicThinkingByModel";
const ANTHROPIC_LEVELS: &[&str] = &["off", "low", "medium", "high", "xhigh", "max"];

/// A provider row as listed (owns key state; the key itself never leaves the
/// keychain).
#[derive(Debug, Clone)]
pub struct ProviderRow {
    pub id: String,
    pub kind: ProviderKind,
    pub label: String,
    pub base_url: String,
    pub models: Vec<String>,
    pub default_model: Option<String>,
    pub needs_key: bool,
    pub has_key: bool,
    pub is_builtin: bool,
    /// Models contributed by the models.dev capability catalog (not part of
    /// the stored record). Filled from the capability catalog at boot;
    /// rendered with a "discovered" badge vs the preset defaults.
    pub catalog_models: Vec<String>,
}

impl From<&StoredProviderRow> for ProviderRow {
    fn from(provider: &StoredProviderRow) -> Self {
        Self {
            id: provider.id.clone(),
            kind: provider.kind,
            label: provider.label.clone(),
            base_url: provider.base_url.clone(),
            models: provider.models.clone(),
            default_model: provider.default_model.clone(),
            needs_key: provider.needs_key,
            has_key: provider.has_key,
            is_builtin: provider.is_builtin.unwrap_or(false),
            catalog_models: Vec::new(),
        }
    }
}

/// Inline editor draft state (input entities are created when the editor
/// opens, so no window handle needs to be threaded through `new`).
pub struct ProviderDraft {
    pub provider_id: String,
    pub label: Entity<InputState>,
    pub base_url: Entity<InputState>,
    pub models: Entity<InputState>,
    pub api_key: Entity<InputState>,
    pub kind: ProviderKind,
    pub needs_key: bool,
    pub has_key: bool,
    /// The default model for new turns (model id or empty).
    pub default_model: String,
    /// The anthropic thinking level for the default model (empty = unset).
    pub thinking_level: String,
    pub saving: bool,
}

#[derive(Default)]
pub struct ProvidersState {
    pub providers: Vec<ProviderRow>,
    /// The models.dev capability catalog (`resources/model-capabilities.json`),
    /// loaded on the background executor at settings boot. Used to enrich
    /// built-in provider rows with every catalog model.
    pub capabilities: Option<Arc<ModelCapabilitiesCatalog>>,
    /// Mirror of `settings.json` for `modelSelection` + thinking prefs.
    pub settings: serde_json::Map<String, serde_json::Value>,
    pub editing: Option<ProviderDraft>,
    /// Provider id awaiting delete confirmation.
    pub removing: Option<String>,
    pub error: Option<String>,
    pub notice: Option<String>,
    _subscriptions: Vec<gpui::Subscription>,
}

impl ProvidersState {
    /// The persisted model selection, if it still points at a configured
    /// provider + model (catalog-contributed models count as offered).
    pub fn selection(&self) -> Option<ModelSelection> {
        let value = self.settings.get(MODEL_SELECTION_KEY)?;
        let selection = ModelSelection::from_settings(value)?;
        let provider = self
            .providers
            .iter()
            .find(|row| row.id == selection.provider_id)?;
        let offers = provider.default_model.as_deref() == Some(selection.model.as_str())
            || provider
                .models
                .iter()
                .any(|model| model == &selection.model)
            || provider
                .catalog_models
                .iter()
                .any(|model| model == &selection.model);
        offers.then_some(selection)
    }
}

impl SettingsView {
    /// The Providers section: header, built-in rows, custom rows, editor.
    pub(crate) fn providers_section(
        &self,
        _window: &mut Window,
        cx: &mut Context<Self>,
    ) -> impl IntoElement {
        // Owned color copies: closures below borrow `cx` mutably (row render
        // helpers), so the theme reference cannot stay live across them.
        let theme = cx.theme();
        let danger = theme.danger;
        let info = theme.info;
        let foreground = theme.foreground;
        let muted_foreground = theme.muted_foreground;
        let state = &self.providers;
        let builtins: Vec<&ProviderRow> = state
            .providers
            .iter()
            .filter(|row| row.is_builtin)
            .collect();
        let custom: Vec<&ProviderRow> = state
            .providers
            .iter()
            .filter(|row| !row.is_builtin)
            .collect();

        v_flex()
            .id("providers-section")
            .w_full()
            .gap_4()
            .child(
                h_flex()
                    .w_full()
                    .items_start()
                    .justify_between()
                    .gap_4()
                    .child(
                        v_flex()
                            .flex_1()
                            .child(
                                div()
                                    .text_lg()
                                    .font_weight(FontWeight::SEMIBOLD)
                                    .child("Providers"),
                            )
                            .child(
                                div()
                                    .text_sm()
                                    .text_color(muted_foreground)
                                    .mt_0p5()
                                    .child(
                                        "Connect local or private OpenAI-compatible servers, and \
                                         review the built-in providers. API keys are stored in your \
                                         keychain.",
                                    ),
                            ),
                    )
                    .child(
                        Button::new("add-provider")
                            .small()
                            .icon(IconName::Plus)
                            .label("Add provider")
                            .on_click(cx.listener(|this, _event, window, cx| {
                                this.providers.open_editor(None, window, cx);
                            })),
                    ),
            )
            .when_some(state.error.clone(), |el, message| {
                el.child(
                    div()
                        .w_full()
                        .px_3()
                        .py_2()
                        .rounded_md()
                        .bg(danger.opacity(0.12))
                        .text_sm()
                        .text_color(danger)
                        .child(message),
                )
            })
            .when_some(state.notice.clone(), |el, message| {
                el.child(
                    div()
                        .w_full()
                        .px_3()
                        .py_2()
                        .rounded_md()
                        .bg(info.opacity(0.12))
                        .text_sm()
                        .text_color(foreground)
                        .child(message),
                )
            })
            .child(
                v_flex()
                    .w_full()
                    .gap_2()
                    .child(
                        v_flex()
                            .gap_1()
                            .child(
                                div()
                                    .text_sm()
                                    .font_weight(FontWeight::SEMIBOLD)
                                    .child("Built into Aiden"),
                            )
                            .child(
                                div()
                                    .text_xs()
                                    .text_color(muted_foreground)
                                    .child(
                                        "These connections update with Aiden. Their endpoints are \
                                         intentionally not editable.",
                                    ),
                            ),
                    )
                    .child(
                        self.provider_card(&builtins, "No built-in providers yet.", cx),
                    ),
            )
            .child(
                v_flex()
                    .w_full()
                    .gap_2()
                    .child(
                        v_flex()
                            .gap_1()
                            .child(
                                div()
                                    .text_sm()
                                    .font_weight(FontWeight::SEMIBOLD)
                                    .child("Custom connections"),
                            )
                            .child(
                                div()
                                    .text_xs()
                                    .text_color(muted_foreground)
                                    .child(
                                        "Configure local, private, and vendor-compatible endpoints.",
                                    ),
                            ),
                    )
                    .child(self.provider_card(&custom, "No custom connections yet.", cx)),
            )
            .when_some(state.editing.as_ref(), |el, draft| {
                el.child(self.provider_editor(draft, cx))
            })
            .when_some(state.removing.clone(), |el, removing| {
                el.child(self.provider_remove_confirm(&removing, cx))
            })
    }

    /// One rounded card listing a set of provider rows.
    fn provider_card(
        &self,
        rows: &[&ProviderRow],
        empty: &str,
        cx: &mut Context<Self>,
    ) -> impl IntoElement {
        let theme = cx.theme();
        let border = theme.border;
        let muted_foreground = theme.muted_foreground;
        if rows.is_empty() {
            return div()
                .w_full()
                .px_3()
                .py_3()
                .rounded_lg()
                .border_1()
                .border_color(border)
                .text_sm()
                .text_color(muted_foreground)
                .child(empty.to_string())
                .into_any_element();
        }
        let selected_id = self
            .providers
            .selection()
            .map(|selection| selection.provider_id);
        v_flex()
            .w_full()
            .rounded_lg()
            .border_1()
            .border_color(border)
            .children(rows.iter().enumerate().map(|(index, row)| {
                let row = (*row).clone();
                let selected = selected_id.as_deref() == Some(row.id.as_str());
                div()
                    .w_full()
                    .when(index > 0, |el| el.border_t_1().border_color(border))
                    .child(self.provider_row(&row, selected, cx))
            }))
            .into_any_element()
    }

    fn provider_row(
        &self,
        row: &ProviderRow,
        selected: bool,
        cx: &mut Context<Self>,
    ) -> impl IntoElement {
        let theme = cx.theme();
        let id = row.id.clone();
        let label = row.label.clone();
        let base_url = row.base_url.clone();
        let models = row.models.len();
        let preset_models = row.models.clone();
        let catalog_models = row.catalog_models.clone();
        let is_builtin = row.is_builtin;
        let needs_key = row.needs_key;
        let has_key = row.has_key;
        let (badge_label, badge_color) = if !needs_key {
            ("No auth", theme.info)
        } else if has_key {
            ("Key set", theme.success)
        } else {
            ("No key", theme.muted_foreground)
        };
        h_flex()
            .id(ElementId::Name(SharedString::from(format!(
                "provider-row-{id}"
            ))))
            .w_full()
            .px_3()
            .py_2p5()
            .gap_3()
            .items_center()
            .child(
                div()
                    .size(px(28.))
                    .rounded_md()
                    .bg(theme.muted)
                    .items_center()
                    .justify_center()
                    .child(
                        Icon::new(IconName::Globe)
                            .xsmall()
                            .text_color(theme.muted_foreground),
                    ),
            )
            .child(
                v_flex()
                    .flex_1()
                    .min_w(px(0.))
                    .child(
                        h_flex()
                            .gap_2()
                            .items_center()
                            .child(
                                div()
                                    .text_sm()
                                    .font_weight(FontWeight::MEDIUM)
                                    .truncate()
                                    .child(label),
                            )
                            .child(
                                div()
                                    .px_1p5()
                                    .py_0p5()
                                    .rounded_md()
                                    .bg(badge_color.opacity(0.14))
                                    .text_xs()
                                    .text_color(badge_color)
                                    .child(badge_label),
                            )
                            .when(selected, |el| {
                                el.child(
                                    div()
                                        .px_1p5()
                                        .py_0p5()
                                        .rounded_md()
                                        .bg(theme.accent.opacity(0.16))
                                        .text_xs()
                                        .text_color(theme.accent)
                                        .child("Default model"),
                                )
                            }),
                    )
                    .child(
                        div()
                            .text_xs()
                            .text_color(theme.muted_foreground)
                            .truncate()
                            .child(if base_url.is_empty() {
                                format!("{} model{}", models, if models == 1 { "" } else { "s" })
                            } else {
                                base_url
                            }),
                    )
                    // Catalog-sourced models: the capability catalog enriches
                    // built-in providers beyond their preset defaults. Preset
                    // models stay unbadged; catalog additions carry a
                    // "discovered" badge (capped with a "+N more" tail).
                    .when(!catalog_models.is_empty(), |el| {
                        let accent = theme.accent;
                        let muted = theme.muted;
                        let muted_foreground = theme.muted_foreground;
                        let shown = catalog_models.len().min(6);
                        let extra = catalog_models.len() - shown;
                        el.child(
                            v_flex()
                                .gap_1()
                                .mt_1()
                                .when(!preset_models.is_empty(), |el| {
                                    el.child(
                                        div().text_xs().text_color(muted_foreground).child(
                                            format!("Preset: {}", preset_models.join(" · ")),
                                        ),
                                    )
                                })
                                .child(
                                    h_flex()
                                        .gap_1()
                                        .flex_wrap()
                                        .items_center()
                                        .child(
                                            div()
                                                .px_1p5()
                                                .py_0p5()
                                                .rounded_md()
                                                .bg(accent.opacity(0.14))
                                                .text_xs()
                                                .font_weight(FontWeight::SEMIBOLD)
                                                .text_color(accent)
                                                .child("discovered"),
                                        )
                                        .children(catalog_models.iter().take(shown).map(|model| {
                                            let model = model.clone();
                                            div()
                                                .px_1p5()
                                                .py_0p5()
                                                .rounded_md()
                                                .bg(muted.opacity(0.5))
                                                .text_xs()
                                                .text_color(muted_foreground)
                                                .child(model)
                                        }))
                                        .when(extra > 0, |el| {
                                            el.child(
                                                div()
                                                    .text_xs()
                                                    .text_color(muted_foreground)
                                                    .child(format!("+{extra} more")),
                                            )
                                        }),
                                ),
                        )
                    }),
            )
            .child(if is_builtin {
                let click_id = id.clone();
                Button::new(ElementId::Name(SharedString::from(format!(
                    "provider-manage-{id}"
                ))))
                .small()
                .label(if has_key { "Manage" } else { "Set up" })
                .on_click(cx.listener(move |this, _event, window, cx| {
                    this.providers
                        .open_editor(Some(click_id.clone()), window, cx);
                }))
                .into_any_element()
            } else {
                h_flex()
                    .gap_1()
                    .child({
                        let click_id = id.clone();
                        Button::new(ElementId::Name(SharedString::from(format!(
                            "provider-edit-{id}"
                        ))))
                        .small()
                        .label("Configure")
                        .on_click(cx.listener(
                            move |this, _event, window, cx| {
                                this.providers
                                    .open_editor(Some(click_id.clone()), window, cx);
                            },
                        ))
                    })
                    .child({
                        let click_id = id.clone();
                        Button::new(ElementId::Name(SharedString::from(format!(
                            "provider-remove-{id}"
                        ))))
                        .small()
                        .ghost()
                        .icon(IconName::Delete)
                        .tooltip("Remove provider")
                        .on_click(cx.listener(
                            move |this, _event, _window, cx| {
                                this.providers.removing = Some(click_id.clone());
                                this.error = None;
                                cx.notify();
                            },
                        ))
                    })
                    .into_any_element()
            })
    }

    /// Inline add/edit card for one provider.
    fn provider_editor(&self, draft: &ProviderDraft, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = cx.theme();
        let is_new = draft.provider_id.starts_with("custom:");
        let label_value = draft.label.read(cx).value().to_string();
        let base_url_value = draft.base_url.read(cx).value().to_string();
        let can_save = !label_value.trim().is_empty()
            && !base_url_value.trim().is_empty()
            && valid_base_url(&base_url_value);

        v_flex()
            .id("provider-editor")
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
                        div()
                            .text_sm()
                            .font_weight(FontWeight::SEMIBOLD)
                            .child(if is_new {
                                "Add custom connection"
                            } else {
                                "Configure connection"
                            }),
                    )
                    .child(
                        Button::new("close-provider-editor")
                            .ghost()
                            .xsmall()
                            .icon(IconName::Close)
                            .tooltip("Close")
                            .on_click(cx.listener(|this, _event, _window, cx| {
                                this.providers.editing = None;
                                cx.notify();
                            })),
                    ),
            )
            .child(
                h_flex()
                    .w_full()
                    .gap_3()
                    .child(
                        v_flex()
                            .flex_1()
                            .gap_1()
                            .child(
                                div()
                                    .text_xs()
                                    .font_weight(FontWeight::MEDIUM)
                                    .text_color(theme.muted_foreground)
                                    .child("Name"),
                            )
                            .child(Input::new(&draft.label).small()),
                    )
                    .child(
                        v_flex()
                            .flex_1()
                            .gap_1()
                            .child(
                                div()
                                    .text_xs()
                                    .font_weight(FontWeight::MEDIUM)
                                    .text_color(theme.muted_foreground)
                                    .child("Base URL"),
                            )
                            .child(Input::new(&draft.base_url).small()),
                    ),
            )
            .child(
                v_flex()
                    .w_full()
                    .gap_1()
                    .child(
                        div()
                            .text_xs()
                            .font_weight(FontWeight::MEDIUM)
                            .text_color(theme.muted_foreground)
                            .child("Models (one per line)"),
                    )
                    .child(Input::new(&draft.models).small()),
            )
            .when(draft.kind == ProviderKind::Anthropic, |el| {
                el.child(
                    h_flex()
                        .w_full()
                        .gap_3()
                        .items_end()
                        .child(
                            v_flex()
                                .flex_1()
                                .gap_1()
                                .child(
                                    div()
                                        .text_xs()
                                        .font_weight(FontWeight::MEDIUM)
                                        .text_color(theme.muted_foreground)
                                        .child("Thinking level"),
                                )
                                .child(
                                    div()
                                        .text_xs()
                                        .text_color(theme.muted_foreground)
                                        .child("Applied to the default model."),
                                ),
                        )
                        .child(
                            h_flex()
                                .gap_1()
                                .children(ANTHROPIC_LEVELS.iter().map(|level| {
                                    let active = draft.thinking_level == *level;
                                    let level = *level;
                                    let mut button = Button::new(ElementId::Name(
                                        SharedString::from(format!("thinking-{level}")),
                                    ))
                                    .ghost()
                                    .xsmall()
                                    .label(level.to_string());
                                    if active {
                                        button = button.primary();
                                    }
                                    button.on_click(cx.listener(
                                        move |this, _event, _window, cx| {
                                            this.providers.set_thinking_level(level, cx);
                                        },
                                    ))
                                })),
                        ),
                )
            })
            .child(
                h_flex()
                    .w_full()
                    .gap_3()
                    .items_end()
                    .child(
                        v_flex()
                            .flex_1()
                            .gap_1()
                            .child(
                                div()
                                    .text_xs()
                                    .font_weight(FontWeight::MEDIUM)
                                    .text_color(theme.muted_foreground)
                                    .child("API key"),
                            )
                            .child(div().text_xs().text_color(theme.muted_foreground).child(
                                if draft.has_key {
                                    "A key is stored in your keychain. Enter a new value to \
                                         replace it."
                                } else {
                                    "No key stored yet. Keys are kept in the macOS keychain."
                                },
                            )),
                    )
                    .child(
                        v_flex()
                            .w(px(280.))
                            .gap_1()
                            .child(Input::new(&draft.api_key).small())
                            .when(draft.has_key, |el| {
                                el.child(
                                    h_flex().justify_end().child(
                                        Button::new("remove-provider-key")
                                            .link()
                                            .xsmall()
                                            .label("Remove stored key")
                                            .on_click(cx.listener(|this, _event, _window, cx| {
                                                this.providers.remove_key(cx);
                                            })),
                                    ),
                                )
                            }),
                    ),
            )
            .child(
                h_flex()
                    .w_full()
                    .justify_end()
                    .gap_2()
                    .child(
                        Button::new("cancel-provider-edit")
                            .small()
                            .ghost()
                            .label("Cancel")
                            .on_click(cx.listener(|this, _event, _window, cx| {
                                this.providers.editing = None;
                                cx.notify();
                            })),
                    )
                    .child(
                        Button::new("save-provider")
                            .small()
                            .primary()
                            .label(if draft.saving { "Saving…" } else { "Save" })
                            .disabled(!can_save || draft.saving)
                            .on_click(cx.listener(|this, _event, _window, cx| {
                                this.providers.save_editor(cx);
                            })),
                    ),
            )
    }

    /// Inline delete-confirmation card.
    fn provider_remove_confirm(&self, removing: &str, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = cx.theme();
        let removing = removing.to_string();
        let label = self
            .providers
            .providers
            .iter()
            .find(|row| row.id == removing)
            .map(|row| row.label.clone())
            .unwrap_or_else(|| "this provider".to_string());
        h_flex()
            .id("provider-remove-confirm")
            .w_full()
            .gap_3()
            .items_center()
            .px_4()
            .py_3()
            .rounded_lg()
            .border_1()
            .border_color(theme.danger.opacity(0.5))
            .child(div().flex_1().text_sm().child(format!(
                "Remove “{label}” and its saved key? This cannot be undone."
            )))
            .child(
                Button::new("cancel-provider-remove")
                    .small()
                    .ghost()
                    .label("Cancel")
                    .on_click(cx.listener(|this, _event, _window, cx| {
                        this.providers.removing = None;
                        cx.notify();
                    })),
            )
            .child(
                Button::new("confirm-provider-remove")
                    .small()
                    .danger()
                    .label("Remove")
                    .on_click(cx.listener(move |this, _event, _window, cx| {
                        this.providers.confirm_remove(&removing, cx);
                    })),
            )
    }
}

impl ProvidersState {
    /// Open the editor for a provider id (`None` = new custom connection).
    fn open_editor(
        &mut self,
        provider_id: Option<String>,
        window: &mut Window,
        cx: &mut Context<SettingsView>,
    ) {
        let existing = provider_id
            .as_ref()
            .and_then(|id| self.providers.iter().find(|row| &row.id == id));
        let provider_id = existing
            .map(|row| row.id.clone())
            .or(provider_id)
            .unwrap_or_else(new_custom_provider_id);
        let (label, base_url, models, needs_key, has_key, kind, default_model) = match existing {
            Some(row) => (
                row.label.clone(),
                row.base_url.clone(),
                row.models.clone(),
                row.needs_key,
                row.has_key,
                row.kind,
                row.default_model.clone().unwrap_or_default(),
            ),
            None => (
                "Custom Provider".to_string(),
                "http://localhost:8000/v1".to_string(),
                Vec::new(),
                false,
                false,
                ProviderKind::Openai,
                String::new(),
            ),
        };
        let thinking_level = if kind == ProviderKind::Anthropic && !default_model.is_empty() {
            self.settings
                .get(ANTHROPIC_THINKING_KEY)
                .and_then(|value| value.get(&default_model))
                .and_then(serde_json::Value::as_str)
                .unwrap_or("high")
                .to_string()
        } else {
            String::new()
        };

        let make_input = |cx: &mut Context<SettingsView>,
                          window: &mut Window,
                          placeholder: &str,
                          value: &str| {
            let placeholder = placeholder.to_string();
            let value = value.to_string();
            cx.new(move |cx| {
                InputState::new(window, cx)
                    .placeholder(placeholder)
                    .default_value(value)
            })
        };
        let label_input = make_input(cx, window, "My provider", &label);
        let base_url_input = make_input(cx, window, "https://api.example.com/v1", &base_url);
        let models_input = make_input(cx, window, "model-one", &models.join("\n"));
        let api_key_input =
            cx.new(|cx| InputState::new(window, cx).placeholder("Paste your API key"));
        for input in [
            label_input.clone(),
            base_url_input.clone(),
            models_input.clone(),
            api_key_input.clone(),
        ] {
            let subscription =
                cx.subscribe_in(&input, window, |_this, _source, event, _window, cx| {
                    if matches!(event, InputEvent::Change) {
                        cx.notify();
                    }
                });
            self._subscriptions.push(subscription);
        }

        self.editing = Some(ProviderDraft {
            provider_id,
            label: label_input,
            base_url: base_url_input,
            models: models_input,
            api_key: api_key_input,
            kind,
            needs_key,
            has_key,
            default_model,
            thinking_level,
            saving: false,
        });
        cx.notify();
    }

    /// Change the thinking-level buttons in the open editor.
    fn set_thinking_level(&mut self, level: &str, cx: &mut Context<SettingsView>) {
        if let Some(draft) = self.editing.as_mut() {
            draft.thinking_level = level.to_string();
            cx.notify();
        }
    }

    /// Remove the stored keychain key for the provider being edited.
    fn remove_key(&mut self, cx: &mut Context<SettingsView>) {
        let Some(draft) = self.editing.as_mut() else {
            return;
        };
        let provider_id = draft.provider_id.clone();
        draft.has_key = false;
        let services = self.services(cx);
        cx.spawn(async move |this, cx| {
            let keys = services.keys.clone();
            cx.background_spawn(async move {
                let _ = keys.delete(&provider_id);
            })
            .await;
            this.update(cx, |this, cx| {
                this.refresh(cx);
                cx.notify();
            })
            .ok();
        })
        .detach();
    }

    /// Persist the editor draft: provider record + keychain key + default
    /// model selection + anthropic thinking level.
    fn save_editor(&mut self, cx: &mut Context<SettingsView>) {
        let Some(draft) = self.editing.as_mut() else {
            return;
        };
        if draft.saving {
            return;
        }
        let provider_id = draft.provider_id.clone();
        let label = draft.label.read(cx).value().to_string();
        let base_url = draft.base_url.read(cx).value().to_string();
        let models = parse_models_text(&draft.models.read(cx).value());
        let api_key = draft.api_key.read(cx).value().to_string();
        let key_draft = if api_key.trim().is_empty() {
            None
        } else {
            Some(api_key.trim().to_string())
        };
        let needs_key = key_draft.is_some() || draft.needs_key;
        let kind = draft.kind;
        let default_model = draft.default_model.clone();
        let thinking_level = draft.thinking_level.clone();
        draft.saving = true;

        let services = self.services(cx);
        let provider = StoredProvider {
            id: provider_id.clone(),
            kind,
            label: label.trim().to_string(),
            base_url: base_url.trim().to_string(),
            models: models.clone(),
            model_metadata: None,
            default_model: if default_model.is_empty() {
                None
            } else {
                Some(default_model.clone())
            },
            needs_key,
            deployment: Some(ProviderDeployment::Hosted),
            is_preset: Some(false),
            is_builtin: Some(false),
            extra: serde_json::Map::new(),
        };

        cx.spawn(async move |this, cx| {
            let mut outcome: Option<String> = None;
            let saved = cx
                .background_spawn({
                    let config = services.config.clone();
                    let provider = provider.clone();
                    async move { config.save_provider(&provider, &|| true).ok() }
                })
                .await;
            if saved.is_none() {
                outcome = Some("The provider could not be saved.".to_string());
            } else if let Some(key) = key_draft {
                let wrote = cx
                    .background_spawn({
                        let keys = services.keys.clone();
                        let provider_id = provider_id.clone();
                        async move { keys.set(&provider_id, &key).is_ok() }
                    })
                    .await;
                if !wrote {
                    outcome = Some(
                        "The connection was saved, but the API key could not be written to the \
                         keychain."
                            .to_string(),
                    );
                }
            }
            if outcome.is_none() && kind == ProviderKind::Anthropic && !thinking_level.is_empty() {
                let model = default_model.clone();
                if !model.is_empty() {
                    outcome = cx
                        .background_spawn({
                            let config = services.config.clone();
                            let model = model.clone();
                            let level = thinking_level.clone();
                            async move {
                                config
                                    .set_anthropic_thinking_level(&model, &level)
                                    .err()
                                    .map(|error| error.to_string())
                            }
                        })
                        .await;
                }
            }
            // Persist the default model selection for new turns.
            let selection = {
                let model = if default_model.is_empty() {
                    models.first().cloned()
                } else {
                    Some(default_model.clone())
                };
                model.map(|model| ModelSelection {
                    provider_id: provider_id.clone(),
                    model,
                })
            };
            if let Some(selection) = selection {
                cx.background_spawn({
                    let config = services.config.clone();
                    let value = selection.to_settings();
                    async move {
                        let mut patch = serde_json::Map::new();
                        patch.insert(MODEL_SELECTION_KEY.to_string(), value);
                        let _ = config.set_settings(&patch, &|| true);
                    }
                })
                .await;
            }
            this.update(cx, |this, cx| {
                this.providers.editing = None;
                this.providers.error = outcome.clone();
                this.providers.notice = if outcome.is_none() {
                    Some("Provider saved.".to_string())
                } else {
                    None
                };
                this.refresh(cx);
                cx.notify();
            })
            .ok();
        })
        .detach();
    }

    /// Confirm + run the remove-provider flow.
    fn confirm_remove(&mut self, provider_id: &str, cx: &mut Context<SettingsView>) {
        let provider_id = provider_id.to_string();
        let services = self.services(cx);
        cx.spawn(async move |this, cx| {
            let ok = cx
                .background_spawn(async move {
                    services
                        .config
                        .remove_provider(&provider_id, &|| true)
                        .is_ok()
                })
                .await;
            this.update(cx, |this, cx| {
                this.providers.removing = None;
                this.providers.editing = None;
                this.providers.error = if ok {
                    None
                } else {
                    Some("The provider could not be removed.".to_string())
                };
                this.refresh(cx);
                cx.notify();
            })
            .ok();
        })
        .detach();
    }

    fn services(&self, cx: &mut Context<SettingsView>) -> SettingsServices {
        cx.entity().read(cx).services.clone()
    }
}

/// Fill `row.catalog_models` with the models.dev catalog models for this
/// provider that the stored record does not already list (the Providers
/// section badges these as "discovered"). `None` catalog (dev checkouts) or an
/// unmatched provider id leaves the row untouched.
pub fn enrich_provider_row(
    mut row: ProviderRow,
    catalog: Option<&ModelCapabilitiesCatalog>,
) -> ProviderRow {
    let Some(entry) = catalog.and_then(|catalog| lookup_provider(catalog, &row.id)) else {
        return row;
    };
    let mut catalog_models: Vec<String> = entry
        .models
        .values()
        .filter_map(|capability| capability.id.clone())
        .filter(|id| !row.models.contains(id))
        .collect();
    catalog_models.sort();
    row.catalog_models = catalog_models;
    row
}

/// New custom provider id: `custom:connection-<hex timestamp>`, mirroring the
/// renderer's `custom:connection-<base36 timestamp>` style.
fn new_custom_provider_id() -> String {
    format!("custom:connection-{:x}", aiden_data::now_millis())
}

/// Parse the models text area (one model per line) into a trimmed, deduped,
/// ordered list.
pub fn parse_models_text(text: &str) -> Vec<String> {
    let mut seen = std::collections::HashSet::new();
    text.lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .filter(|line| seen.insert(line.to_string()))
        .map(str::to_string)
        .collect()
}

/// Whether a base URL looks plausible (http/https and non-empty).
pub fn valid_base_url(url: &str) -> bool {
    let url = url.trim();
    url.starts_with("http://") || url.starts_with("https://")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_models_one_per_line_deduped() {
        let text = "gpt-4o\n  claude-sonnet-5\n\ngpt-4o\nclaude-sonnet-5\n";
        assert_eq!(parse_models_text(text), vec!["gpt-4o", "claude-sonnet-5"]);
        assert_eq!(parse_models_text("   \n\n"), Vec::<String>::new());
    }

    #[test]
    fn base_url_validation_accepts_http_and_https_only() {
        assert!(valid_base_url("http://localhost:8000/v1"));
        assert!(valid_base_url("https://api.openai.com/v1"));
        assert!(!valid_base_url("localhost:8000"));
        assert!(!valid_base_url(""));
        assert!(!valid_base_url("ftp://example.com"));
    }

    #[test]
    fn new_custom_provider_ids_are_prefixed_and_hex_suffixed() {
        let id = new_custom_provider_id();
        assert!(id.starts_with("custom:connection-"));
        let suffix = id.trim_start_matches("custom:connection-");
        assert!(!suffix.is_empty());
        assert!(
            u64::from_str_radix(suffix, 16).is_ok(),
            "suffix is hex: {suffix}"
        );
    }

    #[test]
    fn provider_rows_get_catalog_discovered_models() {
        use aiden_providers::model_capabilities::ModelCapabilitiesCatalog;

        let catalog: ModelCapabilitiesCatalog = serde_json::from_value(serde_json::json!({
            "anthropic": {
                "id": "anthropic",
                "models": {
                    "claude-sonnet-5": { "id": "claude-sonnet-5" },
                    "claude-sonnet-6": { "id": "claude-sonnet-6" }
                }
            }
        }))
        .expect("fixture parses");
        let row = ProviderRow {
            id: "anthropic".into(),
            kind: ProviderKind::Anthropic,
            label: "Anthropic".into(),
            base_url: "https://api.anthropic.com/v1".into(),
            models: vec!["claude-sonnet-5".into()],
            default_model: Some("claude-sonnet-5".into()),
            needs_key: true,
            has_key: true,
            is_builtin: true,
            catalog_models: Vec::new(),
        };
        let enriched = enrich_provider_row(row.clone(), Some(&catalog));
        assert_eq!(enriched.catalog_models, vec!["claude-sonnet-6"]);
        assert!(enriched.models.contains(&"claude-sonnet-5".to_string()));

        // Preset-only models are not badged as discovered.
        let preset = enrich_provider_row(row.clone(), None);
        assert!(preset.catalog_models.is_empty());

        // Unmatched provider ids stay untouched even with a catalog.
        let custom = ProviderRow {
            id: "custom:lmstudio".into(),
            ..row
        };
        assert!(enrich_provider_row(custom, Some(&catalog))
            .catalog_models
            .is_empty());

        // The persisted selection still counts catalog models as offered.
        let state = ProvidersState {
            providers: vec![enriched],
            settings: serde_json::from_str(
                r#"{"modelSelection": {"providerId": "anthropic", "model": "claude-sonnet-6"}}"#,
            )
            .unwrap(),
            ..Default::default()
        };
        assert_eq!(
            state.selection().map(|s| s.model),
            Some("claude-sonnet-6".to_string())
        );
    }
}
