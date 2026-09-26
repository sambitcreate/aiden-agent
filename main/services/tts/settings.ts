// TTS settings document parsing and migration.
//
// The shared module normalizes supported documents; this module adds the
// future-version guard used by the config-store mutation seam: a settings
// document written by a newer build is preserved verbatim and refused by this
// build rather than silently downgraded.

import {
  normalizeTtsSettings,
  TTS_SETTINGS_VERSION,
  type TtsSettingsV1,
} from "../../../renderer/shared/tts.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Parse a persisted TTS settings document. Returns null when the document was
 * written by a newer version and must not be interpreted or rewritten here.
 */
export function parseTtsSettingsDocument(value: unknown): TtsSettingsV1 | null {
  if (
    isRecord(value) &&
    typeof value.version === "number" &&
    value.version > TTS_SETTINGS_VERSION
  ) {
    return null;
  }
  return normalizeTtsSettings(value);
}
