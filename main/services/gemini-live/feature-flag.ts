export const GEMINI_LIVE_FEATURE_FLAG = "AIDEN_EXPERIMENTAL_GEMINI_LIVE";
export const GEMINI_LIVE_MODEL = "gemini-3.8-live";

/** Live stays explicitly experimental until the production model and capture gates pass. */
export function geminiLiveEnabled(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): boolean {
  return environment[GEMINI_LIVE_FEATURE_FLAG]?.trim() === "1";
}

export function experimentalGeminiLiveModel(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): string | null {
  if (!geminiLiveEnabled(environment)) return null;
  return geminiLiveEnabled(environment) ? GEMINI_LIVE_MODEL : null;
}
