export const DEVICES_FEATURE_FLAG = "AIDEN_EXPERIMENTAL_DEVICES";

/**
 * The Simulator tab and device agent tools ship enabled on macOS. Keep an
 * explicit environment kill switch for incident recovery: any value other
 * than `1` or `true` turns the feature off. Local iOS Simulators need Xcode,
 * so non-macOS hosts are always off.
 */
export function devicesEnabled(
  environment: Readonly<Record<string, string | undefined>> = process.env,
  platform: NodeJS.Platform = process.platform,
): boolean {
  if (platform !== "darwin") return false;
  const rawValue = environment[DEVICES_FEATURE_FLAG];
  if (rawValue === undefined) return true;
  const value = rawValue.trim().toLowerCase();
  return value === "1" || value === "true";
}
