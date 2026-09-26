// Shared Text-to-Speech (Read aloud) contracts.
//
// Dependency-free by design: imported from both the main process and the
// renderer. No Electron, no SDK, no secrets. Providers and credentials are
// referenced only through opaque main-owned identifiers.

export type TtsModelId = "gemini-3.8-flash-tts" | "gemini-3.8-flash-lite-tts";

export const TTS_MODEL_IDS: readonly TtsModelId[] = [
  "gemini-3.8-flash-tts",
  "gemini-3.8-flash-lite-tts",
];

export function isTtsModelId(value: unknown): value is TtsModelId {
  return value === "gemini-3.8-flash-tts" || value === "gemini-3.8-flash-lite-tts";
}

export type TtsVoiceKind = "prebuilt" | "prompted" | "replicated";

export type TtsDeliveryPreset = "neutral" | "conversational" | "calm";

/**
 * Versioned machine-local Text-to-Speech preferences. Credentials are never
 * stored here: they live in the encrypted provider secret store under a
 * main-owned internal identity.
 */
export interface TtsSettingsV1 {
  version: 1;
  /** Explicit, separate opt-in for cloud speech synthesis. */
  enabled: boolean;
  credentialSource: "saved-google" | "dedicated";
  model: TtsModelId;
  selectedVoice: null | {
    kind: TtsVoiceKind;
    /** Opaque reference into the main-owned voice store. */
    localVoiceId: string;
  };
  delivery: { preset: TtsDeliveryPreset; note: string };
  reading: { inlineCode: boolean; fencedCode: boolean };
  audioRetention: "session";
}

export const TTS_SETTINGS_VERSION = 1;

export function defaultTtsSettings(): TtsSettingsV1 {
  return {
    version: 1,
    enabled: false,
    credentialSource: "saved-google",
    model: "gemini-3.8-flash-tts",
    selectedVoice: null,
    delivery: { preset: "neutral", note: "" },
    reading: { inlineCode: true, fencedCode: false },
    audioRetention: "session",
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
  );
}

function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).every((key) => keys.includes(key));
}

/**
 * Canonicalize a persisted/patched settings document onto a valid v1 shape.
 * Unknown fields are ignored (fail closed); unknown enum values fall back to
 * defaults rather than being preserved as-is into runtime behavior.
 */
export function normalizeTtsSettings(value: unknown): TtsSettingsV1 {
  const defaults = defaultTtsSettings();
  if (!isRecord(value)) return defaults;
  const delivery = isRecord(value.delivery) ? value.delivery : {};
  const reading = isRecord(value.reading) ? value.reading : {};
  const voice = isRecord(value.selectedVoice) ? value.selectedVoice : null;
  return {
    version: 1,
    enabled: value.enabled === true,
    credentialSource: value.credentialSource === "dedicated" ? "dedicated" : "saved-google",
    model: isTtsModelId(value.model) ? value.model : defaults.model,
    selectedVoice:
      voice &&
      (voice.kind === "prebuilt" || voice.kind === "prompted" || voice.kind === "replicated") &&
      typeof voice.localVoiceId === "string" &&
      voice.localVoiceId.length > 0
        ? {
            kind: voice.kind,
            localVoiceId: voice.localVoiceId,
          }
        : null,
    delivery: {
      preset:
        delivery.preset === "conversational" ||
        delivery.preset === "calm" ||
        delivery.preset === "neutral"
          ? delivery.preset
          : "neutral",
      note:
        typeof delivery.note === "string"
          ? delivery.note.slice(0, TTS_LIMITS.deliveryNoteMaxChars)
          : "",
    },
    reading: {
      inlineCode: reading.inlineCode !== false,
      fencedCode: reading.fencedCode === true,
    },
    audioRetention: "session",
  };
}

const TTS_SETTINGS_PATCH_KEYS: ReadonlySet<string> = new Set([
  "enabled",
  "credentialSource",
  "model",
  "selectedVoice",
  "delivery",
  "reading",
]);

/**
 * Strictly parse a settings patch from the renderer. Only known fields with
 * valid shapes are accepted; anything else is a hard error so a drifted or
 * malicious payload cannot silently change preferences.
 */
