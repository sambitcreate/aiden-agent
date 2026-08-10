//! Onboarding flow (port of `renderer/components/onboarding-flow.tsx` +
//! `onboarding-flow.test.tsx`).
//!
//! [`OnboardingView`] is an `Entity + Render` flow view backed by the pure
//! step-state machine in [`state`]. The orchestrator opens it with
//! [`open_onboarding_window`] and is notified of completion through the
//! [`OnboardingServices::on_complete`] foreground callback (the flow's
//! `InputState` inputs require a gpui-component `Root`, so the window root is
//! `Root` and the completion event cannot be subscribed to directly).
//!
//! Completion mechanism: the view emits the gpui event
//! [`OnboardingEvent::Completed`] once the first-run marker
//! (`aiden:onboarding:v1:complete`, the exact TS `localStorage` key) is queued
//! into `settings.json`. An optional [`OnboardingServices::on_complete`]
//! callback (called on the foreground with `&mut App`) is also available for
//! creators that cannot subscribe to events.
//!
//! API deviation from the plan sketch (`pub fn new(cx, services)`): the view
//! owns gpui-component `InputState` entities, which require a `Window` to
//! construct, so the signature is `new(window, cx, services)` — the same shape
//! as `app::AppState::new(stores, window, cx)`.

mod state;
mod view;

use std::sync::atomic::Ordering;

use aiden_core::appearance::{parse_appearance_config, ReduceMotion};
use aiden_data::config_store::provider_connection_snapshot;
use aiden_data::portable_config::StoredProvider;
use gpui::{
    actions, div, px, size, App, AppContext as _, Bounds, Context, Entity, EventEmitter,
    FocusHandle, KeyBinding, ParentElement as _, Styled as _, Subscription, Task, Window,
    WindowBounds, WindowHandle, WindowOptions,
};
use gpui_component::{
    input::{InputEvent, InputState},
    ActiveTheme as _, Root, TitleBar, WindowExt as _,
};
use gpui_tokio_bridge::Tokio;

use crate::services::appearance::{
    appearance_to_settings, apply_appearance, resolve_scheme, SETTINGS_APPEARANCE_KEY,
};
use crate::services::codex_auth::{CodexAuthAttemptGuard, CodexDialogLease};
use crate::services::stores::Stores;

use state::{
    NextOutcome, OnboardingProvider, ProviderChoice, Step, MODEL_SELECTION_SETTINGS_KEY,
    ONBOARDING_COMPLETE_KEY, PROFILE_NAME_SETTINGS_KEY,
};

enum CodexAuthUpdate {
    DeviceCode(crate::services::codex_auth::CodexDeviceAuthorization),
    Finished(Result<(), String>),
}

actions!(onboarding, [OnboardingNext, OnboardingBack, OnboardingSkip]);

/// Emitted once when the flow finishes (or is skipped).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OnboardingEvent {
    Completed,
}

/// Foreground completion callback invoked (with `&mut App`) when the flow
/// completes, in addition to the [`OnboardingEvent`] emission.
pub type CompletionCallback = Box<dyn Fn(&mut App)>;

/// Everything the flow needs from its creator.
pub struct OnboardingServices {
    pub stores: Stores,
    on_complete: Option<CompletionCallback>,
}

impl OnboardingServices {
    pub fn new(stores: Stores) -> Self {
        Self {
            stores,
            on_complete: None,
        }
    }

    /// Optional foreground callback invoked (with `&mut App`) when the flow
    /// completes. The gpui [`OnboardingEvent`] is emitted either way.
    pub fn with_on_complete(mut self, callback: CompletionCallback) -> Self {
        self.on_complete = Some(callback);
        self
    }
}

