/**
 * Pinned Debian 13 (trixie) arm64 raw disk image for Bot computers.
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

/** Default Linux Bot computer hardware configuration. */
export const BOT_COMPUTER_LINUX_CPU_COUNT = 4;
export const BOT_COMPUTER_LINUX_MEMORY_GB = 4;
export const BOT_COMPUTER_LINUX_MEMORY_BYTES = BOT_COMPUTER_LINUX_MEMORY_GB * 1024 ** 3;
export const BOT_COMPUTER_LINUX_MIN_MEMORY_BYTES = 2 * 1024 ** 3;
export const BOT_COMPUTER_LINUX_DISK_GB = 24;
export const BOT_COMPUTER_LINUX_DISK_BYTES = BOT_COMPUTER_LINUX_DISK_GB * 1024 ** 3;
export const BOT_COMPUTER_LINUX_BASE_SIZE_BYTES = 8_000_000_000;
export const BOT_COMPUTER_LINUX_BASE_DISK_RESERVE_BYTES = 16 * 1024 ** 3;
export const BOT_COMPUTER_LINUX_DISPLAY = "1280x800";

/** Lume 0.8.0 requires macOS 14.0+ on Apple silicon to host Linux VMs. */
export const BOT_COMPUTER_MIN_HOST_MACOS = "14.0";
export const BOT_COMPUTER_LINUX_MIN_HOST_MACOS = BOT_COMPUTER_MIN_HOST_MACOS;

/** Compare dotted macOS versions numerically ("14.4.1" >= "14.0"). */
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

/** Whether this Mac's macOS can host a Linux Bot computer (macOS 14.0+). Unknown versions are refused. */
export function hostMacosSupportsBotComputers(hostVersion: string | undefined): boolean {
  if (!hostVersion || !/^\d+(?:\.\d+){0,2}$/u.test(hostVersion)) return false;
  return compareMacosVersions(hostVersion, BOT_COMPUTER_MIN_HOST_MACOS) >= 0;
}
