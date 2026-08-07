//! Floating dictation pill (port of `main/windows/pill-window.ts` +
//! `renderer/pill/pill-app.tsx`).
//!
//! A tiny frameless, always-on-top, non-activating window (~280×56) that
//! surfaces the dictation state machine over whichever app is focused. The
//! Electron original recorded microphone audio inside the pill renderer and
//! transcribed it through the shared voice pipeline; the GPUI port instead
//! injects an [`audio::AudioLevelSource`] (see [`audio`] for the silence stub
//! and the real sherpa-onnx capture TODO) and lets a coordinator push
//! `aiden_core::dictation::DictationStatePayload` broadcasts through
//! [`PillView::push_dictation`].
//!
//! Window pattern: [`open_pill_window`] returns a `WindowHandle<PillView>`; a
//! later-phase coordinator holds that handle and drives the pill on the
//! foreground with `handle.update(cx, |view, cx| view.push_dictation(&p, cx))`.
//! The window is a non-activating `NSPanel` (`WindowKind::PopUp`), so it
//! floats above other apps without stealing focus — the GPUI analog of
//! Electron's `alwaysOnTop + focusable: false`.
//!
//! Known deviations from Electron (documented; deliberately out of scope):
//! - **Vibrancy**: the Electron window used `transparent: true` +
//!   `NSVisualEffectView`-style material. GPUI 0.2 has no vibrancy API, so the
//!   pill uses `theme.popover` at 72% alpha as the translucent material. A
//!   real `NSVisualEffectView` behind the GPUI surface is a later-phase TODO.
//! - **Window reuse**: the Electron pill was created once and hidden/shown.
//!   GPUI has no public hide API, so Escape closes the window and the
//!   coordinator re-opens it via [`open_pill_window`].
//! - **Dock-aware positioning**: Electron used
//!   `screen.getDisplayNearestPoint(...).workArea`. GPUI exposes only display
//!   frames, so positioning approximates the bottom-center of the primary
//!   display (TODO: nearest-display + work area when the platform layer
//!   exposes it).
//! - **`cmd+.` toggle**: a placeholder binding ([`TogglePill`]) that logs; the
//!   global hotkey coordinator lands in a later phase.

mod audio;
mod state;

/// Re-exported so the shell can construct [`PillDeps`] with the bundled
/// silence source (the real sherpa-onnx capture is a later-phase task).
pub use audio::{AudioLevelSource, SilenceAudioSource};

use std::cell::RefCell;
use std::rc::Rc;
use std::time::Duration;

use aiden_core::appearance::AppearanceConfig;
use aiden_core::dictation::DictationStatePayload;
use gpui::prelude::FluentBuilder as _;
use gpui::{
    actions, div, point, px, size, Animation, AnimationExt as _, App, AppContext as _, Bounds,
    Context, InteractiveElement as _, IntoElement, KeyBinding, ParentElement as _, Render,
    Styled as _, Task, Window, WindowBounds, WindowHandle, WindowKind, WindowOptions,
};
use gpui_component::{
    button::{Button, ButtonVariants as _},
    h_flex, ActiveTheme, Icon, IconName, PixelsExt as _, Sizable as _,
};

use state::{
    format_elapsed, AppearanceSyncState, MotionGate, Phase, PillEvent, PillState, METER_POLL_MS,
    PILL_BOTTOM_OFFSET, PILL_HEIGHT, PILL_WIDTH, WAVEFORM_BARS,
};

actions!(pill, [ClosePill, TogglePill]);

/// Everything the pill needs from its creator. The coordinator constructs this
/// and calls [`open_pill_window`].
pub struct PillDeps {
    /// Injected audio-level source driving the meter bars (see [`audio`]).
    pub audio: Rc<RefCell<dyn audio::AudioLevelSource>>,
    /// The authoritative appearance config at open time (painted immediately).
    pub appearance: AppearanceConfig,
    /// Injected OS reduced-motion preference (GPUI cannot probe it; see
    /// [`state::MotionGate`]).
    pub system_reduced_motion: bool,
}

