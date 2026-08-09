//! Voice & dictation settings (port of `voice-settings.tsx` +
//! `local-voice-settings.tsx`, reduced).
//!
//! Transcription provider (OpenAI / Google Gemini / on-device Parakeet) and,
//! for the on-device engine, the Parakeet model catalog with download/delete
//! (through `aiden-mac`'s download manager), the selected dictation model, and
//! the microphone permission probe.
//!
//! Persisted keys (all in `settings.json`): `voiceProvider`, `voiceModel`,
//! `localVoiceModel`. Downloads touch the network only on the explicit
//! Download button (the same rule as the TS manager). Everything runs off the
//! foreground: catalog reads + keychain writes on the background executor,
//! downloads on the tokio bridge (the download manager uses `tokio::spawn` +
//! `tokio::fs` — see the runtime contract in `main.rs`).

use std::sync::Arc;

use aiden_mac::audio::MicrophonePermission;
use aiden_mac::local_models::{
    delete_model, download_model, list_models, DownloadProgress, LocalModel,
};
use gpui::{
    div, prelude::FluentBuilder as _, px, AppContext as _, Context, FontWeight,
    InteractiveElement as _, IntoElement, ParentElement as _, SharedString,
    StatefulInteractiveElement as _, Styled as _, Window,
};
use gpui_component::{
    button::{Button, ButtonVariants as _},
    h_flex, v_flex, ActiveTheme, Disableable as _, IconName, Sizable as _,
};
use gpui_tokio_bridge::Tokio;
use tokio::sync::mpsc;

use super::SettingsView;

/// The settings keys this section edits.
pub const VOICE_PROVIDER_KEY: &str = "voiceProvider";
pub const VOICE_MODEL_KEY: &str = "voiceModel";
pub const LOCAL_VOICE_MODEL_KEY: &str = "localVoiceModel";

/// The transcription provider (`VoiceProvider`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum VoiceProvider {
    #[default]
    Openai,
    Gemini,
    Local,
}

impl VoiceProvider {
    pub fn as_str(self) -> &'static str {
        match self {
            VoiceProvider::Openai => "openai",
            VoiceProvider::Gemini => "gemini",
            VoiceProvider::Local => "local",
        }
    }

    pub fn label(self) -> &'static str {
        match self {
            VoiceProvider::Openai => "OpenAI",
            VoiceProvider::Gemini => "Google Gemini",
            VoiceProvider::Local => "On-device (Parakeet)",
        }
    }

    fn from_str(value: &str) -> Option<Self> {
        match value {
            "openai" => Some(VoiceProvider::Openai),
            "gemini" => Some(VoiceProvider::Gemini),
            "local" => Some(VoiceProvider::Local),
            _ => None,
        }
    }
}

/// The default cloud transcription model per provider (`CLOUD_MODELS` in TS).
pub fn default_cloud_model(provider: VoiceProvider) -> Option<&'static str> {
    match provider {
        VoiceProvider::Openai => Some("whisper-1"),
        VoiceProvider::Gemini => Some("gemini-2.0-flash"),
        VoiceProvider::Local => None,
    }
}

/// Read the persisted provider, defaulting to OpenAI.
pub fn voice_provider_from_settings(
    settings: &serde_json::Map<String, serde_json::Value>,
) -> VoiceProvider {
    settings
        .get(VOICE_PROVIDER_KEY)
        .and_then(|value| value.as_str())
        .and_then(VoiceProvider::from_str)
        .unwrap_or(VoiceProvider::Openai)
}

#[derive(Default)]
pub struct VoiceState {
    pub provider: VoiceProvider,
    pub voice_model: Option<String>,
    /// The selected on-device model id (`localVoiceModel`).
    pub local_voice_model: Option<String>,
    /// The Parakeet catalog with installed flags (None = still loading).
    pub models: Option<Vec<LocalModel>>,
    /// Microphone permission (None = still probing).
    pub mic_permission: Option<MicrophonePermission>,
    /// The model id currently downloading (with a progress percentage).
    pub downloading: Option<(String, u8)>,
    pub busy: bool,
    pub error: Option<String>,
    _subscriptions: Vec<gpui::Subscription>,
}

impl VoiceState {
    pub fn hydrate(&mut self, settings: &serde_json::Map<String, serde_json::Value>) {
        self.provider = voice_provider_from_settings(settings);
        self.voice_model = settings
            .get(VOICE_MODEL_KEY)
            .and_then(|value| value.as_str())
            .map(str::to_string);
        self.local_voice_model = settings
            .get(LOCAL_VOICE_MODEL_KEY)
            .and_then(|value| value.as_str())
            .map(str::to_string);
    }

