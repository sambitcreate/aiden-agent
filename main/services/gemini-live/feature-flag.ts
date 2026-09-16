export const GEMINI_LIVE_FEATURE_FLAG = "AIDEN_EXPERIMENTAL_GEMINI_LIVE";
export const GEMINI_LIVE_MODEL = "gemini-3.8-live";

/** Gemini Live is available by default as a beta; retain an emergency rollback switch. */
export function geminiLiveEnabled(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): boolean {
  return environment[GEMINI_LIVE_FEATURE_FLAG]?.trim() !== "0";
}

export function experimentalGeminiLiveModel(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): string | null {
  if (!geminiLiveEnabled(environment)) return null;
  return GEMINI_LIVE_MODEL;
}
