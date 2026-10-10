// Profile → Memory over desktop IPC (spec 2026-10-09 §12).
//
// - `bots:memory:get(botId)` → `BotMemoryView`.
// - `bots:memory:edit({ botId, edit })` → `BotMemoryEditResult`. A refused
//   edit (stale entry, over budget, blocked, invalid) is a result, not a
//   throw, so the page can show its message; malformed input throws.
// - `bots:memory:changed` is pushed to every window by the memory service on
//   any write (`bot-memory-main.ts`).

import { BOT_MEMORY_CHANNELS, type BotMemoryEditResult, type BotMemoryView } from "../../renderer/shared/bot-memory.js";
import type { BotMemoryService } from "../services/bot-memory/service.js";
import { parseBotId, parseBotMemoryEdit } from "./bot-params.js";

export interface BotMemoryHandlerDependencies {
  handle(channel: string, handler: (event: unknown, ...args: unknown[]) => unknown): void;
  memory: Pick<BotMemoryService, "view" | "edit">;
  /** Whether the Bot exists; memory of an unknown Bot is refused. */
  botExists(botId: string): Promise<boolean>;
}

export function registerBotMemoryHandlers(dependencies: BotMemoryHandlerDependencies): void {
  async function knownBot(raw: unknown): Promise<string> {
    const botId = parseBotId(raw);
    if (!(await dependencies.botExists(botId))) throw new Error("This Bot no longer exists.");
    return botId;
  }

  dependencies.handle(BOT_MEMORY_CHANNELS.get, async (_event, rawBotId): Promise<BotMemoryView> => {
    return dependencies.memory.view(await knownBot(rawBotId));
  });

  dependencies.handle(BOT_MEMORY_CHANNELS.edit, async (_event, input): Promise<BotMemoryEditResult> => {
    const parsed = parseBotMemoryEdit(input);
    await knownBot(parsed.botId);
    return dependencies.memory.edit(parsed);
  });
}