export function parseTtsSettingsPatch(value: unknown): {
  enabled?: boolean;
  credentialSource?: "saved-google" | "dedicated";
  model?: TtsModelId;
  selectedVoice?: null | {
    kind: TtsVoiceKind;
    localVoiceId: string;
  };
  delivery?: { preset: TtsDeliveryPreset; note: string };
  reading?: { inlineCode: boolean; fencedCode: boolean };
} {
  if (!isRecord(value)) throw new Error("Invalid TTS settings patch.");
  for (const key of Object.keys(value)) {
    if (!TTS_SETTINGS_PATCH_KEYS.has(key)) {
      throw new Error("Invalid TTS settings patch field.");
    }
  }
  const patch: Record<string, unknown> = {};
  if ("enabled" in value) {
    if (typeof value.enabled !== "boolean") throw new Error("Invalid TTS enabled flag.");
    patch.enabled = value.enabled;
  }
  if ("credentialSource" in value) {
    if (value.credentialSource !== "saved-google" && value.credentialSource !== "dedicated")
      throw new Error("Invalid TTS credential source.");
    patch.credentialSource = value.credentialSource;
  }
  if ("model" in value) {
    if (!isTtsModelId(value.model)) throw new Error("Invalid TTS model.");
    patch.model = value.model;
  }
  if ("selectedVoice" in value) {
    if (value.selectedVoice !== null) {
      const voice = value.selectedVoice;
      if (
        !isRecord(voice) ||
        !hasOnlyKeys(voice, ["kind", "localVoiceId"]) ||
        (voice.kind !== "prebuilt" && voice.kind !== "prompted" && voice.kind !== "replicated") ||
        typeof voice.localVoiceId !== "string" ||
        voice.localVoiceId.length === 0 ||
        voice.localVoiceId.length > 256
      )
        throw new Error("Invalid TTS voice selection.");
      patch.selectedVoice = {
        kind: voice.kind,
        localVoiceId: voice.localVoiceId,
      };
    } else {
      patch.selectedVoice = null;
    }
  }
  if ("delivery" in value) {
    const delivery = value.delivery;
    if (
      !isRecord(delivery) ||
      !hasOnlyKeys(delivery, ["preset", "note"]) ||
      (delivery.preset !== "neutral" &&
        delivery.preset !== "conversational" &&
        delivery.preset !== "calm") ||
      typeof delivery.note !== "string" ||
      delivery.note.length > TTS_LIMITS.deliveryNoteMaxChars
    )
      throw new Error("Invalid TTS delivery preference.");
    patch.delivery = {
      preset: delivery.preset,
      note: delivery.note,
    };
  }
  if ("reading" in value) {
    const reading = value.reading;
    if (
      !isRecord(reading) ||
      !hasOnlyKeys(reading, ["inlineCode", "fencedCode"]) ||
      typeof reading.inlineCode !== "boolean" ||
      typeof reading.fencedCode !== "boolean"
    )
      throw new Error("Invalid TTS reading preference.");
    patch.reading = {
      inlineCode: reading.inlineCode,
      fencedCode: reading.fencedCode,
    };
  }
  return patch;
}

/** Identity of exactly one assistant response, issued and revalidated in main. */
export interface TtsSourceRef {
  chatId: string;
  messageId: string;
  /** Concurrency token binding the visible body and terminal state. */
  sourceRevision: string;
}

export function parseTtsSourceRef(value: unknown): TtsSourceRef {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, ["chatId", "messageId", "sourceRevision"]) ||
    typeof value.chatId !== "string" ||
    value.chatId.length === 0 ||
    value.chatId.length > 200 ||
    typeof value.messageId !== "string" ||
    value.messageId.length === 0 ||
    value.messageId.length > 200 ||
    typeof value.sourceRevision !== "string" ||
    value.sourceRevision.length === 0 ||
    value.sourceRevision.length > 200
  )
    throw new Error("Invalid TTS source reference.");
  return {
    chatId: value.chatId,
    messageId: value.messageId,
    sourceRevision: value.sourceRevision,
  };
}

export interface TtsStartRequest {
  /** Idempotency key within the owning document. */
  requestId: string;
  source: TtsSourceRef;
  /** Settings revision captured by the renderer; compared in main. */
  settingsRevision: string;
}

export function parseTtsStartRequest(value: unknown): TtsStartRequest {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, ["requestId", "source", "settingsRevision"]) ||
    typeof value.requestId !== "string" ||
    value.requestId.length === 0 ||
    value.requestId.length > 128 ||
    typeof value.settingsRevision !== "string" ||
    value.settingsRevision.length === 0 ||
    value.settingsRevision.length > 128
  )
    throw new Error("Invalid TTS start request.");
  return {
    requestId: value.requestId,
    source: parseTtsSourceRef(value.source),
    settingsRevision: value.settingsRevision,
  };
}