/// The onboarding flow entity. All step logic lives in
/// [`OnboardingMachine`] (pure, unit-tested); this view renders it and
/// performs the per-step store writes.
pub struct OnboardingView {
    machine: OnboardingMachine,
    stores: Stores,
    on_complete: Option<CompletionCallback>,
    name_input: Entity<InputState>,
    api_key_input: Entity<InputState>,
    base_url_input: Entity<InputState>,
    /// Async persistence in flight (TS `saving` — disables the buttons).
    busy: bool,
    booted: bool,
    completed_emitted: bool,
    /// Last step the view focused, so focus moves only on step changes.
    focused_step: usize,
    /// Focus target for the primary action on non-Welcome steps.
    next_focus: FocusHandle,
    codex_revision: u64,
    codex_attempt: Option<CodexAuthAttemptGuard>,
    _boot: Option<Task<anyhow::Result<()>>>,
    _subscriptions: Vec<Subscription>,
}

impl OnboardingView {
    /// `window` is required for the input entities (see the module docs for
    /// the deviation note).
    pub fn new(window: &mut Window, cx: &mut Context<Self>, services: OnboardingServices) -> Self {
        // Keyboard nav: Enter advances (the TS Enter-on-name behavior, extended
        // to every step), cmd-left goes back, cmd-right advances, Escape skips.
        // While an input is focused its own "Input" context consumes Enter /
        // cmd-left / cmd-right, so typing never advances accidentally.
        cx.bind_keys([
            KeyBinding::new("enter", OnboardingNext, Some("onboarding")),
            KeyBinding::new("cmd-right", OnboardingNext, Some("onboarding")),
            KeyBinding::new("cmd-left", OnboardingBack, Some("onboarding")),
            KeyBinding::new("escape", OnboardingSkip, Some("onboarding")),
        ]);

        let name_input = cx.new(|cx| InputState::new(window, cx).placeholder("Your name"));
        let api_key_input = cx.new(|cx| {
            InputState::new(window, cx)
                .placeholder("Paste key")
                .masked(true)
        });
        let base_url_input = cx.new(|cx| InputState::new(window, cx).placeholder("Base URL"));

        let mut this = Self {
            machine: OnboardingMachine::new(),
            stores: services.stores,
            on_complete: services.on_complete,
            name_input,
            api_key_input,
            base_url_input,
            busy: false,
            booted: false,
            completed_emitted: false,
            focused_step: usize::MAX,
            next_focus: cx.focus_handle(),
            codex_revision: 0,
            codex_attempt: None,
            _boot: None,
            _subscriptions: Vec::new(),
        };

        // Keep the machine in sync with the inputs; Enter submits (TS).
        this._subscriptions.push(cx.subscribe_in(
            &this.name_input,
            window,
            |this, _source, event, _window, cx| match event {
                InputEvent::Change => {
                    this.machine.name = this.name_input.read(cx).value().to_string();
                    cx.notify();
                }
                InputEvent::PressEnter { secondary: false } => this.on_next_pressed(cx),
                InputEvent::PressEnter { secondary: true }
                | InputEvent::Focus
                | InputEvent::Blur => {}
            },
        ));
        this._subscriptions.push(cx.subscribe_in(
            &this.api_key_input,
            window,
            |this, _source, event, _window, cx| match event {
                InputEvent::Change => {
                    this.machine.api_key = this.api_key_input.read(cx).value().to_string();
                    cx.notify();
                }
                InputEvent::PressEnter { secondary: false } => this.on_next_pressed(cx),
                InputEvent::PressEnter { secondary: true }
                | InputEvent::Focus
                | InputEvent::Blur => {}
            },
        ));
        this._subscriptions.push(cx.subscribe_in(
            &this.base_url_input,
            window,
            |this, _source, event, _window, cx| match event {
                InputEvent::Change => {
                    this.machine.base_url = this.base_url_input.read(cx).value().to_string();
                    cx.notify();
                }
                InputEvent::PressEnter { secondary: false } => this.on_next_pressed(cx),
                InputEvent::PressEnter { secondary: true }
                | InputEvent::Focus
                | InputEvent::Blur => {}
            },
        ));

        this.boot(cx);
        this
    }

