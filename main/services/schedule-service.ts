import { Cron } from "croner";
import { ipcMain, logger } from "../platform.js";
import { configStore } from "./config-store.js";
import { scheduleExecution, type ScheduleExecution } from "./schedule-execution.js";
import { nextScheduledRun, scheduleStore, type ScheduleStore } from "./schedule-store.js";
import type { ScheduledRun, ScheduledTask, ScheduledTaskInput } from "./types.js";

export function createScheduleService(
  store: ScheduleStore = scheduleStore,
  execution: ScheduleExecution = scheduleExecution,
) {
  const jobs = new Map<string, Cron>();
  const runningTaskIds = new Set<string>();
  let started = false;
  let globallyEnabled = true;

  function stopJob(taskId: string): void {
    jobs.get(taskId)?.stop();
    jobs.delete(taskId);
  }

  async function advanceBeforeRun(task: ScheduledTask): Promise<ScheduledTask> {
    return store.updateRuntime(task.id, {
      nextRunAt: task.enabled
        ? nextScheduledRun(task.cron, task.timezone, new Date(Date.now() + 1))
        : undefined,
    });
  }

  async function recordUnexpectedFailure(task: ScheduledTask, cause: unknown): Promise<void> {
    const message = cause instanceof Error ? cause.message : String(cause);
    logger.error("schedule", `Scheduled task ${task.id} failed outside its execution boundary.`, cause);
    try {
      await store.recordRun({
        taskId: task.id,
        startedAt: Date.now(),
        finishedAt: Date.now(),
        result: "error",
        output: "",
        error: message,
        chatId: task.chatId,
      });
      ipcMain.broadcast("schedule:updated", { taskId: task.id });
    } catch (recordError) {
      logger.error("schedule", `Could not record failure for scheduled task ${task.id}.`, recordError);
    }
  }

  async function dispatch(taskId: string, options: { automatic: boolean }): Promise<ScheduledRun> {
    if (runningTaskIds.has(taskId)) {
      throw new Error("This scheduled task is already running.");
    }
    const task = await store.get(taskId);
    if (!task) throw new Error(`Scheduled task ${taskId} not found.`);
    if (options.automatic && (!started || !globallyEnabled || !task.enabled)) {
      throw new Error("This scheduled task is paused.");
    }
    const claimed = options.automatic ? await advanceBeforeRun(task) : task;
    runningTaskIds.add(taskId);
    try {
      return await execution.run(claimed);
    } finally {
      runningTaskIds.delete(taskId);
    }
  }

  async function schedule(task: ScheduledTask): Promise<void> {
    stopJob(task.id);
    if (!started || !globallyEnabled || !task.enabled) return;
    const job = new Cron(
      task.cron,
      {
        name: `scheduled:${task.id}`,
        paused: true,
        timezone: task.timezone,
        mode: "5-or-6-parts",
        protect: () => {
          logger.warn("schedule", `Skipped overlapping cron callback for task ${task.id}.`);
        },
        catch: (error) => {
          void store.get(task.id).then((latest) => {
            if (latest) return recordUnexpectedFailure(latest, error);
          });
        },
      },
      async () => {
        await dispatch(task.id, { automatic: true });
      },
    );
    jobs.set(task.id, job);
    const nextRunAt = job.nextRun()?.getTime();
    await store.updateRuntime(task.id, { nextRunAt });
    job.resume();
  }

  async function rescheduleAll(): Promise<void> {
    for (const job of jobs.values()) job.stop();
    jobs.clear();
    if (!started || !globallyEnabled) return;
    for (const task of await store.list()) {
      if (task.enabled) await schedule(task);
    }
  }

  return {
    async start(): Promise<void> {
      if (started) return;
      started = true;
      const settings = await configStore.getSettings();
      globallyEnabled = settings.scheduledTasksEnabled !== false;
      if (!globallyEnabled) return;
      const now = Date.now();
      const tasks = await store.list();
      for (const task of tasks) {
        if (!task.enabled) continue;
        const missed = task.nextRunAt !== undefined && task.nextRunAt < now;
        await schedule(task);
        if (missed) {
          void dispatch(task.id, { automatic: true }).catch((error) =>
            recordUnexpectedFailure(task, error),
          );
        }
      }
    },

    stop(): void {
      if (!started) return;
      started = false;
      for (const job of jobs.values()) job.stop();
      jobs.clear();
      execution.cancelAll();
      runningTaskIds.clear();
    },

    async save(input: ScheduledTaskInput): Promise<ScheduledTask> {
      const task = await store.save(input);
      await schedule(task);
      ipcMain.broadcast("schedule:updated", { taskId: task.id });
      return (await store.get(task.id)) ?? task;
    },

    async remove(id: string): Promise<void> {
      stopJob(id);
      execution.cancel(id);
      await store.remove(id);
      ipcMain.broadcast("schedule:updated", { taskId: id, removed: true });
    },

    async pause(id: string): Promise<ScheduledTask> {
      stopJob(id);
      execution.cancel(id);
      const task = await store.setEnabled(id, false);
      ipcMain.broadcast("schedule:updated", { taskId: id });
      return task;
    },

    async resume(id: string): Promise<ScheduledTask> {
      const task = await store.setEnabled(id, true);
      await schedule(task);
      ipcMain.broadcast("schedule:updated", { taskId: id });
      return (await store.get(id)) ?? task;
    },

    runNow(id: string): Promise<ScheduledRun> {
      return dispatch(id, { automatic: false });
    },

    async setGlobalEnabled(enabled: boolean): Promise<void> {
      globallyEnabled = enabled;
      if (!enabled) {
        for (const job of jobs.values()) job.stop();
        jobs.clear();
        execution.cancelAll();
      } else {
        await rescheduleAll();
      }
      ipcMain.broadcast("schedule:updated", { globallyEnabled: enabled });
    },

    isRunning(id: string): boolean {
      return runningTaskIds.has(id);
    },
  };
}

export const scheduleService = createScheduleService();
export type ScheduleService = ReturnType<typeof createScheduleService>;
