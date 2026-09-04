import { app } from "electron";
import { shouldSuppressOzoneWaylandVulkan } from "./linux-wayland-vulkan-core.js";

export function applyLinuxGraphicsFlags(): void {
  const ozonePlatformOverride = app.commandLine.hasSwitch("ozone-platform")
    ? app.commandLine.getSwitchValue("ozone-platform")
    : undefined;
  if (!shouldSuppressOzoneWaylandVulkan(process.platform, process.env, ozonePlatformOverride)) {
    return;
  }
  app.commandLine.appendSwitch("disable-features", "Vulkan");
}
