// The Bot computer viewer's main-side owner (plan §8.5): it lends the
// Computer tab a device stream target for a Bot's computer and owns the
// viewer hub and the proxy in front of it. Nothing listens until the first
// grant, which only the person opening a Computer tab asks for.
//
// - `grant(botId, { start: true })` starts a stopped computer (reason
//   "viewer"); `{ start: false }` refuses one that isn't running, so a tab
//   restored at launch never boots a VM on its own.
// - The proxy is the device hub proxy the Simulator uses, with its own grants,
//   Host and Origin checks, and a per-launch key it adds for the hub.
// - The hub reaches a computer's screen only while it runs, through P8's
//   sessions, so the Bot's `computer` tool and the viewer share one VNC
//   connection per run.
// - `grantBase()` lends Settings the base computer's screen while setup waits
//   for the person's grants (the guest driver lane, plan §8.6). No Bot drives
//   the base, so the person's input always reaches it.

import { randomBytes } from "node:crypto";

import {
  BOT_COMPUTER_VIEWER_HOST_ID,
  type BotComputerViewerGrant,
} from "../../../renderer/shared/bot-computers.js";
import { rendererProxyOrigins, startDeviceHubProxy, type DeviceHubProxy } from "../devices/device-hub-proxy.js";
import { isLiveScreen, type BotComputerLiveScreen } from "./rfb-screen.js";
import {
  BotComputerError,
  type BotComputerConnection,
  type BotComputerControl,
  type BotComputerHost,
  type BotComputerScreen,
  type BotComputerScreenFactory,
  type BotComputerSessions,
} from "./types.js";
import { BOT_COMPUTER_VIEWER_KEY_HEADER, startBotComputerViewerHub, type BotComputerViewerHub } from "./viewer-hub.js";

/** The hub's key for the base computer; never a Bot id, which can't hold `#`. */
export const BOT_COMPUTER_BASE_VIEW_KEY = "#base-computer";

export interface BotComputerViewerDependencies {
  host: Pick<BotComputerHost, "computer" | "ensureRunning" | "touch" | "onChange"> & Partial<Pick<BotComputerHost, "baseView">>;
  sessions: Pick<BotComputerSessions, "runningScreen">;
  control: Pick<BotComputerControl, "controller" | "takeOver" | "onChange">;
  /** Opens the base computer's screen while setup waits for the person (the same factory as the Bots'). */
  baseScreen?: BotComputerScreenFactory;
  botName?(botId: string): string | Promise<string>;
  allowedOrigins?: readonly string[];
  log?(message: string, error?: unknown): void;
  startHub?: typeof startBotComputerViewerHub;
  startProxy?: typeof startDeviceHubProxy;
}

export interface BotComputerViewer {
  /** Where the Computer tab connects for this Bot's computer. */
  grant(botId: string, options: { start: boolean; signal?: AbortSignal }): Promise<BotComputerViewerGrant>;
  /** Where Settings connects for the base computer while setup waits for the person's grants. */
  grantBase(): Promise<BotComputerViewerGrant>;
  /** Open MJPEG streams and input sockets for a Bot's computer. */
  viewers(botId: string): number;
  close(): Promise<void>;
}

