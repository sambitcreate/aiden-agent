export const GEMINI_LIVE_FEATURE_FLAG = "AIDEN_EXPERIMENTAL_GEMINI_LIVE";

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
  const model = environment.AIDEN_EXPERIMENTAL_GEMINI_LIVE_MODEL?.trim();
  return model && /^[a-z0-9][a-z0-9._/-]{0,127}$/iu.test(model) ? model : null;
}