    fn services(&self, cx: &mut Context<SettingsView>) -> super::SettingsServices {
        cx.entity().read(cx).services.clone()
    }

    /// Load the Parakeet catalog + microphone permission on the background
    /// executor (both are quick local probes).
    pub(crate) fn load_runtime(&mut self, cx: &mut Context<SettingsView>) {
        cx.spawn(async move |this, cx| {
            let (models, mic) = cx
                .background_spawn(async move { (list_models(), microphone_permission()) })
                .await;
            this.update(cx, |this, cx| {
                this.voice.models = Some(models);
                this.voice.mic_permission = Some(mic);
                cx.notify();
            })
            .ok();
        })
        .detach();
    }

    /// Switch the transcription provider (persisted; cloud providers also
    /// record the default model).
    fn set_provider(&mut self, provider: VoiceProvider, cx: &mut Context<SettingsView>) {
        if self.busy || self.provider == provider {
            return;
        }
        self.busy = true;
        self.error = None;
        let services = self.services(cx);
        let (provider_str, model) = match default_cloud_model(provider) {
            Some(model) => (provider.as_str().to_string(), Some(model.to_string())),
            None => (provider.as_str().to_string(), None),
        };
        cx.spawn(async move |this, cx| {
            let result = cx
                .background_spawn(async move {
                    let mut patch = serde_json::Map::new();
                    patch.insert(
                        VOICE_PROVIDER_KEY.to_string(),
                        serde_json::json!(provider_str),
                    );
                    if let Some(model) = model {
                        patch.insert(VOICE_MODEL_KEY.to_string(), serde_json::json!(model));
                    }
                    services.config.set_settings(&patch, &|| true).is_ok()
                })
                .await;
            this.update(cx, |this, cx| {
                this.voice.busy = false;
                if result {
                    this.voice.provider = provider;
                    if let Some(model) = default_cloud_model(provider) {
                        this.voice.voice_model = Some(model.to_string());
                    }
                } else {
                    this.voice.error = Some("The voice provider could not be saved.".to_string());
                }
                cx.notify();
            })
            .ok();
        })
        .detach();
        cx.notify();
    }

    /// Select the on-device model used for dictation.
    fn select_local_model(&mut self, id: String, cx: &mut Context<SettingsView>) {
        if self.busy {
            return;
        }
        self.busy = true;
        self.error = None;
        let id_value = id.clone();
        let services = self.services(cx);
        cx.spawn(async move |this, cx| {
            let result = cx
                .background_spawn(async move {
                    let mut patch = serde_json::Map::new();
                    patch.insert(
                        LOCAL_VOICE_MODEL_KEY.to_string(),
                        serde_json::json!(id_value),
                    );
                    services.config.set_settings(&patch, &|| true).is_ok()
                })
                .await;
            this.update(cx, |this, cx| {
                this.voice.busy = false;
                if result {
                    this.voice.local_voice_model = Some(id);
                } else {
                    this.voice.error = Some("The voice model could not be saved.".to_string());
                }
                cx.notify();
            })
            .ok();
        })
        .detach();
        cx.notify();
    }

    /// Download a Parakeet model through the aiden-mac download manager
    /// (explicit user action; runs on the tokio bridge because the manager
    /// spawns tokio tasks and uses `tokio::fs`).
    fn download(&mut self, id: String, cx: &mut Context<SettingsView>) {
        if self.busy || self.downloading.is_some() {
            return;
        }
        self.busy = true;
        self.error = None;
        self.downloading = Some((id.clone(), 0));
        let (tx, mut rx) = mpsc::unbounded_channel::<DownloadProgress>();
        let task = Tokio::spawn(cx, async move {
            let on_progress: Option<Arc<dyn Fn(DownloadProgress) + Send + Sync>> =
                Some(Arc::new(move |progress| {
                    let _ = tx.send(progress);
                }));
            download_model(&id, on_progress).await
        });
        // Drain progress into the foreground.
        cx.spawn(async move |this, cx| {
            while let Some(progress) = rx.recv().await {
                let percentage = progress.percentage;
                this.update(cx, |this, cx| {
                    this.voice.downloading = Some((progress.id.to_string(), percentage));
                    cx.notify();
                })
                .ok();
            }
        })
        .detach();
        // Wait for the terminal result.
        cx.spawn(async move |this, cx| {
            let result = task.await;
            this.update(cx, |this, cx| {
                this.voice.busy = false;
                this.voice.downloading = None;
                match result {
                    Ok(Ok(())) => {
                        this.voice.error = None;
                        // Refresh the installed flags.
                        let models = list_models();
                        this.voice.models = Some(models);
                    }
                    Ok(Err(error)) => {
                        this.voice.error = Some(format!("Download failed: {error}"));
                    }
                    Err(_) => {
                        this.voice.error = Some("The model download was interrupted.".to_string());
                    }
                }
                cx.notify();
            })
            .ok();
        })
        .detach();
        cx.notify();
    }

