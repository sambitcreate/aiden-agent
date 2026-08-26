export const AMBIENT_MUSIC_FEATURE_FLAG = "AIDEN_AMBIENT_MUSIC_ENABLED";

/**
 * Ambient Music is enabled for normal builds and can be rolled back locally
 * without deleting prompt settings or downloaded model data. Only the exact
 * value `0` disables it; malformed values do not silently change capability.
 */
export function ambientMusicEnabled(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): boolean {
  return environment[AMBIENT_MUSIC_FEATURE_FLAG]?.trim() !== "0";
}
