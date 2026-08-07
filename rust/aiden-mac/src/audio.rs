//! macOS microphone capture — port of the capture half of
//! `renderer/pill/pill-app.tsx` (getUserMedia + MediaRecorder + AudioContext
//! decode to Float32 16 kHz PCM).
//!
//! The preferred path is an [`AVAudioEngine`] input tap via
//! `objc2-avf-audio`: the engine installs a tap on the input node, the tap
//! block runs on a realtime audio thread, and each buffer is downmixed to
//! mono and linearly resampled to 16 kHz (the sherpa feature rate). No extra
//! native code — AVAudioEngine performs the hardware I/O.
//!
//! [`AudioCapture`] is the injectable surface so the aiden-ui pill can drive
//! a real capture or a test fake. The non-macOS build provides a clean
//! [`UnsupportedAudioCapture`] stub.

use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Mutex};

/// Error type for [`AudioCapture`].
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum AudioCaptureError {
    #[error("microphone unavailable: {0}")]
    Unavailable(String),
    #[error("audio capture is unsupported on this platform.")]
    UnsupportedPlatform,
    #[error("audio capture is not running.")]
    NotRunning,
}

/// The per-chunk sample sink the capture calls on the audio thread.
pub type SampleSink = Box<dyn FnMut(&[f32]) + Send>;

/// Microphone capture producing 16 kHz mono Float32 PCM.
///
/// `start` installs the capture and immediately begins calling `on_samples`
/// with mono 16 kHz chunks (on an audio/real-time thread — the callback must
/// stay cheap and never block on user input). `stop` tears the capture down.
/// `level` reports a short-term signal level in `0.0..=1.0` (0 = silence).
///
/// The implementor is NOT `Send`: the macOS engine is bound to the thread
/// that created it, so the concrete capture lives on one thread (the aiden-ui
/// pill creates it inside its capture thread and only ever touches it there).
/// The `on_samples` callback, by contrast, IS `Send` — it feeds shared state
/// that the meter and coordinator read from other threads.
pub trait AudioCapture {
    fn start(&mut self, on_samples: SampleSink) -> Result<(), AudioCaptureError>;
    fn stop(&mut self);
    fn level(&self) -> f32;
}

// ---------------------------------------------------------------------------
// Pure signal helpers (unit-tested; no platform code)
// ---------------------------------------------------------------------------

/// Downmix interleaved Float32 PCM to mono (per-frame channel average).
pub fn downmix_interleaved(input: &[f32], channels: usize, output: &mut Vec<f32>) {
    if channels == 0 || input.is_empty() {
        return;
    }
    let frames = input.len() / channels;
    output.clear();
    output.reserve(frames);
    for frame in 0..frames {
        let mut sum = 0.0f32;
        for channel in 0..channels {
            sum += input[frame * channels + channel];
        }
        output.push(sum / channels as f32);
    }
}

/// Downmix deinterleaved Float32 channel planes to mono (per-frame average).
/// `planes` is a slice of channel pointers; only the first `channels` are
/// read, each with at least `frames` samples.
///
/// # Safety
///
/// Every plane in `planes[..channels]` must point to `frames` readable
/// `f32` samples.
pub unsafe fn downmix_planes(
    planes: &[*const f32],
    channels: usize,
    frames: usize,
    output: &mut Vec<f32>,
) {
    output.clear();
    output.reserve(frames);
    if channels == 0 {
        return;
    }
    for frame in 0..frames {
        let mut sum = 0.0f32;
        for plane in planes.iter().take(channels) {
            sum += *plane.add(frame);
        }
        output.push(sum / channels as f32);
    }
}

/// Linearly resample mono PCM from `input_rate` to `output_rate`, appending
/// to `output`. Equal rates copy through unchanged.
pub fn linear_resample(input: &[f32], input_rate: u32, output_rate: u32, output: &mut Vec<f32>) {
    if input.is_empty() || input_rate == 0 || output_rate == 0 {
        return;
    }
    if input_rate == output_rate {
        output.extend_from_slice(input);
        return;
    }
    // Output samples per input sample (>= 1 when downsampling).
    let step = input_rate as f32 / output_rate as f32;
    let out_len = (input.len() as f32 / step).floor() as usize;
    output.reserve(out_len);
    let last = input.len() - 1;
    for i in 0..out_len {
        let position = i as f32 * step;
        let index = position.floor() as usize;
        let frac = position - index as f32;
        let current = input[index];
        let next = input[(index + 1).min(last)];
        output.push(current + (next - current) * frac);
    }
}

