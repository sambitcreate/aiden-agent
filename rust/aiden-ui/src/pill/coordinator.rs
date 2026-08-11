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

use std::sync::{Arc, Mutex};

use aiden_core::dictation::{DictationState, DictationStatePayload};
use aiden_mac::dictation_coordinator::{
    DictationCoordinator, DictationCoordinatorDeps, TimerHandle,
};
use aiden_mac::paste::{PasteDeps, PasteOutcome};
use futures::future::BoxFuture;
use futures::FutureExt;
use tokio::sync::mpsc;

use super::live_audio::LiveAudioSource;
use crate::services::voice::{VoiceAuthority, VoiceProvider, VoiceRecordingLease};

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
    /// App-owned voice selection and cancellation authority.
    pub voice: Arc<VoiceAuthority>,
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
    active_lease: Mutex<Option<VoiceRecordingLease>>,
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
        let voice_changes = deps.voice.subscribe_changes();
        let credential_changes = deps.voice.subscribe_credential_changes();

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
            active_lease: Mutex::new(None),
        });
        // The watcher serializes broadcasts + external pill events and drives
        // the capture/transcribe loop. It lives exactly as long as the event
        // sender (i.e. as long as `this`), so nothing leaks. The caller spawns
        // it — do NOT call tokio::spawn here because we may be on a GPUI thread
        // without a tokio runtime guard.
        let watcher_this = this.clone();
        let watcher = Box::pin(async move {
            let mut events = event_rx;
            let mut voice_changes = voice_changes;
            let mut credential_changes = credential_changes;
            loop {
                tokio::select! {
                    event = events.recv() => match event {
                        Some(CoordinatorEvent::Broadcast(payload)) => {
                            watcher_this.handle_broadcast(payload).await;
                        }
                        Some(CoordinatorEvent::Cancel) => watcher_this.dictation.cancel().await,
                        Some(CoordinatorEvent::Ready) => watcher_this.dictation.ready().await,
                        None => break,
                    },
                    changed = voice_changes.changed() => {
                        if changed.is_err() {
                            break;
                        }
                        watcher_this.dictation.cancel().await;
                        watcher_this.audio.stop_capture().await;
                        watcher_this.clear_active_lease();
                    }
                    changed = credential_changes.changed() => {
                        if changed.is_err() {
                            break;
                        }
                        if watcher_this
                            .active_lease
                            .lock()
                            .unwrap_or_else(|error| error.into_inner())
                            .as_ref()
                            .is_some_and(|lease| lease.provider != VoiceProvider::Local)
                        {
                            watcher_this.dictation.cancel().await;
                            watcher_this.audio.stop_capture().await;
                            watcher_this.clear_active_lease();
                        }
                    }
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
        self.deps.voice.cancel();
        let _ = self.event_tx.send(CoordinatorEvent::Cancel);
    }

    /// App shutdown.
    #[allow(dead_code)] // coordinator-facing; the shell's quit path calls this
    pub fn dispose(&self) {
        self.deps.voice.cancel();
        self.clear_active_lease();
        self.dictation.dispose();
        self.audio.stop_capture_blocking();
    }
    async fn handle_broadcast(&self, payload: DictationStatePayload) {
        (self.deps.forward)(payload.clone());
        match payload.state {
            DictationState::Recording => {
                let lease = match self.deps.voice.resolve_recording() {
                    Ok(lease) => lease,
                    Err(error) => {
                        self.dictation.error(Some(&error.to_string())).await;
                        return;
                    }
                };
                *self
                    .active_lease
                    .lock()
                    .unwrap_or_else(|error| error.into_inner()) = Some(lease);
                let lease_error = self
                    .active_lease
                    .lock()
                    .unwrap_or_else(|error| error.into_inner())
                    .as_ref()
                    .and_then(|lease| self.deps.voice.ensure_current(lease).err());
                if let Some(error) = lease_error {
                    self.clear_active_lease();
                    self.dictation.error(Some(&error.to_string())).await;
                    return;
                }
                if let Err(error) = self.audio.start_capture().await {
                    self.clear_active_lease();
                    self.dictation
                        .error(Some(&format!(
                            "Microphone access is needed for dictation. {error}"
                        )))
                        .await;
                }
            }
            DictationState::Stopping => self.transcribe_flow().await,
            DictationState::Cancelled | DictationState::Error => {
                self.clear_active_lease();
                self.audio.stop_capture().await;
            }
            DictationState::Pasted | DictationState::Copied => {}
        }
    }

    /// Stop the capture, drain the 16 kHz mono samples, transcribe, and hand
    /// the transcript (or the failure) back to the state machine.
    async fn transcribe_flow(&self) {
        let samples = self.audio.stop_capture().await;
        let Some(lease) = self
            .active_lease
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .take()
        else {
            self.dictation
                .error(Some(
                    "Choose an installed on-device model in Settings → Voice before dictating.",
                ))
                .await;
            return;
        };
        let mut voice_changes = self.deps.voice.subscribe_changes();
        if let Err(error) = self.deps.voice.ensure_current(&lease) {
            self.dictation.error(Some(&error.to_string())).await;
            return;
        }
        let model_id = lease.model_id.clone();
        let authority = self.deps.voice.clone();
        let transcription_lease = lease.clone();
        let transcription: BoxFuture<'static, Result<String, String>> =
            match self.deps.transcribe.as_ref() {
                Some(transcribe) => transcribe(model_id, samples),
                None if lease.provider == VoiceProvider::Local => {
                    Box::pin(async move { default_transcribe(&model_id, samples).await })
                }
                None => Box::pin(async move {
                    authority
                        .transcribe_cloud(&transcription_lease, samples)
                        .await
                        .map_err(|error| error.to_string())
                }),
            };
        let result = tokio::select! {
            result = transcription => result,
            changed = voice_changes.changed() => {
                let _ = changed;
                Err(crate::services::voice::VoiceError::StaleRecording.to_string())
            }
        };
        if let Err(error) = self.deps.voice.ensure_current(&lease) {
            self.dictation.error(Some(&error.to_string())).await;
            return;
        }
        match result {
            Ok(text) => self.dictation.result(Some(&text)).await,
            Err(message) => self.dictation.error(Some(&message)).await,
        }
    }

    fn clear_active_lease(&self) {
        self.active_lease
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .take();
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
    use aiden_data::config_store::ConfigStore;
    use aiden_data::pi_credential_store::{
        EncryptedPiCredentialStore, EncryptedPiCredentialStoreOptions,
    };
    use aiden_data::portable_config::{create_portable_config_stores, PortableConfigTestHooks};
    use aiden_data::secret_map::{ProviderKeysStore, SecretCipher, SecretCipherError};
    use aiden_mac::dictation_coordinator::DictationStage;
    use std::collections::HashMap;
    use std::sync::atomic::{AtomicBool, Ordering as AtomicOrdering};
    use std::time::Duration;

    #[derive(Clone)]
    struct TestHandles {
        forwarded: Arc<std::sync::Mutex<Vec<DictationStatePayload>>>,
        hide_pill: Arc<AtomicBool>,
        voice: Arc<VoiceAuthority>,
        _portable: Arc<tempfile::TempDir>,
        _local: Arc<tempfile::TempDir>,
    }

    #[derive(Default)]
    struct MemoryCipher(std::sync::Mutex<HashMap<String, String>>);

    impl SecretCipher for MemoryCipher {
        fn is_encryption_available(&self) -> bool {
            true
        }
        fn encrypt_string(&self, account: &str, value: &str) -> Result<Vec<u8>, SecretCipherError> {
            self.0.lock().unwrap().insert(account.into(), value.into());
            Ok(value.as_bytes().to_vec())
        }
        fn decrypt_string(&self, account: &str, value: &[u8]) -> Result<String, SecretCipherError> {
            let value = String::from_utf8_lossy(value).to_string();
            (self.0.lock().unwrap().get(account) == Some(&value))
                .then_some(value)
                .ok_or(SecretCipherError::UnrecognizedFormat)
        }
    }

    fn test_voice(
        model_id: &str,
        installed: bool,
    ) -> (
        Arc<VoiceAuthority>,
        Arc<tempfile::TempDir>,
        Arc<tempfile::TempDir>,
        Arc<crate::services::pi_provider_setup::PiProviderSetupAuthority>,
    ) {
        let portable = Arc::new(tempfile::tempdir().unwrap());
        let local = Arc::new(tempfile::tempdir().unwrap());
        let cipher = Arc::new(MemoryCipher::default());
        let keys = Arc::new(ProviderKeysStore::new(
            local.path().into(),
            "pill-voice-test",
            cipher.clone(),
        ));
        let config = Arc::new(ConfigStore::new(
            create_portable_config_stores(
                portable.path().into(),
                Some(local.path().into()),
                PortableConfigTestHooks::default(),
            ),
            Arc::new(crate::services::stores::StoreSecretsPort::new(keys)),
            None,
        ));
        let selected = model_id.to_string();
        let installed_id = selected.clone();
        let mut patch = serde_json::Map::new();
        patch.insert(
            crate::services::voice::VOICE_PROVIDER_KEY.into(),
            serde_json::json!("local"),
        );
        patch.insert(
            crate::services::voice::LOCAL_VOICE_MODEL_KEY.into(),
            serde_json::json!(selected),
        );
        config.set_settings(&patch, &|| true).unwrap();
        let pi_providers =
            crate::services::pi_provider_setup::PiProviderSetupAuthority::new(Arc::new(
                EncryptedPiCredentialStore::new(EncryptedPiCredentialStoreOptions {
                    file_path: local.path().join("pi-provider-credentials.json"),
                    cipher,
                    sync_directory: Some(Box::new(|_| Ok(()))),
                    on_durability_warning: None,
                    before_document_write: None,
                }),
            ));
        let usage = Arc::new(aiden_data::usage_store::UsageStore::new_data_store(Some(
            local.path().into(),
        )));
        let voice = VoiceAuthority::new_with_dependencies(
            config,
            Arc::new(move |id| installed && id == installed_id),
            pi_providers.clone(),
            crate::services::voice_cloud::ProductionCloudVoiceTranscriber::new(),
            usage,
        );
        voice.reconcile_boot().unwrap();
        (voice, portable, local, pi_providers)
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
        let (voice, portable, local, _pi_providers) = test_voice(model_id, true);
        coordinator_with_voice(handles, transcribe, voice, portable, local)
    }

    fn coordinator_with_voice(
        handles: &FakeCaptureHandles,
        transcribe: Option<TranscribeFn>,
        voice: Arc<VoiceAuthority>,
        portable: Arc<tempfile::TempDir>,
        local: Arc<tempfile::TempDir>,
    ) -> (Arc<PillCoordinator>, TestHandles) {
        let forwarded = Arc::new(std::sync::Mutex::new(Vec::new()));
        let hide_pill = Arc::new(AtomicBool::new(false));
        let test_handles = TestHandles {
            forwarded: forwarded.clone(),
            hide_pill: hide_pill.clone(),
            voice: voice.clone(),
            _portable: portable,
            _local: local,
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
            voice,
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
        let (voice, _portable, _local, _pi_providers) = test_voice("parakeet-v3", true);
        let (pill, watcher) = PillCoordinator::new(PillCoordinatorDeps {
            show_pill: Box::new(|| async { Ok(true) }.boxed()),
            hide_pill: Box::new(|| {}),
            destroy_pill: Box::new(|| {}),
            forward: Box::new(|_payload| {}),
            paste: Some(Arc::new(FakePasteDeps)),
            log_error: Box::new(|_message, _error| {}),
            voice,
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
        let transcribe: TranscribeFn = Box::new(|model_id, samples| {
            async move {
                assert_eq!(model_id, "parakeet-v2");
                assert_eq!(samples.len(), 1024, "transcription got the captured audio");
                Ok("hello world".to_string())
            }
            .boxed()
        });
        let (pill, test_handles) = coordinator(&handles, Some(transcribe), "parakeet-v2");

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
    async fn selection_generation_cancels_a_slow_transcription_without_delivery() {
        let handles = FakeCaptureHandles::default();
        let started = Arc::new(tokio::sync::Notify::new());
        let never_finish = Arc::new(tokio::sync::Notify::new());
        let transcribe: TranscribeFn = Box::new({
            let started = started.clone();
            let never_finish = never_finish.clone();
            move |_model_id, _samples| {
                let started = started.clone();
                let never_finish = never_finish.clone();
                async move {
                    started.notify_one();
                    never_finish.notified().await;
                    Ok("must not be delivered".to_string())
                }
                .boxed()
            }
        });
        let (pill, test_handles) = coordinator(&handles, Some(transcribe), "parakeet-v3");
        pill.toggle().await;
        assert!(wait_until(|| handles.is_running(), Duration::from_secs(2)).await);
        pill.toggle().await;
        started.notified().await;
        test_handles.voice.cancel();
        assert!(
            wait_until(
                || {
                    let states = test_handles.forwarded_states();
                    states.contains(&"error".to_string())
                        || states.contains(&"cancelled".to_string())
                },
                Duration::from_secs(2)
            )
            .await
        );
        assert!(!test_handles
            .forwarded_states()
            .contains(&"pasted".to_string()));
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

    #[tokio::test]
    async fn cloud_sign_out_during_capture_cancels_before_transcription_dispatch() {
        let handles = FakeCaptureHandles::default();
        let (voice, portable, local, pi_providers) = test_voice("parakeet-v3", true);
        pi_providers
            .commit_api_key("openai", "key-a", pi_providers.begin_setup())
            .unwrap();
        voice
            .select_cloud_model(VoiceProvider::OpenAi, "whisper-1")
            .unwrap();
        let transcribe_calls = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let calls = transcribe_calls.clone();
        let transcribe: TranscribeFn = Box::new(move |_model, _samples| {
            calls.fetch_add(1, AtomicOrdering::SeqCst);
            async { Ok("must not run".to_string()) }.boxed()
        });
        let (pill, test_handles) =
            coordinator_with_voice(&handles, Some(transcribe), voice, portable, local);
        pill.toggle().await;
        assert!(wait_until(|| handles.is_running(), Duration::from_secs(2)).await);

        pi_providers.sign_out("openai").unwrap();
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
        assert_eq!(transcribe_calls.load(AtomicOrdering::SeqCst), 0);
    }
}
