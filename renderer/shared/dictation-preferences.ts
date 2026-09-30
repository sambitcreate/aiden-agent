// Dictation preferences shared by the main-process coordinator, the IPC
// settings parser, and the Voice settings page. Pure and Electron-free.

/**
 * How the global dictation shortcut starts and stops a recording.
 * - `toggle`: press to start, press again to stop.
 * - `hold`: hold while speaking, release to stop (push-to-talk).
 * - `hybrid`: a quick tap latches like `toggle`; a longer hold is push-to-talk.
 */
export type DictationActivationMode = "toggle" | "hold" | "hybrid";

export const DICTATION_ACTIVATION_MODES: readonly DictationActivationMode[] = [
  "hold",
  "hybrid",
  "toggle",
];

/** A press shorter than this in hybrid mode is a tap and latches recording on. */
export const HYBRID_TAP_THRESHOLD_MS = 300;

export function isDictationActivationMode(value: unknown): value is DictationActivationMode {
  return value === "toggle" || value === "hold" || value === "hybrid";
}

/**
 * Resolve the effective mode. `dictationHoldToTalk` remains the persisted
 * "release events required" flag (Linux portal binding and older settings);
 * `dictationActivationMode` only refines a release-capable choice.
 */
export function resolveDictationActivationMode(
  settings: { dictationActivationMode?: unknown; dictationHoldToTalk?: unknown },
  releaseCapable = true,
): DictationActivationMode {
  if (!releaseCapable || settings.dictationHoldToTalk !== true) return "toggle";
  return settings.dictationActivationMode === "hybrid" ? "hybrid" : "hold";
}

/** Choices offered for unloading an idle on-device model, in minutes; 0 = never. */
export const LOCAL_VOICE_IDLE_UNLOAD_CHOICES: readonly number[] = [0, 2, 5, 10, 15, 30, 60];
export const DEFAULT_LOCAL_VOICE_IDLE_UNLOAD_MINUTES = 10;
const MAX_IDLE_UNLOAD_MINUTES = 24 * 60;

export function isLocalVoiceIdleUnloadMinutes(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= 0 &&
    value <= MAX_IDLE_UNLOAD_MINUTES
  );
}

/** Milliseconds before an idle model is unloaded, or null to keep it loaded. */
export function localVoiceIdleUnloadMs(value: unknown): number | null {
  const minutes = isLocalVoiceIdleUnloadMinutes(value)
    ? value
    : DEFAULT_LOCAL_VOICE_IDLE_UNLOAD_MINUTES;
  return minutes === 0 ? null : minutes * 60_000;
}

export interface DictationPreferencePatch {
  dictationHoldToTalk?: boolean;
  dictationActivationMode?: DictationActivationMode;
  localVoiceIdleUnloadMinutes?: number;
}

/**
 * Validate the activation-mode and idle-unload fields of an untrusted settings
 * patch. Choosing a mode also sets the release-capable flag so the Linux
 * portal binds a hold shortcut for `hold` and `hybrid`. A bare legacy boolean
 * leaves the stored mode alone. Invalid values throw so Settings never silently
 * drops a user's choice.
 */
export function parseDictationPreferencePatch(
  patch: Record<string, unknown>,
): DictationPreferencePatch {
  const next: DictationPreferencePatch = {};
  if (patch.dictationActivationMode !== undefined) {
    if (!isDictationActivationMode(patch.dictationActivationMode)) {
      throw new Error("Invalid dictation activation mode.");
    }
    next.dictationActivationMode = patch.dictationActivationMode;
    next.dictationHoldToTalk = patch.dictationActivationMode !== "toggle";
  } else if (typeof patch.dictationHoldToTalk === "boolean") {
    next.dictationHoldToTalk = patch.dictationHoldToTalk;
  }
  if (patch.localVoiceIdleUnloadMinutes !== undefined) {
    if (!isLocalVoiceIdleUnloadMinutes(patch.localVoiceIdleUnloadMinutes)) {
      throw new Error("Invalid on-device model idle period.");
    }
    next.localVoiceIdleUnloadMinutes = patch.localVoiceIdleUnloadMinutes;
  }
  return next;
}
