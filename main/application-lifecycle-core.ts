export function shouldQuitAfterAllWindowsClose(
  platform: NodeJS.Platform,
  backgroundServiceRunning: boolean,
): boolean {
  return platform !== "darwin" && !backgroundServiceRunning;
}

/**
 * Electron reports `window-all-closed` only once every window is gone,
 * hidden ones included. When only hidden helper windows (the visual snapshot
 * renderer) remain and closing should quit, they must be released so it can.
 */
export function shouldReleaseAuxiliaryWindows(
  platform: NodeJS.Platform,
  backgroundServiceRunning: boolean,
  remaining: readonly { auxiliary: boolean }[],
): boolean {
  return (
    remaining.length > 0 &&
    remaining.every((window) => window.auxiliary) &&
    shouldQuitAfterAllWindowsClose(platform, backgroundServiceRunning)
  );
}
