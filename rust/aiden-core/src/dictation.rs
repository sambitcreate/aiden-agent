//! Port of `renderer/shared/dictation.ts` — the global dictation state
//! contract shared between the main-process coordinator and the transcribe
//! pill renderer.

use serde::{Deserialize, Serialize};

/// Channel over which the coordinator broadcasts `DictationStatePayload`s to
/// the pill.
pub const DICTATION_STATE_CHANNEL: &str = "dictation:state";

/// States the coordinator broadcasts to the pill on `dictation:state`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum DictationState {
    /// Hotkey pressed while idle: pill should show and start recording.
    Recording,
    /// Hotkey pressed while recording: pill should stop, transcribe, then report.
    Stopping,
    /// Transcript was pasted into the focused text field.
    Pasted,
    /// Nothing editable was focused (or paste was unavailable): transcript is on the clipboard.
    Copied,
    /// Something failed (no speech, mic denied, transcription error).
    Error,
    /// Recording was cancelled: pill should discard and hide.
    Cancelled,
}

/// Payload carried over `DICTATION_STATE_CHANNEL`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct DictationStatePayload {
    pub state: DictationState,
    /// Human-readable detail for the `error` state.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn state_tags_match_electron_wire_format() {
        for state in [
            DictationState::Recording,
            DictationState::Stopping,
            DictationState::Pasted,
            DictationState::Copied,
            DictationState::Error,
            DictationState::Cancelled,
        ] {
            let value = serde_json::to_value(state).unwrap();
            let back: DictationState = serde_json::from_value(value).unwrap();
            assert_eq!(back, state);
        }
        assert_eq!(
            serde_json::to_value(DictationState::Recording).unwrap(),
            "recording"
        );
        assert_eq!(
            serde_json::to_value(DictationState::Cancelled).unwrap(),
            "cancelled"
        );
    }

    #[test]
    fn payload_channel_and_optional_message() {
        let payload = DictationStatePayload {
            state: DictationState::Error,
            message: Some("No speech detected".into()),
        };
        let json = serde_json::to_string(&payload).unwrap();
        assert!(json.contains("\"message\":\"No speech detected\""));
        let back: DictationStatePayload = serde_json::from_str(&json).unwrap();
        assert_eq!(back, payload);
        assert_eq!(DICTATION_STATE_CHANNEL, "dictation:state");
    }
}
