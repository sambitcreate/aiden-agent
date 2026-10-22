// Settings → Bot computers and the Bot profile's Computer section over IPC
// (plan §8.1). Registered only where `hostPlatformCapabilities().botComputers`
// is true (Apple silicon), so Linux never reaches any of this.
//
// - `botComputers:status()` → `BotComputersStatus`. Reading it never runs Lume.
// - `botComputers:setUp()` / `updateBase()` start the person's explicit setup
//   and return at once; progress arrives as `botComputers:changed` broadcasts.
// - `cancelSetUp`, `removeEverything`, `updateSettings(patch)`.
// - `give(botId)`, `reset(botId)`, `remove(botId)`, `stop(botId)`.
// - The Computer tab (plan §8.5): `viewerGrant(botId, { start })` lends a
//   device stream target (starting the computer only with `start`, and
//   cancelled if the asking window goes away), `takeOver` (a running
//   computer only) / `giveBack` switch who drives it, and `pointer` reads the
//   Bot's last action point.
// - The guest driver lane (plan §8.6): `setUpElementControl()` starts element
//   control on a ready base without it and returns at once; while setup waits
//   for the person's grants, `baseViewerGrant()` lends Settings the base's
//   screen, and `checkPermissions()` / `skipPermissions()` check again or
//   finish without element control.

import {
  BOT_COMPUTER_CHANNELS,
  BOT_COMPUTERS_CHANGED_CHANNEL,
  parseBotComputersSettingsPatch,
  parseBotComputerViewerRequest,
  type BotComputerPointer,
  type BotComputersSettings,
  type BotComputersStatus,
  type BotComputerStatus,
  type BotComputerViewerGrant,
} from "../../renderer/shared/bot-computers.js";
import type { BotComputerControl, BotComputerHost, BotComputerSessions } from "../services/bot-computers/types.js";
import type { BotComputerViewer } from "../services/bot-computers/viewer-main.js";
import { parseBotId } from "./bot-params.js";

export interface BotComputerHandlerDependencies {
  handle(channel: string, handler: (event: unknown, ...args: unknown[]) => unknown): void;
  host: Pick<
    BotComputerHost,
    | "status"
    | "setUp"
    | "cancelSetUp"
    | "updateBase"
    | "removeEverything"
    | "updateSettings"
    | "give"
    | "reset"
    | "deleteForBot"
    | "stop"
    | "onChange"
    | "computer"
    | "setUpElementControl"
    | "checkPermissions"
    | "skipPermissions"
  >;
  viewer: Pick<BotComputerViewer, "grant" | "grantBase">;
  control: Pick<BotComputerControl, "takeOver" | "giveBack">;
  sessions: Pick<BotComputerSessions, "lastPointer">;
  /** Runs `listener` once the window that invoked goes away; returns the unsubscribe. */
  onSenderGone?(event: unknown, listener: () => void): () => void;
  broadcast(channel: string, payload: unknown): void;
  /** A computer is only given to, reset or removed for a Bot that exists. */
  botExists(botId: string): Promise<boolean>;
  log?(message: string, error?: unknown): void;
  /** Progress can fire many times a second; changes inside this window send one status. */
  coalesceMs?: number;
}

