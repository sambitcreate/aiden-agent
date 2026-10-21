// Electron wiring of the Bot-computer singletons (plan §8). Nothing here runs
// Lume or touches the disk until a caller asks, and every entry point is a
// no-op where `hostPlatformCapabilities().botComputers` is false (Linux,
// Intel Macs), so importing this module never starts anything.

import path from "node:path";
import type { BotComputerHandlerDependencies } from "../../handlers/bot-computers.js";
import { app, ipcMain, logger, nativeImage } from "../../platform.js";
import type { NotificationChannel } from "../../../renderer/preload-channels.js";
import { invalidateBotRuntimeInventoryAuthority } from "../bot-runtime-inventory-lease.js";
import { hostPlatformCapabilities } from "../host-platform-capabilities.js";
import { secrets } from "../secrets.js";
import { createBotComputerControl, type BotComputerControlRegistry } from "./control.js";
import { createBotComputerHost } from "./host.js";
import { resolveLumeInstallation } from "./lume-binary.js";
import { hostMacosSupportsBotComputers } from "./release.js";
import { createRfbScreenFactory, nativeImageEncoder } from "./rfb-screen-main.js";
import { createBotComputerActivity, createBotComputerSessions, type BotComputerActivity } from "./sessions.js";
import type { BotComputerHost, BotComputerSessions } from "./types.js";
import { createBotComputerViewer, type BotComputerViewer } from "./viewer-main.js";

export interface BotComputers {
  host: BotComputerHost;
  control: BotComputerControlRegistry;
  activity: BotComputerActivity;
  sessions: BotComputerSessions;
  viewer: BotComputerViewer;
}

let singleton: BotComputers | undefined;

export function botComputersEnabled(): boolean {
  return hostPlatformCapabilities().botComputers;
}

async function botName(botId: string): Promise<string> {
  const { botStore } = await import("../bot-store.js");
  return (await botStore.get(botId).catch(() => null))?.name ?? "the Bot";
}

/** `<botHome>/Computer`: the one folder shared into the Bot's computer. */
async function botComputerDir(botId: string): Promise<string> {
  const { botApplicationService } = await import("../bot-application-service-main.js");
  const managed = await botApplicationService.resolveManagedWorkspace(botId);
  return path.join(managed.homePath, "Computer");
}

function hostSupport(): { ok: true } | { ok: false; reason: "platform" | "host_os" } {
  if (!botComputersEnabled()) return { ok: false, reason: "platform" };
  const version = typeof process.getSystemVersion === "function" ? process.getSystemVersion() : undefined;
  return hostMacosSupportsBotComputers(version) ? { ok: true } : { ok: false, reason: "host_os" };
}

/** The process-wide Bot computers. Throws where the platform has none. */
export function botComputers(): BotComputers {
  if (!botComputersEnabled()) throw new Error("Bot computers need a Mac with Apple silicon.");
  if (singleton) return singleton;
  const control = createBotComputerControl();
  const activity = createBotComputerActivity();
  const log = (message: string, error?: unknown) =>
    error === undefined ? logger.warn("bot-computers", message) : logger.warn("bot-computers", message, error);
  const host = createBotComputerHost({
    root: path.join(app.getPath("userData"), "bot-computers"),
    lume: async () =>
      (
        await resolveLumeInstallation({
          platform: process.platform,
          arch: process.arch,
          isPackaged: app.isPackaged,
          resourcesPath: process.resourcesPath,
          appPath: app.getAppPath(),
        })
      ).invocation,
    support: hostSupport,
    botComputerDir,
    botName,
    secrets: {
      // Strict: an unreadable store fails the build rather than replacing the password.
      get: (name) => secrets.getKeyStrict(name),
      set: (name, value) => secrets.setInternalKey(name, value, 256),
      deleteFamily: (prefix) => secrets.deleteKeyFamily(prefix),
    },
    control,
    activity,
    // A ready base or Remove everything changes what the Bot runtime offers;
    // starting and stopping a computer never does.
    onSetupReady: () => invalidateBotRuntimeInventoryAuthority("inventory_changed"),
    onRemoved: () => invalidateBotRuntimeInventoryAuthority("inventory_changed"),
    log,
  });
  const sessions = createBotComputerSessions({ host, control, activity, botName });
  // The screen is a VNC connection per run (P9); the Bot's `computer` tool and the viewer share it.
  sessions.setScreenFactory(
    createRfbScreenFactory({
      encode: nativeImageEncoder(nativeImage),
      // Owner-Mac fixture recording only (main/services/bot-computers/fixtures/rfb/README.md).
      recordingsDir:
        process.env.AIDEN_BOT_COMPUTERS_RECORD_RFB === "1"
          ? path.join(app.getPath("userData"), "bot-computers", "rfb-recordings")
          : undefined,
      log,
    }),
  );
  const viewer = createBotComputerViewer({ host, sessions, control, botName, log });
  singleton = { host, control, activity, sessions, viewer };
  return singleton;
}

/** IPC wiring for `registerBotComputerHandlers`. */
export function botComputerHandlerDependencies(): BotComputerHandlerDependencies {
  const { host, viewer, control, sessions } = botComputers();
  return {
    handle: (channel, handler) => ipcMain.handle(channel, handler),
    host,
    viewer,
    control,
    sessions,
    onSenderGone: (event, listener) => {
      const sender = (event as { sender?: { once(name: "destroyed", fn: () => void): unknown; off(name: "destroyed", fn: () => void): unknown } })
        .sender;
      if (!sender) return () => undefined;
      sender.once("destroyed", listener);
      return () => void sender.off("destroyed", listener);
    },
    broadcast: (channel, payload) => ipcMain.broadcast(channel as NotificationChannel, payload),
    botExists: async (botId) => {
      const { botStore } = await import("../bot-store.js");
      return (await botStore.get(botId)) !== null;
    },
    log: (message, error) => logger.warn("bot-computers", message, error),
  };
}

/** Delete Bot step: stop the computer, then delete its VM. Idempotent; a no-op without the platform. */
export async function deleteBotComputer(botId: string): Promise<void> {
  if (!botComputersEnabled()) return;
  await botComputers().host.deleteForBot(botId);
}

/** Pause step: the Bot's computer stops at once. Nothing can be running before the host exists. */
export async function pauseBotComputer(botId: string): Promise<void> {
  if (!botComputersEnabled() || !singleton) return;
  await singleton.host.stop(botId, { reason: "pause" });
}

/** Startup: stop VMs an earlier launch left running and mark interrupted ones stale. */
export async function reconcileBotComputers(): Promise<void> {
  if (!botComputersEnabled()) return;
  await botComputers().host.reconcile();
}

/** Quit: stop every running computer within the deadline. */
export async function shutdownBotComputers(timeoutMs: number): Promise<void> {
  if (!singleton) return;
  // Viewers end first, so no stream holds a computer the host is stopping.
  await singleton.viewer.close().catch((error: unknown) => logger.warn("bot-computers", "The viewer did not close.", error));
  await singleton.host.shutdown(timeoutMs);
}
