//! Live microphone [`AudioLevelSource`] for the pill — replaces the bundled
//! [`super::audio::SilenceAudioSource`] with real capture from aiden-mac.
//!
//! A background thread owns the platform [`AudioCapture`] (the macOS
//! AVAudioEngine is thread-bound, so the capture object is created and used
//! only on that thread). The tap feeds a shared [`CaptureBuffer`]: accumulated
//! mono 16 kHz Float32 samples for transcription (drained on stop) plus a
//! rolling short-term-RMS history for the meter bars.
//!
//! `start_capture`/`stop_capture` are async so the caller can await the
//! start/stop handshake without blocking a runtime worker.

use std::collections::VecDeque;
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::{Arc, Mutex};

use aiden_mac::audio::{create_platform_capture, AudioCapture, SampleSink};

use super::audio::AudioLevelSource;

/// Cap on accumulated samples (10 minutes at 16 kHz) so a forgotten stop can
/// never grow the buffer without bound.
const MAX_ACCUMULATED_SAMPLES: usize = 16_000 * 600;
/// How many per-chunk RMS entries the meter history keeps (~4.8 s at 100 ms
/// chunks; the TS waveform showed ~9 FFT buckets).
const HISTORY_LEN: usize = 48;
/// RMS gain so conversational speech lands near the top of the 0..1 meter.
const LEVEL_GAIN: f32 = 4.0;
/// Level smoothing per chunk.
const LEVEL_SMOOTHING: f32 = 0.35;

/// Shared capture state written by the audio thread, read by the meter and
/// the coordinator.
pub struct CaptureBuffer {
    /// Accumulated mono 16 kHz Float32 samples since start (drained on stop).
    samples: Mutex<Vec<f32>>,
    /// Per-chunk RMS history for the meter (newest last).
    history: Mutex<VecDeque<f32>>,
    /// Smoothed level as raw f32 bits.
    level: AtomicU32,
    /// First capture error (start failure on the audio thread).
    error: Mutex<Option<String>>,
}

impl Default for CaptureBuffer {
    fn default() -> Self {
        Self::new()
    }
}

impl CaptureBuffer {
    pub fn new() -> Self {
        Self {
            samples: Mutex::new(Vec::new()),
            history: Mutex::new(VecDeque::with_capacity(HISTORY_LEN)),
            level: AtomicU32::new(0.0f32.to_bits()),
            error: Mutex::new(None),
        }
    }

    /// Called from the audio thread with each mono 16 kHz chunk.
    fn push(&self, chunk: &[f32]) {
        if let Ok(mut samples) = self.samples.lock() {
            let remaining = MAX_ACCUMULATED_SAMPLES.saturating_sub(samples.len());
            let take = chunk.len().min(remaining);
            samples.extend_from_slice(&chunk[..take]);
        }
        let rms = rms_of(chunk);
        if let Ok(mut history) = self.history.lock() {
            history.push_back(rms);
            while history.len() > HISTORY_LEN {
                history.pop_front();
            }
        }
        let current = f32::from_bits(self.level.load(Ordering::Relaxed));
        let next = current * (1.0 - LEVEL_SMOOTHING) + rms * LEVEL_SMOOTHING;
        self.level.store(
            (next * LEVEL_GAIN).clamp(0.0, 1.0).to_bits(),
            Ordering::Relaxed,
        );
    }

    fn record_error(&self, message: String) {
        if let Ok(mut error) = self.error.lock() {
            if error.is_none() {
                *error = Some(message);
            }
        }
    }

    /// Take the accumulated samples (transcription) and reset the capture
    /// state for the next round.
    pub fn drain(&self) -> Vec<f32> {
        let mut samples = self
            .samples
            .lock()
            .map(|mut samples| std::mem::take(&mut *samples))
            .unwrap_or_default();
        samples.shrink_to_fit();
        if let Ok(mut history) = self.history.lock() {
            history.clear();
        }
        self.level.store(0.0f32.to_bits(), Ordering::Relaxed);
        if let Ok(mut error) = self.error.lock() {
            *error = None;
        }
        samples
    }

    /// Whether a start error was recorded (and what it was).
    pub fn take_error(&self) -> Option<String> {
        self.error.lock().ok().and_then(|mut error| error.take())
    }