export function createBotComputerViewer(deps: BotComputerViewerDependencies): BotComputerViewer {
  const log = deps.log ?? (() => undefined);
  const startHub = deps.startHub ?? startBotComputerViewerHub;
  const startProxy = deps.startProxy ?? startDeviceHubProxy;
  /** VM name → Bot, for computers a grant was lent for. */
  const vms = new Map<string, string>();
  let running: Promise<{ hub: BotComputerViewerHub; proxy: DeviceHubProxy }> | undefined;
  let current: { hub: BotComputerViewerHub; proxy: DeviceHubProxy } | undefined;
  let closed = false;

  const possessive = async (botId: string) => {
    const name = (await deps.botName?.(botId)) ?? "The Bot";
    return name.endsWith("s") ? `${name}'` : `${name}'s`;
  };

  let baseScreen: { key: string; screen: Promise<BotComputerScreen> } | undefined;
  const dropBaseScreen = () => {
    const cached = baseScreen;
    baseScreen = undefined;
    void cached?.screen.then((screen) => screen.close()).catch(() => undefined);
  };
  const baseLiveScreen = async (signal: AbortSignal): Promise<BotComputerLiveScreen> => {
    const connection: BotComputerConnection | undefined = deps.host.baseView?.();
    if (!connection || !deps.baseScreen) throw new BotComputerError("cancelled", "The base computer isn't waiting for you.");
    const key = `${connection.vmName}\u0000${connection.vnc.port}\u0000${connection.vnc.password}`;
    if (baseScreen?.key !== key) {
      dropBaseScreen();
      const opening = deps.baseScreen(connection, signal);
      baseScreen = { key, screen: opening };
      opening.catch(() => {
        if (baseScreen?.screen === opening) baseScreen = undefined;
      });
    }
    const screen = await baseScreen.screen;
    if (!isLiveScreen(screen)) throw new BotComputerError("unsupported", "The base computer's screen can't be viewed.");
    return screen;
  };

  /**
   * The hub only ever shows a computer that is already running; it never starts one. The
   * running check and the connection are one read, so a stop that lands meanwhile can't
   * turn into a start.
   */
  const liveScreen = async (botId: string, signal: AbortSignal): Promise<BotComputerLiveScreen> => {
    if (botId === BOT_COMPUTER_BASE_VIEW_KEY) return baseLiveScreen(signal);
    const screen = await deps.sessions.runningScreen(botId, signal);
    if (!isLiveScreen(screen)) throw new BotComputerError("unsupported", "This computer's screen can't be viewed.");
    return screen;
  };

  const start = () => {
    running ??= (async () => {
      const key = randomBytes(32).toString("base64url");
      const hub = await startHub({
        key,
        botForVm: (vmName) => vms.get(vmName),
        screen: liveScreen,
        // Nobody else drives the base: the person always has it.
        control: {
          controller: (botId) => (botId === BOT_COMPUTER_BASE_VIEW_KEY ? "person" : deps.control.controller(botId)),
          takeOver: (botId, by) => {
            if (botId !== BOT_COMPUTER_BASE_VIEW_KEY) deps.control.takeOver(botId, by);
          },
          onChange: (listener) => deps.control.onChange(listener),
        },
        touch: (botId) => {
          if (botId !== BOT_COMPUTER_BASE_VIEW_KEY) deps.host.touch(botId);
        },
        log,
      });
      try {
        const proxy = await startProxy({
          resolveHub: (hostId) => (hostId === BOT_COMPUTER_VIEWER_HOST_ID ? hub.origin : null),
          allowedOrigins: deps.allowedOrigins ?? rendererProxyOrigins(),
          hubHeaders: { [BOT_COMPUTER_VIEWER_KEY_HEADER]: key },
        });
        if (closed) {
          await Promise.all([proxy.close(), hub.close()]);
          throw new BotComputerError("cancelled", "Aiden is quitting.");
        }
        current = { hub, proxy };
        return current;
      } catch (error) {
        await hub.close().catch(() => undefined);
        throw error;
      }
    })();
    running.catch(() => {
      running = undefined;
    });
    return running;
  };

  // A computer that stops, restarts on another VM or loses its VM ends its viewers; the tab reconnects.
  const unsubscribe = deps.host.onChange((changed) => {
    for (const [vmName, botId] of [...vms]) {
      if (botId === BOT_COMPUTER_BASE_VIEW_KEY) {
        // The base's view ends with the step that waited for the person.
        if (deps.host.baseView?.()?.vmName !== vmName) {
          vms.delete(vmName);
          current?.hub.closeVm(vmName);
          dropBaseScreen();
        }
        continue;
      }
      if (changed !== undefined && changed !== botId) continue;
      void deps.host
        .computer(botId)
        .then((computer) => {
          if (vms.get(vmName) !== botId) return;
          if (!computer || computer.vmName !== vmName) {
            vms.delete(vmName);
            current?.hub.closeVm(vmName);
          } else if (computer.state !== "running") {
            current?.hub.closeVm(vmName);
          }
        })
        .catch((error: unknown) => log("Could not check a viewed Bot computer.", error));
    }
  });

  return {
    async grant(botId, { start: startIt, signal }) {
      if (closed) throw new BotComputerError("cancelled", "Aiden is quitting.");
      const computer = await deps.host.computer(botId);
      if (!computer) throw new BotComputerError("no_computer", `${await possessive(botId)} computer has been removed.`);
      if (startIt) {
        await deps.host.ensureRunning(botId, { reason: "viewer", signal });
      } else if (computer.state !== "running") {
        throw new BotComputerError("cancelled", `${await possessive(botId)} computer isn't running.`);
      }
      // A computer's VM name never changes while the Bot has it; read it again after a start all the same.
      const vmName = (await deps.host.computer(botId))?.vmName ?? computer.vmName;
      vms.set(vmName, botId);
      const { proxy } = await start();
      return { hostId: BOT_COMPUTER_VIEWER_HOST_ID, deviceId: vmName, grant: proxy.mintGrant() };
    },

    async grantBase() {
      if (closed) throw new BotComputerError("cancelled", "Aiden is quitting.");
      const connection = deps.host.baseView?.();
      if (!connection || !deps.baseScreen) throw new BotComputerError("cancelled", "The base computer isn't waiting for you.");
      vms.set(connection.vmName, BOT_COMPUTER_BASE_VIEW_KEY);
      const { proxy } = await start();
      return { hostId: BOT_COMPUTER_VIEWER_HOST_ID, deviceId: connection.vmName, grant: proxy.mintGrant() };
    },

    viewers: (botId) => current?.hub.viewers(botId) ?? 0,

    async close() {
      closed = true;
      unsubscribe();
      dropBaseScreen();
      const started = await running?.catch(() => undefined);
      current = undefined;
      if (started) await Promise.all([started.proxy.close(), started.hub.close()]);
    },
  };
}
