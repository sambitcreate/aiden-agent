/** Wires the Simulator tab IPC in `services/devices/device-ipc.ts` to Electron and the local host. */
import path from "node:path";
import { app, ipcMain } from "../platform.js";
import { rendererDocumentOwner } from "../services/renderer-document-owner.js";
import { startDeviceHubProxy } from "../services/devices/device-hub-proxy.js";
import { registerDeviceHandlersWith } from "../services/devices/device-ipc.js";
import {
  createDeviceService,
  type DeviceService,
} from "../services/devices/device-service.js";
import {
  createNpmRunner,
  defaultNpmResolutionDeps,
  resolveNpm,
} from "../services/devices/device-toolchain.js";
import { devicesEnabled } from "../services/devices/feature-flag.js";
import { registerSimulatorShareHost } from "../services/devices/device-share.js";
import { createPeerDevices } from "../services/devices/peer-devices.js";
import { getPeerHostRegistry } from "../services/peer-host-service-main.js";
import {
  createLocalDeviceHost,
  defaultLocalDeviceHostDeps,
} from "../services/devices/local-device-host.js";

let deviceService: DeviceService | null = null;

function proxyAllowedOrigins(): string[] {
  const origins = ["file://"];
  const devServer = process.env.AIDEN_RENDERER_URL;
  if (devServer) {
    try {
      origins.push(new URL(devServer).origin);
    } catch {
      // A malformed dev URL cannot load the renderer either.
    }
  }
  return origins;
}

function defaultDeviceService(): DeviceService {
  if (deviceService) return deviceService;
  const baseDir = path.join(app.getPath("userData"), "devices");
  const host = createLocalDeviceHost(
    defaultLocalDeviceHostDeps({
      baseDir,
      resolveNpmRunner: async () => {
        const npm = await resolveNpm(defaultNpmResolutionDeps);
        return npm ? createNpmRunner(npm) : null;
      },
    }),
  );
  deviceService = createDeviceService({
    baseDir,
    host,
    // The registry is created on first use, from a user-driven refresh.
    peers: createPeerDevices({
      list: () => getPeerHostRegistry().list(),
      request: (id, input) => getPeerHostRegistry().request(id, input),
      relayTarget: (id) => getPeerHostRegistry().relayTarget(id),
    }),
    startProxy: (resolveHub) =>
      startDeviceHubProxy({ resolveHub, allowedOrigins: proxyAllowedOrigins() }),
    fetch: (url, init) => fetch(url, { ...init, redirect: "error" }),
  });
  return deviceService;
}

/** The service for agent device tools, or null while the feature flag is off. */
export async function deviceServiceForAgents(): Promise<DeviceService | null> {
  if (!devicesEnabled()) return null;
  const service = defaultDeviceService();
  await service.load();
  return service;
}

/** A removed chat's simulator sessions end with it. Simulators keep running. */
export function closeDeviceSessionsForChat(chatId: string): void {
  if (devicesEnabled()) deviceService?.closeChat(chatId);
}

/** Stops helpers the Simulator tab started. Simulators keep running. */
export async function shutdownDevices(): Promise<void> {
  await deviceService?.stop();
}

export function registerDeviceHandlers(): void {
  // Paired Macs reach this Mac's simulators only while the flag and the owner's sharing consent are on.
  registerSimulatorShareHost(() => (devicesEnabled() ? defaultDeviceService().shareHost() : null));
  registerDeviceHandlersWith({
    handle: (channel, listener) =>
      ipcMain.handle(channel, (event, ...args) => listener(event, ...args)),
    enabled: () => devicesEnabled(),
    owner: (event) =>
      rendererDocumentOwner(
        event as Electron.IpcMainInvokeEvent,
        () => new Error("Simulator access requires the active application document."),
      ),
    service: defaultDeviceService,
  });
}