    fn bars(&self, bars: usize) -> Vec<f32> {
        let history = self
            .history
            .lock()
            .map(|history| history.clone())
            .unwrap_or_default();
        let level = f32::from_bits(self.level.load(Ordering::Relaxed));
        let mut levels: Vec<f32> = history.iter().rev().take(bars).copied().collect();
        // Newest first, padded with the live level (or silence before the
        // first chunk lands).
        while levels.len() < bars {
            levels.push(if history.is_empty() { 0.0 } else { level });
        }
        levels.truncate(bars);
        levels
    }
}

fn rms_of(samples: &[f32]) -> f32 {
    if samples.is_empty() {
        return 0.0;
    }
    let sum: f32 = samples.iter().map(|sample| sample * sample).sum();
    (sum / samples.len() as f32).sqrt()
}

/// The capture thread's run-loop + stop signal.
struct CaptureThread {
    stop: std::sync::mpsc::Sender<()>,
    handle: std::thread::JoinHandle<()>,
}

/// Real microphone capture implementing [`AudioLevelSource`] for the pill
/// meter, with async start/stop for the pill coordinator.
pub struct LiveAudioSource {
    buffer: Arc<CaptureBuffer>,
    capture: Mutex<Option<CaptureThread>>,
    /// Constructs the platform capture INSIDE the capture thread (the macOS
    /// engine is thread-bound). Injectable for tests.
    factory: Arc<dyn Fn() -> Box<dyn AudioCapture> + Send + Sync>,
    /// Prevents a second start while one is in flight.
    starting: AtomicBool,
}

impl Default for LiveAudioSource {
    fn default() -> Self {
        Self::new()
    }
}

impl LiveAudioSource {
    pub fn new() -> Self {
        Self {
            buffer: Arc::new(CaptureBuffer::new()),
            capture: Mutex::new(None),
            factory: Arc::new(create_platform_capture),
            starting: AtomicBool::new(false),
        }
    }

    /// Constructor with an injectable capture factory (tests).
    #[allow(dead_code)] // tests + host wiring inject fakes
    pub fn with_capture_factory(
        factory: Box<dyn Fn() -> Box<dyn AudioCapture> + Send + Sync>,
    ) -> Self {
        Self {
            buffer: Arc::new(CaptureBuffer::new()),
            capture: Mutex::new(None),
            factory: Arc::from(factory),
            starting: AtomicBool::new(false),
        }
    }

    #[allow(dead_code)] // tests observe the capture lifecycle
    pub fn is_running(&self) -> bool {
        self.capture
            .lock()
            .map(|capture| capture.is_some())
            .unwrap_or(false)
    }

    /// Start the microphone on a background thread. Resolves when the
    /// platform capture has started (or the failure reason).
    pub async fn start_capture(&self) -> Result<(), String> {
        if self.starting.swap(true, Ordering::SeqCst) {
            return Err("audio capture is already starting".into());
        }
        let result = self.start_capture_inner().await;
        self.starting.store(false, Ordering::SeqCst);
        result
    }

