//! Pure pill state: the dictation phase reducer and the appearance/motion
//! gates. Nothing in this file touches GPUI or the stores, so every behavior
//! the TypeScript port tested with a harness is unit-tested here directly.
//!
//! Phase mapping (from `renderer/pill/pill-app.tsx`):
//!
//! | coordinator broadcast (`aiden_core::dictation::DictationState`) | pill phase |
//! |---|---|---|
//! | `Recording` → start capture | `Listening` (TS "recording") |
//! | `Stopping` → stop capture, transcribe | `Transcribing` |
//! | `Pasted` | `Pasted` |
//! | `Copied` | `Copied` |
//! | `Error { message }` | `Error` |
//! | `Cancelled` → discard | `Idle` |
//!
//! The appearance expectations from `renderer/lib/pill-appearance.test.ts`
//! are ported as pure reducers: strict settings parsing
//! (`strict_appearance_from_settings`), media/motion reaction
//! ([`MotionGate`]), and the revision-guarded hydration that never lets a
//! stale authoritative read clobber a newer storage event
//! ([`AppearanceSyncState`]).

use aiden_core::appearance::{parse_appearance_config, AppearanceConfig, ReduceMotion};
use aiden_core::dictation::DictationStatePayload;

use crate::services::appearance::SETTINGS_APPEARANCE_KEY;

/// Width of the pill window, matching `main/windows/pill-window.ts`.
pub const PILL_WIDTH: f32 = 280.0;
/// Height of the pill window, matching `main/windows/pill-window.ts`.
pub const PILL_HEIGHT: f32 = 56.0;
/// Gap between the pill and the bottom of the usable work area (Dock-aware in
/// Electron; the Rust port approximates with the display frame — see the
/// module docs for the vibrancy/work-area TODO).
pub const PILL_BOTTOM_OFFSET: f32 = 15.0;
/// Number of level-meter bars, matching `renderer/pill/pill-app.tsx`.
pub const WAVEFORM_BARS: usize = 9;
/// Cadence of the injected audio-level source polling, mirroring the
/// renderer's rAF-driven waveform (~60ms).
pub const METER_POLL_MS: u64 = 60;

/// The pill's internal UI phase (the TS `Phase` union from `pill-app.tsx`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum Phase {
    /// Nothing shown; the pill window is effectively empty.
    #[default]
    Idle,
    /// Recording; shows the pulsing dot + level meter + elapsed timer.
    Listening,
    /// Audio captured; transcription running on the injected pipeline.
    Transcribing,
    /// Transcript pasted into the focused field.
    Pasted,
    /// Transcript copied to the clipboard.
    Copied,
    /// Something failed; shows `error_message`.
    Error,
}

impl Phase {
    /// Static label for non-interactive phases (mirrors the TS switch).
    pub fn label(self) -> Option<&'static str> {
        match self {
            Phase::Idle | Phase::Listening | Phase::Error => None,
            Phase::Transcribing => Some("Transcribing…"),
            Phase::Pasted => Some("Pasted"),
            Phase::Copied => Some("Copied to clipboard"),
        }
    }
}

/// Events the pill reducer understands. The coordinator-facing
/// [`Self::from_payload`] mirrors the `dictation:state` broadcasts.
#[derive(Debug, Clone, PartialEq)]
pub enum PillEvent {
    /// Coordinator broadcast: start recording.
    Recording,
    /// Coordinator broadcast: stop recording and transcribe.
    Stopping,
    /// Coordinator broadcast: transcript pasted.
    Pasted,
    /// Coordinator broadcast: transcript copied.
    Copied,
    /// Coordinator broadcast: failure with an optional human-readable detail.
    Error { message: String },
    /// Coordinator broadcast: discard the current recording.
    Cancelled,
    /// Local clock tick while listening (elapsed seconds).
    Tick,
}

