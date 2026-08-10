//! Providers settings (port of `providers-settings.tsx` + `provider-editor.tsx`).
//!
//! Lists every configured provider (built-in and custom) from the portable
//! config, and lets the user add/edit/remove OpenAI-compatible custom
//! connections: name, base URL, model list, API key (written to the keychain
//! on the background executor — never displayed, only `hasKey` state), a
//! per-provider thinking-level select for Anthropic connections, and a default
//! model persisted into `settings.json` under `modelSelection`.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;

use aiden_core::chat_title::{
    ChatTitleProviderId, FoundationModelsConnectionState, FoundationModelsConnectionStatus,
};
use aiden_data::config_store::Provider as StoredProviderRow;
use aiden_data::portable_config::{ProviderDeployment, ProviderKind, StoredProvider};
use aiden_providers::live_discovery;
use aiden_providers::model_capabilities::{lookup_provider, ModelCapabilitiesCatalog};
use gpui::{
    div, prelude::FluentBuilder as _, px, AppContext as _, Context, ElementId, Entity, FontWeight,
    InteractiveElement as _, IntoElement, ParentElement as _, SharedString, Styled as _, Window,
};
use gpui_component::{
    button::{Button, ButtonVariants as _},
    h_flex,
    input::{Input, InputEvent, InputState},
    select::{Select, SelectEvent, SelectItem, SelectState},
    spinner::Spinner,
    v_flex, ActiveTheme, Disableable as _, Icon, IconName, Sizable as _, WindowExt as _,
};
use gpui_tokio_bridge::Tokio;

use super::{SettingsServices, SettingsView};
use crate::services::codex_auth::{
    auth_revision_is_current, CodexAuthAttemptGuard, CodexDeviceOAuth, CodexDialogLease,
    DEVICE_VERIFICATION_URI,
};
use crate::services::provider_kit::ModelSelection;

enum CodexAuthUpdate {
    DeviceCode(crate::services::codex_auth::CodexDeviceAuthorization),
    Finished {
        operation_error: Option<String>,
        actual_account: Result<Option<String>, String>,
        needs_attention: bool,
    },
}

/// The settings key for the persisted provider+model selection.
const MODEL_SELECTION_KEY: &str = "modelSelection";
/// The settings key holding the anthropic per-model thinking preferences.
const ANTHROPIC_THINKING_KEY: &str = "anthropicThinkingByModel";
const ANTHROPIC_LEVELS: &[&str] = &["off", "low", "medium", "high", "xhigh", "max"];
const TITLE_PROVIDER_SELECT_WIDTH_PX: f32 = 192.0;

#[derive(Clone)]
struct TitleProviderItem {
    value: ChatTitleProviderId,
    label: &'static str,
}

impl SelectItem for TitleProviderItem {
    type Value = ChatTitleProviderId;

    fn title(&self) -> SharedString {
        self.label.into()
    }

    fn value(&self) -> &Self::Value {
        &self.value
    }
}

fn title_provider_items() -> Vec<TitleProviderItem> {
    vec![
        TitleProviderItem {
            value: ChatTitleProviderId::Automatic,
            label: "Automatic",
        },
        TitleProviderItem {
            value: ChatTitleProviderId::AppleFoundationModels,
            label: "On-device only",
        },
        TitleProviderItem {
            value: ChatTitleProviderId::ChatModel,
            label: "Selected chat model",
        },
    ]
}

fn title_provider_select_max_width(window_width: f32) -> Option<f32> {
    (!crate::shell::sidebar::is_compact_sidebar_width(window_width))
        .then_some(TITLE_PROVIDER_SELECT_WIDTH_PX)
}

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
    pub is_preset: bool,
    pub deployment: ProviderDeployment,
    /// Models contributed by the bundled capability catalog (not part of the
    /// stored record). Filled from the offline catalog at boot;
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
            is_builtin: provider.is_builtin.unwrap_or(false)
                || provider.is_preset.unwrap_or(false)
                || !aiden_providers::catalog::is_custom_provider_id(&provider.id),
            is_preset: provider.is_preset.unwrap_or(false),
            deployment: provider.deployment.unwrap_or(ProviderDeployment::Hosted),
            catalog_models: Vec::new(),
        }
    }
}

/// Live model-discovery state for one custom provider row (the Test button).
/// Keyed by provider id in [`ProvidersState::discoveries`] so it survives the
/// row-list refreshes that rebuild [`ProviderRow`]s.
#[derive(Debug, Clone, Default)]
pub struct DiscoveryState {
    /// Whether a discovery request is in flight for this provider.
    pub running: bool,
    /// The last completed discovery outcome (cleared when a new Test starts).
    pub outcome: Option<DiscoveryOutcome>,
    /// Monotonic request generation; stale completions are ignored.
    pub revision: u64,
    /// Cancels the active HTTP request when the draft changes or closes.
    pub cancel: Option<tokio::sync::watch::Sender<bool>>,
}

