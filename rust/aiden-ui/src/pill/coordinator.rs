//! The pill's dictation coordinator wiring: a port of the capture/transcribe
//! loop from `renderer/pill/pill-app.tsx` and the glue from
//! `main/services/dictation.ts`. It owns an
//! `aiden_mac::dictation_coordinator::DictationCoordinator` and reacts to its
//! broadcasts by driving the live capture → transcribe → report loop.
//!
//! Flow (mirroring the Electron pill):
//!
//! 1. The app calls [`PillCoordinator::toggle`] (hotkey) → the
//!    `DictationCoordinator` runs its serialized state machine.
//! 2. When the coordinator opens a *new* pill window it emits a `Ready`
//!    replay (the TS `handlePillReady`), which starts recording and
//!    broadcasts `Recording` → this coordinator starts the microphone.
//! 3. The next toggle broadcasts `Stopping` → this coordinator stops the
//!    capture, drains the mono 16 kHz samples, transcribes on-device
//!    (sherpa, gated behind the `dictation` feature + model install), and
//!    reports the result back so the coordinator pastes it.
//!
//! The module is GPUI-free: the app injects window/show/paste closures, so
//! the whole loop is unit-testable with a fake capture + transcribe.

use std::sync::Arc;

use aiden_core::dictation::{DictationState, DictationStatePayload};
use aiden_mac::dictation_coordinator::{
    DictationCoordinator, DictationCoordinatorDeps, TimerHandle,
};
use aiden_mac::paste::{PasteDeps, PasteOutcome};
use futures::future::BoxFuture;
use futures::FutureExt;
use tokio::sync::mpsc;

use super::live_audio::LiveAudioSource;

/// Inject a fake recognizer for tests.
pub type TranscribeFn =
    Box<dyn Fn(String, Vec<f32>) -> BoxFuture<'static, Result<String, String>> + Send + Sync>;

/// The error logger injected by the shell.
pub type LogError = Box<dyn Fn(&str, String) + Send + Sync>;

/// Everything the coordinator needs from the app shell.
pub struct PillCoordinatorDeps {
    /// Open the pill window; `true` when a new window was created.
    pub show_pill: Box<dyn Fn() -> BoxFuture<'static, Result<bool, String>> + Send + Sync>,
    pub hide_pill: Box<dyn Fn() + Send + Sync>,
    pub destroy_pill: Box<dyn Fn() + Send + Sync>,
    /// Forward a `dictation:state` payload to the pill window.
    pub forward: Box<dyn Fn(DictationStatePayload) + Send + Sync>,
    /// Paste backend for transcript delivery (defaults to `MacPasteDeps`).
    pub paste: Option<Arc<dyn PasteDeps>>,
    pub log_error: LogError,
    /// The on-device model id (defaults to the recommended `parakeet-v3`).
    pub model_id: String,
    /// The live audio source shared with the pill meter.
    pub audio: Arc<LiveAudioSource>,
    /// Optional injected recognizer (tests); defaults to the sherpa path.
    pub transcribe: Option<TranscribeFn>,
}

/// Events the coordinator's watcher processes (broadcasts from the state
/// machine plus external pill events).
enum CoordinatorEvent {
    Broadcast(DictationStatePayload),
    /// The user pressed the pill's cancel button.
    Cancel,
    /// A fresh pill window was created and needs the recording replay.
    Ready,
}

/// The wired dictation coordinator.
pub struct PillCoordinator {
    dictation: Arc<DictationCoordinator>,
    deps: Arc<PillCoordinatorDeps>,
    audio: Arc<LiveAudioSource>,
    event_tx: mpsc::UnboundedSender<CoordinatorEvent>,
}