/// The pipeline the tap block runs per buffer: interleaved Float32 PCM at the
/// hardware rate → mono 16 kHz Float32 PCM (downmix + linear resample).
pub fn to_mono_16k(interleaved: &[f32], channels: usize, sample_rate: u32) -> Vec<f32> {
    let mut mono_hw = Vec::with_capacity(interleaved.len() / channels.max(1));
    downmix_interleaved(interleaved, channels, &mut mono_hw);
    let mut output = Vec::with_capacity(mono_hw.len());
    linear_resample(&mono_hw, sample_rate, 16_000, &mut output);
    output
}

// ---------------------------------------------------------------------------
// Non-macOS stub
// ---------------------------------------------------------------------------

/// Cleanly-failing capture for non-macOS hosts.
pub struct UnsupportedAudioCapture;

impl AudioCapture for UnsupportedAudioCapture {
    fn start(&mut self, _on_samples: SampleSink) -> Result<(), AudioCaptureError> {
        Err(AudioCaptureError::UnsupportedPlatform)
    }
    fn stop(&mut self) {}
    fn level(&self) -> f32 {
        0.0
    }
}

// ---------------------------------------------------------------------------
// macOS AVAudioEngine implementation
// ---------------------------------------------------------------------------

#[cfg(target_os = "macos")]
mod imp {
    use super::*;
    use objc2::rc::Retained;
    use objc2::AnyThread;
    use objc2_avf_audio::{AVAudioEngine, AVAudioInputNode, AVAudioPCMBuffer, AVAudioTime};
    use objc2_foundation::NSError;
    use std::ffi::c_float;
    use std::ptr::NonNull;

    /// How many samples of history `level()` reflects (~256 ms at 16 kHz).
    const LEVEL_WINDOW: usize = 4_096;
    /// RMS smoothing factor per chunk.
    const LEVEL_ATTACK: f32 = 0.35;
    /// Signal level gain so conversational speech lands near the top of the
    /// 0..1 meter (the TS waveform applied its own FFT bucket scaling).
    const LEVEL_GAIN: f32 = 4.0;

    /// State shared between the capture thread and the tap callback.
    pub(super) struct CaptureShared {
        pub(super) on_samples: Mutex<Option<SampleSink>>,
        /// Rolling mono 16 kHz window for `level()` (samples).
        window: Mutex<Vec<f32>>,
        /// Smoothed RMS level as raw `f32` bits.
        level: AtomicU32,
    }

    impl CaptureShared {
        pub(super) fn new() -> Arc<Self> {
            Arc::new(Self {
                on_samples: Mutex::new(None),
                window: Mutex::new(Vec::with_capacity(LEVEL_WINDOW)),
                level: AtomicU32::new(0.0f32.to_bits()),
            })
        }

        /// Invoked from the realtime tap thread per buffer.
        pub(super) fn push(&self, mono_16k: &[f32]) {
            if let Ok(mut guard) = self.on_samples.lock() {
                if let Some(callback) = guard.as_mut() {
                    callback(mono_16k);
                }
            }
            if let Ok(mut window) = self.window.lock() {
                window.extend_from_slice(mono_16k);
                if window.len() > LEVEL_WINDOW {
                    let excess = window.len() - LEVEL_WINDOW;
                    window.drain(..excess);
                }
                let rms = rms_of(&window);
                let current = f32::from_bits(self.level.load(Ordering::Relaxed));
                let next = current * (1.0 - LEVEL_ATTACK) + rms * LEVEL_ATTACK;
                self.level.store(
                    (next * LEVEL_GAIN).clamp(0.0, 1.0).to_bits(),
                    Ordering::Relaxed,
                );
            }
        }

        pub(super) fn level(&self) -> f32 {
            f32::from_bits(self.level.load(Ordering::Relaxed))
        }
    }

    fn rms_of(samples: &[f32]) -> f32 {
        if samples.is_empty() {
            return 0.0;
        }
        let sum: f32 = samples.iter().map(|s| s * s).sum();
        (sum / samples.len() as f32).sqrt()
    }

    /// The tap block type (`AVAudioNodeTapBlock`).
    type TapBlock =
        block2::RcBlock<dyn Fn(NonNull<AVAudioPCMBuffer>, NonNull<AVAudioTime>) + 'static>;

    /// AVAudioEngine input-tap capture.
    ///
    /// The engine is created on the caller's thread; `stop` removes the tap
    /// and stops the engine on the same thread. The tap block itself runs on
    /// an audio real-time thread.
    pub struct AvAudioEngineCapture {
        shared: Arc<CaptureShared>,
        engine: Option<Retained<AVAudioEngine>>,
        tap_block: Option<TapBlock>,
        running: bool,
    }

