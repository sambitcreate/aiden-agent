// Production wiring of routine failure handling. Lazy so the scheduler can be
// built before the Bot runtime and issue service load.

import { createBotRoutineRecovery, type BotRoutineRecovery } from "./bot-routine-recovery.js";
import { scheduleStore } from "./schedule-store.js";

let recovery: BotRoutineRecovery | undefined;

/** Hook a later check (the pre-fire health check) runs after a person-only failure. */
let afterPersonFailure: ((botId: string, routineId: string) => void) | undefined;

export function setBotRoutineAfterPersonFailure(hook: ((botId: string, routineId: string) => void) | undefined): void {
  afterPersonFailure = hook;
}

export function botRoutineRecovery(): BotRoutineRecovery {
  recovery ??= createBotRoutineRecovery({
    store: scheduleStore,
    routines: {
      pause: async (botId, id) => (await import("./scheduled-bot-routines-main.js")).botRoutineService.pause(botId, id),
    },
    issues: {
      raise: async (input) => (await import("./bot-issues/service-main.js")).botIssues.raise(input),
      resolve: async (botId, key, resolution) =>
        (await import("./bot-issues/service-main.js")).botIssues.resolve(botId, key, resolution),
    },
    afterPersonFailure: (botId, routineId) => afterPersonFailure?.(botId, routineId),
    now: Date.now,
  });
  return recovery;
}
