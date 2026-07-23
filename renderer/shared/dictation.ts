// Global dictation state contract shared between the main-process coordinator
// (main/services/dictation.ts) and the transcribe pill renderer (renderer/pill/).

/** States the coordinator broadcasts to the pill on "dictation:state". */
export type DictationState =
  /** Hotkey pressed while idle: pill should show and start recording. */
  | "recording"
  /** Hotkey pressed while recording: pill should stop, transcribe, then report. */
  | "stopping"
  /** Transcript was pasted into the focused text field. */
  | "pasted"
  /** Nothing editable was focused (or paste was unavailable): transcript is on the clipboard. */
  | "copied"
  /** Something failed (no speech, mic denied, transcription error). */
  | "error"
  /** Recording was cancelled: pill should discard and hide. */
  | "cancelled";

export interface DictationStatePayload {
  state: DictationState;
  /** Human-readable detail for the "error" state. */
  message?: string;
}

export const DICTATION_STATE_CHANNEL = "dictation:state";