    impl Default for AvAudioEngineCapture {
        fn default() -> Self {
            Self::new()
        }
    }

    impl AvAudioEngineCapture {
        pub fn new() -> Self {
            Self {
                shared: CaptureShared::new(),
                engine: None,
                tap_block: None,
                running: false,
            }
        }

        fn start_inner(&mut self) -> Result<(), AudioCaptureError> {
            let engine = unsafe { AVAudioEngine::init(AVAudioEngine::alloc()) };
            let input: Retained<AVAudioInputNode> = unsafe { engine.inputNode() };
            // Tap with the hardware format; the block downmixes + resamples
            // to 16 kHz mono itself (the tap-format SRC is not guaranteed on
            // the input node).
            let format = unsafe { input.outputFormatForBus(0) };
            let shared = self.shared.clone();
            let tap_block = block2::RcBlock::new(
                move |buffer: NonNull<AVAudioPCMBuffer>, _when: NonNull<AVAudioTime>| {
                    let buffer = unsafe { buffer.as_ref() };
                    let format = unsafe { buffer.format() };
                    let channels = unsafe { format.channelCount() } as usize;
                    let sample_rate = unsafe { format.sampleRate() } as u32;
                    let frame_length = unsafe { buffer.frameLength() } as usize;
                    let data = unsafe { buffer.floatChannelData() };
                    if frame_length == 0 || channels == 0 || data.is_null() {
                        return;
                    }
                    let interleaved = unsafe { format.isInterleaved() };
                    let stride = unsafe { buffer.stride() };
                    let mono: Vec<f32> = if interleaved {
                        let plane = unsafe { *data.add(0) }.as_ptr();
                        // Build a contiguous interleaved copy for the shared
                        // downmix path (frame-major, all channels).
                        let mut interleaved_buf = Vec::with_capacity(frame_length * channels);
                        for frame in 0..frame_length {
                            for channel in 0..channels {
                                interleaved_buf
                                    .push(unsafe { *plane.add(frame * stride + channel) });
                            }
                        }
                        to_mono_16k(&interleaved_buf, channels, sample_rate)
                    } else {
                        let mut planes: Vec<*const c_float> = Vec::with_capacity(channels);
                        for channel in 0..channels {
                            let plane = unsafe { *data.add(channel) }.as_ptr();
                            planes.push(plane);
                        }
                        let mut mono_hw = Vec::with_capacity(frame_length);
                        unsafe { downmix_planes(&planes, channels, frame_length, &mut mono_hw) };
                        let mut output = Vec::with_capacity(mono_hw.len());
                        linear_resample(&mono_hw, sample_rate, 16_000, &mut output);
                        output
                    };
                    shared.push(&mono);
                },
            );

            let tap_ptr = block2::RcBlock::as_ptr(&tap_block);
            unsafe {
                input.installTapOnBus_bufferSize_format_block(
                    0,
                    super::TAP_BUFFER_FRAMES,
                    Some(&format),
                    tap_ptr,
                );
            }

            unsafe { engine.prepare() };
            unsafe { engine.startAndReturnError() }.map_err(|error: Retained<NSError>| {
                let message = error.localizedDescription();
                let message = message.to_string();
                AudioCaptureError::Unavailable(message)
            })?;

            self.engine = Some(engine);
            self.tap_block = Some(tap_block);
            self.running = true;
            Ok(())
        }

        fn stop_inner(&mut self) {
            if let Some(engine) = self.engine.as_ref() {
                let input = unsafe { engine.inputNode() };
                unsafe { input.removeTapOnBus(0) };
                unsafe { engine.stop() };
            }
            self.engine = None;
            self.tap_block = None;
            self.running = false;
        }
    }

    impl AudioCapture for AvAudioEngineCapture {
        fn start(&mut self, on_samples: SampleSink) -> Result<(), AudioCaptureError> {
            if self.running {
                return Err(AudioCaptureError::Unavailable(
                    "audio capture is already running".into(),
                ));
            }
            if let Ok(mut guard) = self.shared.on_samples.lock() {
                *guard = Some(on_samples);
            }
            self.start_inner()
        }

        fn stop(&mut self) {
            self.stop_inner();
            if let Ok(mut guard) = self.shared.on_samples.lock() {
                *guard = None;
            }
        }

        fn level(&self) -> f32 {
            self.shared.level()
        }
    }
}

/// Tap buffer size in frames (~512 ms at 16 kHz; the engine re-chunks).
pub const TAP_BUFFER_FRAMES: u32 = 8_192;

