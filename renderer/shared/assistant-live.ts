export type AssistantLiveAvailabilityReason =
  | "available"
  | "missing_google_credential"
  | "google_oauth_unsupported"
  | "google_api_key_invalid"
  | "live_model_unverified";

export interface AssistantLiveStartIntent {
  microphone: boolean;
  screen?: boolean;
  /** Opaque, one-use main-process proof that Computer Use is ready for this document. */
  computerUseAuthorization: string | null;
}

export interface AssistantLiveSnapshot {
  available: boolean;
  reason: AssistantLiveAvailabilityReason;
  /** Exact main-approved model. Present only after the model gate resolves. */
  model?: string;
  /** True only while the screen-share feature gate is open for this document. */
  screenShareAllowed?: boolean;
  sessionId?: string;
  state:
    | "idle"
    | "connecting"
    | "open"
    | "resuming"
    | "closing"
    | "closed"
    | "failed"
    | "disconnected";
}

/** One screen or window in Aiden's own Linux screen picker. */
export interface LiveDisplaySourceSummary {
  id: string;
  name: string;
  kind: "screen" | "window";
  /** A small PNG preview as a data URL, or "" when the desktop gave none. */
  thumbnail: string;
}

/**
 * What Choose… shows before capture: nothing to list (macOS system picker,
 * or screen share off), the desktop's portal picker (Linux on Wayland), or
 * Aiden's own list (Linux on X11).
 */
export type LiveDisplaySources =
  | { mode: "unavailable" }
  | { mode: "portal" }
  | { mode: "list"; sources: LiveDisplaySourceSummary[] };

/** Safe renderer projection. Binary media, credentials, and raw tool data are absent by design. */
export type AssistantLiveRendererEvent =
  | { type: "snapshot"; snapshot: AssistantLiveSnapshot }
  | { type: "ready"; sessionId: string }
  | { type: "playback_flush"; sessionId: string }
  | { type: "audio"; sessionId: string; pcm: Uint8Array; sampleRate: 24_000 }
  | {
      type: "caption";
      sessionId: string;
      direction: "input" | "output";
      final: boolean;
      text: string;
      /** Google marked this transcription finished, which ends the user's utterance. */
      finished?: true;
    }
  | { type: "model_text"; sessionId: string; text: string }
  | { type: "computer_use_state"; sessionId: string; active: boolean }
  /** Main asks the attended window to run one renderer-side Live tool (see live-renderer-tools). */
  | {
      type: "tool_request";
      sessionId: string;
      requestId: string;
      name: string;
      args: Record<string, unknown>;
    }
  | { type: "tool_cancel"; sessionId: string; requestId: string }
  | {
      type: "turn";
      sessionId: string;
      state: "generation_complete" | "turn_complete" | "waiting";
    }
  | {
      type: "usage";
      sessionId: string;
      promptTokens: number;
      responseTokens: number;
      totalTokens: number;
    }
  | {
      type: "error";
      sessionId: string;
      code: string;
      message: string;
    }
  | {
      type: "reconnect_required";
      sessionId: string;
      reason: "resumption_unavailable" | "resume_failed" | "unexpected_disconnect";
    };

/** Largest renderer tool result main accepts, in UTF-8 bytes of its JSON. */
export const ASSISTANT_LIVE_MAX_TOOL_RESULT_BYTES = 32_768;
/** Largest note the renderer may send to Live, in characters. */
export const ASSISTANT_LIVE_MAX_NOTE_CHARS = 2_000;
