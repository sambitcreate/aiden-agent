import { ipcMain } from "../platform.js";
import { botApplicationService } from "./bot-application-service-main.js";
import type { BotRoutinePorts } from "./bot-routines-port.js";
import { scheduleService } from "./schedule-service.js";
import { scheduleStore, systemTimezone } from "./schedule-store.js";
import { createBotRoutineService } from "./scheduled-bot-routines.js";

/** The durable Bot session the scheduler submits routines to. */
export async function botRoutinePorts(): Promise<BotRoutinePorts> {
  const { botSessionRuntime } = await import("./bot-runtime/bot-session-main.js");
  return botSessionRuntime();
}

export const botRoutineService = createBotRoutineService({
  store: scheduleStore,
  service: scheduleService,
  botExists: async (botId) => {
    const bot = await botApplicationService.get(botId);
    return bot !== null && bot.id === botId && bot.archivedAt === undefined;
  },
  defaultTimezone: systemTimezone,
  // Routine changes ride the existing Bot invalidation channel so Bot views refresh.
  notifyChanged: (payload) => ipcMain.broadcast("bots:changed", payload),
});
