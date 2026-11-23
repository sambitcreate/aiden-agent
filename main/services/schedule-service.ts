import { ipcMain, logger } from "../platform.js";
import { configStore } from "./config-store.js";
import { scheduleExecution, type ScheduleExecution } from "./schedule-execution.js";
import { createScheduleServiceCore } from "./schedule-service-core.js";
import { scheduleStore, type ScheduleStore } from "./schedule-store.js";

export function createScheduleService(
  store: ScheduleStore = scheduleStore,
  execution: ScheduleExecution = scheduleExecution,
) {
  return createScheduleServiceCore({
    store,
    execution,
    globallyEnabled: async () => (await configStore.getSettings()).scheduledTasksEnabled !== false,
    broadcast: (payload) => {
      ipcMain.broadcast("schedule:updated", payload);
      // A saved, removed or switched task may start or stop a trigger's watch.
      void import("./scheduled-task-triggers-main.js")
        .then(({ rearmScheduledTaskTriggers }) => rearmScheduledTaskTriggers(payload))
        .catch((error: unknown) => logger.warn("schedule", "Could not re-arm task triggers.", error));
    },
    pausedAfterFailures: async (task, error) => {
      await execution.recordInLandingChat(task, {
        tone: "failure",
        summary: "Paused after 3 failed runs",
        text: `Scheduled task "${task.name}" was paused: it failed 3 times in a row${error ? ` (${error})` : ""}. Fix what's failing, then turn the task back on.`,
      });
    },
    warn: (message) => logger.warn("schedule", message),
    error: (message, cause) => logger.error("schedule", message, cause),
  });
}

export const scheduleService = createScheduleService();
export type ScheduleService = ReturnType<typeof createScheduleService>;
