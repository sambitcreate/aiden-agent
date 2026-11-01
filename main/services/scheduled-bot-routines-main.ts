import { app, ipcMain, logger } from "../platform.js";
import { botApplicationService } from "./bot-application-service-main.js";
import { createBotRoutineNotesStore } from "./bot-routine-notes.js";
import { scheduleService } from "./schedule-service.js";
import { scheduleStore, systemTimezone } from "./schedule-store.js";
import { botRunStalls } from "./bot-runtime/bot-run-watchdog.js";
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
 * routine's notes. A routine's result leaves through the delivery funnel, not
 * through these ports.
 */
export async function botRoutinePorts(): Promise<BotRoutineExecutorPorts> {
  const { botSessionRuntime, botSpendingStop } = await import("./bot-runtime/bot-session-main.js");
  const runtime = await botSessionRuntime();
  return {
    submissionForRequest: (botId, requestId) => runtime.submissionForRequest(botId, requestId),
    send: (botId, input) => runtime.send(botId, input),
    state: (botId) => runtime.state(botId),
    awaitReply: (botId, submissionId, signal) => runtime.awaitReply(botId, submissionId, signal),
    markSilent: (botId, submissionId) => runtime.markSilent(botId, submissionId),
    // Notes, then the lessons the person kept for this routine.
    routineNotes: async (botId, taskId) => {
      const [{ botLessons }, { renderRoutineLessons }] = await Promise.all([
        import("./bot-learning/learning-main.js"),
        import("./bot-lessons/prompt.js"),
      ]);
      const lessons = renderRoutineLessons(await botLessons.list(botId, { scope: { kind: "routine", routineId: taskId }, status: "active" }));
      return [await botRoutineNotes.render(botId, taskId), lessons].filter(Boolean).join("\n\n");
    },
    fingerprint: async (botId) => (await import("./bot-learning/learning-main.js")).botFingerprint(botId),
    consumeStall: (botId) => botRunStalls.consume(botId),
    checkClaims: async (botId) => (await import("./bot-runtime/bot-session-main.js")).botTurnClaims(botId),
    spendingStop: (_botId, requestId) => botSpendingStop(requestId),
    // RoutineRun / RoutineFailed hooks run in the Bot's folder.
    hookCwd: async (botId) =>
      (await (await import("./bot-capability-services-main.js")).botManagedWorkspace.resolve(botId)).homePath,
    hookReport: (botId, lines) => logger.info("hooks", `Bot ${botId} routine hook messages.`, lines),
  };
}

export const botRoutineService = createBotRoutineService({
  store: scheduleStore,
  service: scheduleService,
  botExists: async (botId) => {
    const bot = await botApplicationService.get(botId);
    return bot !== null && bot.id === botId;
  },
  isPaused: async (botId) => (await import("./bot-pause-main.js")).isBotPaused(botId),
  defaultTimezone: systemTimezone,
  // Routine changes ride the existing Bot invalidation channel so Bot views refresh.
  notifyChanged: (payload) => ipcMain.broadcast("bots:changed", payload),
  routineResumed: async (botId, routineId) =>
    (await import("./bot-routine-recovery-main.js")).botRoutineRecovery().resumed(botId, routineId),
  routineDeleted: async (botId, routineId) => {
    await import("./bot-learning/learning-main.js").then(({ botLessons }) => botLessons.forgetRoutine(botId, routineId)).catch(() => undefined);
    await botRoutineNotes.clear(botId, routineId);
    try {
      const { settleBotIssuesForRoutine } = await import("./bot-issues/service-main.js");
      await settleBotIssuesForRoutine(botId, routineId);
    } catch (error) {
      logger.warn("bots", `Bot ${botId} routine ${routineId} issues could not be settled.`, error);
    }
  },
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