    /// Load settings + the provider catalog on the background, then either
    /// close immediately (already completed) or populate the machine.
    fn boot(&mut self, cx: &mut Context<Self>) {
        let stores = self.stores.clone();
        let task = cx.spawn(async move |this, cx| -> anyhow::Result<()> {
            let (settings, providers, codex_configured) = cx
                .background_spawn(async move {
                    let settings = stores.config.get_settings().unwrap_or_default();
                    let providers = stores.config.list_providers().unwrap_or_default();
                    let codex_configured = stores.codex_auth.is_configured().unwrap_or(false);
                    (settings, providers, codex_configured)
                })
                .await;
            this.update(cx, |this, cx| {
                if !should_show_onboarding(&settings) {
                    // Marker already set (e.g. re-entrant open): self-close.
                    this.complete_onboarding(cx);
                    return;
                }
                let reduce_motion = settings
                    .get(SETTINGS_APPEARANCE_KEY)
                    .and_then(|value| parse_appearance_config(value).ok())
                    .map(|config| config.reduce_motion)
                    .unwrap_or(ReduceMotion::System);
                this.machine.set_reduce_motion(reduce_motion);
                this.machine.codex_configured = codex_configured;
                if codex_configured {
                    this.machine.record_codex_configured();
                }
                if let Some(first) = providers.first() {
                    this.machine
                        .set_catalog(Some(first.id.clone()), first.models.clone());
                }
                this.booted = true;
                cx.notify();
            })?;
            Ok(())
        });
        self._boot = Some(task);
    }

    // -----------------------------------------------------------------------
    // Navigation + persistence orchestration
    // -----------------------------------------------------------------------

    fn on_next(&mut self, _: &OnboardingNext, _window: &mut Window, cx: &mut Context<Self>) {
        self.on_next_pressed(cx);
    }

    /// Advance the machine and run the per-step persistence. Shared by the
    /// Next button, the Enter bindings, and the input PressEnter events.
    fn on_next_pressed(&mut self, cx: &mut Context<Self>) {
        if self.busy || !self.booted || self.completed_emitted {
            return;
        }
        let step = self.machine.current();
        if let Some(message) = self.machine.validate() {
            self.machine.error = Some(message);
            cx.notify();
            return;
        }
        match step {
            Step::Provider => self.save_provider_then_advance(cx),
            _ => {
                let from = step;
                match self.machine.advance() {
                    NextOutcome::Advanced => self.persist_after_step(from, cx),
                    NextOutcome::Completed => self.complete_onboarding(cx),
                    // `advance()` never yields `Blocked` (only `next()` does, and
                    // the wired view calls `advance()` directly after `validate()`).
                    // Treat the unreachable case as a quiet no-op instead of
                    // panicking inside an ObjC event callback (panic_cannot_unwind).
                    NextOutcome::Blocked => {
                        tracing::error!(
                            "onboarding advance returned Blocked after a passing validate"
                        );
                    }
                }
                cx.notify();
            }
        }
    }

