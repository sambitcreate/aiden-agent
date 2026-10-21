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

import { randomBytes } from "node:crypto";

import {
  BOT_COMPUTER_VIEWER_HOST_ID,
  type BotComputerViewerGrant,
} from "../../../renderer/shared/bot-computers.js";
import { rendererProxyOrigins, startDeviceHubProxy, type DeviceHubProxy } from "../devices/device-hub-proxy.js";
import { isLiveScreen, type BotComputerLiveScreen } from "./rfb-screen.js";
import {
  BotComputerError,
  type BotComputerControl,
  type BotComputerHost,
  type BotComputerScreen,
  type BotComputerStartReason,
} from "./types.js";
import { BOT_COMPUTER_VIEWER_KEY_HEADER, startBotComputerViewerHub, type BotComputerViewerHub } from "./viewer-hub.js";

export interface BotComputerViewerDependencies {
  host: Pick<BotComputerHost, "computer" | "ensureRunning" | "touch" | "onChange">;
  sessions: {
    screen(botId: string, signal?: AbortSignal, options?: { reason?: BotComputerStartReason }): Promise<BotComputerScreen>;
  };
  control: Pick<BotComputerControl, "controller" | "takeOver" | "onChange">;
  botName?(botId: string): string | Promise<string>;
  allowedOrigins?: readonly string[];
  log?(message: string, error?: unknown): void;
  startHub?: typeof startBotComputerViewerHub;
  startProxy?: typeof startDeviceHubProxy;
}

export interface BotComputerViewer {
  /** Where the Computer tab connects for this Bot's computer. */
  grant(botId: string, options: { start: boolean; signal?: AbortSignal }): Promise<BotComputerViewerGrant>;
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

  /** The hub only ever shows a computer that is already running; it never starts one. */
  const liveScreen = async (botId: string, signal: AbortSignal): Promise<BotComputerLiveScreen> => {
    const computer = await deps.host.computer(botId);
    if (computer?.state !== "running") throw new BotComputerError("cancelled", "The computer isn't running.");
    const screen = await deps.sessions.screen(botId, signal, { reason: "viewer" });
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
        control: deps.control,
        touch: (botId) => deps.host.touch(botId),
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

    viewers: (botId) => current?.hub.viewers(botId) ?? 0,

    async close() {
      closed = true;
      unsubscribe();
      const started = await running?.catch(() => undefined);
      current = undefined;
      if (started) await Promise.all([started.proxy.close(), started.hub.close()]);
    },
  };
}
