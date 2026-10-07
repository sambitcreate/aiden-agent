import { ipcMain } from "../platform.js";
import { botApplicationService } from "./bot-application-service-main.js";
import type { BotRoutinePorts } from "./bot-routines-port.js";
import { scheduleService } from "./schedule-service.js";
import { scheduleStore, systemTimezone } from "./schedule-store.js";
import { createBotRoutineService } from "./scheduled-bot-routines.js";

let ports: BotRoutinePorts | undefined;

/**
 * The Bot session the scheduler submits routines to.
 *
 * SHIM: until the per-Bot `BotSessionService` (Bots rework plan, Task 1.3)
 * merges, this resolves to the temporary adapter over the legacy Bot chat
 * send path. Swap the body for the real service (`send`/`state` plus the
 * routine reply port) and delete `bot-routines-legacy-session.ts`.
 */
export async function botRoutinePorts(): Promise<BotRoutinePorts> {
  if (!ports) {
    const { createLegacyBotRoutineSession } = await import("./bot-routines-legacy-session.js");
    ports = createLegacyBotRoutineSession();
  }
  return ports;
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