    /// Persist what the step we just left collected. Mirrors the TS `next()`
    /// handler (profile save, provider save, marker write) plus the port-only
    /// model/appearance persistence.
    fn persist_after_step(&mut self, from: Step, cx: &mut Context<Self>) {
        let stores = self.stores.clone();
        match from {
            Step::Welcome => {
                let name = self.machine.name.trim().to_string();
                cx.spawn(async move |_, cx| {
                    let _ = cx
                        .background_spawn(async move {
                            let mut patch = serde_json::Map::new();
                            patch.insert(
                                PROFILE_NAME_SETTINGS_KEY.to_string(),
                                serde_json::Value::String(name),
                            );
                            let _ = stores.config.set_settings(&patch, &|| true);
                        })
                        .await;
                })
                .detach();
            }
            Step::Model => {
                if let Some((provider_id, model)) = self.machine.selection() {
                    cx.spawn(async move |_, cx| {
                        let _ = cx
                            .background_spawn(async move {
                                let mut patch = serde_json::Map::new();
                                patch.insert(
                                    MODEL_SELECTION_SETTINGS_KEY.to_string(),
                                    serde_json::json!({ "providerId": provider_id, "model": model }),
                                );
                                let _ = stores.config.set_settings(&patch, &|| true);
                            })
                            .await;
                    })
                    .detach();
                }
            }
            Step::Appearance => {
                let value = appearance_to_settings(&self.machine.appearance_config());
                cx.spawn(async move |_, cx| {
                    let _ = cx
                        .background_spawn(async move {
                            let mut patch = serde_json::Map::new();
                            patch.insert(SETTINGS_APPEARANCE_KEY.to_string(), value);
                            let _ = stores.config.set_settings(&patch, &|| true);
                        })
                        .await;
                })
                .detach();
            }
            Step::Provider | Step::Permissions | Step::Finish => {}
        }
    }

    /// Provider step: write the provider record + API key on the background,
    /// then advance. `openai-signin` skips the write (the OAuth window is a
    /// later-phase stub; the model step falls back to the boot catalog).
    fn save_provider_then_advance(&mut self, cx: &mut Context<Self>) {
        if self.machine.choice == ProviderChoice::ChatGpt && self.machine.codex_configured {
            self.machine.record_codex_configured();
            let _ = self.machine.advance();
            cx.notify();
            return;
        }
        self.busy = true;
        cx.notify();
        let pending = self.machine.pending_provider_save();
        let stores = self.stores.clone();
        cx.spawn(async move |this, cx| {
            let result: Result<Option<OnboardingProvider>, String> = cx
                .background_spawn(async move {
                    let Some(provider) = &pending.provider else {
                        return Ok(None);
                    };
                    let stored = StoredProvider {
                        id: provider.id.clone(),
                        kind: provider.kind,
                        label: provider.label.clone(),
                        base_url: provider.base_url.clone(),
                        models: provider.models.clone(),
                        model_metadata: None,
                        default_model: provider.default_model.clone(),
                        needs_key: provider.needs_key,
                        deployment: Some(provider.deployment),
                        is_preset: None,
                        is_builtin: None,
                        extra: serde_json::Map::new(),
                    };
                    stores
                        .config
                        .save_provider(&stored, &|| true)
                        .map_err(|error| format!("Couldn't add that provider: {error}"))?;
                    if let Some(key) = &pending.api_key {
                        stores
                            .keys
                            .set_bound(&provider.id, key, &provider_connection_snapshot(&stored))
                            .map_err(|error| format!("Couldn't save the API key: {error}"))?;
                    }
                    Ok(Some(provider.clone()))
                })
                .await;
            match result {
                Ok(saved) => {
                    let _ = this.update(cx, |this, cx| {
                        if let Some(provider) = saved {
                            this.machine.record_provider_saved(provider);
                        }
                        this.busy = false;
                        match this.machine.advance() {
                            NextOutcome::Advanced => {}
                            NextOutcome::Completed => this.complete_onboarding(cx),
                            // Same invariant as `on_next_pressed`: `advance()`
                            // never yields Blocked. Stay panic-free on the
                            // foreground update dispatched from this task.
                            NextOutcome::Blocked => {
                                tracing::error!(
                                    "onboarding advance returned Blocked after the provider write"
                                );
                            }
                        }
                        cx.notify();
                    });
                }
                Err(message) => {
                    let _ = this.update(cx, |this, cx| {
                        this.busy = false;
                        this.machine.error = Some(static_str(&message));
                        cx.notify();
                    });
                }
            }
        })
        .detach();
    }

