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

/** About how much disk a freshly installed macOS 26 base takes (assumed; confirm on the owner Mac). */
export const BOT_COMPUTER_BASE_SIZE_BYTES = 50_000_000_000;

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

/**
 * Pinned Debian 13 (trixie) arm64 raw disk image for Linux Bot computers
 * (behind `AIDEN_BOT_COMPUTERS_LINUX` until F4).
 *
 * `generic` is chosen deliberately over `genericcloud`: `generic` ships
 * Debian's full `linux-image-arm64` kernel (with `virtio-gpu` / DRM drivers
 * needed for XFCE under Apple Virtualization.framework's
 * `VZVirtioGraphicsDeviceConfiguration`), whereas `genericcloud` uses
 * `linux-image-cloud-arm64` which strips graphics/DRM modules. Both ship as a
 * plain raw disk with `cloud-init` and `cloud-initramfs-growroot` preinstalled,
 * so no image conversion tool is needed.
 *
 * Verified directly against Debian's official `SHA512SUMS` for `20261123-2671`
 * and streamed end-to-end to compute the exact SHA-256 and byte length.
 */
export const BOT_COMPUTER_LINUX_IMAGE = Object.freeze({
  distribution: "debian",
  version: "13",
  codename: "trixie",
  variant: "generic",
  architecture: "arm64",
  build: "20261123-2671",
  url: "https://cloud.debian.org/images/cloud/trixie/20261123-2671/debian-13-generic-arm64-20261123-2671.raw",
  bytes: 3_221_225_472,
  sha256: "eede309c98bdeffcae251a2f0c5f7078427979768e357d5dea2319d779eaf9e7",
  sha512:
    "056644b92b6e70c96b8f6bd4b9c5635d61d8193f768489dd62ee33dd7251055ead9db6c83619345beae146f8782e5877a660590320c060471814ee0e88246495",
} as const);

/**
 * Concrete `snapshot.debian.org` timestamps matching the pinned image build so
 * every Mac installs the exact same Debian package versions until Update base
 * moves the pin.
 */
export const BOT_COMPUTER_LINUX_APT_SNAPSHOT = Object.freeze({
  date: "2026-11-23",
  archiveTimestamp: "20261123T203846Z",
  securityTimestamp: "20261123T220438Z",
  archiveUrl: "https://snapshot.debian.org/archive/debian/20261123T203846Z",
  securityUrl: "https://snapshot.debian.org/archive/debian-security/20261123T220438Z",
} as const);

/** Default Linux Bot computer hardware configuration (plan §Before and after). */
export const BOT_COMPUTER_LINUX_CPU_COUNT = 4;
export const BOT_COMPUTER_LINUX_MEMORY_GB = 4;
export const BOT_COMPUTER_LINUX_MEMORY_BYTES = BOT_COMPUTER_LINUX_MEMORY_GB * 1024 ** 3;
export const BOT_COMPUTER_LINUX_MIN_MEMORY_BYTES = 2 * 1024 ** 3;
export const BOT_COMPUTER_LINUX_DISK_GB = 24;
export const BOT_COMPUTER_LINUX_DISK_BYTES = BOT_COMPUTER_LINUX_DISK_GB * 1024 ** 3;
export const BOT_COMPUTER_LINUX_BASE_SIZE_BYTES = 8_000_000_000;
export const BOT_COMPUTER_LINUX_BASE_DISK_RESERVE_BYTES = 16 * 1024 ** 3;
export const BOT_COMPUTER_LINUX_DISPLAY = "1280x800";
/** Lume 0.8.0 requires macOS 14.0+; Linux guests are not bound to host macOS 26. */
export const BOT_COMPUTER_LINUX_MIN_HOST_MACOS = "14.0";

/** Whether this Mac's macOS can host a Linux Bot computer (macOS 14.0+). */
export function hostMacosSupportsLinuxBotComputers(hostVersion: string | undefined): boolean {
  if (!hostVersion || !/^\d+(?:\.\d+){0,2}$/u.test(hostVersion)) return false;
  return compareMacosVersions(hostVersion, BOT_COMPUTER_LINUX_MIN_HOST_MACOS) >= 0;
}
