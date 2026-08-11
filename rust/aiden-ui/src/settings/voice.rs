//! Voice & dictation settings (port of `voice-settings.tsx` +
//! `local-voice-settings.tsx`).
//!
//! The app-owned authority exposes configured OpenAI/Gemini transcription and
//! truthful on-device transcription, plus the Parakeet model catalog with
//! download/delete, selected model, and microphone permission probe.
//!
//! Persisted keys are normalized by the app-owned [`VoiceAuthority`]. Downloads
//! touch the network only on the explicit
//! Download button (the same rule as the TS manager). Everything runs off the
//! foreground: catalog reads + keychain writes on the background executor,
//! downloads on the tokio bridge (the download manager uses `tokio::spawn` +
//! `tokio::fs` — see the runtime contract in `main.rs`).

use std::sync::Arc;

use aiden_mac::audio::MicrophonePermission;
use aiden_mac::local_models::{
    cancel_download, delete_model, download_model, list_models, DownloadProgress, LocalModel,
    ModelError,
};
use gpui::{
    div, prelude::FluentBuilder as _, px, AnyElement, AppContext as _, Context, Entity, FontWeight,
    InteractiveElement as _, IntoElement, ParentElement as _, SharedString, Styled as _, Window,
};
use gpui_component::{
    button::{Button, ButtonVariants as _},
    h_flex,
    select::{Select, SelectEvent, SelectItem, SelectState},
    v_flex, ActiveTheme, Disableable as _, IconName, Sizable as _,
};
use gpui_tokio_bridge::Tokio;
use tokio::sync::mpsc;

use super::{SettingsEvent, SettingsServices, SettingsView};
use crate::services::voice::{
    CloudVoiceOption, VoiceProvider, GEMINI_MODELS, LOCAL_VOICE_MODEL_KEY, OPENAI_MODELS,
    VOICE_MIGRATION_NOTICE_KEY, VOICE_MODEL_KEY, VOICE_PROVIDER_KEY,
};
use crate::settings::SettingsSection;
use aiden_core::keybindings::{pretty_accelerator, GlobalShortcutState};

#[derive(Clone)]
struct VoiceProviderItem {
    value: VoiceProvider,
    label: SharedString,
}

impl SelectItem for VoiceProviderItem {
    type Value = VoiceProvider;

    fn title(&self) -> SharedString {
        self.label.clone()
    }

    fn value(&self) -> &Self::Value {
        &self.value
    }
}

#[derive(Clone)]
struct VoiceModelItem {
    value: String,
}

impl SelectItem for VoiceModelItem {
    type Value = String;

    fn title(&self) -> SharedString {
        self.value.clone().into()
    }

    fn value(&self) -> &Self::Value {
        &self.value
    }
}

fn cloud_setup_event(option: &CloudVoiceOption) -> SettingsEvent {
    SettingsEvent::PiProviderSetupRequested {
        provider_id: option.setup_provider_id.to_string(),
        label: option.setup_label.to_string(),
        authority_revision: option.authority_revision,
    }
}

#[derive(Default)]
pub struct VoiceState {
    pub provider: VoiceProvider,
    pub cloud_model: Option<String>,
    pub cloud_options: Vec<CloudVoiceOption>,
    /// Provider and cloud-model selectors are retained so keyboard focus and
    /// open menus survive ordinary settings re-renders.
    provider_select: Option<Entity<SelectState<Vec<VoiceProviderItem>>>>,
    cloud_model_select: Option<Entity<SelectState<Vec<VoiceModelItem>>>>,
    /// The selected on-device model id (`localVoiceModel`).
    pub local_voice_model: Option<String>,
    /// A legacy cloud choice was moved to the supported local runtime.
    pub migrated_to_local: bool,
    /// The Parakeet catalog with installed flags (None = still loading).
    pub models: Option<Vec<LocalModel>>,
    /// Microphone permission (None = still probing).
    pub mic_permission: Option<MicrophonePermission>,
    /// Bundled local engine readiness. This is a local capability read only;
    /// it never downloads a model or contacts a provider.
    pub engine_status: Option<Result<(), String>>,
    /// Accessibility trust used for auto-pasting dictated text. `None` means
    /// the local-only status read has not completed yet.
    pub accessibility_trusted: Option<bool>,
    /// Whether the explicit model-management controls are expanded.
    models_manager_open: bool,
    /// The model id currently downloading (with a progress percentage).
    pub downloading: Option<(String, u8)>,
    pub busy: bool,
    pub error: Option<String>,
    /// Monotonic owner for every asynchronous Voice Settings operation.
    /// Completions from an older provider/model/runtime snapshot are inert.
    operation_revision: u64,
    /// Section/document lifetime fence. Leaving Voice invalidates probes and
    /// writes even when their operation revision happens to be reused.
    lifecycle_revision: u64,
    _subscriptions: Vec<gpui::Subscription>,
}

