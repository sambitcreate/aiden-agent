//! Serialized dictation lifecycle — port of `main/services/dictation-coordinator.ts`.
//!
//! Every external event enters the same serialized queue, so cold-window
//! startup, duplicate ready messages, delivery, and a new hotkey can never
//! overtake one another. The queue is a tokio mutex (the TS promise chain):
//! each public method awaits the lock, runs its operation, and releases, so
//! later events strictly follow earlier ones. Stage transitions mirror the
//! TypeScript exactly (idle → starting → recording → transcribing →
//! delivering).

use std::future::Future;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use aiden_core::dictation::{DictationState, DictationStatePayload};
use futures::future::BoxFuture;

use crate::paste::PasteOutcome;

/// How long a finished/errored dictation stays visible before hiding.
pub const RESULT_HIDE_DELAY_MS: u64 = 1_200;
/// How long an error stays visible before hiding.
pub const ERROR_HIDE_DELAY_MS: u64 = 2_000;
/// Cap on the transcript delivered to paste (mirrors TS).
pub const MAX_TRANSCRIPT_LENGTH: usize = 100_000;

/// The coordinator stage machine (`DictationStage`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum DictationStage {
    #[default]
    Idle,
    Starting,
    Recording,
    Transcribing,
    Delivering,
}

/// Opaque timer handle returned by [`DictationCoordinatorDeps::set_timer`];
/// consumed by [`DictationCoordinatorDeps::clear_timer`].
pub struct TimerHandle {
    cancel: Box<dyn FnOnce() + Send>,
}

impl TimerHandle {
    pub fn new(cancel: Box<dyn FnOnce() + Send>) -> Self {
        Self { cancel }
    }

    /// Cancel the scheduled callback. Consumes the handle.
    pub fn cancel(self) {
        (self.cancel)();
    }
}

/// Injected dependencies — the `DictationCoordinatorDeps` interface from the
/// TypeScript coordinator.
pub trait DictationCoordinatorDeps: Send + Sync {
    /// Resolves `true` when this call created a new pill window/document.
    fn show_pill(&self) -> BoxFuture<'static, Result<bool, String>>;
    fn hide_pill(&self);
    fn destroy_pill(&self);
    fn broadcast(&self, payload: &DictationStatePayload);
    fn paste(&self, text: &str) -> BoxFuture<'static, PasteOutcome>;
    /// Schedule `callback` after `delay_ms`; the returned handle must be
    /// cleared with [`Self::clear_timer`] to cancel.
    fn set_timer(&self, callback: Box<dyn FnOnce() + Send>, delay_ms: u64) -> TimerHandle;
    fn clear_timer(&self, timer: TimerHandle);
    fn log_error(&self, message: &str, error: &dyn std::fmt::Display);
}

/// Shared coordinator state (guarded by a plain mutex; never held across
/// awaits). `Arc` so the hide-timer callback can reach the live stage + timer
/// slot from outside the queue.
struct CoordinatorState {
    stage: DictationStage,
    pill_ready: bool,
    hide_timer: Option<TimerHandle>,
}

/// Serialized dictation lifecycle.
pub struct DictationCoordinator {
    deps: Arc<dyn DictationCoordinatorDeps>,
    state: Arc<Mutex<CoordinatorState>>,
    /// The queue: one operation at a time, FIFO.
    serial: tokio::sync::Mutex<()>,
    disposed: AtomicBool,
}

impl DictationCoordinator {
    pub fn new(deps: Arc<dyn DictationCoordinatorDeps>) -> Self {
        Self {
            deps,
            state: Arc::new(Mutex::new(CoordinatorState {
                stage: DictationStage::Idle,
                pill_ready: false,
                hide_timer: None,
            })),
            serial: tokio::sync::Mutex::new(()),
            disposed: AtomicBool::new(false),
        }
    }

    pub fn current_stage(&self) -> DictationStage {
        self.with_state(|state| state.stage)
    }

    fn with_state<R>(&self, read: impl FnOnce(&CoordinatorState) -> R) -> R {
        match self.state.lock() {
            Ok(guard) => read(&guard),
            Err(poisoned) => read(&poisoned.into_inner()),
        }
    }