/// The pill window's root view.
pub struct PillView {
    state: PillState,
    audio: Rc<RefCell<dyn audio::AudioLevelSource>>,
    motion: MotionGate,
    /// Latest per-bar levels (fed by the meter task while listening).
    meter_levels: Vec<f32>,
    appearance: AppearanceSyncState,
    _meter_task: Option<Task<anyhow::Result<()>>>,
}

impl PillView {
    pub fn new(cx: &mut Context<Self>, deps: PillDeps) -> Self {
        // Bindings are app-global but scoped to the "pill" key context, which
        // only exists inside this window's tree.
        cx.bind_keys([
            KeyBinding::new("escape", ClosePill, Some("pill")),
            KeyBinding::new("cmd-.", TogglePill, Some("pill")),
        ]);

        let mut appearance = AppearanceSyncState::new();
        appearance.adopt(deps.appearance);
        Self {
            state: PillState::new(),
            audio: deps.audio,
            motion: MotionGate::default().with_system_reduced(deps.system_reduced_motion),
            meter_levels: vec![0.0; WAVEFORM_BARS],
            appearance,
            _meter_task: None,
        }
    }

    /// Apply a `dictation:state` broadcast from the coordinator. This is the
    /// coordinator-facing entry point; call it on the foreground via the
    /// returned `WindowHandle`.
    #[allow(dead_code)] // coordinator-facing; the aiden-mac hotkey wiring lands later
    pub fn push_dictation(&mut self, payload: &DictationStatePayload, cx: &mut Context<Self>) {
        let event = PillEvent::from_payload(payload);
        self.state.reduce(&event);
        if self.state.phase == Phase::Listening {
            self.start_meter(cx);
        }
        cx.notify();
    }

    /// Adopt an appearance broadcast (palette/scheme changes while hidden).
    #[allow(dead_code)] // coordinator-facing; appearance sync lands with the wiring phase
    pub fn update_appearance(&mut self, config: AppearanceConfig, cx: &mut Context<Self>) {
        self.appearance.adopt(config);
        cx.notify();
    }

    /// Inject the OS reduced-motion preference once the platform probe exists.
    #[allow(dead_code)] // coordinator-facing; the platform probe lands later
    pub fn set_system_reduced_motion(&mut self, reduced: bool) {
        self.motion = self.motion.with_system_reduced(reduced);
    }

    /// Drive the level meter while `Listening`: poll the injected source on
    /// the foreground at the renderer's rAF cadence and re-render. Gated by
    /// the motion gate (reduced motion renders a static meter — matching the
    /// design docs' "freeze to a static state").
    fn start_meter(&mut self, cx: &mut Context<Self>) {
        if self._meter_task.is_some() || !self.motion.allow() {
            return;
        }
        let audio = self.audio.clone();
        let task = cx.spawn(async move |this, cx| -> anyhow::Result<()> {
            loop {
                if !this.read_with(cx, |this, _| this.state.phase == Phase::Listening)? {
                    break;
                }
                let levels = audio.borrow_mut().levels(WAVEFORM_BARS);
                cx.background_executor()
                    .timer(Duration::from_millis(METER_POLL_MS))
                    .await;
                this.update(cx, |this, cx| {
                    if this.state.phase == Phase::Listening {
                        this.meter_levels = levels;
                        cx.notify();
                    }
                })?;
            }
            this.update(cx, |this, _| {
                this._meter_task = None;
            })?;
            Ok(())
        });
        self._meter_task = Some(task);
    }

    fn on_close(&mut self, _: &ClosePill, window: &mut Window, _cx: &mut Context<Self>) {
        window.remove_window();
    }