/// The outcome of one Test/discovery run.
#[derive(Debug, Clone)]
pub enum DiscoveryOutcome {
    /// `count` chat-capable models were found; `models` is what "Use these
    /// models" would persist.
    Found { count: usize, models: Vec<String> },
    /// The discovery failed (offline server, timeout, non-JSON response, ...).
    Failed(String),
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
    pub deployment: ProviderDeployment,
    pub is_preset: bool,
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
    /// Per-provider live model-discovery state (the custom-row Test button).
    pub discoveries: HashMap<String, DiscoveryState>,
    pub error: Option<String>,
    pub notice: Option<String>,
    pub codex_configured: bool,
    pub codex_account: Option<String>,
    pub codex_needs_attention: bool,
    pub codex_busy: bool,
    pub codex_error: Option<String>,
    pub codex_revision: u64,
    pub codex_attempt: Option<CodexAuthAttemptGuard>,
    pub codex_dialog: Option<CodexDialogLease>,
    pub foundation_status: Option<FoundationModelsConnectionStatus>,
    pub foundation_loading: bool,
    pub foundation_error: Option<String>,
    pub title_revision: Arc<AtomicU64>,
    title_provider_select: Option<Entity<SelectState<Vec<TitleProviderItem>>>>,
    _subscriptions: Vec<gpui::Subscription>,
}

impl ProvidersState {
    fn codex_auth_active(&self) -> bool {
        self.codex_attempt.is_some()
            || self
                .codex_dialog
                .as_ref()
                .is_some_and(CodexDialogLease::is_open)
    }