    async fn start_capture_inner(&self) -> Result<(), String> {
        {
            let guard = self
                .capture
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            if guard.is_some() {
                return Err("audio capture is already running".into());
            }
        }

        let buffer = self.buffer.clone();
        let (stop_tx, stop_rx) = std::sync::mpsc::channel();
        let stop_for_thread = stop_tx.clone();
        let (started_tx, started_rx) = tokio::sync::oneshot::channel();
        let factory = self.factory.clone();
        let handle = std::thread::Builder::new()
            .name("pill-audio-capture".into())
            .spawn(move || {
                let mut capture = factory();
                let buffer_for_sink = buffer.clone();
                let sink: SampleSink = Box::new(move |chunk: &[f32]| {
                    buffer_for_sink.push(chunk);
                });
                match capture.start(sink) {
                    Ok(()) => {
                        let _ = started_tx.send(Ok(()));
                    }
                    Err(error) => {
                        buffer.record_error(error.to_string());
                        let _ = started_tx.send(Err(error.to_string()));
                        return;
                    }
                }
                // Block until stop is signalled (or the source is dropped).
                let _ = stop_rx.recv();
                capture.stop();
            })
            .map_err(|error| format!("failed to spawn the capture thread: {error}"))?;

        // Only store the thread once start succeeded; otherwise join it.
        match started_rx.await {
            Ok(Ok(())) => {
                let mut guard = self
                    .capture
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner());
                *guard = Some(CaptureThread {
                    stop: stop_for_thread,
                    handle,
                });
                Ok(())
            }
            Ok(Err(error)) => {
                let _ = handle.join();
                Err(error)
            }
            Err(_) => {
                // The thread exited before reporting — drain any recorded
                // error and join.
                let error = self
                    .buffer
                    .take_error()
                    .unwrap_or_else(|| "the capture thread exited before starting".to_string());
                let _ = handle.join();
                Err(error)
            }
        }
    }

    /// Stop the microphone and return the accumulated mono 16 kHz samples.
    pub async fn stop_capture(&self) -> Vec<f32> {
        let thread = self
            .capture
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .take();
        if let Some(thread) = thread {
            let _ = thread.stop.send(());
            // The engine stop is brief; run the join off the caller's thread.
            let handle = thread.handle;
            let _ = tokio::task::spawn_blocking(move || {
                let _ = handle.join();
            })
            .await;
        }
        self.buffer.drain()
    }

    /// Synchronous stop used at app shutdown (no runtime guarantee).
    #[allow(dead_code)] // PillCoordinator::dispose (the shell quit path)
    pub fn stop_capture_blocking(&self) -> Vec<f32> {
        let thread = self
            .capture
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .take();
        if let Some(thread) = thread {
            let _ = thread.stop.send(());
            let _ = thread.handle.join();
        }
        self.buffer.drain()
    }

    #[allow(dead_code)] // tests read the capture-side level
    pub fn level(&self) -> f32 {
        f32::from_bits(self.buffer.level.load(std::sync::atomic::Ordering::Relaxed))
    }
}

impl Drop for LiveAudioSource {
    fn drop(&mut self) {
        if let Some(thread) = self
            .capture
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .take()
        {
            let _ = thread.stop.send(());
            let _ = thread.handle.join();
        }
    }
}

impl AudioLevelSource for LiveAudioSource {
    fn levels(&self, bars: usize) -> Vec<f32> {
        self.buffer.bars(bars)
    }

    fn name(&self) -> &'static str {
        "live-microphone"
    }
}

/// [`AudioLevelSource`] for the shared `Arc<LiveAudioSource>` the pill window
/// receives (`Rc<RefCell<Arc<LiveAudioSource>>>` coerces to the trait).
impl AudioLevelSource for Arc<LiveAudioSource> {
    fn levels(&self, bars: usize) -> Vec<f32> {
        (**self).levels(bars)
    }

    fn name(&self) -> &'static str {
        (**self).name()
    }
}