impl PillCoordinator {
    /// Creates the coordinator and returns `(coordinator, watcher_future)`.
    /// The caller must spawn `watcher_future` on a tokio runtime (e.g. via
    /// `gpui_tokio_bridge::Tokio::spawn(cx, watcher)`).
    pub fn new(
        deps: PillCoordinatorDeps,
    ) -> (
        Arc<Self>,
        std::pin::Pin<Box<dyn std::future::Future<Output = ()> + Send>>,
    ) {
        let deps = Arc::new(deps);
        let audio = deps.audio.clone();
        let (event_tx, event_rx) = mpsc::unbounded_channel::<CoordinatorEvent>();

        let coordinator_deps = Arc::new(CoordinatorDepsAdapter {
            deps: deps.clone(),
            event_tx: event_tx.clone(),
        });
        let dictation = Arc::new(DictationCoordinator::new(coordinator_deps));

        let this = Arc::new(Self {
            dictation,
            deps,
            audio,
            event_tx,
        });
        // The watcher serializes broadcasts + external pill events and drives
        // the capture/transcribe loop. It lives exactly as long as the event
        // sender (i.e. as long as `this`), so nothing leaks. The caller spawns
        // it — do NOT call tokio::spawn here because we may be on a GPUI thread
        // without a tokio runtime guard.
        let watcher_this = this.clone();
        let watcher = Box::pin(async move {
            let mut rx = event_rx;
            while let Some(event) = rx.recv().await {
                match event {
                    CoordinatorEvent::Broadcast(payload) => {
                        watcher_this.handle_broadcast(payload).await;
                    }
                    CoordinatorEvent::Cancel => watcher_this.dictation.cancel().await,
                    CoordinatorEvent::Ready => watcher_this.dictation.ready().await,
                }
            }
        });
        (this, watcher)
    }

    /// The underlying state machine (stage queries for tests/instrumentation).
    #[allow(dead_code)] // coordinator-facing; the shell queries stage via events
    pub fn dictation(&self) -> &DictationCoordinator {
        &self.dictation
    }

    /// The audio source shared with the pill meter.
    #[allow(dead_code)] // coordinator-facing; the shell injects it into PillDeps
    pub fn audio(&self) -> Arc<LiveAudioSource> {
        self.audio.clone()
    }

    /// Hotkey: toggle dictation (fire-and-forget from the shell).
    pub async fn toggle(&self) {
        self.dictation.toggle().await;
    }

    /// The pill's cancel button (routes through the watcher so it is
    /// serialized with broadcasts).
    pub fn request_cancel(&self) {
        let _ = self.event_tx.send(CoordinatorEvent::Cancel);
    }

    /// App shutdown.
    #[allow(dead_code)] // coordinator-facing; the shell's quit path calls this
    pub fn dispose(&self) {
        self.dictation.dispose();
        self.audio.stop_capture_blocking();
    }
    async fn handle_broadcast(&self, payload: DictationStatePayload) {
        (self.deps.forward)(payload.clone());
        match payload.state {
            DictationState::Recording => {
                if let Err(error) = self.audio.start_capture().await {
                    self.dictation
                        .error(Some(&format!(
                            "Microphone access is needed for dictation. {error}"
                        )))
                        .await;
                }
            }
            DictationState::Stopping => self.transcribe_flow().await,
            DictationState::Cancelled | DictationState::Error => {
                self.audio.stop_capture().await;
            }
            DictationState::Pasted | DictationState::Copied => {}
        }
    }

    /// Stop the capture, drain the 16 kHz mono samples, transcribe, and hand
    /// the transcript (or the failure) back to the state machine.
    async fn transcribe_flow(&self) {
        let samples = self.audio.stop_capture().await;
        let model_id = self.deps.model_id.clone();
        let result = match self.deps.transcribe.as_ref() {
            Some(transcribe) => transcribe(model_id, samples).await,
            None => default_transcribe(&model_id, samples).await,
        };
        match result {
            Ok(text) => self.dictation.result(Some(&text)).await,
            Err(message) => self.dictation.error(Some(&message)).await,
        }
    }
}

/// The default on-device transcription (sherpa Parakeet). Gated behind the
/// `dictation` feature; a build without it reports a clear error.
async fn default_transcribe(model_id: &str, samples: Vec<f32>) -> Result<String, String> {
    #[cfg(feature = "dictation")]
    {
        use aiden_mac::local_models::is_model_installed;
        use aiden_mac::sherpa::get_recognizer;
        if !is_model_installed(model_id) {
            return Err(
                "The selected voice model isn't downloaded. Download it in Settings → Voice."
                    .to_string(),
            );
        }
        let recognizer = get_recognizer(model_id).map_err(|error| error.to_string())?;
        tokio::task::spawn_blocking(move || recognizer.transcribe(&samples))
            .await
            .map_err(|error| format!("transcription task failed: {error}"))
    }
    #[cfg(not(feature = "dictation"))]
    {
        let _ = (model_id, samples);
        Err("On-device dictation isn't built into this app build.".to_string())
    }
}