    /// Delete an installed Parakeet model (background executor; the manager's
    /// delete is plain `std::fs`). A deleted model that was the dictation
    /// selection is cleared from settings so the mic prompts to pick another.
    fn remove(&mut self, id: String, cx: &mut Context<SettingsView>) {
        if self.busy {
            return;
        }
        self.busy = true;
        self.error = None;
        let clear_selection = self.local_voice_model.as_deref() == Some(id.as_str());
        let services = self.services(cx);
        cx.spawn(async move |this, cx| {
            let result = cx
                .background_spawn(async move {
                    let deleted = delete_model(&id).await;
                    if deleted.is_ok() && clear_selection {
                        let mut patch = serde_json::Map::new();
                        patch.insert(LOCAL_VOICE_MODEL_KEY.to_string(), serde_json::json!(""));
                        let _ = services.config.set_settings(&patch, &|| true);
                    }
                    deleted
                })
                .await;
            this.update(cx, |this, cx| {
                this.voice.busy = false;
                match result {
                    Ok(()) => {
                        this.voice.error = None;
                        if clear_selection {
                            this.voice.local_voice_model = None;
                        }
                        this.voice.models = Some(list_models());
                    }
                    Err(error) => {
                        this.voice.error = Some(format!("Could not remove the model: {error}"));
                    }
                }
                cx.notify();
            })
            .ok();
        })
        .detach();
        cx.notify();
    }
}

/// The microphone permission probe (read-only; unknown off-macOS).
fn microphone_permission() -> MicrophonePermission {
    aiden_mac::audio::microphone_permission()
}

impl SettingsView {
    /// The Voice section: provider picker + on-device engine panel.
    pub(crate) fn voice_section(
        &self,
        _window: &mut Window,
        cx: &mut Context<Self>,
    ) -> impl IntoElement {
        let theme = cx.theme().clone();
        let state = &self.voice;
        v_flex()
            .id("voice-section")
            .w_full()
            .gap_4()
            .child(
                v_flex()
                    .child(
                        div()
                            .text_lg()
                            .font_weight(FontWeight::SEMIBOLD)
                            .child("Voice & dictation"),
                    )
                    .child(
                        div()
                            .text_sm()
                            .text_color(theme.muted_foreground)
                            .mt_0p5()
                            .child(
                                "Transcription for the composer's mic button and the dictation \
                                 hotkey. Cloud providers reuse the keys configured under \
                                 Providers; on-device runs Parakeet locally.",
                            ),
                    ),
            )
            .child(
                v_flex()
                    .w_full()
                    .gap_2()
                    .rounded_lg()
                    .border_1()
                    .border_color(theme.border)
                    .px_4()
                    .py_3()
                    .child(
                        div()
                            .text_sm()
                            .font_weight(FontWeight::SEMIBOLD)
                            .child("Voice input"),
                    )
                    .child(
                        h_flex()
                            .w_full()
                            .gap_2()
                            .items_center()
                            .child(
                                div()
                                    .text_xs()
                                    .font_weight(FontWeight::MEDIUM)
                                    .text_color(theme.muted_foreground)
                                    .child("Provider"),
                            )
                            .child(
                                h_flex().gap_2().children(
                                    [
                                        VoiceProvider::Openai,
                                        VoiceProvider::Gemini,
                                        VoiceProvider::Local,
                                    ]
                                    .into_iter()
                                    .map(|provider| {
                                        let active = state.provider == provider;
                                        let mut button = Button::new(SharedString::from(format!(
                                            "voice-provider-{}",
                                            provider.as_str()
                                        )))
                                        .outline()
                                        .small();
                                        if active {
                                            button = button.primary();
                                        }
                                        button
                                            .label(provider.label())
                                            .disabled(state.busy)
                                            .on_click(cx.listener(
                                                move |this, _event, _window, cx| {
                                                    this.voice.set_provider(provider, cx);
                                                },
                                            ))
                                    }),
                                ),
                            ),
                    )
                    .child(div().text_xs().text_color(theme.muted_foreground).child(
                        match state.provider {
                            VoiceProvider::Local => {
                                "Transcribes on this Mac after an on-device model is \
                                     downloaded."
                            }
                            VoiceProvider::Openai => {
                                "Sends recordings to OpenAI for transcription."
                            }
                            VoiceProvider::Gemini => {
                                "Sends recordings to Google for transcription."
                            }
                        },
                    ))
                    .when(state.provider == VoiceProvider::Local, |el| {
                        el.child(self.on_device_panel(cx))
                    }),
            )
            .when_some(state.error.clone(), |el, message| {
                el.child(
                    div()
                        .w_full()
                        .px_3()
                        .py_2()
                        .rounded_md()
                        .bg(theme.danger.opacity(0.12))
                        .text_sm()
                        .text_color(theme.danger)
                        .child(message),
                )
            })
    }

