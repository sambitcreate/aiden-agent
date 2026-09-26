export const DEVICES_FEATURE_FLAG = "AIDEN_EXPERIMENTAL_DEVICES";

/**
 * The Simulator tab and device agent tools stay dark until explicitly enabled.
 * Local iOS Simulators need Xcode, so non-macOS hosts are always off.
 */
export function devicesEnabled(
  environment: Readonly<Record<string, string | undefined>> = process.env,
  platform: NodeJS.Platform = process.platform,
): boolean {
  if (platform !== "darwin") return false;
  const value = environment[DEVICES_FEATURE_FLAG]?.trim().toLowerCase();
  return value === "1" || value === "true";
}
