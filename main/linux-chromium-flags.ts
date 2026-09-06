export interface ChromiumCommandLine {
  appendSwitch: (name: string, value?: string) => void;
  getSwitchValue?: (name: string) => string;
}

export function linuxWaylandVulkanDisableFeatures(input: {
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  existingDisableFeatures?: string;
}): string | null {
  if (input.platform !== "linux") return null;
  const session = (input.env.XDG_SESSION_TYPE ?? "").trim().toLowerCase();
  const waylandDisplay = input.env.WAYLAND_DISPLAY?.trim();
  const ozone = (input.env.ELECTRON_OZONE_PLATFORM ?? "").trim().toLowerCase();
  const wayland = session === "wayland" || Boolean(waylandDisplay) || ozone === "wayland";
  if (!wayland) return null;
  const existing = (input.existingDisableFeatures ?? "")
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
  if (!existing.some((feature) => feature.toLowerCase() === "vulkan")) {
    existing.push("Vulkan");
  }
  return existing.join(",");
}

export function applyLinuxWaylandChromiumFlags(
  commandLine: ChromiumCommandLine,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): boolean {
  const features = linuxWaylandVulkanDisableFeatures({
    platform,
    env,
    existingDisableFeatures: commandLine.getSwitchValue?.("disable-features") ?? "",
  });
  if (!features) return false;
  commandLine.appendSwitch("disable-features", features);
  return true;
}
