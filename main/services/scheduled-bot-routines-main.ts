import { app, ipcMain, logger } from "../platform.js";
import { botApplicationService } from "./bot-application-service-main.js";
import { createBotRoutineNotesStore } from "./bot-routine-notes.js";
import { scheduleService } from "./schedule-service.js";
import { scheduleStore, systemTimezone } from "./schedule-store.js";
import {
  createBotRoutineCatchUp,
  createBotRoutineCatchUpTrigger,
  createBotRoutineService,
  type BotRoutineExecutorPorts,
} from "./scheduled-bot-routines.js";

/** Each routine's notepad, next to its Bot's session (`routine_notes`). */
export const botRoutineNotes = createBotRoutineNotesStore({ profileDir: () => app.getPath("userData") });

/**
 * The durable Bot session the scheduler submits routines to, plus the
 * routine's notes and the Telegram fan-out of its result.
 */
export async function botRoutinePorts(): Promise<BotRoutineExecutorPorts> {
  const { botSessionRuntime } = await import("./bot-runtime/bot-session-main.js");
  const runtime = await botSessionRuntime();
  return {
    send: (botId, input) => runtime.send(botId, input),
    state: (botId) => runtime.state(botId),
    awaitReply: (botId, submissionId, signal) => runtime.awaitReply(botId, submissionId, signal),
    markSilent: (botId, submissionId) => runtime.markSilent(botId, submissionId),
    routineNotes: (botId, taskId) => botRoutineNotes.render(botId, taskId),
    async deliverResult(delivery) {
      try {
        const { telegramService } = await import("./telegram/telegram-service.js");
        await telegramService.deliverBotRoutineResult(delivery);
      } catch (error) {
        logger.warn("bots", `Bot ${delivery.botId} routine result could not reach Telegram.`, error);
      }
    },
  };
}

export const botRoutineService = createBotRoutineService({
  store: scheduleStore,
  service: scheduleService,
  botExists: async (botId) => {
    const bot = await botApplicationService.get(botId);
    return bot !== null && bot.id === botId;
  },
  defaultTimezone: systemTimezone,
  // Routine changes ride the existing Bot invalidation channel so Bot views refresh.
  notifyChanged: (payload) => ipcMain.broadcast("bots:changed", payload),
  routineDeleted: (botId, routineId) => botRoutineNotes.clear(botId, routineId),
});

const catchUp = createBotRoutineCatchUp({ store: scheduleStore, scheduler: scheduleService });

/**
 * A Bot leaving its paused state runs, once, the newest routine fire it
 * skipped (§11.2). Installed with the Bot runtime's state bridge.
 */
const catchUpOnResume = createBotRoutineCatchUpTrigger((botId) => {
  void catchUp
    .catchUp(botId)
    .then((runs) => Promise.all(runs.map(({ completion }) => completion)))
    .catch((error: unknown) => logger.warn("bots", `Bot ${botId} routine catch-up failed.`, error));
});

void import("./bot-runtime/bot-session-main.js")
  .then(({ onBotSessionStateChange }) => onBotSessionStateChange(catchUpOnResume))
  .catch((error: unknown) => logger.warn("bots", "Bot routine catch-up is unavailable.", error));
