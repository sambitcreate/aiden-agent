// The process-wide Bot memory service (spec 2026-10-09 §6–§8).
//
// Memory lives in each Bot's private session directory,
// `<userData>/bots/<dir>/memory/`. Every successful write, whoever made it
// (the person, the Bot's own tool, background review, compaction flush), is
// pushed to desktop windows as `bots:memory:changed`; Remote subscribes to
// `onChanged` itself.

import { app, ipcMain, logger } from "../../platform.js";
import type { BOT_MEMORY_CHANNELS } from "../../../renderer/shared/bot-memory.js";
import { createBotMemoryService, type BotMemoryRuntime, type BotMemoryService } from "./service.js";
import { createBotMemoryStore } from "./store.js";

export type { BotMemoryRuntime, BotMemoryService };

// A literal so the IPC inventory contract can see this push site.
const BOT_MEMORY_CHANGED_CHANNEL: typeof BOT_MEMORY_CHANNELS.changed = "bots:memory:changed";

let runtime: BotMemoryRuntime | undefined;

/** Created on first use, once the profile directory is known. */
export function botMemoryRuntime(): BotMemoryRuntime {
  if (runtime === undefined) {
    runtime = createBotMemoryService({
      store: createBotMemoryStore({ profileDir: app.getPath("userData") }),
      onReport: (botId, error) => logger.warn("bots", `Bot ${botId} memory listener failed.`, error),
    });
    runtime.onChanged((event) => ipcMain.broadcast(BOT_MEMORY_CHANGED_CHANNEL, event));
  }
  return runtime;
}

/** The process-wide service, resolved on first call (safe to import before the app is ready). */
export const botMemory: BotMemoryRuntime = {
  view: (botId) => botMemoryRuntime().view(botId),
  edit: (input) => botMemoryRuntime().edit(input),
  apply: (botId, target, operations, options) => botMemoryRuntime().apply(botId, target, operations, options),
  snapshot: (botId) => botMemoryRuntime().snapshot(botId),
  beginSession: (botId) => botMemoryRuntime().beginSession(botId),
  markStale: (botId) => botMemoryRuntime().markStale(botId),
  forgetBot: (botId) => botMemoryRuntime().forgetBot(botId),
  onChanged: (listener) => botMemoryRuntime().onChanged(listener),
};

/** The Step 0 contract Remote and IPC use. */
export const botMemoryService: BotMemoryService = botMemory;