    /// The on-device engine panel: models, selected model, mic permission.
    fn on_device_panel(&self, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = cx.theme().clone();
        let state = &self.voice;
        let models = state.models.as_deref();
        v_flex()
            .w_full()
            .gap_2()
            .child(
                h_flex()
                    .w_full()
                    .items_center()
                    .justify_between()
                    .child(
                        div()
                            .text_sm()
                            .font_weight(FontWeight::SEMIBOLD)
                            .child("On-device engine"),
                    )
                    .child(
                        div()
                            .px_1p5()
                            .py_0p5()
                            .rounded_md()
                            .bg(theme.info.opacity(0.14))
                            .text_xs()
                            .text_color(theme.info)
                            .child("Parakeet"),
                    ),
            )
            .child(div().text_xs().text_color(theme.muted_foreground).child(
                "Download a model to transcribe locally. The selected model is used by \
                         the dictation shortcut.",
            ))
            .child(self.mic_permission_row(state.mic_permission, cx))
            .child(
                div()
                    .w_full()
                    .rounded_md()
                    .border_1()
                    .border_color(theme.border)
                    .children(
                        models
                            .map(|models| {
                                let border = theme.border;
                                models
                                    .iter()
                                    .enumerate()
                                    .map(move |(index, model)| {
                                        self.model_row(model, index, border, cx)
                                    })
                                    .collect::<Vec<_>>()
                            })
                            .unwrap_or_default(),
                    ),
            )
            .when(models.is_none(), |el| {
                el.child(
                    div()
                        .text_xs()
                        .text_color(theme.muted_foreground)
                        .child("Checking for on-device models…"),
                )
            })
    }