    fn with_state_mut<R>(&self, mutate: impl FnOnce(&mut CoordinatorState) -> R) -> R {
        match self.state.lock() {
            Ok(mut guard) => mutate(&mut guard),
            Err(poisoned) => mutate(&mut poisoned.into_inner()),
        }
    }

    /// Run `operation` on the serialized queue. Mirrors the TS `enqueue`:
    /// operations are chained, and a disposed coordinator skips pending work.
    async fn enqueue(&self, operation: impl Future<Output = ()> + Send) {
        let _guard = self.serial.lock().await;
        if self.disposed.load(Ordering::SeqCst) {
            return;
        }
        operation.await;
    }

    fn broadcast(&self, state: DictationState, message: Option<&str>) {
        self.deps.broadcast(&DictationStatePayload {
            state,
            message: message.map(str::to_string),
        });
    }

    fn clear_hide_timer(&self) {
        let timer = self.with_state_mut(|state| state.hide_timer.take());
        if let Some(timer) = timer {
            self.deps.clear_timer(timer);
        }
    }

    fn schedule_hide(&self, delay_ms: u64) {
        self.clear_hide_timer();
        let deps = self.deps.clone();
        let deps_for_timer = self.deps.clone();
        let state = self.state.clone();
        let timer = deps.set_timer(
            Box::new(move || {
                let mut guard = match state.lock() {
                    Ok(guard) => guard,
                    Err(poisoned) => poisoned.into_inner(),
                };
                guard.hide_timer = None;
                let stage = guard.stage;
                drop(guard);
                if stage == DictationStage::Idle {
                    deps_for_timer.hide_pill();
                }
            }),
            delay_ms,
        );
        self.with_state_mut(|state| state.hide_timer = Some(timer));
    }

    /// Hotkey callback. Idle → show the pill and start recording; while
    /// starting, a second press cancels; while recording it stops and starts
    /// transcription; while transcribing it cancels. Delivery is serialized:
    /// a queued toggle begins a new recording only after the previous
    /// transcript finished delivery.
    pub async fn toggle(&self) {
        self.enqueue(async {
            self.clear_hide_timer();
            match self.current_stage() {
                DictationStage::Idle => {
                    self.with_state_mut(|state| state.stage = DictationStage::Starting);
                    let created = match self.deps.show_pill().await {
                        Ok(created) => created,
                        Err(error) => {
                            self.with_state_mut(|state| state.stage = DictationStage::Idle);
                            self.deps
                                .log_error("Could not show the dictation pill.", &error);
                            return;
                        }
                    };
                    if created {
                        self.with_state_mut(|state| state.pill_ready = false);
                    }
                    let (stage, pill_ready) =
                        self.with_state(|state| (state.stage, state.pill_ready));
                    if stage == DictationStage::Starting && pill_ready {
                        self.with_state_mut(|state| state.stage = DictationStage::Recording);
                        self.broadcast(DictationState::Recording, None);
                    }
                }
                DictationStage::Starting => {
                    self.with_state_mut(|state| state.stage = DictationStage::Idle);
                    self.broadcast(DictationState::Cancelled, None);
                    self.deps.hide_pill();
                }
                DictationStage::Recording => {
                    self.with_state_mut(|state| state.stage = DictationStage::Transcribing);
                    self.broadcast(DictationState::Stopping, None);
                }
                DictationStage::Transcribing => {
                    self.with_state_mut(|state| state.stage = DictationStage::Idle);
                    self.broadcast(DictationState::Cancelled, None);
                    self.deps.hide_pill();
                }
                // Delivery is intentionally serialized — a queued toggle runs
                // only after the previous transcript finished delivery.
                DictationStage::Delivering => {}
            }
        })
        .await;
    }

    /// The pill signals it subscribed to state broadcasts. When a freshly
    /// created pill missed the initial "recording" broadcast, replay it.
    pub async fn ready(&self) {
        self.enqueue(async {
            self.with_state_mut(|state| state.pill_ready = true);
            if self.current_stage() == DictationStage::Starting {
                self.with_state_mut(|state| state.stage = DictationStage::Recording);
                self.broadcast(DictationState::Recording, None);
            }
        })
        .await;
    }