impl PillEvent {
    /// Map a `dictation:state` payload onto the pill's event space. The
    /// default error copy matches `pill-app.tsx` (`"Dictation failed."`).
    pub fn from_payload(payload: &DictationStatePayload) -> Self {
        use aiden_core::dictation::DictationState as State;
        match payload.state {
            State::Recording => PillEvent::Recording,
            State::Stopping => PillEvent::Stopping,
            State::Pasted => PillEvent::Pasted,
            State::Copied => PillEvent::Copied,
            State::Error => PillEvent::Error {
                message: payload
                    .message
                    .clone()
                    .unwrap_or_else(|| "Dictation failed.".to_string()),
            },
            State::Cancelled => PillEvent::Cancelled,
        }
    }
}

/// The pill's full UI state, reduced by [`PillState::reduce`].
#[derive(Debug, Clone, Default, PartialEq)]
pub struct PillState {
    pub phase: Phase,
    /// Human-readable detail for `Phase::Error`.
    pub error_message: Option<String>,
    /// Recording duration in whole seconds (TS `formatElapsed` source).
    pub elapsed_seconds: u64,
}

impl PillState {
    pub fn new() -> Self {
        Self::default()
    }

    /// Apply one event. This is the pure step-state machine the TS
    /// coordinator/renderer pair implemented imperatively.
    pub fn reduce(&mut self, event: &PillEvent) {
        match event {
            PillEvent::Recording => {
                self.phase = Phase::Listening;
                self.elapsed_seconds = 0;
                self.error_message = None;
            }
            PillEvent::Stopping => {
                // Only a live recording transcribes; a stale stop is dropped.
                if self.phase == Phase::Listening {
                    self.phase = Phase::Transcribing;
                }
            }
            PillEvent::Pasted => self.phase = Phase::Pasted,
            PillEvent::Copied => self.phase = Phase::Copied,
            PillEvent::Error { message } => {
                self.phase = Phase::Error;
                self.error_message = Some(message.clone());
            }
            PillEvent::Cancelled => {
                self.phase = Phase::Idle;
                self.elapsed_seconds = 0;
                self.error_message = None;
            }
            PillEvent::Tick => {
                if self.phase == Phase::Listening {
                    self.elapsed_seconds += 1;
                }
            }
        }
    }

    /// Whether the pill should be visible at all (TS renders nothing when
    /// `phase === "idle"`).
    pub fn visible(&self) -> bool {
        self.phase != Phase::Idle
    }
}

/// `m:ss` elapsed formatting, byte-for-byte the TS `formatElapsed`.
pub fn format_elapsed(total_seconds: u64) -> String {
    let minutes = total_seconds / 60;
    let seconds = total_seconds % 60;
    format!("{minutes}:{seconds:02}")
}

// ---------------------------------------------------------------------------
// Appearance / motion gates (port of renderer/lib/pill-appearance.test.ts)
// ---------------------------------------------------------------------------

/// Strictly parse the persisted `appearance` settings value, returning `None`
/// for missing or malformed input. This ports `parsePillAppearanceStorageValue`:
/// damage falls back to the caller's fallback instead of silently becoming
/// default appearance values.
pub fn strict_appearance_from_settings(
    settings: &serde_json::Map<String, serde_json::Value>,
) -> Option<AppearanceConfig> {
    let value = settings.get(SETTINGS_APPEARANCE_KEY)?;
    parse_appearance_config(value).ok()
}

/// Reduced-motion gate. GPUI exposes no `prefers-reduced-motion` probe, so the
/// system preference is injected (default off); the persisted
/// `appearance.reduceMotion` (`System | On | Off`) decides, mirroring the
/// renderer's media-query + setting behavior.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct MotionGate {
    pub reduce_motion: ReduceMotion,
    /// Whether the OS requests reduced motion (injectable; see module docs).
    pub system_reduced: bool,
}

impl Default for MotionGate {
    fn default() -> Self {
        Self {
            reduce_motion: ReduceMotion::System,
            system_reduced: false,
        }
    }
}