export function registerBotComputerHandlers(deps: BotComputerHandlerDependencies): void {
  const log = deps.log ?? (() => undefined);
  const coalesceMs = deps.coalesceMs ?? 150;
  let pending = false;
  deps.host.onChange(() => {
    if (pending) return;
    pending = true;
    setTimeout(() => {
      pending = false;
      void deps.host
        .status()
        .then((status) => deps.broadcast(BOT_COMPUTERS_CHANGED_CHANNEL, status))
        .catch((error: unknown) => log("Could not publish Bot computer status.", error));
    }, coalesceMs);
  });

  async function knownBot(raw: unknown): Promise<string> {
    const botId = parseBotId(raw);
    if (!(await deps.botExists(botId))) throw new Error("This Bot no longer exists.");
    return botId;
  }

  const start = (operation: () => Promise<void>, what: string) => {
    void operation().catch((error: unknown) => log(`Bot computer ${what} did not finish.`, error));
  };

  deps.handle(BOT_COMPUTER_CHANNELS.status, (): Promise<BotComputersStatus> => deps.host.status());

  deps.handle(BOT_COMPUTER_CHANNELS.setUp, async (): Promise<BotComputersStatus> => {
    start(() => deps.host.setUp(), "setup");
    return deps.host.status();
  });

  deps.handle(BOT_COMPUTER_CHANNELS.updateBase, async (): Promise<BotComputersStatus> => {
    start(() => deps.host.updateBase(), "base update");
    return deps.host.status();
  });

  deps.handle(BOT_COMPUTER_CHANNELS.cancelSetUp, () => {
    deps.host.cancelSetUp();
  });

  deps.handle(BOT_COMPUTER_CHANNELS.setUpElementControl, async (): Promise<BotComputersStatus> => {
    start(() => deps.host.setUpElementControl(), "element control setup");
    return deps.host.status();
  });

  deps.handle(BOT_COMPUTER_CHANNELS.checkPermissions, () => {
    deps.host.checkPermissions();
  });

  deps.handle(BOT_COMPUTER_CHANNELS.skipPermissions, () => {
    deps.host.skipPermissions();
  });

  deps.handle(BOT_COMPUTER_CHANNELS.baseViewerGrant, (): Promise<BotComputerViewerGrant> => deps.viewer.grantBase());

  deps.handle(BOT_COMPUTER_CHANNELS.removeEverything, async (): Promise<BotComputersStatus> => {
    await deps.host.removeEverything();
    return deps.host.status();
  });

  deps.handle(BOT_COMPUTER_CHANNELS.updateSettings, async (_event, patch): Promise<BotComputersSettings> =>
    deps.host.updateSettings(parseBotComputersSettingsPatch(patch)),
  );

  deps.handle(BOT_COMPUTER_CHANNELS.give, async (_event, rawBotId): Promise<BotComputerStatus> =>
    deps.host.give(await knownBot(rawBotId)),
  );

  deps.handle(BOT_COMPUTER_CHANNELS.reset, async (_event, rawBotId): Promise<BotComputerStatus> =>
    deps.host.reset(await knownBot(rawBotId)),
  );

  // Removing a computer is allowed for a Bot that is already gone: it is the cleanup.
  deps.handle(BOT_COMPUTER_CHANNELS.remove, async (_event, rawBotId): Promise<void> => {
    await deps.host.deleteForBot(parseBotId(rawBotId));
  });

  deps.handle(BOT_COMPUTER_CHANNELS.stop, async (_event, rawBotId): Promise<void> => {
    await deps.host.stop(parseBotId(rawBotId), { reason: "person" });
  });

  async function computerOf(botId: string): Promise<BotComputerStatus> {
    const computer = await deps.host.computer(botId);
    if (!computer) throw new Error("This Bot doesn't have a computer.");
    return computer;
  }

  deps.handle(BOT_COMPUTER_CHANNELS.viewerGrant, async (event, rawBotId, rawOptions): Promise<BotComputerViewerGrant> => {
    const botId = await knownBot(rawBotId);
    const { start } = parseBotComputerViewerRequest(rawOptions);
    // A start the asking window no longer waits for is cancelled, unless another caller still wants it.
    const controller = new AbortController();
    const unsubscribe = deps.onSenderGone?.(event, () => controller.abort());
    try {
      return await deps.viewer.grant(botId, { start, signal: controller.signal });
    } finally {
      unsubscribe?.();
    }
  });

  deps.handle(BOT_COMPUTER_CHANNELS.takeOver, async (_event, rawBotId): Promise<BotComputerStatus> => {
    const botId = await knownBot(rawBotId);
    // Only a running computer can be used. Control taken over a stopped one would keep the Bot
    // waiting for a Give back the tab doesn't offer until the computer runs again.
    if ((await computerOf(botId)).state !== "running") throw new Error("This Bot's computer isn't running.");
    deps.control.takeOver(botId, "viewer");
    return computerOf(botId);
  });

  deps.handle(BOT_COMPUTER_CHANNELS.giveBack, async (_event, rawBotId): Promise<BotComputerStatus> => {
    const botId = await knownBot(rawBotId);
    await computerOf(botId);
    deps.control.giveBack(botId);
    return computerOf(botId);
  });

  deps.handle(BOT_COMPUTER_CHANNELS.pointer, async (_event, rawBotId): Promise<BotComputerPointer | null> =>
    deps.sessions.lastPointer(parseBotId(rawBotId)) ?? null,
  );
}
