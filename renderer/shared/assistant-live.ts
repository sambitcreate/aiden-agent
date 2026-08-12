export type AssistantLiveAvailabilityReason =
  | "available"
  | "missing_google_credential"
  | "google_oauth_unsupported"
  | "google_api_key_invalid"
  | "live_model_unverified";

export interface AssistantLiveStartIntent {
  /** Exact attended Assistant thread whose Computer Use opt-in may be inherited. */
  chatId?: string | null;
  microphone: boolean;
  screen: boolean;
}

export interface AssistantLiveSnapshot {
  available: boolean;
  reason: AssistantLiveAvailabilityReason;
  /** Exact main-approved model. Present only after the model gate resolves. */
  model?: string;
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
    }
  | { type: "model_text"; sessionId: string; text: string }
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
