export function shouldQuitAfterAllWindowsClose(
  platform: NodeJS.Platform,
  backgroundServiceRunning: boolean,
): boolean {
  return platform !== "darwin" && !backgroundServiceRunning;
}
