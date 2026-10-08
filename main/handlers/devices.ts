/** Wires the Simulator tab IPC in `services/devices/device-ipc.ts` to Electron and the local host. */
import { spawn as nodeSpawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { copyFile, mkdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { BrowserWindow, app, clipboard, dialog, ipcMain, shell } from "../platform.js";
import { createDeviceFeatures, type DeviceFeatures } from "../services/devices/device-features.js";
import { registerDeviceFeatureHandlersWith } from "../services/devices/device-feature-ipc.js";
import { createDeviceRecorder } from "../services/devices/device-recording.js";
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
  reservePort,
} from "../services/devices/local-device-host.js";
import {
  createSshDeviceHost,
  defaultSshDeviceHostDeps,
  runSshCommand,
  sshDeviceHostOwner,
} from "../services/devices/ssh-device-host.js";
import { defaultLocalSshTargetDeps, isLocalSshTarget } from "../services/devices/local-ssh-target.js";

/** The system ssh; Aiden never bundles one or stores keys. */
const SSH_PATH = "/usr/bin/ssh";

let deviceService: DeviceService | null = null;
let deviceFeatures: DeviceFeatures | null = null;

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
    // SSH hosts are created from the saved list without contacting them; each connects on a user action.
    ssh: {
      create: (config) =>
        createSshDeviceHost(
          config,
          defaultSshDeviceHostDeps({ owner: sshDeviceHostOwner(baseDir, config.id), sshPath: SSH_PATH, reservePort }),
        ),
      isLocalTarget: (config) =>
        isLocalSshTarget(
          config,
          defaultLocalSshTargetDeps(async (args) => {
            const result = await runSshCommand(SSH_PATH, args, { timeoutMs: 5_000 });
            return result.code === 0 ? result.stdout : null;
          }),
        ),
    },
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

function defaultDeviceFeatures(): DeviceFeatures {
  if (deviceFeatures) return deviceFeatures;
  const baseDir = path.join(app.getPath("userData"), "devices");
  deviceFeatures = createDeviceFeatures({
    service: defaultDeviceService(),
    recorder: createDeviceRecorder({
      spawn: (command, args) => {
        const child = nodeSpawn(command, [...args], { stdio: "ignore", detached: false });
        // A spawn failure may never emit "exit"; the recorder settles on exit, so report one.
        child.once("error", () => {
          if (child.exitCode === null && child.signalCode === null) child.emit("exit", 127, null);
        });
        return child;
      },
      tempDir: async () => {
        const directory = path.join(baseDir, "recordings");
        await mkdir(directory, { recursive: true, mode: 0o700 });
        return directory;
      },
      fileSize: async (file) => (await stat(file).catch(() => null))?.size ?? null,
      removeFile: (file) => rm(file, { force: true }),
      newId: () => randomBytes(12).toString("base64url"),
      now: () => Date.now(),
      setTimeout: (callback, ms) => setTimeout(callback, ms),
      clearTimeout: (timer) => clearTimeout(timer),
    }),
    clipboard: {
      readText: () => clipboard.readText(),
      availableFormats: () => clipboard.availableFormats(),
      writeText: (text) => clipboard.writeText(text),
    },
    moveFile: async (from, to) => {
      await copyFile(from, to);
      await rm(from, { force: true });
    },
    removeFile: (file) => rm(file, { force: true }),
    writeFile: (file, bytes) => writeFile(file, bytes),
    now: () => new Date(),
  });
  return deviceFeatures;
}

/** Where `device_screenshot` may save besides the chat's workspace. */
export function deviceDownloadsDir(): string {
  return app.getPath("downloads");
}

/** A removed chat's simulator sessions and screen recordings end with it. Simulators keep running. */
export function closeDeviceSessionsForChat(chatId: string): void {
  if (!devicesEnabled()) return;
  deviceService?.closeChat(chatId);
  void deviceFeatures?.discardForChat(chatId).catch(() => undefined);
}

/** Stops helpers and recordings the Simulator tab started. Simulators keep running. */
export async function shutdownDevices(): Promise<void> {
  await deviceFeatures?.stop().catch(() => undefined);
  await deviceService?.stop();
}

export function registerDeviceHandlers(): void {
  // Paired Macs reach this Mac's simulators only while the flag and the owner's sharing consent are on.
  registerSimulatorShareHost((audience) => (devicesEnabled() ? defaultDeviceService().shareHost(audience) : null));
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
  registerDeviceFeatureHandlersWith({
    handle: (channel, listener) =>
      ipcMain.handle(channel, (event, ...args) => listener(event, ...args)),
    enabled: () => devicesEnabled(),
    owner: (event) =>
      rendererDocumentOwner(
        event as Electron.IpcMainInvokeEvent,
        () => new Error("Simulator access requires the active application document."),
      ),
    features: defaultDeviceFeatures,
    chooseSavePath: async (event, { defaultName, kind }) => {
      const parent = BrowserWindow.fromWebContents((event as Electron.IpcMainInvokeEvent).sender);
      if (!parent || parent.isDestroyed()) throw new Error("The window is unavailable.");
      const result = await dialog.showSaveDialog(parent, {
        title: kind === "mp4" ? "Save screen recording" : "Save screenshot",
        defaultPath: path.join(app.getPath("downloads"), defaultName),
        filters:
          kind === "mp4"
            ? [{ name: "MPEG-4 video", extensions: ["mp4"] }]
            : [{ name: "PNG image", extensions: ["png"] }],
        properties: ["createDirectory", "showOverwriteConfirmation"],
      });
      return result.canceled || !result.filePath ? null : result.filePath;
    },
    revealInFinder: (file) => shell.showItemInFolder(file),
  });
}
