export const GEMINI_TRANSCRIPTION_MODEL = "gemini-3.5-transcribe";
export const GEMINI_LIVE_TRANSCRIPTION_MODEL = "gemini-3.5-transcribe-live";

export const CLOUD_VOICE_MODELS = {
  openai: ["whisper-1", "gpt-4o-transcribe", "gpt-4o-mini-transcribe"],
  gemini: [GEMINI_LIVE_TRANSCRIPTION_MODEL, GEMINI_TRANSCRIPTION_MODEL],
} as const;

export type CloudVoiceProvider = keyof typeof CLOUD_VOICE_MODELS;

/**
 * Keep persisted selections inside the provider's supported voice catalog.
 * This also upgrades legacy Gemini Flash voice selections to the dedicated
 * Gemini 3.5 Transcribe model without making an unrelated settings write.
 */
export function resolveCloudVoiceModel(
  provider: CloudVoiceProvider,
  selected: string | undefined,
): string {
  const models = CLOUD_VOICE_MODELS[provider] as readonly string[];
  return selected && models.includes(selected) ? selected : models[0]!;
}

export function isGeminiLiveTranscriptionModel(model: string | undefined): boolean {
  return model === GEMINI_LIVE_TRANSCRIPTION_MODEL;
}

export function isGeminiTranscriptionModel(model: string | undefined): boolean {
  return (CLOUD_VOICE_MODELS.gemini as readonly string[]).includes(model ?? "");
}

/** Apply legacy-model normalization at recording boundaries, not only in Settings UI. */
export function shouldUseGeminiLiveTranscription(
  provider: string | undefined,
  model: string | undefined,
): boolean {
  return (
    provider === "gemini" && isGeminiLiveTranscriptionModel(resolveCloudVoiceModel("gemini", model))
  );
}
