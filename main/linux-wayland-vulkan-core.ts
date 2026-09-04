export function isWaylandSession(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.XDG_SESSION_TYPE?.trim().toLowerCase() === "wayland") return true;
  return (env.WAYLAND_DISPLAY ?? "").trim().length > 0;
}

export function shouldSuppressOzoneWaylandVulkan(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
  ozonePlatformOverride?: string,
): boolean {
  if (platform !== "linux") return false;
  if (ozonePlatformOverride?.trim().toLowerCase() === "x11") return false;
  return isWaylandSession(env);
}