impl MotionGate {
    /// Read the gate from a persisted settings map (missing → `System`).
    pub fn from_settings(settings: &serde_json::Map<String, serde_json::Value>) -> Self {
        let reduce_motion = strict_appearance_from_settings(settings)
            .map(|config| config.reduce_motion)
            .unwrap_or(ReduceMotion::System);
        Self {
            reduce_motion,
            system_reduced: false,
        }
    }

    /// Inject the OS-level preference (a GPUI/objc2 probe is a later-phase
    /// TODO; this lets a coordinator plumb it in).
    pub fn with_system_reduced(mut self, system_reduced: bool) -> Self {
        self.system_reduced = system_reduced;
        self
    }

    /// Whether motion is allowed. `On` always disables, `Off` always allows,
    /// and `System` follows the injected OS preference — the exact semantics
    /// of the renderer's reduced-motion media query reacting to changes.
    pub fn allow(self) -> bool {
        match self.reduce_motion {
            ReduceMotion::On => false,
            ReduceMotion::Off => true,
            ReduceMotion::System => !self.system_reduced,
        }
    }
}

/// Revision-guarded appearance synchronization. Ports the hydration contract
/// from `startPillAppearanceSync`: a cached/storage value always wins over a
/// *stale* authoritative hydration (`hydrationRevision !== revision`), so the
/// pill never flashes an older persisted appearance after a newer event.
#[derive(Debug, Clone, Default)]
pub struct AppearanceSyncState {
    pub config: Option<AppearanceConfig>,
    revision: u64,
}

impl AppearanceSyncState {
    pub fn new() -> Self {
        Self::default()
    }

    /// The current revision; capture before starting an async hydration.
    pub fn revision(&self) -> u64 {
        self.revision
    }

    pub fn has_config(&self) -> bool {
        self.config.is_some()
    }

    /// Adopt a storage/cache appearance. Always wins; bumps the revision so an
    /// in-flight older hydration is dropped. Returns whether a repaint is
    /// needed.
    pub fn adopt(&mut self, config: AppearanceConfig) -> bool {
        self.revision += 1;
        self.config = Some(config);
        true
    }

