//! Floating dictation pill (port of `main/windows/pill-window.ts` +
//! `renderer/pill/pill-app.tsx`).
//!
//! A tiny frameless, always-on-top, non-activating window (~280×56) that
//! surfaces the dictation state machine over whichever app is focused. The
//! Electron original recorded microphone audio inside the pill renderer and
//! transcribed it through the shared voice pipeline; the GPUI port injects a
//! [`audio::AudioLevelSource`] — the real capture is
//! [`live_audio::LiveAudioSource`] (aiden-mac AVAudioEngine capture on a
//! background thread feeding the meter + the coordinator) — and lets
//! [`coordinator::PillCoordinator`] drive the pill through
//! [`PillView::push_dictation`]. The bundled [`audio::SilenceAudioSource`]
//! remains for tests and non-wired hosts.
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
//! - **Dock-aware positioning**: the macOS bridge now asks AppKit for the
//!   cursor display's visible frame on every new show and passes the matching
//!   GPUI display id to the window. Non-macOS hosts and transient AppKit
//!   failures fall back to GPUI's primary display frame.
//! - **`cmd+.` toggle**: a placeholder binding ([`TogglePill`]) that logs; the
//!   global hotkey coordinator lands in a later phase.

mod audio;
pub mod coordinator;
pub mod live_audio;
mod state;

use std::sync::Arc;

/// Re-exported so the shell can construct [`PillDeps`] with the live capture
/// source (or the bundled silence stub for non-wired hosts and tests).
#[allow(unused_imports)] // SilenceAudioSource is a public convenience stub
pub use audio::{AudioLevelSource, SilenceAudioSource};
pub use coordinator::{PillCoordinator, PillCoordinatorDeps};
pub use live_audio::LiveAudioSource;

use std::cell::RefCell;
use std::rc::Rc;
use std::time::{Duration, Instant};

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

#[derive(Debug, Clone, Copy, PartialEq)]
struct PillWorkArea {
    x: f32,
    y: f32,
    width: f32,
    height: f32,
}

fn pill_origin_for_work_area(area: PillWorkArea) -> (f32, f32) {
    let x = area.x + ((area.width - PILL_WIDTH) / 2.0).max(0.0);
    let y = area.y + (area.height - PILL_HEIGHT - PILL_BOTTOM_OFFSET).max(0.0);
    (x, y)
}

actions!(pill, [ClosePill, TogglePill]);

/// Bound catch-up work when the foreground task is delayed. The recording
/// timer is intentionally derived from elapsed monotonic time rather than
/// assuming every 60ms meter frame arrived; a stalled UI therefore catches up
/// at most one minute of display ticks per pass and never spins unboundedly.
fn timer_ticks_due(elapsed_seconds: u64, emitted_ticks: u64) -> u64 {
    elapsed_seconds.saturating_sub(emitted_ticks).min(60)
}

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
    /// Called when the user presses the pill's cancel button (the coordinator
    /// cancel path, mirroring `dictationApi.cancel()` in pill-app.tsx).
    pub on_cancel: Option<Arc<dyn Fn() + Send + Sync>>,
}