    /// Pill finished transcribing: deliver the transcript via paste, then
    /// hide after a short result pause.
    pub async fn result(&self, value: Option<&str>) {
        self.enqueue(async {
            if self.current_stage() != DictationStage::Transcribing {
                return;
            }
            self.with_state_mut(|state| state.stage = DictationStage::Delivering);
            let transcript = value
                .map(|value| value.trim())
                .unwrap_or_default()
                .chars()
                .take(MAX_TRANSCRIPT_LENGTH)
                .collect::<String>();
            if transcript.is_empty() {
                self.with_state_mut(|state| state.stage = DictationStage::Idle);
                self.broadcast(DictationState::Error, Some("No speech detected."));
                self.schedule_hide(ERROR_HIDE_DELAY_MS);
                return;
            }
            let outcome = self.deps.paste(&transcript).await;
            self.with_state_mut(|state| state.stage = DictationStage::Idle);
            match outcome {
                PasteOutcome::Pasted => self.broadcast(DictationState::Pasted, None),
                PasteOutcome::Copied => self.broadcast(DictationState::Copied, None),
            }
            self.schedule_hide(RESULT_HIDE_DELAY_MS);
        })
        .await;
    }

    /// Pill reports a capture/transcription failure.
    pub async fn error(&self, value: Option<&str>) {
        self.enqueue(async {
            if self.current_stage() == DictationStage::Idle {
                return;
            }
            self.with_state_mut(|state| state.stage = DictationStage::Idle);
            let message = value
                .map(|value| value.trim())
                .filter(|value| !value.is_empty())
                .map(str::to_string)
                .unwrap_or_else(|| "Dictation failed.".to_string());
            self.broadcast(DictationState::Error, Some(&message));
            self.schedule_hide(ERROR_HIDE_DELAY_MS);
        })
        .await;
    }

    /// Pill cancel button: discard the current recording and hide.
    pub async fn cancel(&self) {
        self.enqueue(async {
            if self.current_stage() == DictationStage::Idle {
                return;
            }
            self.with_state_mut(|state| state.stage = DictationStage::Idle);
            self.clear_hide_timer();
            self.broadcast(DictationState::Cancelled, None);
            self.deps.hide_pill();
        })
        .await;
    }

