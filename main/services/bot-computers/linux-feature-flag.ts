export const BOT_COMPUTERS_LINUX_FLAG = "AIDEN_BOT_COMPUTERS_LINUX";

/**
 * Build switch for Linux Bot computers (Debian 13 + XFCE in Lume).
 * Off by default through F1–F3 so `main` never ships a partial migration;
 * F4 removes the macOS path and turns Linux on permanently.
 */
export function botComputersLinuxEnabled(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): boolean {
  const rawValue = environment[BOT_COMPUTERS_LINUX_FLAG];
  if (rawValue === undefined) return false;
  const normalized = rawValue.trim().toLowerCase();
  return normalized === "1" || normalized === "true";
}
