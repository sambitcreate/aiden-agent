// Settings → Bot computers and the Bot profile's Computer section over IPC
// (plan §8.1). Registered only where `hostPlatformCapabilities().botComputers`
// is true (Apple silicon), so Linux never reaches any of this.
//
// - `botComputers:status()` → `BotComputersStatus`. Reading it never runs Lume.
// - `botComputers:setUp()` / `updateBase()` start the person's explicit setup
//   and return at once; progress arrives as `botComputers:changed` broadcasts.
// - `cancelSetUp`, `removeEverything`, `updateSettings(patch)`.
// - `give(botId)`, `reset(botId)`, `remove(botId)`, `stop(botId)`.

import {
  BOT_COMPUTER_CHANNELS,
  BOT_COMPUTERS_CHANGED_CHANNEL,
  parseBotComputersSettingsPatch,
  type BotComputersSettings,
  type BotComputersStatus,
  type BotComputerStatus,
} from "../../renderer/shared/bot-computers.js";
import type { BotComputerHost } from "../services/bot-computers/types.js";
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
  >;
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
}