    /// App shutdown: tear down the pill window and ignore further events.
    pub fn dispose(&self) {
        self.disposed.store(true, Ordering::SeqCst);
        self.clear_hide_timer();
        self.with_state_mut(|state| state.stage = DictationStage::Idle);
        self.deps.destroy_pill();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use futures::FutureExt;
    use std::sync::atomic::{AtomicUsize, Ordering as AtomicOrdering};
    use std::time::Duration;

    /// A one-shot value resolver that supports multiple awaits (the TS
    /// `deferred()` helper, whose promise every `showPill` call shares).
    struct Deferred<T: Clone> {
        value: std::sync::Mutex<Option<T>>,
        notify: tokio::sync::Notify,
    }

    impl<T: Clone> Deferred<T> {
        fn new() -> Self {
            Self {
                value: std::sync::Mutex::new(None),
                notify: tokio::sync::Notify::new(),
            }
        }

        async fn wait(&self) -> T {
            loop {
                if let Some(value) = self.value.lock().unwrap().clone() {
                    return value;
                }
                self.notify.notified().await;
            }
        }

        fn resolve(&self, value: T) {
            *self.value.lock().unwrap() = Some(value);
            self.notify.notify_waiters();
        }
    }

    #[derive(Default)]
    struct HarnessState {
        events: Mutex<Vec<DictationStatePayload>>,
        hidden: AtomicUsize,
        logs: Mutex<Vec<String>>,
    }

    impl HarnessState {
        fn timer_delay_ms(&self) -> u64 {
            60_000
        }
    }

    type ShowPill = Box<dyn Fn() -> BoxFuture<'static, Result<bool, String>> + Send + Sync>;
    type PasteFn = Box<dyn Fn(String) -> BoxFuture<'static, PasteOutcome> + Send + Sync>;

    struct HarnessDeps {
        show_pill: ShowPill,
        hide_pill: Box<dyn Fn() + Send + Sync>,
        destroy_pill: Box<dyn Fn() + Send + Sync>,
        paste: PasteFn,
        shared: Arc<HarnessState>,
    }

    impl DictationCoordinatorDeps for HarnessDeps {
        fn show_pill(&self) -> BoxFuture<'static, Result<bool, String>> {
            (self.show_pill)()
        }
        fn hide_pill(&self) {
            (self.hide_pill)();
        }
        fn destroy_pill(&self) {
            (self.destroy_pill)();
        }
        fn broadcast(&self, payload: &DictationStatePayload) {
            if let Ok(mut events) = self.shared.events.lock() {
                events.push(payload.clone());
            }
        }
        fn paste(&self, text: &str) -> BoxFuture<'static, PasteOutcome> {
            (self.paste)(text.to_string())
        }
        fn set_timer(&self, callback: Box<dyn FnOnce() + Send>, delay_ms: u64) -> TimerHandle {
            // Never fires inside a test (the TS harness used 60_000 ms).
            let delay_ms = delay_ms.max(self.shared.timer_delay_ms());
            let handle = tokio::spawn(async move {
                tokio::time::sleep(Duration::from_millis(delay_ms)).await;
                callback();
            });
            TimerHandle::new(Box::new(move || handle.abort()))
        }
        fn clear_timer(&self, timer: TimerHandle) {
            timer.cancel();
        }
        fn log_error(&self, message: &str, error: &dyn std::fmt::Display) {
            if let Ok(mut logs) = self.shared.logs.lock() {
                logs.push(format!("{message}: {error}"));
            }
        }
    }

    struct Harness {
        coordinator: Arc<DictationCoordinator>,
        shared: Arc<HarnessState>,
    }

    impl Harness {
        fn hidden(&self) -> usize {
            self.shared.hidden.load(AtomicOrdering::SeqCst)
        }

        fn events(&self) -> Vec<String> {
            self.shared
                .events
                .lock()
                .map(|events| events.iter().map(payload_label).collect())
                .unwrap_or_default()
        }

        fn logs(&self) -> Vec<String> {
            self.shared
                .logs
                .lock()
                .map(|logs| logs.clone())
                .unwrap_or_default()
        }
    }

    fn payload_label(payload: &DictationStatePayload) -> String {
        match payload.state {
            DictationState::Recording => "recording".into(),
            DictationState::Stopping => "stopping".into(),
            DictationState::Pasted => "pasted".into(),
            DictationState::Copied => "copied".into(),
            DictationState::Error => {
                format!("error:{}", payload.message.as_deref().unwrap_or_default())
            }
            DictationState::Cancelled => "cancelled".into(),
        }
    }

    fn harness_with(show_pill: ShowPill, paste: Option<PasteFn>) -> Harness {
        let shared = Arc::new(HarnessState::default());
        let shared_for_hide = shared.clone();
        let deps = Arc::new(HarnessDeps {
            show_pill,
            hide_pill: Box::new(move || {
                shared_for_hide.hidden.fetch_add(1, AtomicOrdering::SeqCst);
            }),
            destroy_pill: Box::new(|| {}),
            paste: paste
                .unwrap_or_else(|| Box::new(|_text| async { PasteOutcome::Pasted }.boxed())),
            shared: shared.clone(),
        });
        let coordinator = Arc::new(DictationCoordinator::new(deps));
        Harness {
            coordinator,
            shared,
        }
    }

    fn default_show_pill() -> ShowPill {
        Box::new(|| async { Ok(false) }.boxed())
    }

    // -----------------------------------------------------------------------
    // dictation-coordinator.test.ts — all four test cases mirrored
    // -----------------------------------------------------------------------

    #[tokio::test]
    async fn a_second_hotkey_during_cold_pill_startup_cancels_without_a_late_recording_event() {
        let shown = Arc::new(Deferred::<bool>::new());
        let shown_for_show = shown.clone();
        let harness = harness_with(
            Box::new(move || {
                let shown = shown_for_show.clone();
                async move { Ok(shown.wait().await) }.boxed()
            }),
            None,
        );
        let first = harness.coordinator.toggle();
        let second = harness.coordinator.toggle();
        shown.resolve(true);
        tokio::join!(first, second);
        assert_eq!(harness.coordinator.current_stage(), DictationStage::Idle);
        assert_eq!(harness.events(), vec!["cancelled"]);
        assert_eq!(harness.hidden(), 1);
    }

    #[tokio::test]
    async fn duplicate_pill_ready_messages_start_one_recorder_only() {
        let harness = harness_with(default_show_pill(), None);
        harness.coordinator.toggle().await;
        tokio::join!(harness.coordinator.ready(), harness.coordinator.ready());
        assert_eq!(
            harness.coordinator.current_stage(),
            DictationStage::Recording
        );
        assert_eq!(harness.events(), vec!["recording"]);
    }

    #[tokio::test]
    async fn a_new_hotkey_waits_for_transcript_delivery_before_starting_another_recording() {
        let delivered = Arc::new(Deferred::<()>::new());
        let paste_started = Arc::new(Deferred::<()>::new());
        let delivered_for_paste = delivered.clone();
        let paste_started_for_paste = paste_started.clone();
        let harness = harness_with(
            default_show_pill(),
            Some(Box::new(move |_text| {
                let delivered = delivered_for_paste.clone();
                let paste_started = paste_started_for_paste.clone();
                async move {
                    paste_started.resolve(());
                    delivered.wait().await;
                    PasteOutcome::Pasted
                }
                .boxed()
            })),
        );
        harness.coordinator.ready().await;
        harness.coordinator.toggle().await;
        harness.coordinator.toggle().await;
        // The TS promises were eager; spawn the lazy Rust futures so the
        // paste deferred resolves while delivery is in flight.
        let coordinator = harness.coordinator.clone();
        let result = tokio::spawn(async move { coordinator.result(Some("first")).await });
        let coordinator = harness.coordinator.clone();
        let next = tokio::spawn(async move { coordinator.toggle().await });
        paste_started.wait().await;
        assert_eq!(
            harness.coordinator.current_stage(),
            DictationStage::Delivering
        );
        delivered.resolve(());
        let (result, next) = tokio::join!(result, next);
        result.unwrap();
        next.unwrap();
        assert_eq!(
            harness.events(),
            vec!["recording", "stopping", "pasted", "recording"]
        );
        assert_eq!(
            harness.coordinator.current_stage(),
            DictationStage::Recording
        );
    }

    #[tokio::test]
    async fn a_hotkey_cancels_a_stuck_transcription_and_ignores_its_late_result() {
        let harness = harness_with(default_show_pill(), None);
        harness.coordinator.ready().await;
        harness.coordinator.toggle().await;
        harness.coordinator.toggle().await;
        harness.coordinator.toggle().await;
        harness.coordinator.result(Some("late transcript")).await;
        assert_eq!(harness.events(), vec!["recording", "stopping", "cancelled"]);
        assert_eq!(harness.coordinator.current_stage(), DictationStage::Idle);
    }

    // -----------------------------------------------------------------------
    // Additional state machine edges implied by the TS (not covered there)
    // -----------------------------------------------------------------------

    #[tokio::test]
    async fn empty_transcript_reports_no_speech_detected() {
        let harness = harness_with(default_show_pill(), None);
        harness.coordinator.ready().await;
        harness.coordinator.toggle().await;
        harness.coordinator.toggle().await;
        harness.coordinator.result(Some("   ")).await;
        assert_eq!(
            harness.events(),
            vec!["recording", "stopping", "error:No speech detected."]
        );
        assert_eq!(harness.coordinator.current_stage(), DictationStage::Idle);
    }

    #[tokio::test]
    async fn result_outside_transcribing_is_ignored() {
        let harness = harness_with(default_show_pill(), None);
        harness.coordinator.result(Some("stray")).await;
        assert_eq!(harness.events(), Vec::<String>::new());
        assert_eq!(harness.coordinator.current_stage(), DictationStage::Idle);
    }

    #[tokio::test]
    async fn error_outside_a_live_session_is_ignored() {
        let harness = harness_with(default_show_pill(), None);
        harness.coordinator.error(Some("boom")).await;
        assert_eq!(harness.events(), Vec::<String>::new());
    }

    #[tokio::test]
    async fn error_during_recording_returns_to_idle_and_reports() {
        let harness = harness_with(default_show_pill(), None);
        harness.coordinator.ready().await;
        harness.coordinator.toggle().await;
        harness.coordinator.error(Some("mic denied")).await;
        assert_eq!(harness.events(), vec!["recording", "error:mic denied"]);
        assert_eq!(harness.coordinator.current_stage(), DictationStage::Idle);
    }

    #[tokio::test]
    async fn error_with_blank_message_falls_back_to_default_copy() {
        let harness = harness_with(default_show_pill(), None);
        harness.coordinator.ready().await;
        harness.coordinator.toggle().await;
        harness.coordinator.error(Some("   ")).await;
        assert_eq!(
            harness.events(),
            vec!["recording", "error:Dictation failed."]
        );
    }

    #[tokio::test]
    async fn cancel_during_recording_hides_and_discards() {
        let harness = harness_with(default_show_pill(), None);
        harness.coordinator.ready().await;
        harness.coordinator.toggle().await;
        harness.coordinator.cancel().await;
        assert_eq!(harness.events(), vec!["recording", "cancelled"]);
        assert_eq!(harness.hidden(), 1);
        assert_eq!(harness.coordinator.current_stage(), DictationStage::Idle);
    }

    #[tokio::test]
    async fn cancel_at_idle_is_a_noop() {
        let harness = harness_with(default_show_pill(), None);
        harness.coordinator.cancel().await;
        assert_eq!(harness.events(), Vec::<String>::new());
        assert_eq!(harness.hidden(), 0);
    }

    #[tokio::test]
    async fn transcript_is_trimmed_and_capped_at_max_length() {
        let captured = Arc::new(Mutex::new(String::new()));
        let captured_for_paste = captured.clone();
        let harness = harness_with(
            default_show_pill(),
            Some(Box::new(move |text| {
                let captured = captured_for_paste.clone();
                async move {
                    *captured.lock().unwrap() = text.clone();
                    PasteOutcome::Copied
                }
                .boxed()
            })),
        );
        harness.coordinator.ready().await;
        harness.coordinator.toggle().await;
        harness.coordinator.toggle().await;
        let long = format!("  {}  ", "x".repeat(MAX_TRANSCRIPT_LENGTH + 50));
        harness.coordinator.result(Some(&long)).await;
        let delivered = captured.lock().unwrap().clone();
        assert_eq!(delivered.len(), MAX_TRANSCRIPT_LENGTH);
        assert_eq!(harness.events(), vec!["recording", "stopping", "copied"]);
        assert_eq!(harness.coordinator.current_stage(), DictationStage::Idle);
    }

    #[tokio::test]
    async fn dispose_tears_down_the_pill_and_blocks_later_ops() {
        let destroyed = Arc::new(AtomicUsize::new(0));
        let destroyed_for_deps = destroyed.clone();
        let shared = Arc::new(HarnessState::default());
        let shared_for_hide = shared.clone();
        let deps = Arc::new(HarnessDeps {
            show_pill: default_show_pill(),
            hide_pill: Box::new(move || {
                shared_for_hide.hidden.fetch_add(1, AtomicOrdering::SeqCst);
            }),
            destroy_pill: Box::new(move || {
                destroyed_for_deps.fetch_add(1, AtomicOrdering::SeqCst);
            }),
            paste: Box::new(|_text| async { PasteOutcome::Pasted }.boxed()),
            shared: shared.clone(),
        });
        let coordinator = Arc::new(DictationCoordinator::new(deps));
        coordinator.dispose();
        assert_eq!(destroyed.load(AtomicOrdering::SeqCst), 1);
        coordinator.toggle().await;
        coordinator.ready().await;
        assert_eq!(coordinator.current_stage(), DictationStage::Idle);
        assert!(shared.events.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn a_failing_show_pill_returns_to_idle_and_logs() {
        let harness = harness_with(
            Box::new(|| async { Err("window boom".into()) }.boxed()),
            None,
        );
        harness.coordinator.toggle().await;
        assert_eq!(harness.coordinator.current_stage(), DictationStage::Idle);
        assert!(harness.events().is_empty());
        assert!(harness
            .logs()
            .iter()
            .any(|log| log.starts_with("Could not show the dictation pill.")));
    }

    #[tokio::test]
    async fn result_schedules_a_pending_hide_without_an_immediate_hide() {
        let harness = harness_with(default_show_pill(), None);
        harness.coordinator.ready().await;
        harness.coordinator.toggle().await;
        harness.coordinator.toggle().await;
        harness.coordinator.result(Some("done")).await;
        // The harness timer never fires, so the hide is scheduled but not
        // executed yet — matching TS `scheduleHide(RESULT_HIDE_DELAY_MS)`.
        assert_eq!(harness.hidden(), 0);
        assert_eq!(harness.events(), vec!["recording", "stopping", "pasted"]);
    }
}
