/**
 * Pinned per Aiden release (decision 8a). Values from AppleDB; the build
 * container could not reach Apple's CDN, so the download's own SHA-256 check is
 * the verification. Updating means editing this constant in a reviewed change,
 * which also makes existing bases show "Update base".
 */
export const BOT_COMPUTER_RESTORE_IMAGE = Object.freeze({
  version: "26.6.2",
  build: "25G83",
  url: "https://updates.cdn-apple.com/2026SummerFCS/fullrestores/140-75212/A2A24B94-1FC1-45A3-93F7-C51B02AF1F4D/UniversalMac_26.6.2_25G83_Restore.ipsw",
  bytes: 19_772_231_540,
  sha256: "885503b7f4b06609e9a512f2befd40f59730640a3f1233e3892d60affdd51c95",
} as const);

/** The base is about 50 GB on disk; this adds headroom for clones and logs. */
export const BOT_COMPUTER_BASE_DISK_RESERVE_BYTES = 60 * 1024 ** 3;

/** Lume's default macOS guest memory, needed free for each running VM. */
export const BOT_COMPUTER_VM_MEMORY_BYTES = 8 * 1024 ** 3;

/**
 * The guest's major version is never newer than the host's: the pinned base is
 * macOS 26, so the host needs macOS 26 or later.
 */
export const BOT_COMPUTER_MIN_HOST_MACOS = "26.0";

/** Compare dotted macOS versions numerically ("26.0.1" >= "26.0"). */
export function compareMacosVersions(left: string, right: string): number {
  const parse = (value: string) => value.split(".").map((part) => Number.parseInt(part, 10) || 0);
  const a = parse(left);
  const b = parse(right);
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const difference = (a[index] ?? 0) - (b[index] ?? 0);
    if (difference !== 0) return Math.sign(difference);
  }
  return 0;
}

/** Whether this Mac's macOS can host the pinned guest. Unknown versions are refused. */
export function hostMacosSupportsBotComputers(hostVersion: string | undefined): boolean {
  if (!hostVersion || !/^\d+(?:\.\d+){0,2}$/u.test(hostVersion)) return false;
  return compareMacosVersions(hostVersion, BOT_COMPUTER_MIN_HOST_MACOS) >= 0;
}