    /// `cmd+.` placeholder: the global dictation toggle coordinator is a
    /// later-phase wiring task.
    fn on_toggle(&mut self, _: &TogglePill, _window: &mut Window, _cx: &mut Context<Self>) {
        tracing::info!(
            "cmd+. dictation toggle placeholder: coordinator wiring lands in a later phase"
        );
    }
}

impl Render for PillView {
    fn render(&mut self, _window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let motion = self.motion.allow();

        div()
            .id("pill-root")
            .size_full()
            .key_context("pill")
            .on_action(cx.listener(Self::on_close))
            .on_action(cx.listener(Self::on_toggle))
            .child(
                h_flex()
                    .id("pill-body")
                    .size_full()
                    .items_center()
                    .justify_center()
                    .when(self.state.visible(), |el| {
                        el.child(self.pill_card(motion, cx))
                    }),
            )
    }
}

impl PillView {
    /// The translucent rounded card (the only visible element of the pill).
    fn pill_card(&self, motion: bool, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = cx.theme();
        let phase = self.state.phase;

        h_flex()
            .id("pill-card")
            .h(px(40.0))
            .items_center()
            .gap_2p5()
            .px_3p5()
            .rounded_full()
            // Vibrancy-like material: theme.popover at 72% alpha (see module
            // docs for the NSVisualEffectView TODO).
            .bg(theme.popover.alpha(0.72))
            .border_1()
            .border_color(theme.border.alpha(0.6))
            .shadow_md()
            .child(match phase {
                Phase::Idle => unreachable!("hidden by the caller"),
                Phase::Listening => self.listening_content(motion, cx).into_any_element(),
                Phase::Transcribing => {
                    let spinner: gpui::AnyElement = if motion {
                        Icon::new(IconName::LoaderCircle)
                            .small()
                            .text_color(theme.muted_foreground)
                            .with_animation(
                                "pill-transcribing-pulse",
                                Animation::new(Duration::from_millis(900)).repeat(),
                                |icon, progress| icon.opacity(quiet_pulse(progress)),
                            )
                            .into_any_element()
                    } else {
                        Icon::new(IconName::LoaderCircle)
                            .small()
                            .text_color(theme.muted_foreground)
                            .into_any_element()
                    };
                    h_flex()
                        .gap_2()
                        .items_center()
                        .child(spinner)
                        .child(
                            div()
                                .text_sm()
                                .text_color(theme.muted_foreground)
                                .child(phase.label().unwrap_or_default()),
                        )
                        .into_any_element()
                }
                Phase::Pasted => h_flex()
                    .gap_2()
                    .items_center()
                    .child(
                        Icon::new(IconName::CircleCheck)
                            .small()
                            .text_color(theme.success),
                    )
                    .child(
                        div()
                            .text_sm()
                            .font_weight(gpui::FontWeight::MEDIUM)
                            .child(phase.label().unwrap_or_default()),
                    )
                    .into_any_element(),
                Phase::Copied => h_flex()
                    .gap_2()
                    .items_center()
                    .child(
                        Icon::new(IconName::Copy)
                            .small()
                            .text_color(theme.muted_foreground),
                    )
                    .child(
                        div()
                            .text_sm()
                            .font_weight(gpui::FontWeight::MEDIUM)
                            .child(phase.label().unwrap_or_default()),
                    )
                    .into_any_element(),
                Phase::Error => div()
                    .max_w(px(224.0))
                    .text_sm()
                    .text_color(theme.danger)
                    .truncate()
                    .child(self.error_copy())
                    .into_any_element(),
            })
    }

    fn error_copy(&self) -> String {
        self.state
            .error_message
            .clone()
            .unwrap_or_else(|| "Dictation failed.".to_string())
    }