/// The pill window's root view.
pub struct PillView {
    state: PillState,
    audio: Rc<RefCell<dyn audio::AudioLevelSource>>,
    motion: MotionGate,
    /// Latest per-bar levels (fed by the meter task while listening).
    meter_levels: Vec<f32>,
    appearance: AppearanceSyncState,
    on_cancel: Option<Arc<dyn Fn() + Send + Sync>>,
    /// Monotonic start of the current recording. The meter task compares this
    /// identity before applying levels/ticks so a stale task cannot advance a
    /// newer recording after a rapid stop/start transition.
    recording_started_at: Option<Instant>,
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
        let reduce_motion = deps.appearance.reduce_motion;
        appearance.adopt(deps.appearance);
        Self {
            state: PillState::new(),
            audio: deps.audio,
            motion: MotionGate {
                reduce_motion,
                system_reduced: deps.system_reduced_motion,
            },
            meter_levels: vec![0.0; WAVEFORM_BARS],
            appearance,
            on_cancel: deps.on_cancel,
            recording_started_at: None,
            _meter_task: None,
        }
    }

    /// Apply a `dictation:state` broadcast from the coordinator. This is the
    /// coordinator-facing entry point; call it on the foreground via the
    /// returned `WindowHandle`.
    #[allow(dead_code)] // coordinator-facing; the aiden-mac hotkey wiring lands later
    pub fn push_dictation(&mut self, payload: &DictationStatePayload, cx: &mut Context<Self>) {
        let event = PillEvent::from_payload(payload);
        match &event {
            PillEvent::Recording => self.recording_started_at = Some(Instant::now()),
            PillEvent::Stopping | PillEvent::Error { .. } | PillEvent::Cancelled => {
                self.recording_started_at = None
            }
            PillEvent::Copied | PillEvent::Pasted | PillEvent::Tick => {}
        }
        self.state.reduce(&event);
        if self.state.phase == Phase::Listening {
            self.start_meter(cx);
        }
        cx.notify();
    }

    /// Adopt an appearance broadcast (palette/scheme changes while hidden).
    #[allow(dead_code)] // coordinator-facing; appearance sync lands with the wiring phase
    pub fn update_appearance(&mut self, config: AppearanceConfig, cx: &mut Context<Self>) {
        self.motion.reduce_motion = config.reduce_motion;
        self.appearance.adopt(config);
        if self.state.phase == Phase::Listening {
            self.start_meter(cx);
        }
        cx.notify();
    }

    /// Inject the OS reduced-motion preference once the platform probe exists.
    #[allow(dead_code)] // coordinator-facing; the platform probe lands later
    pub fn set_system_reduced_motion(&mut self, reduced: bool, cx: &mut Context<Self>) {
        self.motion = self.motion.with_system_reduced(reduced);
        if self.state.phase == Phase::Listening {
            self.start_meter(cx);
        }
        cx.notify();
    }

    /// Drive the level meter and elapsed timer while `Listening`: poll the
    /// injected source on the foreground at the renderer's rAF cadence and
    /// re-render. Reduced motion freezes only the animated level bars; the
    /// elapsed timer remains live, matching the renderer's independent clock.
    fn start_meter(&mut self, cx: &mut Context<Self>) {
        if self._meter_task.is_some() {
            return;
        }
        let audio = self.audio.clone();
        let task = cx.spawn(async move |this, cx| -> anyhow::Result<()> {
            let mut recording_started_at = None;
            let mut emitted_ticks = 0u64;
            loop {
                let current = this.read_with(cx, |this, _| {
                    (
                        this.state.phase == Phase::Listening,
                        this.motion.allow(),
                        this.recording_started_at,
                    )
                })?;
                if !current.0 {
                    break;
                }
                let Some(current_started_at) = current.2 else {
                    break;
                };
                if recording_started_at != Some(current_started_at) {
                    recording_started_at = Some(current_started_at);
                    emitted_ticks = 0;
                }
                let levels = current.1.then(|| audio.borrow_mut().levels(WAVEFORM_BARS));
                cx.background_executor()
                    .timer(Duration::from_millis(METER_POLL_MS))
                    .await;
                let ticks = timer_ticks_due(current_started_at.elapsed().as_secs(), emitted_ticks);
                this.update(cx, |this, cx| {
                    if this.state.phase == Phase::Listening
                        && this.recording_started_at == Some(current_started_at)
                    {
                        for _ in 0..ticks {
                            this.state.reduce(&PillEvent::Tick);
                        }
                        emitted_ticks = emitted_ticks.saturating_add(ticks);
                        if let Some(levels) = levels {
                            this.meter_levels = levels;
                        }
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
        // The coordinator owns the recording state machine. Closing the pill
        // (Escape) without reporting a cancel leaves the coordinator in
        // `Recording`: the microphone keeps capturing with no visible UI until
        // the next hotkey toggle. Report the cancel (mirroring the cancel
        // button) so the coordinator discards the session and stops capture.
        if let Some(on_cancel) = self.on_cancel.as_ref() {
            on_cancel();
        }
        window.remove_window();
    }

    /// `cmd+.` in-app toggle: routes through the same coordinator as the
    /// shell hotkey when wired (the coordinator owns the state machine; the
    /// in-app binding is a convenience).
    fn on_toggle(&mut self, _: &TogglePill, _window: &mut Window, _cx: &mut Context<Self>) {
        tracing::info!("cmd+. dictation toggle: route through the shell's PillCoordinator");
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
                Phase::Idle => div().into_any_element(),
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
                        // Mirror pill-app.tsx: the button reports a cancel to
                        // the coordinator (which broadcasts `cancelled`); the
                        // local reduce hides the pill immediately.
                        if let Some(on_cancel) = this.on_cancel.as_ref() {
                            on_cancel();
                        }
                        this.recording_started_at = None;
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
    let (bounds, display_id) = pill_window_bounds(cx, pill_size);

    let options = WindowOptions {
        window_bounds: Some(WindowBounds::Windowed(bounds)),
        display_id,
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

fn pill_window_bounds(
    cx: &App,
    pill_size: gpui::Size<gpui::Pixels>,
) -> (Bounds<gpui::Pixels>, Option<gpui::DisplayId>) {
    if let Some(native_area) = aiden_mac::pill_display::cursor_work_area() {
        if let Some(display) = cx
            .displays()
            .into_iter()
            .find(|display| u32::from(display.id()) == native_area.display_id)
        {
            let (x, y) = pill_origin_for_work_area(PillWorkArea {
                x: native_area.x,
                y: native_area.y,
                width: native_area.width,
                height: native_area.height,
            });
            return (
                Bounds::new(point(px(x), px(y)), pill_size),
                Some(display.id()),
            );
        }
    }

    match cx.primary_display() {
        Some(display) => {
            let frame = display.bounds();
            let (x, y) = pill_origin_for_work_area(PillWorkArea {
                x: frame.origin.x.as_f32(),
                y: frame.origin.y.as_f32(),
                width: frame.size.width.as_f32(),
                height: frame.size.height.as_f32(),
            });
            (
                Bounds::new(point(px(x), px(y)), pill_size),
                Some(display.id()),
            )
        }
        None => (Bounds::centered(None, pill_size, cx), None),
    }
}

#[cfg(test)]
mod appearance_tests {
    use super::*;

    #[test]
    fn timer_ticks_are_monotonic_and_bounded_when_meter_frames_lag() {
        assert_eq!(timer_ticks_due(0, 0), 0);
        assert_eq!(timer_ticks_due(2, 0), 2);
        assert_eq!(timer_ticks_due(2, 2), 0);
        assert_eq!(timer_ticks_due(10_000, 0), 60);
        let source = include_str!("mod.rs");
        let meter = source
            .split_once("let task = cx.spawn")
            .and_then(|(_, rest)| rest.split_once("self._meter_task = Some(task)"))
            .map(|(body, _)| body)
            .expect("meter task source boundary");
        assert!(meter.contains("PillEvent::Tick"));
        assert!(meter.contains("recording_started_at == Some(current_started_at)"));
        assert!(meter.contains("this.state.phase == Phase::Listening"));
        assert!(meter.contains("current.1.then"));
    }

    #[test]
    fn pill_geometry_follows_cursor_work_area_and_reserved_insets() {
        let (x, y) = pill_origin_for_work_area(PillWorkArea {
            x: 1440.0,
            y: 36.0,
            width: 1920.0,
            height: 1040.0,
        });
        assert_eq!(x, 2260.0);
        assert_eq!(y, 1005.0);
    }

    #[test]
    fn pill_geometry_clamps_when_a_work_area_is_smaller_than_the_window() {
        let (x, y) = pill_origin_for_work_area(PillWorkArea {
            x: -12.0,
            y: 4.0,
            width: 160.0,
            height: 40.0,
        });
        assert_eq!(x, -12.0);
        assert_eq!(y, 4.0);
    }

    #[test]
    fn pill_window_prefers_native_cursor_display_before_primary_fallback() {
        let source = include_str!("mod.rs");
        let open = source
            .split_once("pub fn open_pill_window(")
            .and_then(|(_, rest)| rest.split_once("#[cfg(test)]"))
            .map(|(body, _)| body)
            .expect("pill window function boundary");
        assert!(open.contains("aiden_mac::pill_display::cursor_work_area()"));
        assert!(open.contains("display_id"));
        assert!(open.contains("cx.primary_display()"));
    }
}
