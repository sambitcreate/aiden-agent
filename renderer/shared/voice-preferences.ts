import { normalizeLanguageIntent } from "./voice-language.js";

export interface VoicePreferencePatch {
  voiceLanguage?: string;
  voiceTranslateToEnglish?: boolean;
  voiceTrimSilence?: boolean;
}

export function parseVoicePreferencePatch(patch: Record<string, unknown>): VoicePreferencePatch {
  const result: VoicePreferencePatch = {};
  if ("voiceLanguage" in patch) {
    const language = normalizeLanguageIntent(patch.voiceLanguage);
    if (language) result.voiceLanguage = language;
  }
  if (typeof patch.voiceTranslateToEnglish === "boolean") result.voiceTranslateToEnglish = patch.voiceTranslateToEnglish;
  if (typeof patch.voiceTrimSilence === "boolean") result.voiceTrimSilence = patch.voiceTrimSilence;
  return result;
}

export function voiceTrimSilenceEnabled(value: boolean | undefined): boolean {
  return value !== false;
}

export type VoiceProviderChoice = "openai" | "gemini" | "local";

/**
 * Settings patch for the explicit voice provider. `null` means Automatic and
 * yields an own `voiceProvider: undefined` so the stored choice is removed.
 */
export function parseVoiceProviderPatch(patch: Record<string, unknown>): { voiceProvider?: VoiceProviderChoice } {
  const value = patch.voiceProvider;
  if (value === null) return { voiceProvider: undefined };
  if (value === "openai" || value === "gemini" || value === "local") return { voiceProvider: value };
  return {};
}