    /// The recording layout: pulsing dot, live level meter, elapsed timer, and
    /// the cancel button.
    fn listening_content(&self, motion: bool, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = cx.theme();
        let heights = audio::bar_heights(&self.meter_levels);

        let dot: gpui::AnyElement = if motion {
            div()
                .size(px(8.0))
                .rounded_full()
                .bg(theme.danger)
                .with_animation(
                    "pill-dot-pulse",
                    Animation::new(Duration::from_millis(900)).repeat(),
                    |dot, progress| dot.opacity(quiet_pulse(progress)),
                )
                .into_any_element()
        } else {
            div()
                .size(px(8.0))
                .rounded_full()
                .bg(theme.danger)
                .into_any_element()
        };

        h_flex()
            .id("pill-listening")
            .gap_2p5()
            .items_center()
            .child(dot)
            .child(
                h_flex()
                    .id("pill-meter")
                    .h(px(22.0))
                    .items_end()
                    .gap_0p5()
                    .children(heights.iter().enumerate().map(|(index, height)| {
                        div()
                            .id(("pill-bar", index))
                            .w(px(3.0))
                            .rounded_full()
                            .bg(theme.accent)
                            .h(px(*height))
                    })),
            )
            .child(
                div()
                    .text_xs()
                    .text_color(theme.muted_foreground)
                    .child(format_elapsed(self.state.elapsed_seconds)),
            )
            .child(
                Button::new("pill-cancel")
                    .ghost()
                    .icon(IconName::Close)
                    .xsmall()
                    .tooltip("Cancel dictation")
                    .on_click(cx.listener(|this, _event, _window, cx| {
                        this.state.reduce(&PillEvent::Cancelled);
                        cx.notify();
                    })),
            )
    }
}

/// A quiet 0.0..1.0 opacity pulse (matches the renderer's `animate-pulse`
/// restraint: the dot never fully disappears).
fn quiet_pulse(progress: f32) -> f32 {
    0.5 + 0.5 * (progress * std::f32::consts::TAU).cos()
}

/// Open the pill window. Returns the entity handle a coordinator uses to push
/// `dictation:state` broadcasts on the foreground:
///
/// ```ignore
/// let handle = pill::open_pill_window(cx, deps)?;
/// handle.update(cx, |view, cx| view.push_dictation(&payload, cx));
/// ```
///
/// The window's root view is [`PillView`] itself (a non-activating `NSPanel` via
/// `WindowKind::PopUp`), so it floats above other apps without stealing focus
/// — the GPUI analog of Electron's `alwaysOnTop + focusable: false`. Note it
/// intentionally omits the gpui-component `Root` wrapper: the pill uses no
/// dialogs/sheets/notifications, and keeping `PillView` as the root is what
/// lets the coordinator drive the state machine through the returned handle.
pub fn open_pill_window(cx: &mut App, deps: PillDeps) -> anyhow::Result<WindowHandle<PillView>> {
    let pill_size = size(px(PILL_WIDTH), px(PILL_HEIGHT));
    let bounds = match cx.primary_display() {
        Some(display) => {
            let frame = display.bounds();
            let origin = point(
                px(frame.origin.x.as_f32() + (frame.size.width.as_f32() - PILL_WIDTH) / 2.0),
                px(frame.origin.y.as_f32() + frame.size.height.as_f32()
                    - PILL_HEIGHT
                    - PILL_BOTTOM_OFFSET),
            );
            Bounds::new(origin, pill_size)
        }
        None => Bounds::centered(None, pill_size, cx),
    };

    let options = WindowOptions {
        window_bounds: Some(WindowBounds::Windowed(bounds)),
        titlebar: None,
        focus: false,
        show: true,
        kind: WindowKind::PopUp,
        is_movable: false,
        is_resizable: false,
        window_background: gpui::WindowBackgroundAppearance::Transparent,
        app_id: Some("com.sambitcreate.aiden-agent.pill".to_string()),
        window_min_size: Some(pill_size),
        ..Default::default()
    };

    cx.open_window(options, |_window, cx| cx.new(|cx| PillView::new(cx, deps)))
}
