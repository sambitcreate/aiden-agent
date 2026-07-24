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
    broadcast: (payload) => ipcMain.broadcast("schedule:updated", payload),
    warn: (message) => logger.warn("schedule", message),
    error: (message, cause) => logger.error("schedule", message, cause),
  });
}

export const scheduleService = createScheduleService();
export type ScheduleService = ReturnType<typeof createScheduleService>;
