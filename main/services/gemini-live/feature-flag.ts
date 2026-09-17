export const GEMINI_LIVE_FEATURE_FLAG = "AIDEN_EXPERIMENTAL_GEMINI_LIVE";
export const GEMINI_LIVE_SCREEN_FLAG = "AIDEN_EXPERIMENTAL_GEMINI_LIVE_SCREEN";
export const GEMINI_LIVE_MODEL = "gemini-3.8-live";

/** Live stays explicitly experimental until the production model and capture gates pass. */
export function geminiLiveEnabled(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): boolean {
  return environment[GEMINI_LIVE_FEATURE_FLAG]?.trim() === "1";
}

/**
 * Screen sharing is a second attended-Live gate. It is enabled only after the
 * packaged, Screen Recording-authorized native-picker acceptance has been
 * recorded for the current build; it can never outlive the Live flag itself.
 */
export function geminiLiveScreenEnabled(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): boolean {
  return (
    geminiLiveEnabled(environment) &&
    environment[GEMINI_LIVE_SCREEN_FLAG]?.trim() === "1"
  );
}

export function experimentalGeminiLiveModel(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): string | null {
  if (!geminiLiveEnabled(environment)) return null;
  return GEMINI_LIVE_MODEL;
}
