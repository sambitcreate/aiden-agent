import os from "node:os";
import type { NotificationChannel } from "../../renderer/preload-channels.js";
import { app, ipcMain, powerMonitor } from "../platform.js";
import { PeerHostManager, peerNetworkFingerprint } from "./peer-host-manager.js";
import { getPeerHostRegistry } from "./peer-host-service-main.js";

let manager: PeerHostManager | undefined;

/** How often the network fingerprint is compared while any host is supervised. */
const NETWORK_CHECK_MS = 15_000;

/**
 * The connection supervisor, started on first use so a launch with no device
 * UI makes no peer traffic. Sleep/resume, unlock and network changes wake it.
 *
 * Kept apart from the registry singleton so modules that only read paired
 * devices (and the headless CLI that bundles them) do not load the supervisor.
 */
export function getPeerHostManager(): PeerHostManager {
  if (manager) return manager;
  const current = new PeerHostManager({
    registry: getPeerHostRegistry(),
    broadcast: (channel, payload) =>
      ipcMain.broadcast(channel as NotificationChannel, payload),
  });
  manager = current;
  const wake = (): void => current.wake();
  powerMonitor.on("resume", wake);
  powerMonitor.on("unlock-screen", wake);
  let network = peerNetworkFingerprint(os.networkInterfaces());
  const watcher = setInterval(() => {
    if (current.supervising === 0) return;
    const next = peerNetworkFingerprint(os.networkInterfaces());
    if (next === network) return;
    network = next;
    current.wake();
  }, NETWORK_CHECK_MS);
  watcher.unref?.();
  app.once("before-quit", () => {
    clearInterval(watcher);
    powerMonitor.removeListener("resume", wake);
    powerMonitor.removeListener("unlock-screen", wake);
    current.close();
  });
  return current;
}
