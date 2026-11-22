// Production wiring for chat tasks that run when something happens: the
// bookkeeping file, the schedule service and execution, and the watch sources.

import path from "node:path";
import { ipcMain, logger } from "../platform.js";
import { fetchBotWatchUrl } from "./bot-routine-events/watch-sources.js";
import { DataStore } from "./data-store.js";
import { scheduleExecution } from "./schedule-execution.js";
import { resolveScheduledScript, runScheduledScript } from "./schedule-script.js";
import { scheduleService } from "./schedule-service.js";
import { scheduleStore } from "./schedule-store.js";
import { createScheduledTaskTriggers } from "./scheduled-task-triggers.js";
import { SCHEDULED_TASK_TRIGGERS_FILE, createScheduledTaskTriggerStore } from "./scheduled-task-triggers-store.js";

const triggerStore = createScheduledTaskTriggerStore({
  persistence: new DataStore<unknown>(SCHEDULED_TASK_TRIGGERS_FILE, { version: 1, tasks: {} }),
  tasks: () => scheduleStore.list(),
  pauseTask: async (taskId, reason) => {
    await scheduleStore.updateRuntime(taskId, {
      enabled: false,
      lastError: `Paused after 3 failed checks${reason ? `: ${reason}` : "."}`.slice(0, 4_096),
    });
    ipcMain.broadcast("schedule:updated", { taskId });
  },
  now: Date.now,
});

const timer = (fn: () => void, ms: number) => {
  const handle = setTimeout(fn, ms);
  handle.unref?.();
  return { cancel: () => clearTimeout(handle) };
};

const triggers = createScheduledTaskTriggers({
  store: triggerStore,
  isActive: () => scheduleService.isActive(),
  runEvent: (taskId, event, runId) => scheduleService.runEvent(taskId, event, runId),
  findRun: (taskId, runId) => scheduleStore.runById(taskId, runId),
  fetchUrl: (url, signal) => fetchBotWatchUrl(url, { signal }),
  resolveScript: async (task, script) => {
    if (task.permission !== "full") throw new Error("A script watch needs Full permission.");
    const folder = await scheduleExecution.taskWorkspaceFolder(task);
    const scriptPath = await resolveScheduledScript({ script, workspaceRoot: folder });
    return { path: scriptPath, cwd: folder ?? path.dirname(scriptPath) };
  },
  execScript: (scriptPath, options) => runScheduledScript(scriptPath, options),
  checkStateDir: async () => path.join((await import("../platform.js")).app.getPath("userData"), "scheduled-task-check-state"),
  paused: async (task, error) => {
    await scheduleExecution.recordInLandingChat(task, {
      tone: "failure",
      summary: "Paused after 3 failed checks",
      text: `Scheduled task "${task.name}" was paused: its watch failed 3 times in a row${error ? ` (${error})` : ""}. Check the address or script, then turn the task back on.`,
    });
  },
  changed: (taskId) => ipcMain.broadcast("schedule:updated", { taskId }),
  now: Date.now,
  timeZone: () => Intl.DateTimeFormat().resolvedOptions().timeZone,
  setTimer: timer,
  onError: (error) => logger.warn("schedule", "A task trigger step did not finish.", error),
});

let started = false;

export async function startScheduledTaskTriggers(): Promise<void> {
  if (started) return;
  started = true;
  await triggers.start().catch((error: unknown) => logger.warn("schedule", "Could not arm task triggers.", error));
}

/** Re-read the tasks after a save, removal or switch change. */
export function rearmScheduledTaskTriggers(): void {
  if (!started) return;
  void triggers.rearm().catch((error: unknown) => logger.warn("schedule", "Could not re-arm task triggers.", error));
}

export function stopScheduledTaskTriggers(): void {
  if (!started) return;
  started = false;
  triggers.stop();
}
