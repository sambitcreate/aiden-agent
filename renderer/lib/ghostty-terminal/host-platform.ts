export function isMacPlatform(platform?: string): boolean {
  const value = platform ?? (typeof navigator === "undefined" ? "" : navigator.platform);
  return /Mac|iPhone|iPad|iPod/iu.test(value);
}