impl VoiceState {
    pub fn hydrate(&mut self, settings: &serde_json::Map<String, serde_json::Value>) {
        self.operation_revision = self.operation_revision.saturating_add(1);
        self.busy = false;
        self.provider = match settings
            .get(VOICE_PROVIDER_KEY)
            .and_then(|value| value.as_str())
        {
            Some("openai") => VoiceProvider::OpenAi,
            Some("gemini") => VoiceProvider::Gemini,
            _ => VoiceProvider::Local,
        };
        self.cloud_model = settings
            .get(VOICE_MODEL_KEY)
            .and_then(|value| value.as_str())
            .filter(|value| !value.is_empty())
            .map(str::to_string);
        self.local_voice_model = settings
            .get(LOCAL_VOICE_MODEL_KEY)
            .and_then(|value| value.as_str())
            .map(str::to_string);
        self.migrated_to_local = settings
            .get(VOICE_MIGRATION_NOTICE_KEY)
            .and_then(serde_json::Value::as_bool)
            .unwrap_or(false);
    }

    fn begin_operation(&mut self) -> (u64, u64) {
        self.operation_revision = self.operation_revision.saturating_add(1);
        (self.operation_revision, self.lifecycle_revision)
    }

    fn operation_is_current(&self, operation: u64, lifecycle: u64) -> bool {
        self.operation_revision == operation && self.lifecycle_revision == lifecycle
    }

    /// Invalidate all Voice completions when Settings leaves this section.
    pub(crate) fn leave_section(&mut self) {
        self.lifecycle_revision = self.lifecycle_revision.saturating_add(1);
        self.operation_revision = self.operation_revision.saturating_add(1);
        if let Some((id, _)) = self.downloading.take() {
            let _ = cancel_download(&id);
        }
        self.busy = false;
    }

    /// Load local-only runtime facts on the background executor.
    ///
    /// Electron only asks for the on-device engine/model/accessibility facts
    /// while the local provider panel is mounted. Keep the same boundary here:
    /// cloud-only Voice settings still expose provider options without probing
    /// the microphone, Accessibility, or the bundled engine. No operation in
    /// this method contacts a network or downloads a model.
    pub(crate) fn load_runtime(
        &mut self,
        services: &SettingsServices,
        cx: &mut Context<SettingsView>,
    ) {
        let local = self.provider == VoiceProvider::Local;
        let (operation, lifecycle) = self.begin_operation();
        let voice = services.voice.clone();
        cx.spawn(async move |this, cx| {
            let (models, mic, engine, accessibility, cloud_options) = cx
                .background_spawn(async move {
                    let local_runtime = local.then(|| {
                        (
                            list_models(),
                            microphone_permission(),
                            local_engine_status(),
                            aiden_mac::paste::MacPasteDeps::accessibility_trusted(),
                        )
                    });
                    (
                        local_runtime.as_ref().map(|runtime| runtime.0.clone()),
                        local_runtime.as_ref().map(|runtime| runtime.1),
                        local_runtime.as_ref().map(|runtime| runtime.2.clone()),
                        local_runtime.as_ref().map(|runtime| runtime.3),
                        voice.cloud_options(),
                    )
                })
                .await;
            this.update(cx, |this, cx| {
                if !this.voice.operation_is_current(operation, lifecycle) {
                    return;
                }
                this.voice.models = models;
                this.voice.mic_permission = mic;
                this.voice.engine_status = engine;
                this.voice.accessibility_trusted = accessibility;
                this.voice.cloud_options = cloud_options;
                cx.notify();
            })
            .ok();
        })
        .detach();
    }

    fn select_provider(
        &mut self,
        provider: VoiceProvider,
        services: &SettingsServices,
        cx: &mut Context<SettingsView>,
    ) {
        if self.busy || provider == self.provider {
            return;
        }
        let cloud_model = self
            .cloud_options
            .iter()
            .find(|option| option.provider == provider)
            .and_then(|option| {
                self.cloud_model
                    .as_deref()
                    .filter(|model| option.models.contains(model))
                    .or_else(|| option.models.first().copied())
            })
            .map(str::to_string);
        self.busy = true;
        self.error = None;
        let (operation, lifecycle) = self.begin_operation();
        let authority = services.voice.clone();
        cx.spawn(async move |this, cx| {
            let selected_model = cloud_model.clone();
            let result = cx
                .background_spawn(async move {
                    match provider {
                        VoiceProvider::Local => authority.select_local(),
                        VoiceProvider::OpenAi | VoiceProvider::Gemini => authority
                            .select_cloud_model(
                                provider,
                                selected_model.as_deref().unwrap_or_default(),
                            ),
                    }
                })
                .await;
            this.update(cx, |this, cx| {
                if !this.voice.operation_is_current(operation, lifecycle) {
                    return;
                }
                this.voice.busy = false;
                let succeeded = result.is_ok();
                match result {
                    Ok(()) => {
                        this.voice.provider = provider;
                        this.voice.cloud_model = cloud_model;
                        if provider != VoiceProvider::Local {
                            // The local panel is not mounted for cloud Voice;
                            // discard stale capability snapshots so a later
                            // provider switch cannot present old readiness.
                            this.voice.models = None;
                            this.voice.mic_permission = None;
                            this.voice.engine_status = None;
                            this.voice.accessibility_trusted = None;
                        }
                        this.voice.error = None;
                    }
                    Err(error) => this.voice.error = Some(error.to_string()),
                }
                if succeeded && provider == VoiceProvider::Local {
                    let services = this.services.clone();
                    this.voice.load_runtime(&services, cx);
                }
                cx.notify();
            })
            .ok();
        })
        .detach();
        cx.notify();
    }

