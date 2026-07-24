import { Cron } from "croner";
import { nextScheduledRun, type ScheduleStore } from "./schedule-store.js";
import type { ScheduledRun, ScheduledTask, ScheduledTaskInput } from "./types.js";

interface ScheduleExecutionLike {
  run(task: ScheduledTask): Promise<ScheduledRun>;
  cancel(taskId: string): boolean;
  cancelAll(): void;
}

interface RunningTask {
  promise: Promise<ScheduledRun>;
  cancelRequested: boolean;
}

export interface ScheduleServiceDependencies {
  store: ScheduleStore;
  execution: ScheduleExecutionLike;
  globallyEnabled(): Promise<boolean>;
  broadcast(payload: Record<string, unknown>): void;
  warn(message: string): void;
  error(message: string, cause: unknown): void;
}

export function createScheduleServiceCore(dependencies: ScheduleServiceDependencies) {
  const { store, execution } = dependencies;
  const jobs = new Map<string, Cron>();
  const runningTasks = new Map<string, RunningTask>();
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
    dependencies.error(
      `Scheduled task ${task.id} failed outside its execution boundary.`,
      cause,
    );
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
      dependencies.broadcast({ taskId: task.id });
    } catch (recordError) {
      dependencies.error(`Could not record failure for scheduled task ${task.id}.`, recordError);
    }
  }

  function dispatch(taskId: string, options: { automatic: boolean }): Promise<ScheduledRun> {
    if (runningTasks.has(taskId)) {
      throw new Error("This scheduled task is already running.");
    }
    const state: RunningTask = {
      cancelRequested: false,
      promise: Promise.resolve(undefined as never),
    };
    const operation = (async () => {
      const task = await store.get(taskId);
      if (!task) throw new Error(`Scheduled task ${taskId} not found.`);
      if (options.automatic && (!started || !globallyEnabled || !task.enabled)) {
        throw new Error("This scheduled task is paused.");
      }
      const claimed = options.automatic ? await advanceBeforeRun(task) : task;
      if (state.cancelRequested) throw new Error("This scheduled task was cancelled.");
      return execution.run(claimed);
    })();
    state.promise = operation.finally(() => {
      if (runningTasks.get(taskId) === state) runningTasks.delete(taskId);
    });
    runningTasks.set(taskId, state);
    return state.promise;
  }

  async function cancelAndSettle(taskId?: string): Promise<void> {
    const selected = taskId
      ? [...runningTasks.entries()].filter(([id]) => id === taskId)
      : [...runningTasks.entries()];
    for (const [, state] of selected) state.cancelRequested = true;
    if (taskId) execution.cancel(taskId);
    else execution.cancelAll();
    await Promise.allSettled(selected.map(([, state]) => state.promise));
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
          dependencies.warn(`Skipped overlapping cron callback for task ${task.id}.`);
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
      try {
        globallyEnabled = await dependencies.globallyEnabled();
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
      } catch (error) {
        started = false;
        for (const job of jobs.values()) job.stop();
        jobs.clear();
        throw error;
      }
    },

    stop(): void {
      if (!started) return;
      started = false;
      for (const job of jobs.values()) job.stop();
      jobs.clear();
      for (const state of runningTasks.values()) state.cancelRequested = true;
      execution.cancelAll();
    },

    async save(input: ScheduledTaskInput): Promise<ScheduledTask> {
      const task = await store.save(input);
      await schedule(task);
      dependencies.broadcast({ taskId: task.id });
      return (await store.get(task.id)) ?? task;
    },

    async remove(id: string): Promise<void> {
      stopJob(id);
      await cancelAndSettle(id);
      await store.remove(id);
      dependencies.broadcast({ taskId: id, removed: true });
    },

    async pause(id: string): Promise<ScheduledTask> {
      stopJob(id);
      execution.cancel(id);
      const state = runningTasks.get(id);
      if (state) state.cancelRequested = true;
      const task = await store.setEnabled(id, false);
      dependencies.broadcast({ taskId: id });
      return task;
    },

    async resume(id: string): Promise<ScheduledTask> {
      const task = await store.setEnabled(id, true);
      await schedule(task);
      dependencies.broadcast({ taskId: id });
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
        await cancelAndSettle();
      } else {
        await rescheduleAll();
      }
      dependencies.broadcast({ globallyEnabled: enabled });
    },

    isRunning(id: string): boolean {
      return runningTasks.has(id);
    },
  };
}
