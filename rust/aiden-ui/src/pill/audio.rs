//! Injected audio-level source for the pill's level meter.
//!
//! Real microphone capture is out of scope for this phase: the Electron pill
//! recorded via `getUserMedia` + `AnalyserNode` in `renderer/pill/pill-app.tsx`
//! and drove per-bar FFT levels. The GPUI port inverts that dependency — the
//! pill renders whatever [`AudioLevelSource`] the coordinator injects. The
//! bundled [`SilenceAudioSource`] produces a flat (silence) meter so the
//! surface is exercisable end-to-end today; a sherpa-onnx / AVFoundation
//! capture implementation (and the transcription pipeline it feeds) is a
//! later-phase task that only needs to implement this trait.

/// Per-bar source of audio levels in `0.0..=1.0` (0 = silence).
pub trait AudioLevelSource {
    /// Return `bars` per-bar levels, newest frame first. Clamp defensively:
    /// values outside `0.0..=1.0` are treated as silence/clip by the renderer.
    fn levels(&mut self, bars: usize) -> Vec<f32>;

    /// Debug name for logs (e.g. "silence" or the future "sherpa-onnx").
    fn name(&self) -> &'static str {
        "audio-level-source"
    }
}

/// Stub source producing constant silence. Keeps the pill renderable and
/// testable without any audio stack.
#[derive(Debug, Clone, Copy, Default)]
pub struct SilenceAudioSource;

impl AudioLevelSource for SilenceAudioSource {
    fn levels(&mut self, bars: usize) -> Vec<f32> {
        vec![0.0; bars]
    }

    fn name(&self) -> &'static str {
        "silence"
    }
}

/// Map one `0.0..=1.0` level to a meter-bar height in pixels, mirroring the
/// renderer's waveform math exactly: `Math.round(4 + level * 18)`.
pub fn bar_height(level: f32) -> f32 {
    (4.0 + level.clamp(0.0, 1.0) * 18.0).round()
}

/// Map a frame of levels to bar heights (TS `startWaveform`'s per-bar height).
pub fn bar_heights(levels: &[f32]) -> Vec<f32> {
    levels.iter().map(|level| bar_height(*level)).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::pill::state::WAVEFORM_BARS;

    #[test]
    fn silence_renders_a_flat_minimum_meter() {
        let mut source = SilenceAudioSource;
        let levels = source.levels(WAVEFORM_BARS);
        assert_eq!(levels.len(), WAVEFORM_BARS);
        assert!(levels.iter().all(|level| *level == 0.0));
        assert_eq!(source.name(), "silence");
        assert!(bar_heights(&levels).iter().all(|height| *height == 4.0));
    }

    #[test]
    fn bar_heights_match_the_renderer_waveform_math() {
        assert_eq!(bar_height(0.0), 4.0);
        assert_eq!(bar_height(1.0), 22.0);
        assert_eq!(bar_height(0.5), 13.0);
        assert_eq!(bar_heights(&[0.0, 0.5, 1.0]), vec![4.0, 13.0, 22.0]);
    }

    #[test]
    fn levels_clamp_into_the_bar_range() {
        assert_eq!(bar_height(-1.0), 4.0);
        assert_eq!(bar_height(2.0), 22.0);
    }
}