    /// One Parakeet model row: name + size, select/download/delete actions.
    fn model_row(
        &self,
        model: &LocalModel,
        index: usize,
        border: gpui::Hsla,
        cx: &mut Context<Self>,
    ) -> impl IntoElement {
        let theme = cx.theme().clone();
        let state = &self.voice;
        let id = model.id.clone();
        let name = model.name.to_string();
        let size_label = model.size_label.to_string();
        let languages_label = model.languages_label.to_string();
        let installed = model.installed;
        let selected = state.local_voice_model.as_deref() == Some(id.as_str());
        let downloading_this = state
            .downloading
            .as_ref()
            .is_some_and(|(downloading_id, _)| downloading_id == &id);
        let progress = state
            .downloading
            .as_ref()
            .map(|(_, percentage)| *percentage);
        let busy = state.busy && !downloading_this;
        let mut row = div()
            .id(SharedString::from(format!("voice-model-{id}")))
            .w_full()
            .when(index > 0, |el| el.border_t_1().border_color(border))
            .px_3()
            .py_2p5()
            .gap_3()
            .items_center();
        if installed && !busy {
            row = row.cursor_pointer().on_click(cx.listener({
                let id = id.clone();
                move |this, _event, _window, cx| {
                    this.voice.select_local_model(id.clone(), cx);
                }
            }));
        }
        row.child(
            v_flex()
                .flex_1()
                .min_w(px(0.))
                .child(
                    h_flex()
                        .gap_2()
                        .items_center()
                        .child(div().text_sm().font_weight(FontWeight::MEDIUM).child(name))
                        .child(
                            div()
                                .px_1p5()
                                .py_0p5()
                                .rounded_md()
                                .bg(if installed {
                                    theme.success
                                } else {
                                    theme.muted_foreground
                                }
                                .opacity(0.14))
                                .text_xs()
                                .text_color(if installed {
                                    theme.success
                                } else {
                                    theme.muted_foreground
                                })
                                .child(if installed {
                                    "Installed"
                                } else {
                                    "Not installed"
                                }),
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
                                    .child("Dictation model"),
                            )
                        }),
                )
                .child(
                    div()
                        .text_xs()
                        .text_color(theme.muted_foreground)
                        .child(format!(
                            "{size_label} · {languages_label}{}",
                            if model.recommended {
                                " · Recommended"
                            } else {
                                ""
                            }
                        )),
                ),
        )
        .child(if downloading_this {
            v_flex()
                .items_end()
                .gap_0p5()
                .child(
                    div()
                        .text_xs()
                        .text_color(theme.accent)
                        .child(format!("Downloading… {}%", progress.unwrap_or(0))),
                )
                .child(
                    div()
                        .w(px(96.))
                        .h(px(4.))
                        .rounded_full()
                        .bg(theme.muted)
                        .child(
                            div()
                                .h_full()
                                .rounded_full()
                                .bg(theme.accent)
                                .w(gpui::relative(progress.unwrap_or(0) as f32 / 100.0)),
                        ),
                )
                .into_any_element()
        } else if installed {
            h_flex()
                .gap_2()
                .child(
                    Button::new(SharedString::from(format!("voice-delete-{id}")))
                        .small()
                        .ghost()
                        .icon(IconName::Delete)
                        .label("Delete")
                        .disabled(busy)
                        .on_click(cx.listener({
                            let id = id.clone();
                            move |this, _event, _window, cx| {
                                this.voice.remove(id.clone(), cx);
                            }
                        })),
                )
                .into_any_element()
        } else {
            Button::new(SharedString::from(format!("voice-download-{id}")))
                .small()
                .icon(IconName::ArrowDown)
                .label("Download")
                .disabled(busy)
                .on_click(cx.listener({
                    let id = id.clone();
                    move |this, _event, _window, cx| {
                        this.voice.download(id.clone(), cx);
                    }
                }))
                .into_any_element()
        })
    }

    /// The microphone permission status row.
    fn mic_permission_row(
        &self,
        permission: Option<MicrophonePermission>,
        cx: &mut Context<Self>,
    ) -> impl IntoElement {
        let theme = cx.theme().clone();
        let (label, color) = match permission {
            Some(MicrophonePermission::Granted) => ("Granted", theme.success),
            Some(MicrophonePermission::Denied) => ("Denied", theme.danger),
            Some(MicrophonePermission::Undetermined) => {
                ("Not requested yet", theme.muted_foreground)
            }
            Some(MicrophonePermission::Unknown) | None => ("Unknown", theme.muted_foreground),
        };
        h_flex()
            .w_full()
            .items_center()
            .justify_between()
            .child(
                div()
                    .text_sm()
                    .font_weight(FontWeight::MEDIUM)
                    .child("Microphone access"),
            )
            .child(
                h_flex()
                    .gap_2()
                    .items_center()
                    .child(
                        div()
                            .px_1p5()
                            .py_0p5()
                            .rounded_md()
                            .bg(color.opacity(0.14))
                            .text_xs()
                            .text_color(color)
                            .child(label),
                    )
                    .when(permission == Some(MicrophonePermission::Denied), |el| {
                        el.child(div().text_xs().text_color(theme.muted_foreground).child(
                            "Grant access in System Settings → Privacy & Security → Microphone",
                        ))
                    }),
            )
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn provider_defaults_to_openai_and_parses() {
        let mut settings = serde_json::Map::new();
        assert_eq!(
            voice_provider_from_settings(&settings),
            VoiceProvider::Openai
        );
        settings.insert(VOICE_PROVIDER_KEY.to_string(), serde_json::json!("local"));
        assert_eq!(
            voice_provider_from_settings(&settings),
            VoiceProvider::Local
        );
        settings.insert(VOICE_PROVIDER_KEY.to_string(), serde_json::json!("future"));
        assert_eq!(
            voice_provider_from_settings(&settings),
            VoiceProvider::Openai
        );
    }

    #[test]
    fn cloud_defaults_exist_for_both_cloud_providers() {
        assert_eq!(
            default_cloud_model(VoiceProvider::Openai),
            Some("whisper-1")
        );
        assert_eq!(
            default_cloud_model(VoiceProvider::Gemini),
            Some("gemini-2.0-flash")
        );
        assert_eq!(default_cloud_model(VoiceProvider::Local), None);
    }
}