/// Adapts [`PillCoordinatorDeps`] to the `DictationCoordinatorDeps` trait.
struct CoordinatorDepsAdapter {
    deps: Arc<PillCoordinatorDeps>,
    event_tx: mpsc::UnboundedSender<CoordinatorEvent>,
}

impl DictationCoordinatorDeps for CoordinatorDepsAdapter {
    fn show_pill(&self) -> BoxFuture<'static, Result<bool, String>> {
        let deps = self.deps.clone();
        let event_tx = self.event_tx.clone();
        async move {
            let created = (deps.show_pill)().await?;
            // A fresh pill needs the recording replay once it is live (the TS
            // `handlePillReady` path).
            if created {
                let _ = event_tx.send(CoordinatorEvent::Ready);
            }
            Ok(created)
        }
        .boxed()
    }

    fn hide_pill(&self) {
        (self.deps.hide_pill)();
    }

    fn destroy_pill(&self) {
        (self.deps.destroy_pill)();
    }

    fn broadcast(&self, payload: &DictationStatePayload) {
        let _ = self
            .event_tx
            .send(CoordinatorEvent::Broadcast(payload.clone()));
    }

    fn paste(&self, text: &str) -> BoxFuture<'static, PasteOutcome> {
        let paste: Arc<dyn PasteDeps> = self
            .deps
            .paste
            .clone()
            .unwrap_or_else(|| Arc::new(aiden_mac::paste::MacPasteDeps));
        let text = text.to_string();
        async move { aiden_mac::paste::paste_transcript(&text, paste.as_ref()).await }.boxed()
    }

    fn set_timer(&self, callback: Box<dyn FnOnce() + Send>, delay_ms: u64) -> TimerHandle {
        // Runtime contract: this is only ever invoked from the dictation
        // coordinator's state machine, which runs inside the pill watcher — and
        // the watcher is spawned via `gpui_tokio_bridge::Tokio::spawn` (see
        // `app::wire_pill_coordinator`). So a tokio guard IS present here and
        // `tokio::spawn` + `tokio::time::sleep` are safe. Do NOT call this impl
        // from a GPUI foreground/cx.spawn context — see the crate-root runtime
        // contract in `main.rs`.
        let handle = tokio::spawn(async move {
            tokio::time::sleep(std::time::Duration::from_millis(delay_ms)).await;
            callback();
        });
        TimerHandle::new(Box::new(move || handle.abort()))
    }

    fn clear_timer(&self, timer: TimerHandle) {
        timer.cancel();
    }

    fn log_error(&self, message: &str, error: &dyn std::fmt::Display) {
        (self.deps.log_error)(message, error.to_string());
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::pill::live_audio::tests::FakeCaptureHandles;
    use aiden_mac::dictation_coordinator::DictationStage;
    use std::sync::atomic::{AtomicBool, Ordering as AtomicOrdering};
    use std::time::Duration;

    #[derive(Clone)]
    struct TestHandles {
        forwarded: Arc<std::sync::Mutex<Vec<DictationStatePayload>>>,
        hide_pill: Arc<AtomicBool>,
    }

    impl TestHandles {
        fn forwarded_states(&self) -> Vec<String> {
            self.forwarded
                .lock()
                .map(|events| events.iter().map(|p| p.state.label()).collect())
                .unwrap_or_default()
        }

        fn error_messages(&self) -> Vec<String> {
            self.forwarded
                .lock()
                .map(|events| {
                    events
                        .iter()
                        .filter(|payload| payload.state == DictationState::Error)
                        .filter_map(|payload| payload.message.clone())
                        .collect()
                })
                .unwrap_or_default()
        }
    }

    trait StateLabel {
        fn label(&self) -> String;
    }
    impl StateLabel for DictationState {
        fn label(&self) -> String {
            match self {
                DictationState::Recording => "recording".into(),
                DictationState::Stopping => "stopping".into(),
                DictationState::Pasted => "pasted".into(),
                DictationState::Copied => "copied".into(),
                DictationState::Error => "error".into(),
                DictationState::Cancelled => "cancelled".into(),
            }
        }
    }

    async fn wait_until(mut condition: impl FnMut() -> bool, timeout: Duration) -> bool {
        let deadline = std::time::Instant::now() + timeout;
        while std::time::Instant::now() < deadline {
            if condition() {
                return true;
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
        condition()
    }

    /// Paste deps that always succeeds (trusted + pasted).
    struct FakePasteDeps;
    impl PasteDeps for FakePasteDeps {
        fn write_clipboard(&self, _text: &str) {}
        fn is_accessibility_trusted(&self, _prompt: bool) -> bool {
            true
        }
        fn paste_with_preserved_clipboard(
            &self,
            _text: &str,
        ) -> BoxFuture<'static, Result<bool, String>> {
            async { Ok(true) }.boxed()
        }
        fn log(&self, _message: &str, _error: Option<&str>) {}
    }

    /// Build a fully-wired coordinator over shared fake capture handles.
    fn coordinator(
        handles: &FakeCaptureHandles,
        transcribe: Option<TranscribeFn>,
        model_id: &str,
    ) -> (Arc<PillCoordinator>, TestHandles) {
        let forwarded = Arc::new(std::sync::Mutex::new(Vec::new()));
        let hide_pill = Arc::new(AtomicBool::new(false));
        let test_handles = TestHandles {
            forwarded: forwarded.clone(),
            hide_pill: hide_pill.clone(),
        };
        let audio = Arc::new(LiveAudioSource::with_capture_factory(
            handles.clone().factory(),
        ));
        let pill = PillCoordinator::new(PillCoordinatorDeps {
            show_pill: Box::new(|| async { Ok(true) }.boxed()),
            hide_pill: Box::new(move || {
                hide_pill.store(true, AtomicOrdering::SeqCst);
            }),
            destroy_pill: Box::new(|| {}),
            forward: Box::new(move |payload| {
                if let Ok(mut events) = forwarded.lock() {
                    events.push(payload);
                }
            }),
            paste: Some(Arc::new(FakePasteDeps)),
            log_error: Box::new(|_message, _error| {}),
            model_id: model_id.to_string(),
            audio,
            transcribe,
        });
        let (pill, watcher) = pill;
        tokio::spawn(watcher); // tests are #[tokio::test] — runtime is available
        (pill, test_handles)
    }

    /// Regression guard for the runtime contract (see the crate-root doc in
    /// `main.rs`): [`PillCoordinator::new`] must NOT touch the tokio runtime,
    /// because in production it is constructed on the GPUI foreground, which
    /// carries no tokio runtime guard. Historically `new()` called bare
    /// `tokio::spawn` internally — which was masked in CI because every other
    /// test here runs under `#[tokio::test]` (a runtime IS present), so it only
    /// panicked in the real app (fix: commit 24e5d57).
    ///
    /// This is deliberately a plain `#[test]` with NO tokio runtime. If anyone
    /// reintroduces a `tokio::spawn` / `tokio::time::*` / `spawn_blocking`
    /// inside `new()`, it will panic here ("there is no reactor running") and
    /// fail CI instead of crashing the app at runtime.
    #[test]
    fn new_does_not_require_a_tokio_runtime() {
        let handles = FakeCaptureHandles::default();
        let audio = Arc::new(LiveAudioSource::with_capture_factory(handles.factory()));
        let (pill, watcher) = PillCoordinator::new(PillCoordinatorDeps {
            show_pill: Box::new(|| async { Ok(true) }.boxed()),
            hide_pill: Box::new(|| {}),
            destroy_pill: Box::new(|| {}),
            forward: Box::new(|_payload| {}),
            paste: Some(Arc::new(FakePasteDeps)),
            log_error: Box::new(|_message, _error| {}),
            model_id: "regression-model".to_string(),
            audio,
            transcribe: None,
        });
        // The coordinator is usable immediately and holds the audio source; the
        // watcher future is the caller's responsibility to spawn on a tokio
        // runtime. We deliberately do NOT poll/await `watcher` here (that would
        // need a tokio executor) — only assert construction succeeded.
        assert!(!pill.audio().is_running());
        // Dropping both without spawning is safe and requires no runtime: the
        // event sender drops, so the watcher (if ever driven elsewhere) would
        // observe the closed channel and exit.
        drop(watcher);
        drop(pill);
    }

    #[tokio::test]
    async fn a_hotkey_records_then_transcribes_and_delivers() {
        let handles = FakeCaptureHandles::default();
        let transcribe: TranscribeFn = Box::new(|_model_id, samples| {
            async move {
                assert_eq!(samples.len(), 1024, "transcription got the captured audio");
                Ok("hello world".to_string())
            }
            .boxed()
        });
        let (pill, test_handles) = coordinator(&handles, Some(transcribe), "parakeet-v3");

        // Hotkey 1: the fresh window triggers the ready replay → recording.
        pill.toggle().await;
        assert!(wait_until(|| handles.is_running(), Duration::from_secs(2)).await);
        assert!(
            wait_until(
                || test_handles
                    .forwarded_states()
                    .contains(&"recording".to_string()),
                Duration::from_secs(2)
            )
            .await
        );

        // Simulate mic input, then hotkey 2: stop → transcribe → deliver.
        handles.feed(&[0.25; 512]);
        handles.feed(&[0.25; 512]);
        pill.toggle().await;
        assert!(
            wait_until(
                || test_handles
                    .forwarded_states()
                    .contains(&"pasted".to_string()),
                Duration::from_secs(2)
            )
            .await
        );
        assert!(!handles.is_running());
        // The hide timer is scheduled (1.2 s), not yet fired.
        assert!(!test_handles.hide_pill.load(AtomicOrdering::SeqCst));
        let states = test_handles.forwarded_states();
        assert!(
            states.iter().position(|s| s == "stopping").unwrap()
                < states.iter().position(|s| s == "pasted").unwrap()
        );
        assert_eq!(pill.dictation().current_stage(), DictationStage::Idle);
    }

    #[tokio::test]
    async fn a_missing_model_reports_the_settings_voice_error() {
        let handles = FakeCaptureHandles::default();
        // transcribe: None → the default path. With the `dictation` feature
        // the sherpa path refuses with the exact Settings → Voice copy when
        // the model is not installed; without it the build reports that
        // on-device dictation isn't compiled in.
        let (pill, test_handles) = coordinator(&handles, None, "parakeet-v3");
        pill.toggle().await;
        assert!(wait_until(|| handles.is_running(), Duration::from_secs(2)).await);
        pill.toggle().await;
        #[cfg(feature = "dictation")]
        let expected = "Download it in Settings → Voice";
        #[cfg(not(feature = "dictation"))]
        let expected = "isn't built into this app build";
        assert!(
            wait_until(
                || test_handles
                    .error_messages()
                    .iter()
                    .any(|message| message.contains(expected)),
                Duration::from_secs(2)
            )
            .await
        );
        assert_eq!(pill.dictation().current_stage(), DictationStage::Idle);
        assert!(!handles.is_running());
    }

    #[tokio::test]
    async fn cancel_button_routes_through_the_state_machine() {
        let handles = FakeCaptureHandles::default();
        let (pill, test_handles) = coordinator(
            &handles,
            Some(Box::new(|_model_id, _samples| {
                async { Ok("x".to_string()) }.boxed()
            })),
            "parakeet-v3",
        );
        pill.toggle().await;
        assert!(wait_until(|| handles.is_running(), Duration::from_secs(2)).await);
        pill.request_cancel();
        assert!(
            wait_until(
                || test_handles
                    .forwarded_states()
                    .contains(&"cancelled".to_string()),
                Duration::from_secs(2)
            )
            .await
        );
        assert!(wait_until(|| !handles.is_running(), Duration::from_secs(2)).await);
        assert!(test_handles.hide_pill.load(AtomicOrdering::SeqCst));
    }
}