    fn select_cloud_model(
        &mut self,
        provider: VoiceProvider,
        model: String,
        services: &SettingsServices,
        cx: &mut Context<SettingsView>,
    ) {
        if self.busy {
            return;
        }
        self.busy = true;
        self.error = None;
        let (operation, lifecycle) = self.begin_operation();
        let authority = services.voice.clone();
        cx.spawn(async move |this, cx| {
            let model_value = model.clone();
            let result = cx
                .background_spawn(
                    async move { authority.select_cloud_model(provider, &model_value) },
                )
                .await;
            this.update(cx, |this, cx| {
                if !this.voice.operation_is_current(operation, lifecycle) {
                    return;
                }
                this.voice.busy = false;
                match result {
                    Ok(()) => {
                        this.voice.provider = provider;
                        this.voice.cloud_model = Some(model);
                        this.voice.error = None;
                    }
                    Err(error) => this.voice.error = Some(error.to_string()),
                }
                cx.notify();
            })
            .ok();
        })
        .detach();
        cx.notify();
    }

    /// Select the on-device model used for dictation.
    fn select_local_model(
        &mut self,
        id: String,
        services: &SettingsServices,
        cx: &mut Context<SettingsView>,
    ) {
        if self.busy {
            return;
        }
        self.busy = true;
        self.error = None;
        let (operation, lifecycle) = self.begin_operation();
        let id_value = id.clone();
        let authority = services.voice.clone();
        cx.spawn(async move |this, cx| {
            let result = cx
                .background_spawn(async move { authority.select_local_model(&id_value) })
                .await;
            this.update(cx, |this, cx| {
                if !this.voice.operation_is_current(operation, lifecycle) {
                    return;
                }
                this.voice.busy = false;
                if result.is_ok() {
                    this.voice.local_voice_model = Some(id);
                    this.voice.migrated_to_local = false;
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
        let (operation, lifecycle) = self.begin_operation();
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
                    if !this.voice.operation_is_current(operation, lifecycle) {
                        return;
                    }
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
                if !this.voice.operation_is_current(operation, lifecycle) {
                    return;
                }
                this.voice.busy = false;
                this.voice.downloading = None;
                match result {
                    Ok(Ok(())) => {
                        this.voice.error = None;
                        // Refresh the installed flags.
                        let models = list_models();
                        this.voice.models = Some(models);
                    }
                    Ok(Err(ModelError::Cancelled)) => {
                        this.voice.error = None;
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

    fn cancel_download(&mut self, id: &str, cx: &mut Context<SettingsView>) {
        if self
            .downloading
            .as_ref()
            .is_some_and(|(active, _)| active == id)
        {
            let _ = cancel_download(id);
            cx.notify();
        }
    }

    /// Delete an installed Parakeet model (background executor; the manager's
    /// delete is plain `std::fs`). A deleted model that was the dictation
    /// selection is cleared from settings so the mic prompts to pick another.
    fn remove(&mut self, id: String, services: &SettingsServices, cx: &mut Context<SettingsView>) {
        if self.busy {
            return;
        }
        self.busy = true;
        self.error = None;
        let (operation, lifecycle) = self.begin_operation();
        let authority = services.voice.clone();
        cx.spawn(async move |this, cx| {
            let result = cx
                .background_spawn(async move {
                    let clear_selection = authority
                        .clear_selected_model(&id)
                        .map_err(|_| "Could not update the voice selection.".to_string())?;
                    let deleted = delete_model(&id).await.map_err(|error| error.to_string());
                    Ok::<_, String>((clear_selection, deleted))
                })
                .await;
            this.update(cx, |this, cx| {
                if !this.voice.operation_is_current(operation, lifecycle) {
                    return;
                }
                this.voice.busy = false;
                match result {
                    Ok((clear_selection, Ok(()))) => {
                        this.voice.error = None;
                        if clear_selection {
                            this.voice.local_voice_model = None;
                        }
                        this.voice.models = Some(list_models());
                    }
                    Ok((clear_selection, Err(error))) => {
                        if clear_selection {
                            this.voice.local_voice_model = None;
                        }
                        this.voice.error = Some(format!("Could not remove the model: {error}"));
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

/// Return the bundled on-device engine capability without touching model
/// storage or the network. `sherpa` is optional so development builds that
/// omit the large native dependency fail closed with an actionable message.
fn local_engine_status() -> Result<(), String> {
    #[cfg(feature = "dictation")]
    {
        aiden_mac::sherpa::engine_status()
    }
    #[cfg(not(feature = "dictation"))]
    {
        Err("On-device dictation isn't built into this app build.".to_string())
    }
}

fn provider_description(provider: VoiceProvider) -> &'static str {
    match provider {
        VoiceProvider::Local => "Runs with a downloaded Parakeet model; audio stays on this Mac.",
        VoiceProvider::OpenAi => "Sends each completed recording to OpenAI for transcription.",
        VoiceProvider::Gemini => {
            "Sends each completed recording to Google Gemini for transcription."
        }
    }
}

impl SettingsView {
    fn voice_provider_items(&self) -> Vec<VoiceProviderItem> {
        let mut items = vec![VoiceProviderItem {
            value: VoiceProvider::Local,
            label: "On-device (Parakeet)".into(),
        }];
        let mut seen = [false; 2];
        for option in &self.voice.cloud_options {
            let (index, name) = match option.provider {
                VoiceProvider::OpenAi => (0, "OpenAI"),
                VoiceProvider::Gemini => (1, "Google Gemini"),
                VoiceProvider::Local => continue,
            };
            if seen[index] {
                continue;
            }
            seen[index] = true;
            let suffix = if option.configured {
                ""
            } else {
                " · Set up required"
            };
            items.push(VoiceProviderItem {
                value: option.provider,
                label: format!("{name}{suffix}").into(),
            });
        }
        // Keep the selector truthful during the short cloud-options loading
        // window and when a legacy settings snapshot names a cloud provider.
        if !seen[0] {
            items.push(VoiceProviderItem {
                value: VoiceProvider::OpenAi,
                label: "OpenAI · Set up required".into(),
            });
        }
        if !seen[1] {
            items.push(VoiceProviderItem {
                value: VoiceProvider::Gemini,
                label: "Google Gemini · Set up required".into(),
            });
        }
        items
    }

    fn ensure_voice_provider_select(
        &mut self,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Entity<SelectState<Vec<VoiceProviderItem>>> {
        let items = self.voice_provider_items();
        let selected = self.voice.provider;
        if let Some(state) = self.voice.provider_select.clone() {
            state.update(cx, |state, cx| {
                state.set_items(items, window, cx);
                state.set_selected_value(&selected, window, cx);
            });
            return state;
        }
        let selected_index = items
            .iter()
            .position(|item| item.value == selected)
            .map(|row| gpui_component::IndexPath::default().row(row));
        let state = cx.new(|cx| SelectState::new(items, selected_index, window, cx));
        self.voice._subscriptions.push(cx.subscribe_in(
            &state,
            window,
            |this, _state, event, _window, cx| {
                let SelectEvent::Confirm(Some(provider)) = event else {
                    return;
                };
                let provider = *provider;
                if provider == this.voice.provider {
                    return;
                }
                if let Some(option) = this
                    .voice
                    .cloud_options
                    .iter()
                    .find(|option| option.provider == provider)
                    .filter(|option| !option.configured)
                {
                    cx.emit(cloud_setup_event(option));
                    this.voice.error = None;
                    cx.notify();
                    return;
                }
                let services = this.services.clone();
                this.voice.select_provider(provider, &services, cx);
            },
        ));
        self.voice.provider_select = Some(state.clone());
        state
    }

    fn voice_model_items(&self) -> Vec<VoiceModelItem> {
        let models: &[&str] = match self.voice.provider {
            VoiceProvider::OpenAi => self
                .voice
                .cloud_options
                .iter()
                .find(|option| option.provider == VoiceProvider::OpenAi)
                .map(|option| option.models)
                .unwrap_or(OPENAI_MODELS),
            VoiceProvider::Gemini => self
                .voice
                .cloud_options
                .iter()
                .find(|option| option.provider == VoiceProvider::Gemini)
                .map(|option| option.models)
                .unwrap_or(GEMINI_MODELS),
            VoiceProvider::Local => &[],
        };
        models
            .iter()
            .map(|model| VoiceModelItem {
                value: (*model).to_string(),
            })
            .collect()
    }

    fn ensure_voice_model_select(
        &mut self,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Entity<SelectState<Vec<VoiceModelItem>>> {
        let items = self.voice_model_items();
        let selected = self
            .voice
            .cloud_model
            .clone()
            .or_else(|| items.first().map(|item| item.value.clone()));
        if let Some(state) = self.voice.cloud_model_select.clone() {
            state.update(cx, |state, cx| {
                state.set_items(items, window, cx);
                if let Some(selected) = selected.as_ref() {
                    state.set_selected_value(selected, window, cx);
                }
            });
            return state;
        }
        let selected_index = selected.as_ref().and_then(|selected| {
            self.voice_model_items()
                .iter()
                .position(|item| &item.value == selected)
                .map(|row| gpui_component::IndexPath::default().row(row))
        });
        let state = cx.new(|cx| SelectState::new(items, selected_index, window, cx));
        self.voice._subscriptions.push(cx.subscribe_in(
            &state,
            window,
            |this, _state, event, _window, cx| {
                let SelectEvent::Confirm(Some(model)) = event else {
                    return;
                };
                let provider = this.voice.provider;
                let services = this.services.clone();
                this.voice
                    .select_cloud_model(provider, model.clone(), &services, cx);
            },
        ));
        self.voice.cloud_model_select = Some(state.clone());
        state
    }

    /// The Voice section: provider selection plus the on-device model manager.
    pub(crate) fn voice_section(
        &mut self,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> impl IntoElement {
        let theme = cx.theme().clone();
        let provider_select = self.ensure_voice_provider_select(window, cx);
        let provider = self.voice.provider;
        let selected_cloud_configured = self
            .voice
            .cloud_options
            .iter()
            .any(|option| option.provider == provider && option.configured);
        let setup_options = self
            .voice
            .cloud_options
            .iter()
            .filter(|option| !option.configured)
            .cloned()
            .collect::<Vec<_>>();
        let migrated_to_local = self.voice.migrated_to_local;
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
                                "Choose on-device transcription or a configured cloud provider. \
                                 Recording starts only from the composer mic or dictation hotkey; \
                                 Aiden never saves or logs audio.",
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
                    .child(div().text_xs().text_color(theme.muted_foreground).child(
                        "On-device audio stays on this Mac. Cloud audio is sent only to the provider you explicitly select after recording.",
                    ))
                    .child(
                        h_flex()
                            .w_full()
                            .items_center()
                            .justify_between()
                            .gap_3()
                            .child(
                                v_flex()
                                    .flex_1()
                                    .min_w(px(0.))
                                    .child(div().text_sm().font_weight(FontWeight::MEDIUM).child("Provider"))
                                    .child(div().text_xs().text_color(theme.muted_foreground).child(
                                        provider_description(self.voice.provider),
                                    )),
                            )
                            .child(
                                Select::new(&provider_select)
                                    .small()
                                    .w(px(220.))
                                    .disabled(self.voice.busy),
                            ),
                    )
                    .children(setup_options.into_iter().map(|option| {
                        self.voice_provider_setup_row(option, cx)
                    }))
                    .when(provider == VoiceProvider::Local, |el| {
                        el.child(self.on_device_panel(cx))
                    })
                    .when(selected_cloud_configured, |el| {
                        el.child(self.cloud_model_panel(window, cx))
                    }),
            )
            .when(migrated_to_local, |el| {
                el.child(
                    div()
                        .w_full()
                        .px_3()
                        .py_2()
                        .rounded_md()
                        .bg(theme.info.opacity(0.12))
                        .text_sm()
                        .text_color(theme.info)
                        .child("An earlier build moved Voice to On-device. Configured OpenAI or Google Gemini transcription can now be selected here."),
                )
            })
            .when_some(self.voice.error.clone(), |el, message| {
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

    fn voice_provider_setup_row(
        &self,
        option: CloudVoiceOption,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let theme = cx.theme().clone();
        h_flex()
            .w_full()
            .items_center()
            .justify_between()
            .gap_3()
            .px_3()
            .py_2()
            .rounded_md()
            .border_1()
            .border_color(theme.border)
            .child(
                v_flex()
                    .flex_1()
                    .min_w(px(0.))
                    .child(
                        div()
                            .text_sm()
                            .font_weight(FontWeight::MEDIUM)
                            .child(format!("{} setup required", option.setup_label)),
                    )
                    .child(div().text_xs().text_color(theme.muted_foreground).child(
                        "Voice uses the same provider credential configured in Settings → Providers.",
                    )),
            )
            .child(
                Button::new(SharedString::from(format!(
                    "voice-setup-{}",
                    option.setup_provider_id
                )))
                .small()
                .outline()
                .label("Set up in Providers")
                .on_click(cx.listener(move |_this, _event, _window, cx| {
                    cx.emit(cloud_setup_event(&option));
                })),
            )
            .into_any_element()
    }

    fn cloud_model_panel(&mut self, window: &mut Window, cx: &mut Context<Self>) -> AnyElement {
        let theme = cx.theme().clone();
        let provider = self.voice.provider;
        let model_select = self.ensure_voice_model_select(window, cx);
        let models = self
            .voice
            .cloud_options
            .iter()
            .find(|option| option.provider == provider)
            .map(|option| option.models)
            .unwrap_or_default();
        v_flex()
            .w_full()
            .gap_2()
            .child(
                div()
                    .text_sm()
                    .font_weight(FontWeight::SEMIBOLD)
                    .child("Transcription model"),
            )
            .child(
                h_flex()
                    .items_center()
                    .gap_3()
                    .child(
                        Select::new(&model_select)
                            .small()
                            .w(px(260.))
                            .disabled(self.voice.busy),
                    )
                    .child(
                        div()
                            .text_xs()
                            .text_color(theme.muted_foreground)
                            .child(format!("{} model options", models.len())),
                    ),
            )
            .child(
                div()
                    .text_xs()
                    .text_color(theme.muted_foreground)
                    .child("The exact provider key and model are fixed before microphone capture; changing or signing out cancels the recording."),
            )
            .into_any_element()
    }

    fn engine_status_row(&self, cx: &mut Context<Self>) -> AnyElement {
        let theme = cx.theme().clone();
        let content = match self.voice.engine_status.as_ref() {
            None => h_flex()
                .gap_2()
                .items_center()
                .child(
                    div()
                        .px_1p5()
                        .py_0p5()
                        .rounded_md()
                        .bg(theme.muted.opacity(0.14))
                        .text_xs()
                        .text_color(theme.muted_foreground)
                        .child("Checking…"),
                )
                .into_any_element(),
            Some(Ok(())) => h_flex()
                .gap_2()
                .items_center()
                .child(
                    div()
                        .px_1p5()
                        .py_0p5()
                        .rounded_md()
                        .bg(theme.success.opacity(0.14))
                        .text_xs()
                        .text_color(theme.success)
                        .child("Ready"),
                )
                .into_any_element(),
            Some(Err(error)) => v_flex()
                .items_end()
                .gap_0p5()
                .child(
                    div()
                        .px_1p5()
                        .py_0p5()
                        .rounded_md()
                        .bg(theme.danger.opacity(0.14))
                        .text_xs()
                        .text_color(theme.danger)
                        .child("Unavailable"),
                )
                .child(
                    div()
                        .max_w(px(280.))
                        .text_xs()
                        .text_color(theme.danger)
                        .child(error.clone()),
                )
                .into_any_element(),
        };
        h_flex()
            .id("voice-engine-status")
            .w_full()
            .items_start()
            .justify_between()
            .gap_3()
            .child(
                v_flex()
                    .flex_1()
                    .min_w(px(0.))
                    .child(div().text_sm().font_weight(FontWeight::MEDIUM).child("Engine"))
                    .child(
                        div()
                            .text_xs()
                            .text_color(theme.muted_foreground)
                            .child("The bundled Parakeet engine is checked locally; no model is downloaded automatically."),
                    ),
            )
            .child(content)
            .into_any_element()
    }

    fn dictation_hotkey_row(&self, cx: &mut Context<Self>) -> AnyElement {
        let theme = cx.theme().clone();
        let status = self
            .shortcuts
            .global
            .iter()
            .find(|status| status.command_id == aiden_core::CommandId::DictationToggle);
        let binding = self
            .shortcuts
            .effective
            .get(aiden_core::CommandId::DictationToggle.as_str())
            .and_then(|binding| binding.as_deref());
        let (state_label, state_color, detail, can_retry) = match status {
            Some(status) => match status.state {
                GlobalShortcutState::Active => (
                    "Active",
                    theme.success,
                    "Available while Aiden is running.".to_string(),
                    false,
                ),
                GlobalShortcutState::Unavailable => (
                    "Unavailable",
                    theme.danger,
                    status.message.clone().unwrap_or_else(|| {
                        "The global dictation shortcut could not be registered.".to_string()
                    }),
                    true,
                ),
                GlobalShortcutState::Disabled => (
                    "Off",
                    theme.muted_foreground,
                    "Enable the shortcut in Keyboard shortcuts to dictate from anywhere."
                        .to_string(),
                    false,
                ),
            },
            None => (
                "Unavailable",
                theme.muted_foreground,
                "Shortcut runtime status is unavailable.".to_string(),
                true,
            ),
        };
        let binding = pretty_accelerator(binding);
        h_flex()
            .id("voice-dictation-hotkey")
            .w_full()
            .items_start()
            .justify_between()
            .gap_3()
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
                                    .child("Dictation hotkey"),
                            )
                            .child(
                                div()
                                    .text_sm()
                                    .text_color(theme.muted_foreground)
                                    .child(format!("{binding} · {state_label}")),
                            ),
                    )
                    .child(
                        div()
                            .text_xs()
                            .text_color(theme.muted_foreground)
                            .child(detail),
                    ),
            )
            .child(
                h_flex()
                    .gap_2()
                    .items_center()
                    .when(can_retry, |el| {
                        el.child(
                            Button::new("voice-retry-dictation-hotkey")
                                .small()
                                .ghost()
                                .label("Retry")
                                .on_click(cx.listener(|this, _event, _window, cx| {
                                    this.services
                                        .shortcuts
                                        .update(cx, |runtime, cx| runtime.retry_globals(cx));
                                })),
                        )
                    })
                    .child(
                        Button::new("voice-manage-dictation-hotkey")
                            .small()
                            .ghost()
                            .label("Manage shortcuts")
                            .on_click(cx.listener(|this, _event, _window, cx| {
                                this.active = SettingsSection::Shortcut;
                                cx.notify();
                            })),
                    ),
            )
            .child(
                div()
                    .px_1p5()
                    .py_0p5()
                    .rounded_md()
                    .bg(state_color.opacity(0.14))
                    .text_xs()
                    .text_color(state_color)
                    .child(state_label),
            )
            .into_any_element()
    }

    fn accessibility_row(&self, cx: &mut Context<Self>) -> AnyElement {
        let theme = cx.theme().clone();
        let trusted = self.voice.accessibility_trusted;
        h_flex()
            .id("voice-accessibility-access")
            .w_full()
            .items_start()
            .justify_between()
            .gap_3()
            .child(
                v_flex()
                    .flex_1()
                    .min_w(px(0.))
                    .child(
                        div()
                            .text_sm()
                            .font_weight(FontWeight::MEDIUM)
                            .child("Accessibility access"),
                    )
                    .child(
                        div()
                            .text_xs()
                            .text_color(theme.muted_foreground)
                            .child("Lets Aiden paste dictated text into the focused field. Without it, transcripts stay on the clipboard."),
                    ),
            )
            .child(match trusted {
                None => h_flex()
                    .gap_2()
                    .items_center()
                    .child(
                        div()
                            .px_1p5()
                            .py_0p5()
                            .rounded_md()
                            .bg(theme.muted.opacity(0.14))
                            .text_xs()
                            .text_color(theme.muted_foreground)
                            .child("Checking…"),
                    )
                    .into_any_element(),
                Some(true) => h_flex()
                    .gap_2()
                    .items_center()
                    .child(
                        div()
                            .px_1p5()
                            .py_0p5()
                            .rounded_md()
                            .bg(theme.success.opacity(0.14))
                            .text_xs()
                            .text_color(theme.success)
                            .child("Granted"),
                    )
                    .child(
                        Button::new("voice-refresh-accessibility")
                            .small()
                            .ghost()
                            .label("Refresh")
                            .on_click(cx.listener(|this, _event, _window, cx| {
                                this.refresh_accessibility(false, cx);
                            })),
                    )
                    .into_any_element(),
                Some(false) => h_flex()
                    .gap_2()
                    .items_center()
                    .child(
                        div()
                            .px_1p5()
                            .py_0p5()
                            .rounded_md()
                            .bg(theme.warning.opacity(0.14))
                            .text_xs()
                            .text_color(theme.warning)
                            .child("Not granted"),
                    )
                    .child(
                        Button::new("voice-grant-accessibility")
                            .small()
                            .outline()
                            .label("Grant access")
                            .on_click(cx.listener(|this, _event, _window, cx| {
                                this.refresh_accessibility(true, cx);
                            })),
                    )
                    .child(
                        Button::new("voice-refresh-accessibility")
                            .small()
                            .ghost()
                            .label("Refresh")
                            .on_click(cx.listener(|this, _event, _window, cx| {
                                this.refresh_accessibility(false, cx);
                            })),
                    )
                    .into_any_element(),
            })
            .into_any_element()
    }

    fn refresh_accessibility(&mut self, prompt: bool, cx: &mut Context<Self>) {
        let (operation, lifecycle) = self.voice.begin_operation();
        cx.spawn(async move |this, cx| {
            let trusted = cx
                .background_spawn(async move {
                    if prompt {
                        aiden_mac::paste::MacPasteDeps::request_accessibility()
                    } else {
                        aiden_mac::paste::MacPasteDeps::accessibility_trusted()
                    }
                })
                .await;
            this.update(cx, |this, cx| {
                if !this.voice.operation_is_current(operation, lifecycle) {
                    return;
                }
                this.voice.accessibility_trusted = Some(trusted);
                cx.notify();
            })
            .ok();
        })
        .detach();
    }

    /// The on-device engine panel: models, selected model, mic permission.
    fn on_device_panel(&self, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = cx.theme().clone();
        let state = &self.voice;
        let models = state.models.as_deref();
        let model_controls = match models {
            None => div()
                .text_xs()
                .text_color(theme.muted_foreground)
                .child("Checking for on-device models…")
                .into_any_element(),
            Some(models) if !state.models_manager_open => {
                let active = state.local_voice_model.as_deref().and_then(|id| {
                    models
                        .iter()
                        .find(|model| model.id == id && model.installed)
                });
                let copy = active
                    .map(|model| {
                        format!(
                            "{} · {} · {}",
                            model.name, model.size_label, model.languages_label
                        )
                    })
                    .unwrap_or_else(|| {
                        "No installed model selected. Open Manage models to download one."
                            .to_string()
                    });
                h_flex()
                    .w_full()
                    .items_center()
                    .justify_between()
                    .gap_3()
                    .px_3()
                    .py_2()
                    .rounded_md()
                    .bg(theme.muted.opacity(0.08))
                    .child(
                        v_flex()
                            .flex_1()
                            .min_w(px(0.))
                            .child(
                                div()
                                    .text_sm()
                                    .font_weight(FontWeight::MEDIUM)
                                    .child("Active model"),
                            )
                            .child(
                                div()
                                    .text_xs()
                                    .text_color(theme.muted_foreground)
                                    .child(copy),
                            ),
                    )
                    .into_any_element()
            }
            Some(models) => {
                let border = theme.border;
                div()
                    .w_full()
                    .rounded_md()
                    .border_1()
                    .border_color(border)
                    .children(
                        models
                            .iter()
                            .enumerate()
                            .map(|(index, model)| self.model_row(model, index, border, cx))
                            .collect::<Vec<_>>(),
                    )
                    .into_any_element()
            }
        };
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
            .child(self.engine_status_row(cx))
            .child(self.mic_permission_row(state.mic_permission, cx))
            .child(self.dictation_hotkey_row(cx))
            .child(self.accessibility_row(cx))
            .child(
                h_flex()
                    .w_full()
                    .items_center()
                    .justify_between()
                    .child(
                        v_flex()
                            .flex_1()
                            .min_w(px(0.))
                            .child(
                                div()
                                    .text_sm()
                                    .font_weight(FontWeight::MEDIUM)
                                    .child("Models"),
                            )
                            .child(div().text_xs().text_color(theme.muted_foreground).child(
                                "Download, remove, and choose the on-device transcription model.",
                            )),
                    )
                    .child(
                        Button::new("voice-manage-models")
                            .small()
                            .outline()
                            .label(if state.models_manager_open {
                                "Hide models"
                            } else {
                                "Manage models"
                            })
                            .disabled(state.busy && state.downloading.is_none())
                            .on_click(cx.listener(|this, _event, _window, cx| {
                                this.voice.models_manager_open = !this.voice.models_manager_open;
                                cx.notify();
                            })),
                    ),
            )
            .child(model_controls)
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
        let row = div()
            .id(SharedString::from(format!("voice-model-{id}")))
            .w_full()
            .when(index > 0, |el| el.border_t_1().border_color(border))
            .px_3()
            .py_2p5()
            .gap_3()
            .items_center();
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
            h_flex()
                .gap_2()
                .items_center()
                .child(
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
                        ),
                )
                .child(
                    Button::new(SharedString::from(format!("voice-cancel-download-{id}")))
                        .small()
                        .ghost()
                        .label("Cancel")
                        .on_click(cx.listener({
                            let id = id.clone();
                            move |this, _event, _window, cx| {
                                this.voice.cancel_download(&id, cx);
                            }
                        })),
                )
                .into_any_element()
        } else if installed {
            h_flex()
                .gap_2()
                .when(!selected, |el| {
                    el.child(
                        Button::new(SharedString::from(format!("voice-select-{id}")))
                            .small()
                            .outline()
                            .label("Use")
                            .disabled(busy)
                            .on_click(cx.listener({
                                let id = id.clone();
                                move |this, _event, _window, cx| {
                                    this.voice
                                        .select_local_model(id.clone(), &this.services, cx);
                                }
                            })),
                    )
                })
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
                                this.voice.remove(id.clone(), &this.services, cx);
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
    fn hydrate_surfaces_the_local_only_migration_notice_and_exact_selection() {
        let mut settings = serde_json::Map::new();
        settings.insert(
            LOCAL_VOICE_MODEL_KEY.into(),
            serde_json::json!("parakeet-v2"),
        );
        settings.insert(VOICE_MIGRATION_NOTICE_KEY.into(), serde_json::json!(true));
        let mut state = VoiceState::default();
        state.hydrate(&settings);
        assert_eq!(state.local_voice_model.as_deref(), Some("parakeet-v2"));
        assert!(state.migrated_to_local);
    }

    #[test]
    fn hydrate_preserves_an_explicit_cloud_model_and_setup_event_binding() {
        let mut settings = serde_json::Map::new();
        settings.insert(VOICE_PROVIDER_KEY.into(), serde_json::json!("gemini"));
        settings.insert(
            VOICE_MODEL_KEY.into(),
            serde_json::json!("gemini-2.5-flash"),
        );
        let mut state = VoiceState::default();
        state.hydrate(&settings);
        assert_eq!(state.provider, VoiceProvider::Gemini);
        assert_eq!(state.cloud_model.as_deref(), Some("gemini-2.5-flash"));

        let option = CloudVoiceOption {
            provider: VoiceProvider::Gemini,
            configured: false,
            models: crate::services::voice::GEMINI_MODELS,
            setup_provider_id: "google",
            setup_label: "Google",
            authority_revision: 42,
        };
        assert_eq!(
            cloud_setup_event(&option),
            SettingsEvent::PiProviderSetupRequested {
                provider_id: "google".into(),
                label: "Google".into(),
                authority_revision: 42,
            }
        );
    }

    #[test]
    fn older_runtime_completion_is_rejected_after_a_newer_voice_operation() {
        let mut state = VoiceState::default();
        let older = state.begin_operation();
        let newer = state.begin_operation();
        assert!(!state.operation_is_current(older.0, older.1));
        assert!(state.operation_is_current(newer.0, newer.1));
    }

    #[test]
    fn hydration_invalidates_an_in_flight_voice_completion() {
        let mut state = VoiceState::default();
        let older = state.begin_operation();
        state.hydrate(&serde_json::Map::new());
        assert!(!state.operation_is_current(older.0, older.1));
        assert!(!state.busy);
    }

    #[test]
    fn leaving_voice_invalidates_operations_and_cancels_download_state() {
        let mut state = VoiceState::default();
        let older = state.begin_operation();
        state.busy = true;
        state.downloading = Some(("parakeet-v2".into(), 12));
        state.leave_section();
        assert!(!state.operation_is_current(older.0, older.1));
        assert!(!state.busy);
        assert!(state.downloading.is_none());
    }
}