/// Test fakes are shared with `coordinator`'s tests.
#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use aiden_mac::audio::AudioCaptureError;
    use std::sync::atomic::AtomicUsize;
    use std::time::Duration;

    /// Handles shared by every capture the factory creates, so a test can
    /// assert the running state and feed samples as if a mic delivered them.
    #[derive(Clone, Default)]
    pub struct FakeCaptureHandles {
        running: Arc<AtomicBool>,
        sink: Arc<Mutex<Option<SampleSink>>>,
        started: Arc<AtomicUsize>,
        stopped: Arc<AtomicUsize>,
        fail_start: Arc<AtomicBool>,
    }

    /// Capture fake for tests (aiden-mac's `AudioCapture` trait).
    pub struct FakeCapture {
        handles: FakeCaptureHandles,
    }

    impl FakeCapture {
        pub fn new(handles: FakeCaptureHandles) -> Self {
            Self { handles }
        }
    }

    impl AudioCapture for FakeCapture {
        fn start(&mut self, on_samples: SampleSink) -> Result<(), AudioCaptureError> {
            if self.handles.fail_start.load(Ordering::SeqCst) {
                return Err(AudioCaptureError::Unavailable("mic denied".into()));
            }
            *self.handles.sink.lock().unwrap() = Some(on_samples);
            self.handles.running.store(true, Ordering::SeqCst);
            self.handles.started.fetch_add(1, Ordering::SeqCst);
            Ok(())
        }
        fn stop(&mut self) {
            self.handles.running.store(false, Ordering::SeqCst);
            *self.handles.sink.lock().unwrap() = None;
            self.handles.stopped.fetch_add(1, Ordering::SeqCst);
        }
        fn level(&self) -> f32 {
            if self.handles.running.load(Ordering::SeqCst) {
                0.5
            } else {
                0.0
            }
        }
    }

    impl FakeCaptureHandles {
        pub(crate) fn factory(self) -> Box<dyn Fn() -> Box<dyn AudioCapture> + Send + Sync> {
            Box::new(move || Box::new(FakeCapture::new(self.clone())))
        }

        pub(crate) fn is_running(&self) -> bool {
            self.running.load(Ordering::SeqCst)
        }

        pub(crate) fn feed(&self, samples: &[f32]) {
            if let Some(sink) = self.sink.lock().unwrap().as_mut() {
                sink(samples);
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

    #[tokio::test]
    async fn capture_starts_and_fed_samples_drive_bars_and_drain() {
        let handles = FakeCaptureHandles::default();
        let source = Arc::new(LiveAudioSource::with_capture_factory(
            handles.clone().factory(),
        ));
        assert!(!source.is_running());
        source.start_capture().await.unwrap();
        assert!(wait_until(|| handles.is_running(), Duration::from_secs(2)).await);

        // Feed a loud chunk; the meter should move off silence.
        handles.feed(&[0.5; 512]);
        handles.feed(&[0.5; 512]);
        let level_source = source.clone();
        assert!(
            wait_until(
                || level_source.levels(9).iter().any(|level| *level > 0.0),
                Duration::from_secs(2)
            )
            .await
        );
        assert!(source.level() > 0.0, "capture-side level reflects audio");

        // Stop drains exactly what was fed.
        let samples = source.stop_capture().await;
        assert_eq!(samples.len(), 1024);
        assert!(samples.iter().all(|sample| *sample == 0.5));
        assert!(wait_until(|| !handles.is_running(), Duration::from_secs(2)).await);
        assert_eq!(handles.stopped.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn a_failing_start_reports_the_error_and_does_not_keep_running() {
        let handles = FakeCaptureHandles::default();
        handles.fail_start.store(true, Ordering::SeqCst);
        let source = LiveAudioSource::with_capture_factory(handles.clone().factory());
        let error = source.start_capture().await.unwrap_err();
        assert!(error.contains("mic denied"));
        assert!(!source.is_running());
        assert!(!handles.is_running());
    }

    #[tokio::test]
    async fn a_second_start_while_running_is_rejected() {
        let handles = FakeCaptureHandles::default();
        let source = Arc::new(LiveAudioSource::with_capture_factory(
            handles.clone().factory(),
        ));
        source.start_capture().await.unwrap();
        assert!(wait_until(|| handles.is_running(), Duration::from_secs(2)).await);
        let error = source.start_capture().await.unwrap_err();
        assert!(error.contains("already running"));
        source.stop_capture().await;
        // Restart works after a stop.
        source.start_capture().await.unwrap();
        assert!(wait_until(|| handles.is_running(), Duration::from_secs(2)).await);
        source.stop_capture().await;
    }

    #[test]
    fn bars_reflect_recent_chunk_energy_newest_first() {
        let buffer = CaptureBuffer::new();
        for level in [0.1f32, 0.2, 0.3, 0.4] {
            buffer.push(&[level; 64]);
        }
        let bars = buffer.bars(4);
        assert_eq!(bars.len(), 4);
        // Newest chunk first.
        assert!((bars[0] - 0.4).abs() < 1e-6);
        assert!((bars[3] - 0.1).abs() < 1e-6);
        // Padding when fewer chunks than bars.
        let bars = buffer.bars(8);
        assert_eq!(bars.len(), 8);
        assert!((bars[0] - 0.4).abs() < 1e-6);
        // A fresh buffer yields silence.
        assert!(CaptureBuffer::new()
            .bars(9)
            .iter()
            .all(|level| *level == 0.0));
    }

    #[test]
    fn accumulated_samples_are_capped() {
        let buffer = CaptureBuffer::new();
        let chunk = vec![1.0f32; 16_000];
        for _ in 0..1_000 {
            buffer.push(&chunk);
        }
        let samples = buffer.drain();
        assert_eq!(samples.len(), MAX_ACCUMULATED_SAMPLES);
    }
}