export type TtsJobPhase =
  | "preparing"
  | "generating"
  | "buffering"
  | "playing"
  | "paused"
  | "completed"
  | "cancelled"
  | "failed";

/** Safe, renderer-facing job snapshot; never content or credentials. */
export interface TtsJobSnapshot {
  jobId: string;
  chatId: string | null;
  kind: "read-aloud" | "preview";
  phase: TtsJobPhase;
  totalSegments: number;
  readySegments: number;
  omissions: readonly string[];
  error: TtsSafeError | null;
}

export type TtsServiceEvent = { kind: "job"; snapshot: TtsJobSnapshot } | { kind: "status" };

/** Closed error union: raw provider strings never cross this boundary. */
export type TtsErrorCode =
  | "setup_required"
  | "secure_storage_unavailable"
  | "invalid_credential"
  | "model_unavailable"
  | "voice_unavailable"
  | "permission_denied"
  | "quota"
  | "provider_unavailable"
  | "network"
  | "invalid_response"
  | "source_changed"
  | "response_incomplete"
  | "response_too_large"
  | "owner_invalidated"
  | "audio_buffer_limit"
  | "playback_unavailable"
  | "not_found";

export const TTS_ERROR_CODES: readonly TtsErrorCode[] = [
  "setup_required",
  "secure_storage_unavailable",
  "invalid_credential",
  "model_unavailable",
  "voice_unavailable",
  "permission_denied",
  "quota",
  "provider_unavailable",
  "network",
  "invalid_response",
  "source_changed",
  "response_incomplete",
  "response_too_large",
  "owner_invalidated",
  "audio_buffer_limit",
  "playback_unavailable",
  "not_found",
];

export interface TtsSafeError {
  code: TtsErrorCode;
  message: string;
  retryable: boolean;
  /**
   * True when a request may have been metered even though it failed locally.
   * Unknown outcomes must be reported as possibly billed, never as zero.
   */
  generationMayHaveBeenBilled: boolean;
}

/** Normalized-text preparation result shared with the renderer for notices. */
export interface TtsPreparationSummary {
  /** Version of the normalization policy; cached in audio identity keys. */
  policyVersion: number;
  /** Number of prepared segments. */
  segments: number;
  /** Human-readable omission notices, e.g. "Code blocks skipped". */
  omissions: readonly string[];
}

/** Safe capability/readiness projection. Never contains secrets. */
export interface TtsStatusV1 {
  /** Normalized effective settings. */
  settings: TtsSettingsV1;
  /** Monotonic settings revision for compare-and-set updates. */
  settingsRevision: string;
  /** True when the selected credential source has a usable key. */
  credentialReady: boolean;
  /** Safe label for the resolved credential source, never the key. */
  credentialSourceLabel: string;
  /** True when synthesis is configured end to end. */
  synthesisReady: boolean;
}

/**
 * Application guardrails (not provider limits). See plan §13.3; final values
 * stay reviewable in one place.
 */
export const TTS_LIMITS = {
  /** Source bytes accepted before Markdown parsing; larger sources are rejected. */
  sourceMaxBytes: 1024 * 1024,
  /** Prepared transcript ceiling; larger prepared text is an explicit error. */
  transcriptMaxBytes: 128 * 1024,
  /** Preferred segment window. */
  segmentTargetMinChars: 600,
  segmentTargetMaxChars: 1200,
  /** Hard per-segment UTF-8 ceiling. */
  segmentMaxBytes: 4 * 1024,
  /** Preview sample text ceiling. */
  previewMaxChars: 400,
  /** Optional delivery note ceiling. */
  deliveryNoteMaxChars: 240,
  /** Voice design description ceiling. */
  designDescriptionMaxChars: 1000,
  /** Decoded audio retained per synthesis segment. */
  segmentAudioMaxBytes: 8 * 1024 * 1024,
  /** Total retained session audio across segments. */
  sessionAudioMaxBytes: 32 * 1024 * 1024,
  /** Maximum bytes delivered in one tts:audio:read response. */
  audioReadMaxBytes: 64 * 1024,
  /** Provider request lifetime per segment. */
  requestTimeoutMs: 60_000,
  /** Idle paused jobs expire after this interval. */
  pausedJobExpiryMs: 10 * 60_000,
  /** Imported recording admission size. */
  recordingMaxBytes: 8 * 1024 * 1024,
} as const;

/** Sentinel preview sentence for explicit voice previews (never chat text). */
export const TTS_PREVIEW_SENTENCE = "This is a short preview of the selected voice.";