/// The macOS [`AudioCapture`] implementation. On other platforms this is an
/// alias for [`UnsupportedAudioCapture`].
#[cfg(target_os = "macos")]
pub use imp::AvAudioEngineCapture;

/// Construct the platform [`AudioCapture`]: AVAudioEngine on macOS, the
/// failing stub elsewhere.
pub fn create_platform_capture() -> Box<dyn AudioCapture> {
    #[cfg(target_os = "macos")]
    {
        Box::new(imp::AvAudioEngineCapture::new())
    }
    #[cfg(not(target_os = "macos"))]
    {
        Box::new(UnsupportedAudioCapture)
    }
}

/// Read-only microphone permission state (best-effort; on non-macOS always
/// `Unknown`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MicrophonePermission {
    Unknown,
    Undetermined,
    Denied,
    Granted,
}

/// Current microphone permission, `Unknown` when it cannot be probed.
pub fn microphone_permission() -> MicrophonePermission {
    #[cfg(target_os = "macos")]
    {
        use objc2_avf_audio::{AVAudioApplication, AVAudioApplicationRecordPermission};
        let shared = unsafe { AVAudioApplication::sharedInstance() };
        let permission = unsafe { shared.recordPermission() };
        match permission {
            AVAudioApplicationRecordPermission::Undetermined => MicrophonePermission::Undetermined,
            AVAudioApplicationRecordPermission::Denied => MicrophonePermission::Denied,
            AVAudioApplicationRecordPermission::Granted => MicrophonePermission::Granted,
            _ => MicrophonePermission::Unknown,
        }
    }
    #[cfg(not(target_os = "macos"))]
    {
        MicrophonePermission::Unknown
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn downmix_averages_channels_per_frame() {
        // Two channels: [l, r, l, r, ...] -> mono averages.
        let mut out = Vec::new();
        downmix_interleaved(&[0.0, 0.2, 0.4, 0.6], 2, &mut out);
        assert_eq!(out, vec![0.1, 0.5]);
    }

    #[test]
    fn downmix_single_channel_is_identity() {
        let mut out = Vec::new();
        downmix_interleaved(&[0.5, -0.5, 1.0], 1, &mut out);
        assert_eq!(out, vec![0.5, -0.5, 1.0]);
    }

    #[test]
    fn linear_resample_equal_rate_copies() {
        let mut out = Vec::new();
        linear_resample(&[1.0, 2.0, 3.0], 16_000, 16_000, &mut out);
        assert_eq!(out, vec![1.0, 2.0, 3.0]);
    }

    #[test]
    fn linear_resample_downsample_to_half() {
        let mut out = Vec::new();
        // 4 samples at 32 kHz -> 2 samples at 16 kHz (positions 0 and 2).
        linear_resample(&[0.0, 0.5, 1.0, 0.5], 32_000, 16_000, &mut out);
        assert_eq!(out.len(), 2);
        assert!((out[0] - 0.0).abs() < 1e-6);
        assert!((out[1] - 1.0).abs() < 1e-6);
    }

    #[test]
    fn linear_resample_upsample_doubles_length() {
        let mut out = Vec::new();
        // 2 samples at 8 kHz -> 4 samples at 16 kHz.
        linear_resample(&[0.0, 1.0], 8_000, 16_000, &mut out);
        assert_eq!(out.len(), 4);
        // Interpolated midpoint at position 1 is 0.5.
        assert!((out[1] - 0.5).abs() < 1e-4);
    }

    #[test]
    fn to_mono_16k_does_the_full_pipeline() {
        // Stereo 48 kHz with identical channels -> mono 16 kHz, 1/3 length.
        let stereo: Vec<f32> = (0..96).map(|i| i as f32 / 96.0).collect();
        let interleaved: Vec<f32> = stereo
            .iter()
            .flat_map(|sample| [*sample, *sample])
            .collect();
        let mono = to_mono_16k(&interleaved, 2, 48_000);
        assert_eq!(mono.len(), 32);
        // Downmix kept the value (averaging identical channels) so the
        // resampler's interpolated output tracks the source shape.
        assert!((mono[0] - 0.0).abs() < 1e-4);
        assert!((mono[31] - (93.0 / 96.0)).abs() < 1e-2);
    }

    #[test]
    fn unsupported_capture_fails_cleanly() {
        let mut capture = UnsupportedAudioCapture;
        assert_eq!(
            capture.start(Box::new(|_| {})),
            Err(AudioCaptureError::UnsupportedPlatform)
        );
        capture.stop();
        assert_eq!(capture.level(), 0.0);
    }
}
