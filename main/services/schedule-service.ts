import { createLazyModule } from "../lazy-module.js";
import * as loadedSubsystems from "../loaded-subsystems.js";
import { ipcMain, logger } from "../platform.js";
import { configStore } from "./config-store.js";
import type { ScheduleExecution } from "./schedule-execution.js";
import { createScheduleServiceCore } from "./schedule-service-core.js";
import { scheduleStore, type ScheduleStore } from "./schedule-store.js";

const scheduleExecutionModule = createLazyModule(() => import("./schedule-execution.js"));

const lazyDefaultScheduleExecution: ScheduleExecution = {
  deliverTaskRunToChat: async (task, options) =>
    (await scheduleExecutionModule.load()).scheduleExecution.deliverTaskRunToChat(task, options),
  taskWorkspaceFolder: async (task) =>
    (await scheduleExecutionModule.load()).scheduleExecution.taskWorkspaceFolder(task),
  claimRoutineExecution: async (task, trigger) =>
    (await scheduleExecutionModule.load()).scheduleExecution.claimRoutineExecution(task, trigger),
  recordInLandingChat: async (task, card, options) =>
    (await scheduleExecutionModule.load()).scheduleExecution.recordInLandingChat(task, card, options),
  run: async (task, runId, trigger) =>
    (await scheduleExecutionModule.load()).scheduleExecution.run(task, runId, trigger),
  cancel: (taskId) =>
    scheduleExecutionModule.peek()?.scheduleExecution.cancel(taskId) ?? false,
  cancelAll: () => {
    scheduleExecutionModule.peek()?.scheduleExecution.cancelAll();
  },
};

export function createScheduleService(
  store: ScheduleStore = scheduleStore,
  execution: ScheduleExecution = lazyDefaultScheduleExecution,
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

loadedSubsystems.registerLoadedSubsystem?.("scheduleService", scheduleService);
