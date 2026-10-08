export const GEMINI_LIVE_FEATURE_FLAG = "AIDEN_EXPERIMENTAL_GEMINI_LIVE";
export const GEMINI_LIVE_MODEL = "gemini-3.8-live-extended-thinking";
export const GEMINI_LIVE_SCREEN_FLAG = "AIDEN_EXPERIMENTAL_GEMINI_LIVE_SCREEN";

/**
 * Voice-only Aiden Live ships enabled. Keep an explicit environment kill
 * switch for incident recovery without coupling ordinary voice to the
 * separately gated screen-capture path.
 */
export function geminiLiveEnabled(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): boolean {
  const rawValue = environment[GEMINI_LIVE_FEATURE_FLAG];
  if (rawValue === undefined) return true;
  const value = rawValue.trim().toLowerCase();
  return value === "1" || value === "true";
}

/**
 * Screen sharing is a second attended-Live gate. It ships enabled, keeps its
 * own kill switch (any value other than `1` or `true`), and can never outlive
 * the Live flag itself.
 */
export function geminiLiveScreenEnabled(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): boolean {
  if (!geminiLiveEnabled(environment)) return false;
  const rawValue = environment[GEMINI_LIVE_SCREEN_FLAG];
  if (rawValue === undefined) return true;
  const value = rawValue.trim().toLowerCase();
  return value === "1" || value === "true";
}

export function experimentalGeminiLiveModel(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): string | null {
  if (!geminiLiveEnabled(environment)) return null;
  return GEMINI_LIVE_MODEL;
}