    fn start_codex_sign_in(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.busy {
            return;
        }
        self.codex_revision = self.codex_revision.wrapping_add(1);
        let revision = self.codex_revision;
        self.busy = true;
        self.machine.error = None;
        let auth_store = self.stores.codex_auth.clone();
        let attempt = CodexAuthAttemptGuard::new(auth_store.clone());
        let cancelled = attempt.cancelled();
        let auth_revision = attempt.revision();
        self.codex_attempt = Some(attempt);
        let dialog_lease = CodexDialogLease::default();
        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
        Tokio::spawn(cx, async move {
            let oauth = crate::services::codex_auth::CodexDeviceOAuth::default();
            let authorization = match oauth.begin(&cancelled).await {
                Ok(authorization) => authorization,
                Err(error) => {
                    let _ = tx.send(CodexAuthUpdate::Finished(Err(error.to_string())));
                    return;
                }
            };
            if tx
                .send(CodexAuthUpdate::DeviceCode(authorization.clone()))
                .is_err()
            {
                return;
            }
            let result = oauth
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
                .map_err(|error| error.to_string());
            let _ = tx.send(CodexAuthUpdate::Finished(result));
        })
        .detach();

        let return_focus = window.focused(cx);
        cx.spawn_in(window, async move |this, cx| -> anyhow::Result<()> {
            while let Some(update) = rx.recv().await {
                let done = matches!(update, CodexAuthUpdate::Finished(_));
                this.update_in(cx, |this, window, cx| {
                    if matches!(update, CodexAuthUpdate::Finished(_))
                        && dialog_lease.take_owned_dialog()
                    {
                        window.close_dialog(cx);
                        if let Some(focus) = &return_focus {
                            focus.focus(window);
                        }
                    }
                    if !crate::services::codex_auth::auth_revision_is_current(
                        this.codex_revision,
                        revision,
                    ) {
                        return;
                    }
                    match update {
                        CodexAuthUpdate::DeviceCode(authorization) => {
                            cx.open_url(crate::services::codex_auth::DEVICE_VERIFICATION_URI);
                            let code = authorization.user_code;
                            let cancel = this
                                .codex_attempt
                                .as_ref()
                                .map(CodexAuthAttemptGuard::cancelled);
                            let auth_store = this.stores.codex_auth.clone();
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
                                        gpui_component::v_flex()
                                            .gap_3()
                                            .child("Enter this temporary code on OpenAI's verification page:")
                                            .child(div().text_2xl().font_weight(gpui::FontWeight::SEMIBOLD).child(code.clone()))
                                            .child(div().text_sm().text_color(cx.theme().muted_foreground).child("OAuth tokens stay encrypted in this Mac's Keychain.")),
                                    )
                                    .footer(|_, cancel_button, window, cx| vec![cancel_button(window, cx)])
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
                        CodexAuthUpdate::Finished(result) => {
                            this.busy = false;
                            this.codex_attempt = None;
                            match result {
                                Ok(()) => this.machine.record_codex_configured(),
                                Err(error) => this.machine.error = Some(static_str(&error)),
                            }
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

    fn on_back(&mut self, _: &OnboardingBack, _window: &mut Window, cx: &mut Context<Self>) {
        self.back_pressed(cx);
    }

    /// Skip the whole flow (TS "Skip" button / our Escape binding).
    fn on_skip(&mut self, _: &OnboardingSkip, _window: &mut Window, cx: &mut Context<Self>) {
        self.skip_pressed(cx);
    }

    /// The Back button / cmd-left handler.
    fn back_pressed(&mut self, cx: &mut Context<Self>) {
        if self.busy || self.completed_emitted {
            return;
        }
        self.machine.back();
        cx.notify();
    }

    /// The Skip button / Escape handler.
    fn skip_pressed(&mut self, cx: &mut Context<Self>) {
        if self.busy || self.completed_emitted {
            return;
        }
        self.machine.skip();
        self.complete_onboarding(cx);
    }

    /// Queue the first-run marker into settings.json, then run the completion
    /// callback and emit the event.
    ///
    /// Two ordering rules keep the completion path crash/race-free:
    ///
    /// 1. The marker is written BEFORE the callback runs. The callback opens
    ///    the main window; if a quit lands right after "Start using Aiden",
    ///    a fire-and-forget marker write could be lost and onboarding would
    ///    reappear on the next launch.
    ///
    /// 2. The callback is deferred out of the current update cycle. gpui
    ///    takes a window out of the app's window map for the duration of any
    ///    event dispatch (`update_window_id` → `windows.get_mut(id)?.take()?`),
    ///    and the callback closes THIS window (`handle.update(remove_window)`)
    ///    before opening the main one. Invoked synchronously from a button /
    ///    key handler on this window, that nested `handle.update` fails with
    ///    "window not found" and the onboarding window stays open on top of
    ///    the main window — both visible at once. Deferring runs the callback
    ///    at the end of the effect cycle, after this window is back in the map.
    fn complete_onboarding(&mut self, cx: &mut Context<Self>) {
        if self.completed_emitted {
            return;
        }
        self.completed_emitted = true;
        let stores = self.stores.clone();
        cx.spawn(async move |this, cx| {
            let _ = cx
                .background_spawn(async move {
                    let mut patch = serde_json::Map::new();
                    patch.insert(
                        ONBOARDING_COMPLETE_KEY.to_string(),
                        serde_json::Value::String("true".into()),
                    );
                    stores.config.set_settings(&patch, &|| true)
                })
                .await;
            this.update(cx, |this, cx| {
                if let Some(callback) = this.on_complete.take() {
                    cx.defer(move |cx| callback(cx));
                }
                cx.emit(OnboardingEvent::Completed);
                cx.notify();
            })
            .ok();
        })
        .detach();
    }

    /// Apply the machine's appearance config to the running theme (live
    /// preview for the appearance step).
    fn preview_appearance(&self, cx: &mut Context<Self>) {
        let config = self.machine.appearance_config();
        let scheme = resolve_scheme(config.mode, cx.window_appearance());
        apply_appearance(cx, &config, scheme, false, false);
    }
}

impl EventEmitter<OnboardingEvent> for OnboardingView {}

/// Leak a heap string into `'static` for the machine's error slot (the errors
/// are short-lived, user-facing messages).
fn static_str(message: &str) -> &'static str {
    Box::leak(message.to_string().into_boxed_str())
}

/// Open the onboarding flow in its own window. The window's root view is a
/// gpui-component `Root` (the flow's `InputState` inputs paint through the
/// Root layer), with [`OnboardingView`] as the Root's child; the returned
/// handle therefore targets `Root`, and completion is delivered through the
/// [`OnboardingServices::on_complete`] callback rather than an event
/// subscription.
pub fn open_onboarding_window(
    cx: &mut App,
    services: OnboardingServices,
) -> anyhow::Result<WindowHandle<Root>> {
    let options = WindowOptions {
        window_bounds: Some(WindowBounds::Windowed(Bounds::centered(
            None,
            size(px(960.0), px(680.0)),
            cx,
        ))),
        titlebar: Some(TitleBar::title_bar_options()),
        window_background: gpui::WindowBackgroundAppearance::Blurred,
        app_id: Some("com.sambitcreate.aiden-agent.onboarding".to_string()),
        tabbing_identifier: Some("aiden-onboarding".to_string()),
        ..Default::default()
    };

    cx.open_window(options, |window, cx| {
        let view = cx.new(|cx| OnboardingView::new(window, cx, services));
        cx.new(|cx| Root::new(view, window, cx))
    })
}

/// Re-exported for the orchestrator's first-run check in `main.rs`.
pub use state::should_show_onboarding;
/// Re-exported for the orchestrator and tests.
pub use state::OnboardingMachine;