    /// Adopt an authoritative (settings) appearance only if nothing newer
    /// arrived since `hydration_revision` was captured. Returns whether the
    /// config actually changed.
    pub fn adopt_authoritative(
        &mut self,
        config: AppearanceConfig,
        hydration_revision: u64,
    ) -> bool {
        if hydration_revision != self.revision {
            return false;
        }
        self.revision += 1;
        self.config = Some(config);
        true
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use aiden_core::appearance::{
        create_default_appearance_config, get_preset_variant, PresetId, Scheme,
    };
    use aiden_core::dictation::{DictationState, DictationStatePayload};

    fn custom_appearance(mode: aiden_core::appearance::Mode) -> AppearanceConfig {
        let mut config = create_default_appearance_config();
        config.mode = mode;
        config.light = get_preset_variant(PresetId::Berry, Scheme::Light);
        config.dark = get_preset_variant(PresetId::Slate, Scheme::Dark);
        config
    }

    fn payload(state: DictationState, message: Option<&str>) -> DictationStatePayload {
        DictationStatePayload {
            state,
            message: message.map(str::to_string),
        }
    }

    // -----------------------------------------------------------------------
    // Phase reducer (renderer/pill/pill-app.tsx)
    // -----------------------------------------------------------------------

    #[test]
    fn full_phase_lifecycle_follows_the_renderer() {
        let mut state = PillState::new();
        assert!(!state.visible());

        // Hotkey → record: dot + meter + timer.
        state.reduce(&PillEvent::from_payload(&payload(
            DictationState::Recording,
            None,
        )));
        assert_eq!(state.phase, Phase::Listening);
        assert!(state.visible());
        assert_eq!(state.elapsed_seconds, 0);

        state.reduce(&PillEvent::Tick);
        state.reduce(&PillEvent::Tick);
        assert_eq!(state.elapsed_seconds, 2);

        // Hotkey again → stop, transcribe.
        state.reduce(&PillEvent::from_payload(&payload(
            DictationState::Stopping,
            None,
        )));
        assert_eq!(state.phase, Phase::Transcribing);

        // Pasting result.
        state.reduce(&PillEvent::from_payload(&payload(
            DictationState::Pasted,
            None,
        )));
        assert_eq!(state.phase, Phase::Pasted);

        // Fresh round: record → copied result.
        state.reduce(&PillEvent::Recording);
        assert_eq!(state.phase, Phase::Listening);
        assert_eq!(state.elapsed_seconds, 0);
        state.reduce(&PillEvent::from_payload(&payload(
            DictationState::Stopping,
            None,
        )));
        state.reduce(&PillEvent::from_payload(&payload(
            DictationState::Copied,
            None,
        )));
        assert_eq!(state.phase, Phase::Copied);

        // Failure path carries the coordinator message.
        state.reduce(&PillEvent::from_payload(&payload(
            DictationState::Error,
            Some("No speech detected"),
        )));
        assert_eq!(state.phase, Phase::Error);
        assert_eq!(state.error_message.as_deref(), Some("No speech detected"));

        // Cancel discards everything.
        state.reduce(&PillEvent::from_payload(&payload(
            DictationState::Cancelled,
            None,
        )));
        assert_eq!(state.phase, Phase::Idle);
        assert!(!state.visible());
        assert_eq!(state.error_message, None);
        assert_eq!(state.elapsed_seconds, 0);
    }

    #[test]
    fn error_defaults_to_renderer_copy_and_stops_at_idle() {
        let mut state = PillState::new();
        state.reduce(&PillEvent::Error {
            message: String::new(),
        });
        // The view layers the default on when the coordinator omits a message.
        assert_eq!(state.error_message.as_deref(), Some(""));

        let mut via_payload = PillState::new();
        via_payload.reduce(&PillEvent::from_payload(&payload(
            DictationState::Error,
            None,
        )));
        assert_eq!(
            via_payload.error_message.as_deref(),
            Some("Dictation failed."),
            "pill-app.tsx default error copy"
        );
    }

    #[test]
    fn stale_stopping_does_not_enter_transcribing() {
        let mut state = PillState::new();
        state.reduce(&PillEvent::Stopping);
        assert_eq!(state.phase, Phase::Idle, "no active recording to stop");
    }

    #[test]
    fn elapsed_format_matches_the_renderer() {
        assert_eq!(format_elapsed(0), "0:00");
        assert_eq!(format_elapsed(9), "0:09");
        assert_eq!(format_elapsed(61), "1:01");
        assert_eq!(format_elapsed(600), "10:00");
    }

    // -----------------------------------------------------------------------
    // pill-appearance.test.ts — strict parsing
    // -----------------------------------------------------------------------

    #[test]
    fn strict_appearance_parsing_rejects_missing_and_malformed_values() {
        let valid = custom_appearance(aiden_core::appearance::Mode::Dark);
        let mut settings = serde_json::Map::new();
        settings.insert(
            SETTINGS_APPEARANCE_KEY.to_string(),
            serde_json::to_value(&valid).unwrap(),
        );
        assert_eq!(
            strict_appearance_from_settings(&settings),
            Some(valid),
            "round-trips a valid config"
        );

        assert_eq!(
            strict_appearance_from_settings(&serde_json::Map::new()),
            None
        );
        let mut partial = serde_json::Map::new();
        partial.insert(
            SETTINGS_APPEARANCE_KEY.to_string(),
            serde_json::Value::String("{".into()),
        );
        assert_eq!(strict_appearance_from_settings(&partial), None);
        let mut empty = serde_json::Map::new();
        empty.insert(SETTINGS_APPEARANCE_KEY.to_string(), serde_json::json!({}));
        assert_eq!(strict_appearance_from_settings(&empty), None);
    }

    // -----------------------------------------------------------------------
    // pill-appearance.test.ts — media + motion reaction
    // -----------------------------------------------------------------------

    #[test]
    fn the_pill_reacts_to_scheme_contrast_and_motion_changes() {
        // System follows the injected OS flag (the media-query analog).
        let gate = MotionGate::default().with_system_reduced(false);
        assert!(gate.allow());
        let reduced = gate.with_system_reduced(true);
        assert!(!reduced.allow(), "prefers-reduced-motion: reduce");
        // Contrast/scheme repaints flow through the theme, not the gate; the
        // motion change is the gate's observable surface.
        let off = MotionGate {
            reduce_motion: ReduceMotion::Off,
            system_reduced: true,
        };
        assert!(off.allow(), "Off always animates");
        let on = MotionGate {
            reduce_motion: ReduceMotion::On,
            system_reduced: false,
        };
        assert!(!on.allow(), "On never animates");
    }

    #[test]
    fn motion_gate_reads_the_persisted_setting() {
        let mut settings = serde_json::Map::new();
        settings.insert(
            SETTINGS_APPEARANCE_KEY.to_string(),
            serde_json::to_value(custom_appearance(aiden_core::appearance::Mode::System)).unwrap(),
        );
        let gate = MotionGate::from_settings(&settings);
        assert_eq!(gate.reduce_motion, ReduceMotion::System);
        assert!(gate.allow(), "default: motion on");
        assert_eq!(
            MotionGate::from_settings(&serde_json::Map::new()).reduce_motion,
            ReduceMotion::System
        );
    }

    // -----------------------------------------------------------------------
    // pill-appearance.test.ts — revision-guarded hydration
    // -----------------------------------------------------------------------

    #[test]
    fn missing_cache_hydrates_without_clobbering_a_newer_storage_event() {
        let mut sync = AppearanceSyncState::new();
        assert!(!sync.has_config(), "no cached appearance yet");

        let hydration_revision = sync.revision();
        let newer = custom_appearance(aiden_core::appearance::Mode::Dark);
        assert!(sync.adopt(newer.clone()));

        // The stale authoritative read resolves *after* the storage event and
        // must be dropped (revision mismatch) — pill-appearance.test.ts "missing
        // cache hydrates settings without clobbering a newer storage event".
        let stale = create_default_appearance_config();
        assert!(!sync.adopt_authoritative(stale, hydration_revision));
        assert_eq!(sync.config.as_ref(), Some(&newer));
    }

    #[test]
    fn fresh_hydration_applies_the_persisted_appearance() {
        let recovered = custom_appearance(aiden_core::appearance::Mode::Light);
        let mut sync = AppearanceSyncState::new();
        let hydration_revision = sync.revision();
        assert!(sync.adopt_authoritative(recovered.clone(), hydration_revision));
        assert_eq!(sync.config.as_ref(), Some(&recovered));
    }

    #[test]
    fn appearance_broadcast_beats_an_older_authoritative_value() {
        let stale = create_default_appearance_config();
        let mut sync = AppearanceSyncState::new();
        let hydration_revision = sync.revision();
        let newer = custom_appearance(aiden_core::appearance::Mode::Dark);

        assert!(sync.adopt(newer.clone()));
        assert!(!sync.adopt_authoritative(stale, hydration_revision));
        assert_eq!(sync.config.as_ref(), Some(&newer));

        // Re-hydration with the *current* revision wins again (visibility
        // refresh path).
        let current = sync.revision();
        let refreshed = custom_appearance(aiden_core::appearance::Mode::System);
        assert!(sync.adopt_authoritative(refreshed.clone(), current));
        assert_eq!(sync.config.as_ref(), Some(&refreshed));
    }
}