    fn detach_codex_dialog(&mut self) -> bool {
        self.codex_dialog
            .take()
            .is_some_and(|lease| lease.take_owned_dialog())
    }

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
        &mut self,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> impl IntoElement {
        // Owned color copies: closures below borrow `cx` mutably (row render
        // helpers), so the theme reference cannot stay live across them.
        let theme = cx.theme();
        let danger = theme.danger;
        let info = theme.info;
        let foreground = theme.foreground;
        let muted_foreground = theme.muted_foreground;
        let foundation_card = self.foundation_models_card(window, cx).into_any_element();
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
            .child(self.codex_provider_card(cx))
            .child(foundation_card)
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

    fn codex_provider_card(&self, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = cx.theme();
        let configured = self.providers.codex_configured;
        let needs_attention = self.providers.codex_needs_attention;
        let usable = configured && !needs_attention;
        let busy = self.providers.codex_busy;
        v_flex()
            .id("codex-provider-card")
            .w_full()
            .gap_3()
            .p_3()
            .rounded_lg()
            .border_1()
            .border_color(theme.border)
            .child(
                h_flex()
                    .w_full()
                    .items_start()
                    .gap_3()
                    .child(
                        div()
                            .size(px(28.0))
                            .rounded_md()
                            .bg(theme.muted)
                            .items_center()
                            .justify_center()
                            .child(Icon::new(IconName::Bot).xsmall()),
                    )
                    .child(
                        v_flex()
                            .flex_1()
                            .gap_1()
                            .child(
                                h_flex()
                                    .gap_2()
                                    .child(
                                        div()
                                            .text_sm()
                                            .font_weight(FontWeight::SEMIBOLD)
                                            .child("ChatGPT / Codex"),
                                    )
                                    .child(
                                        div()
                                            .px_1p5()
                                            .py_0p5()
                                            .rounded_md()
                                            .bg(if usable {
                                                theme.success.opacity(0.14)
                                            } else {
                                                theme.muted
                                            })
                                            .text_xs()
                                            .text_color(if usable {
                                                theme.success
                                            } else {
                                                theme.muted_foreground
                                            })
                                            .child(if needs_attention {
                                                "Sign in again"
                                            } else if configured {
                                                "Configured"
                                            } else {
                                                "Sign in needed"
                                            }),
                                    ),
                            )
                            .child(div().text_xs().text_color(theme.muted_foreground).child(
                                "Use your ChatGPT Plus or Pro account for Codex models. \
                                         OAuth tokens stay encrypted in this Mac's Keychain.",
                            ))
                            .when_some(self.providers.codex_account.clone(), |el, account| {
                                el.child(
                                    div()
                                        .text_xs()
                                        .text_color(theme.muted_foreground)
                                        .child(account),
                                )
                            })
                            .when(usable, |el| {
                                el.child(
                                    div()
                                        .text_xs()
                                        .text_color(theme.muted_foreground)
                                        .child("Models: GPT-5.3 Codex Spark, GPT-5.4, GPT-5.4 mini, GPT-5.5, GPT-5.6 Luna, Sol, and Terra"),
                                )
                            }),
                    )
                    .child(
                        h_flex()
                            .gap_2()
                            .child(
                                Button::new("codex-sign-in")
                                    .small()
                                    .primary()
                                    .label(if configured {
                                        "Sign in again"
                                    } else {
                                        "Sign in"
                                    })
                                    .loading(busy)
                                    .disabled(busy)
                                    .on_click(cx.listener(|this, _event, window, cx| {
                                        this.start_codex_sign_in(window, cx);
                                    })),
                            )
                            .when(configured, |el| {
                                el.child(
                                    Button::new("codex-sign-out")
                                        .small()
                                        .ghost()
                                        .label("Sign out")
                                        .disabled(busy)
                                        .on_click(cx.listener(|this, _event, _window, cx| {
                                            this.sign_out_codex(cx);
                                        })),
                                )
                            }),
                    ),
            )
            .when_some(self.providers.codex_error.clone(), |el, error| {
                el.child(div().text_xs().text_color(theme.danger).child(error))
            })
    }

    fn foundation_models_card(
        &mut self,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> impl IntoElement {
        let selected = self
            .providers
            .settings
            .get("chatTitleProviderId")
            .and_then(serde_json::Value::as_str)
            .and_then(ChatTitleProviderId::from_str)
            .unwrap_or(ChatTitleProviderId::Automatic);
        let title_provider_select = self.title_provider_select(selected, window, cx);
        let title_provider_max_width =
            title_provider_select_max_width(window.viewport_size().width.into());
        let theme = cx.theme();
        let status = self.providers.foundation_status.as_ref();
        let status_label = status.map_or("Not checked", |status| match status.state {
            FoundationModelsConnectionState::Ready => "Ready",
            FoundationModelsConnectionState::ModelPreparing => "Preparing",
            _ => "Unavailable",
        });
        v_flex()
            .id("foundation-models-title-card")
            .w_full()
            .gap_3()
            .p_3()
            .rounded_lg()
            .border_1()
            .border_color(theme.border)
            .child(
                h_flex()
                    .w_full()
                    .justify_between()
                    .child(
                        v_flex()
                            .gap_1()
                            .child(
                                div()
                                    .text_sm()
                                    .font_weight(FontWeight::SEMIBOLD)
                                    .child("Chat titles"),
                            )
                            .child(
                                div()
                                    .text_xs()
                                    .text_color(theme.muted_foreground)
                                    .child("Apple Foundation Models run on-device when available."),
                            )
                            .child(
                                div()
                                    .text_xs()
                                    .text_color(theme.muted_foreground)
                                    .child(status_label),
                            )
                            .when_some(status.map(|status| status.detail.clone()), |el, detail| {
                                el.child(
                                    div()
                                        .text_xs()
                                        .text_color(theme.muted_foreground)
                                        .child(detail),
                                )
                            }),
                    )
                    .child(
                        Button::new("foundation-refresh")
                            .small()
                            .ghost()
                            .label("Refresh status")
                            .loading(self.providers.foundation_loading)
                            .disabled(self.providers.foundation_loading)
                            .on_click(cx.listener(|this, _, _, cx| {
                                this.refresh_foundation_status(cx);
                            })),
                    ),
            )
            .child(
                div()
                    .w_full()
                    .when_some(title_provider_max_width, |element, width| {
                        element.max_w(px(width))
                    })
                    .child(
                        Select::new(&title_provider_select)
                            .small()
                            .disabled(self.providers.foundation_loading)
                            .menu_width(px(TITLE_PROVIDER_SELECT_WIDTH_PX)),
                    ),
            )
            .when_some(self.providers.foundation_error.clone(), |el, error| {
                el.child(div().text_xs().text_color(theme.danger).child(error))
            })
    }

    fn title_provider_select(
        &mut self,
        selected: ChatTitleProviderId,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Entity<SelectState<Vec<TitleProviderItem>>> {
        if let Some(state) = &self.providers.title_provider_select {
            if state.read(cx).selected_value() != Some(&selected) {
                let state = state.clone();
                cx.defer_in(window, move |_, window, cx| {
                    state.update(cx, |state, cx| {
                        state.set_selected_value(&selected, window, cx)
                    });
                });
            }
            return state.clone();
        }
        let items = title_provider_items();
        let selected_index = items
            .iter()
            .position(|item| item.value == selected)
            .map(|row| gpui_component::IndexPath::default().row(row));
        let state = cx.new(|cx| SelectState::new(items, selected_index, window, cx));
        self.providers._subscriptions.push(cx.subscribe_in(
            &state,
            window,
            |this, _state, event, window, cx| {
                let SelectEvent::Confirm(Some(value)) = event else {
                    return;
                };
                this.save_title_provider(*value, window, cx);
            },
        ));
        self.providers.title_provider_select = Some(state.clone());
        state
    }

    fn refresh_foundation_status(&mut self, cx: &mut Context<Self>) {
        if self.providers.foundation_loading {
            return;
        }
        let revision = self.providers.title_revision.fetch_add(1, Ordering::SeqCst) + 1;
        self.providers.foundation_loading = true;
        self.providers.foundation_error = None;
        let connection = self.services.foundation_models.clone();
        let current = self.providers.title_revision.clone();
        let task = Tokio::spawn(cx, async move { connection.status(true).await });
        cx.spawn(async move |this, cx| {
            let status = task.await.ok().flatten();
            this.update(cx, |this, cx| {
                if current.load(Ordering::SeqCst) != revision {
                    return;
                }
                this.providers.foundation_loading = false;
                this.providers.foundation_status = status;
                this.providers.foundation_error =
                    this.providers.foundation_status.is_none().then(|| {
                        "Apple Foundation Models are not available on this device.".to_string()
                    });
                cx.notify();
            })?;
            Ok::<_, anyhow::Error>(())
        })
        .detach();
    }

    fn save_title_provider(
        &mut self,
        value: ChatTitleProviderId,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let revision = self.providers.title_revision.fetch_add(1, Ordering::SeqCst) + 1;
        let current = self.providers.title_revision.clone();
        let config = self.services.config.clone();
        self.providers.foundation_loading = true;
        self.providers.foundation_error = None;
        let task = Tokio::spawn(cx, async move {
            let mut patch = serde_json::Map::new();
            patch.insert(
                "chatTitleProviderId".to_string(),
                serde_json::Value::String(value.as_str().to_string()),
            );
            config
                .set_settings(&patch, &|| current.load(Ordering::SeqCst) == revision)
                .map(|_| ())
                .map_err(|error| error.to_string())
        });
        cx.spawn_in(window, async move |this, cx| {
            let result = task
                .await
                .unwrap_or_else(|_| Err("Chat title setting save was interrupted.".to_string()));
            this.update_in(cx, |this, window, cx| {
                if this.providers.title_revision.load(Ordering::SeqCst) != revision {
                    return;
                }
                this.providers.foundation_loading = false;
                match result {
                    Ok(()) => {
                        this.providers.settings.insert(
                            "chatTitleProviderId".to_string(),
                            serde_json::Value::String(value.as_str().to_string()),
                        );
                    }
                    Err(error) => {
                        this.providers.foundation_error = Some(error);
                        let persisted = this
                            .providers
                            .settings
                            .get("chatTitleProviderId")
                            .and_then(serde_json::Value::as_str)
                            .and_then(ChatTitleProviderId::from_str)
                            .unwrap_or(ChatTitleProviderId::Automatic);
                        if let Some(select) = &this.providers.title_provider_select {
                            select.update(cx, |select, cx| {
                                select.set_selected_value(&persisted, window, cx)
                            });
                        }
                    }
                }
                cx.notify();
            })?;
            Ok::<_, anyhow::Error>(())
        })
        .detach();
    }

    fn start_codex_sign_in(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.providers.codex_busy {
            return;
        }
        self.providers.codex_revision = self.providers.codex_revision.wrapping_add(1);
        let revision = self.providers.codex_revision;
        self.providers.codex_busy = true;
        self.providers.codex_error = None;
        let auth_store = self.services.codex_auth.clone();
        let attempt = CodexAuthAttemptGuard::new(auth_store.clone());
        let cancelled = attempt.cancelled();
        let auth_revision = attempt.revision();
        self.providers.codex_attempt = Some(attempt);
        let dialog_lease = CodexDialogLease::default();
        self.providers.codex_dialog = Some(dialog_lease.clone());
        let return_focus = window.focused(cx);
        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
        Tokio::spawn(cx, async move {
            let oauth = CodexDeviceOAuth::default();
            let authorization = match oauth.begin(&cancelled).await {
                Ok(authorization) => authorization,
                Err(error) => {
                    let (actual_account, needs_attention) = auth_store
                        .account_status()
                        .map(|(account, attention)| (Ok(account), attention))
                        .unwrap_or_else(|error| (Err(error.to_string()), true));
                    let _ = tx.send(CodexAuthUpdate::Finished {
                        operation_error: Some(error.to_string()),
                        actual_account,
                        needs_attention,
                    });
                    return;
                }
            };
            if tx
                .send(CodexAuthUpdate::DeviceCode(authorization.clone()))
                .is_err()
            {
                return;
            }
            let operation_error = oauth
                .complete(&authorization, &cancelled)
                .await
                .and_then(|credential| {
                    auth_store
                        .commit_auth_attempt(auth_revision, &credential)
                        .and_then(|committed| {
                            if committed {
                                Ok(())
                            } else {
                                Err(aiden_providers::ProviderError::Auth(
                                    "ChatGPT sign-in was cancelled.".to_string(),
                                ))
                            }
                        })
                })
                .err()
                .map(|error| error.to_string());
            let (actual_account, needs_attention) = auth_store
                .account_status()
                .map(|(account, attention)| (Ok(account), attention))
                .unwrap_or_else(|error| (Err(error.to_string()), true));
            let _ = tx.send(CodexAuthUpdate::Finished {
                operation_error,
                actual_account,
                needs_attention,
            });
        })
        .detach();

        cx.spawn_in(window, async move |this, cx| -> anyhow::Result<()> {
            while let Some(update) = rx.recv().await {
                let done = matches!(update, CodexAuthUpdate::Finished { .. });
                this.update_in(cx, |this, window, cx| {
                    if matches!(update, CodexAuthUpdate::Finished { .. })
                        && dialog_lease.take_owned_dialog()
                    {
                        window.close_dialog(cx);
                        if let Some(focus) = &return_focus {
                            focus.focus(window);
                        }
                    }
                    if !auth_revision_is_current(this.providers.codex_revision, revision) {
                        if this
                            .providers
                            .codex_dialog
                            .as_ref()
                            .is_some_and(|owned| owned.is_same(&dialog_lease))
                        {
                            this.providers.codex_dialog = None;
                        }
                        return;
                    }
                    match update {
                        CodexAuthUpdate::DeviceCode(authorization) => {
                            cx.open_url(DEVICE_VERIFICATION_URI);
                            let code = authorization.user_code;
                            let cancel = this
                                .providers
                                .codex_attempt
                                .as_ref()
                                .map(CodexAuthAttemptGuard::cancelled);
                            let auth_store = this.services.codex_auth.clone();
                            let return_focus = return_focus.clone();
                            let dialog_lease = dialog_lease.clone();
                            dialog_lease.mark_open();
                            window.open_dialog(cx, move |dialog, _window, cx| {
                                let cancel = cancel.clone();
                                let auth_store = auth_store.clone();
                                let return_focus = return_focus.clone();
                                let cancel_lease = dialog_lease.clone();
                                let close_lease = dialog_lease.clone();
                                dialog
                                    .title("Sign in to ChatGPT")
                                    .overlay_closable(false)
                                    .child(
                                        v_flex()
                                            .gap_3()
                                            .child("Enter this temporary code on OpenAI's verification page:")
                                            .child(
                                                div()
                                                    .text_2xl()
                                                    .font_weight(FontWeight::SEMIBOLD)
                                                    .child(code.clone()),
                                            )
                                            .child(
                                                div()
                                                    .text_sm()
                                                    .text_color(cx.theme().muted_foreground)
                                                    .child("The browser page has been opened. Aiden never displays or logs the resulting tokens."),
                                            ),
                                    )
                                    .footer(|_, cancel_button, window, cx| {
                                        vec![cancel_button(window, cx)]
                                    })
                                    .on_cancel(move |_, _, _| {
                                        if let Some(cancel) = &cancel {
                                            cancel.store(true, Ordering::SeqCst);
                                        }
                                        auth_store.invalidate_auth_attempts();
                                        cancel_lease.request_focus_restore();
                                        true
                                    })
                                    .on_close(move |_, window, _| {
                                        close_lease.mark_closed();
                                        if close_lease.should_restore_focus() {
                                            if let Some(focus) = &return_focus {
                                                focus.focus(window);
                                            }
                                        }
                                    })
                            });
                        }
                        CodexAuthUpdate::Finished {
                            operation_error,
                            actual_account,
                            needs_attention,
                        } => {
                            this.providers.codex_busy = false;
                            this.providers.codex_attempt = None;
                            this.providers.codex_dialog = None;
                            this.providers.codex_needs_attention = needs_attention;
                            match actual_account {
                                Ok(account) => {
                                    this.providers.codex_configured = account.is_some();
                                    this.providers.codex_account = account;
                                    this.providers.codex_error = operation_error;
                                }
                                Err(error) => {
                                    this.providers.codex_configured = false;
                                    this.providers.codex_account = None;
                                    this.providers.codex_error = Some(
                                        operation_error.unwrap_or(error),
                                    );
                                }
                            }
                            this.service_refresh_after_codex(cx);
                        }
                    }
                    cx.notify();
                })?;
                if done {
                    break;
                }
            }
            Ok(())
        })
        .detach();
        cx.notify();
    }

    fn sign_out_codex(&mut self, cx: &mut Context<Self>) {
        if self.providers.codex_busy {
            return;
        }
        self.providers.codex_revision = self.providers.codex_revision.wrapping_add(1);
        let revision = self.providers.codex_revision;
        self.providers.codex_busy = true;
        self.providers.codex_error = None;
        let store = self.services.codex_auth.clone();
        let state_store = store.clone();
        let task = Tokio::spawn(cx, async move {
            let operation_error = store.clear().err().map(|error| error.to_string());
            let (actual_account, needs_attention) = store
                .account_status()
                .map(|(account, attention)| (Ok(account), attention))
                .unwrap_or_else(|error| (Err(error.to_string()), true));
            (operation_error, actual_account, needs_attention)
        });
        cx.spawn(async move |this, cx| {
            let result = match task.await {
                Ok(result) => result,
                Err(_) => (
                    Some("ChatGPT sign-out was interrupted.".to_string()),
                    state_store
                        .account_status()
                        .map(|(account, _)| account)
                        .map_err(|error| error.to_string()),
                    state_store
                        .account_status()
                        .map(|(_, attention)| attention)
                        .unwrap_or(true),
                ),
            };
            this.update(cx, |this, cx| {
                if !auth_revision_is_current(this.providers.codex_revision, revision) {
                    return;
                }
                this.providers.codex_busy = false;
                let (operation_error, actual_account, needs_attention) = result;
                this.providers.codex_needs_attention = needs_attention;
                match actual_account {
                    Ok(account) => {
                        this.providers.codex_configured = account.is_some();
                        this.providers.codex_account = account;
                        this.providers.codex_error = operation_error;
                    }
                    Err(error) => {
                        this.providers.codex_configured = false;
                        this.providers.codex_account = None;
                        this.providers.codex_error = Some(operation_error.unwrap_or(error));
                    }
                }
                this.service_refresh_after_codex(cx);
                cx.notify();
            })?;
            Ok::<_, anyhow::Error>(())
        })
        .detach();
        cx.notify();
    }

    pub(crate) fn cancel_codex_sign_in(&mut self) -> bool {
        let owned_dialog = self.providers.detach_codex_dialog();
        if self.providers.codex_attempt.take().is_some() {
            self.providers.codex_revision = self.providers.codex_revision.wrapping_add(1);
            self.providers.codex_busy = false;
        }
        owned_dialog
    }

    pub(crate) fn codex_auth_active(&self) -> bool {
        self.providers.codex_auth_active()
    }

    fn service_refresh_after_codex(&self, cx: &mut Context<Self>) {
        self.services
            .appearance_service
            .update(cx, |service, cx| service.refresh_providers(cx));
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
        let discovery = self
            .providers
            .discoveries
            .get(&id)
            .cloned()
            .unwrap_or_default();
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
                    // Live model discovery status: a spinner while the Test
                    // request is in flight, then the discovered count with an
                    // opt-in "Use these models", or the failure message.
                    .when(discovery.running, |el| {
                        el.child(
                            h_flex()
                                .gap_1()
                                .items_center()
                                .mt_1()
                                .child(Spinner::new().small().color(theme.accent))
                                .child(
                                    div()
                                        .text_xs()
                                        .text_color(theme.muted_foreground)
                                        .child("Discovering models…"),
                                ),
                        )
                    })
                    .when_some(discovery.outcome.clone(), |el, outcome| match outcome {
                        DiscoveryOutcome::Found { count, models } => {
                            let use_id = id.clone();
                            let use_models = models.clone();
                            let shown: Vec<String> = models.iter().take(3).cloned().collect();
                            el.child(
                                h_flex()
                                    .gap_2()
                                    .items_center()
                                    .mt_1()
                                    .child(div().text_xs().text_color(theme.success).child(
                                        format!(
                                            "Found {count} model{}.",
                                            if count == 1 { "" } else { "s" }
                                        ),
                                    ))
                                    .child(
                                        Button::new(ElementId::Name(SharedString::from(format!(
                                            "provider-use-models-{use_id}"
                                        ))))
                                        .xsmall()
                                        .label("Use these models")
                                        .on_click(
                                            cx.listener(move |this, _event, _window, cx| {
                                                this.providers.use_discovered_models(
                                                    &use_id,
                                                    use_models.clone(),
                                                    &this.services,
                                                    cx,
                                                );
                                            }),
                                        ),
                                    )
                                    .when(!shown.is_empty(), |el| {
                                        el.child(
                                            div()
                                                .text_xs()
                                                .text_color(theme.muted_foreground)
                                                .child(shown.join(" · ")),
                                        )
                                    }),
                            )
                        }
                        DiscoveryOutcome::Failed(message) => el.child(
                            div()
                                .mt_1()
                                .text_xs()
                                .text_color(theme.danger)
                                .child(format!("Test failed: {message}")),
                        ),
                    })
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
                Button::new(ElementId::Name(SharedString::from(format!(
                    "provider-manage-{id}"
                ))))
                .small()
                .label(if has_key {
                    "Managed"
                } else {
                    "Setup unavailable"
                })
                .disabled(true)
                .tooltip("Pi-native provider setup is not available in this build")
                .into_any_element()
            } else {
                h_flex()
                    .gap_1()
                    .child({
                        let click_id = id.clone();
                        Button::new(ElementId::Name(SharedString::from(format!(
                            "provider-test-{id}"
                        ))))
                        .small()
                        .ghost()
                        .icon(IconName::Search)
                        .label(if discovery.running {
                            "Testing…"
                        } else {
                            "Test"
                        })
                        .disabled(discovery.running)
                        .tooltip("Test the connection and discover models")
                        .on_click(cx.listener(
                            move |this, _event, _window, cx| {
                                this.providers.test_discover(&click_id, cx);
                            },
                        ))
                    })
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
        let discovery = self
            .providers
            .discoveries
            .get(&draft.provider_id)
            .cloned()
            .unwrap_or_default();

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
                                this.providers.close_editor();
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
                                                this.providers.remove_key(&this.services, cx);
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
                        Button::new("test-provider-draft")
                            .small()
                            .ghost()
                            .label("Test connection")
                            .disabled(draft.saving || discovery.running)
                            .on_click(cx.listener(|this, _event, _window, cx| {
                                this.providers.test_discover_draft(&this.services, cx);
                            })),
                    )
                    .child(
                        Button::new("cancel-provider-edit")
                            .small()
                            .ghost()
                            .label("Cancel")
                            .on_click(cx.listener(|this, _event, _window, cx| {
                                this.providers.close_editor();
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
                                this.providers.save_editor(&this.services, cx);
                            })),
                    ),
            )
            .when_some(discovery.outcome, |el, outcome| {
                let message = match outcome {
                    DiscoveryOutcome::Found { count, .. } => {
                        format!("Found {count} available model(s).")
                    }
                    DiscoveryOutcome::Failed(message) => message,
                };
                el.child(
                    div()
                        .text_xs()
                        .text_color(theme.muted_foreground)
                        .child(message),
                )
            })
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
                        this.providers.confirm_remove(&removing, &this.services, cx);
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
        let (
            label,
            base_url,
            models,
            needs_key,
            has_key,
            kind,
            default_model,
            deployment,
            is_preset,
        ) = match existing {
            Some(row) => (
                row.label.clone(),
                row.base_url.clone(),
                row.models.clone(),
                row.needs_key,
                row.has_key,
                row.kind,
                row.default_model.clone().unwrap_or_default(),
                row.deployment,
                row.is_preset,
            ),
            None => (
                "Custom Provider".to_string(),
                "http://localhost:8000/v1".to_string(),
                Vec::new(),
                false,
                false,
                ProviderKind::Openai,
                String::new(),
                ProviderDeployment::Local,
                false,
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
        let api_key_input = cx.new(|cx| {
            InputState::new(window, cx)
                .placeholder("Paste your API key")
                .masked(true)
        });
        for input in [
            label_input.clone(),
            base_url_input.clone(),
            models_input.clone(),
            api_key_input.clone(),
        ] {
            let subscription =
                cx.subscribe_in(&input, window, |this, _source, event, _window, cx| {
                    if matches!(event, InputEvent::Change) {
                        if let Some(draft) = this.providers.editing.as_ref() {
                            if let Some(discovery) =
                                this.providers.discoveries.get_mut(&draft.provider_id)
                            {
                                if let Some(cancel) = discovery.cancel.take() {
                                    let _ = cancel.send(true);
                                }
                                discovery.revision = discovery.revision.wrapping_add(1);
                                discovery.running = false;
                                discovery.outcome = None;
                            }
                        }
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
            deployment,
            is_preset,
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

    fn close_editor(&mut self) {
        if let Some(draft) = self.editing.as_ref() {
            if let Some(discovery) = self.discoveries.get_mut(&draft.provider_id) {
                discovery.revision = discovery.revision.wrapping_add(1);
                discovery.running = false;
                if let Some(cancel) = discovery.cancel.take() {
                    let _ = cancel.send(true);
                }
            }
        }
        self.editing = None;
    }

    /// Remove the stored keychain key for the provider being edited.
    fn remove_key(&mut self, services: &SettingsServices, cx: &mut Context<SettingsView>) {
        let Some(draft) = self.editing.as_mut() else {
            return;
        };
        let provider_id = draft.provider_id.clone();
        draft.has_key = false;
        let services = services.clone();
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
    fn save_editor(&mut self, services: &SettingsServices, cx: &mut Context<SettingsView>) {
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
        let deployment = draft.deployment;
        let is_preset = draft.is_preset;
        draft.saving = true;

        let services = services.clone();
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
            deployment: Some(deployment),
            is_preset: Some(is_preset),
            is_builtin: Some(false),
            extra: serde_json::Map::new(),
        };

        cx.spawn(async move |this, cx| {
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
            let mut outcome = cx
                .background_spawn({
                    let config = services.config.clone();
                    let keys = services.keys.clone();
                    let provider = provider.clone();
                    async move {
                        crate::services::provider_mutation::ProviderMutationService::new(
                            config, keys,
                        )
                        .save_custom(&provider, key_draft.as_deref(), selection.as_ref())
                        .err()
                        .map(|error| error.to_string())
                    }
                })
                .await;
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
            this.update(cx, |this, cx| {
                if outcome.is_none() {
                    this.providers.close_editor();
                } else if let Some(draft) = this.providers.editing.as_mut() {
                    if draft.provider_id == provider_id {
                        draft.saving = false;
                    }
                }
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

    /// Run live model discovery for a custom provider row (the Test button).
    /// The request runs on the tokio bridge; the row shows a spinner while in
    /// flight and the discovered count / failure message when it settles.
    fn test_discover(&mut self, provider_id: &str, cx: &mut Context<SettingsView>) {
        let Some(row) = self.providers.iter().find(|row| row.id == provider_id) else {
            return;
        };
        let provider_id = provider_id.to_string();
        let base_url = row.base_url.clone();
        let runtime = live_discovery::runtime_kind_for_provider(&row.id, &base_url);
        let state = self.discoveries.entry(provider_id.clone()).or_default();
        state.running = true;
        state.outcome = None;
        let task = Tokio::spawn(cx, async move {
            live_discovery::discover_models(&base_url, runtime).await
        });
        cx.spawn(async move |this, cx| {
            let result = task.await;
            this.update(cx, |this, cx| {
                let state = this.providers.discoveries.entry(provider_id).or_default();
                state.running = false;
                state.outcome = Some(match result {
                    Ok(Ok(models)) => {
                        let count = models.len();
                        let ids = models.into_iter().map(|model| model.id).collect();
                        DiscoveryOutcome::Found { count, models: ids }
                    }
                    Ok(Err(error)) => DiscoveryOutcome::Failed(error.to_string()),
                    Err(_join) => {
                        DiscoveryOutcome::Failed("The model discovery was interrupted.".to_string())
                    }
                });
                cx.notify();
            })
            .ok();
        })
        .detach();
        cx.notify();
    }

    /// Test the exact editor draft. A changed connection can use only a newly
    /// entered key; bound lookup fails closed for an old endpoint credential.
    fn test_discover_draft(&mut self, services: &SettingsServices, cx: &mut Context<SettingsView>) {
        let Some(draft) = self.editing.as_ref() else {
            return;
        };
        let provider_id = draft.provider_id.clone();
        let base_url = draft.base_url.read(cx).value().trim().to_string();
        let key_draft = draft.api_key.read(cx).value().trim().to_string();
        let connection = StoredProvider {
            id: provider_id.clone(),
            kind: draft.kind,
            label: draft.label.read(cx).value().trim().to_string(),
            base_url: base_url.clone(),
            models: parse_models_text(&draft.models.read(cx).value()),
            model_metadata: None,
            default_model: (!draft.default_model.is_empty()).then(|| draft.default_model.clone()),
            needs_key: draft.needs_key,
            deployment: Some(draft.deployment),
            is_preset: Some(draft.is_preset),
            is_builtin: Some(false),
            extra: serde_json::Map::new(),
        };
        let state = self.discoveries.entry(provider_id.clone()).or_default();
        if let Some(cancel) = state.cancel.take() {
            let _ = cancel.send(true);
        }
        state.revision = state.revision.wrapping_add(1);
        let revision = state.revision;
        state.running = true;
        state.outcome = None;
        let (cancel, mut cancelled) = tokio::sync::watch::channel(false);
        state.cancel = Some(cancel);

        let config = services.config.clone();
        let runtime = live_discovery::runtime_kind_for_provider(&provider_id, &base_url);
        let task = Tokio::spawn(cx, async move {
            let api_key = if !key_draft.is_empty() {
                Some(key_draft)
            } else if connection.needs_key {
                config.get_bound_provider_key(&connection).ok().flatten()
            } else {
                None
            };
            if connection.needs_key && api_key.is_none() {
                return Err("Enter the API key for this connection before testing.".to_string());
            }
            let options = live_discovery::DiscoveryOptions::default();
            tokio::select! {
                _ = cancelled.changed() => Err("The model discovery was cancelled.".to_string()),
                result = live_discovery::discover_models_with_auth(
                    &base_url,
                    runtime,
                    &options,
                    api_key.as_deref(),
                ) => result.map_err(|error| error.to_string()),
            }
        });
        cx.spawn(async move |this, cx| {
            let result = task.await;
            this.update(cx, |this, cx| {
                let still_open = this
                    .providers
                    .editing
                    .as_ref()
                    .is_some_and(|draft| draft.provider_id == provider_id);
                let state = this.providers.discoveries.entry(provider_id).or_default();
                if !still_open || state.revision != revision {
                    return;
                }
                state.running = false;
                state.cancel = None;
                state.outcome = Some(match result {
                    Ok(Ok(models)) => DiscoveryOutcome::Found {
                        count: models.len(),
                        models: models.into_iter().map(|model| model.id).collect(),
                    },
                    Ok(Err(error)) => DiscoveryOutcome::Failed(error),
                    Err(_) => {
                        DiscoveryOutcome::Failed("The model discovery was interrupted.".to_string())
                    }
                });
                cx.notify();
            })
            .ok();
        })
        .detach();
        cx.notify();
    }

    /// Persist the discovered model list as the provider's configured models
    /// (the "Use these models" button). The current record's label / URL /
    /// key survive; only the cached model list is swapped.
    fn use_discovered_models(
        &mut self,
        provider_id: &str,
        models: Vec<String>,
        services: &SettingsServices,
        cx: &mut Context<SettingsView>,
    ) {
        let provider_id = provider_id.to_string();
        let services = services.clone();
        cx.spawn(async move |this, cx| {
            let saved = cx
                .background_spawn({
                    let config = services.config.clone();
                    let keys = services.keys.clone();
                    let provider_id = provider_id.clone();
                    let models = models.clone();
                    async move {
                        crate::services::provider_mutation::ProviderMutationService::new(
                            config, keys,
                        )
                        .save_discovered_models(&provider_id, models)
                        .map_err(|error| error.to_string())
                    }
                })
                .await;
            this.update(cx, |this, cx| {
                if let Err(message) = saved {
                    this.providers.error = Some(message);
                } else {
                    this.providers.notice = Some("Model list updated.".to_string());
                }
                // The discovery outcome is stale once the list is persisted.
                if let Some(state) = this.providers.discoveries.get_mut(&provider_id) {
                    state.outcome = None;
                }
                this.refresh(cx);
                cx.notify();
            })
            .ok();
        })
        .detach();
    }

    /// Confirm + run the remove-provider flow.
    fn confirm_remove(
        &mut self,
        provider_id: &str,
        services: &SettingsServices,
        cx: &mut Context<SettingsView>,
    ) {
        let provider_id = provider_id.to_string();
        let services = services.clone();
        cx.spawn(async move |this, cx| {
            let ok = cx
                .background_spawn(async move {
                    crate::services::provider_mutation::ProviderMutationService::new(
                        services.config.clone(),
                        services.keys.clone(),
                    )
                    .remove_custom(&provider_id)
                    .is_ok()
                })
                .await;
            this.update(cx, |this, cx| {
                this.providers.removing = None;
                this.providers.close_editor();
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
    fn chat_title_setting_choices_round_trip_exact_persisted_values() {
        for choice in [
            ChatTitleProviderId::Automatic,
            ChatTitleProviderId::AppleFoundationModels,
            ChatTitleProviderId::ChatModel,
        ] {
            assert_eq!(ChatTitleProviderId::from_str(choice.as_str()), Some(choice));
        }
    }

    #[test]
    fn chat_title_select_fits_compact_settings_and_preserves_keyboard_order() {
        assert_eq!(title_provider_select_max_width(390.0), None);
        assert_eq!(
            title_provider_select_max_width(700.0),
            Some(TITLE_PROVIDER_SELECT_WIDTH_PX)
        );
        assert_eq!(
            title_provider_items()
                .into_iter()
                .map(|item| item.value)
                .collect::<Vec<_>>(),
            vec![
                ChatTitleProviderId::Automatic,
                ChatTitleProviderId::AppleFoundationModels,
                ChatTitleProviderId::ChatModel,
            ]
        );
    }

    #[test]
    fn codex_dialog_keeps_settings_auth_active_until_its_exact_close() {
        let lease = CodexDialogLease::default();
        let mut state = ProvidersState {
            codex_dialog: Some(lease.clone()),
            ..Default::default()
        };
        lease.mark_open();
        assert!(state.codex_auth_active());

        lease.mark_closed();
        assert!(!state.codex_auth_active());
        state.codex_dialog = None;
        assert!(!state.codex_auth_active());
    }

    #[test]
    fn navigation_detaches_dialog_before_late_finish_and_never_requests_invoker_focus() {
        let lease = CodexDialogLease::default();
        lease.mark_open();
        let mut state = ProvidersState {
            codex_dialog: Some(lease.clone()),
            ..Default::default()
        };
        let destination_focus_valid = true;

        assert!(state.detach_codex_dialog());
        assert!(!lease.take_owned_dialog());
        assert!(!lease.should_restore_focus());
        assert!(destination_focus_valid);
    }

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
            is_preset: true,
            deployment: ProviderDeployment::Hosted,
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
