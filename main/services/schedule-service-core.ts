import { Cron } from "croner";
import { nextScheduledRun, type ScheduleStore } from "./schedule-store.js";
import type {
  ScheduledRun,
  ScheduledTask,
  ScheduledTaskInput,
} from "./types.js";

interface ScheduleExecutionLike {
  run(task: ScheduledTask): Promise<ScheduledRun>;
  cancel(taskId: string): boolean;
  cancelAll(): void;
}

interface RunningTask {
  promise: Promise<ScheduledRun>;
  cancelRequested: boolean;
  workspaceId?: string;
  workspaceReady: Promise<void>;
}

export interface ScheduleServiceDependencies {
  store: ScheduleStore;
  execution: ScheduleExecutionLike;
  globallyEnabled(): Promise<boolean>;
  broadcast(payload: Record<string, unknown>): void;
  warn(message: string): void;
  error(message: string, cause: unknown): void;
}

export function createScheduleServiceCore(
  dependencies: ScheduleServiceDependencies,
) {
  const { store, execution } = dependencies;
  const jobs = new Map<string, Cron>();
  const runningTasks = new Map<string, RunningTask>();
  const lifecycleTails = new Map<string, Promise<void>>();
  const blockedWorkspaces = new Set<string>();
  let started = false;
  let globallyEnabled = true;

  const throwIfAborted = (signal: AbortSignal | undefined, action: string) => {
    if (signal?.aborted)
      throw new Error(`Scheduled task ${action} was cancelled.`);
  };

  async function withTaskLifecycle<T>(
    taskId: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    const previous = lifecycleTails.get(taskId) ?? Promise.resolve();
    let release: () => void = () => {};
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.catch(() => undefined).then(() => current);
    lifecycleTails.set(taskId, tail);
    await previous.catch(() => undefined);
    try {
      return await operation();
    } finally {
      release();
      if (lifecycleTails.get(taskId) === tail) lifecycleTails.delete(taskId);
    }
  }

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

  async function recordUnexpectedFailure(
    task: ScheduledTask,
    cause: unknown,
  ): Promise<void> {
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
      dependencies.error(
        `Could not record failure for scheduled task ${task.id}.`,
        recordError,
      );
    }
  }

  function dispatch(
    taskId: string,
    options: { automatic: boolean },
  ): Promise<ScheduledRun> {
    if (runningTasks.has(taskId)) {
      throw new Error("This scheduled task is already running.");
    }
    let resolveWorkspaceReady: () => void = () => {};
    let workspaceResolved = false;
    const state: RunningTask = {
      cancelRequested: false,
      promise: Promise.resolve(undefined as never),
      workspaceReady: new Promise<void>((resolve) => {
        resolveWorkspaceReady = resolve;
      }),
    };
    const operation = (async () => {
      try {
        const task = await store.get(taskId);
        if (!task) throw new Error(`Scheduled task ${taskId} not found.`);
        state.workspaceId = task.workspaceId;
        workspaceResolved = true;
        resolveWorkspaceReady();
        if (task.workspaceId && blockedWorkspaces.has(task.workspaceId)) {
          throw new Error(
            "This scheduled task's workspace is changing or unavailable.",
          );
        }
        if (
          options.automatic &&
          (!started || !globallyEnabled || !task.enabled)
        ) {
          throw new Error("This scheduled task is paused.");
        }
        const claimed = options.automatic ? await advanceBeforeRun(task) : task;
        if (state.cancelRequested)
          throw new Error("This scheduled task was cancelled.");
        return execution.run(claimed);
      } finally {
        if (!workspaceResolved) {
          workspaceResolved = true;
          resolveWorkspaceReady();
        }
      }
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

  async function cancelWorkspaceAndSettle(workspaceId: string): Promise<void> {
    const snapshot = [...runningTasks.entries()];
    await Promise.all(snapshot.map(([, state]) => state.workspaceReady));
    const selected = snapshot.filter(
      ([, state]) => state.workspaceId === workspaceId,
    );
    for (const [taskId, state] of selected) {
      state.cancelRequested = true;
      execution.cancel(taskId);
    }
    await Promise.allSettled(selected.map(([, state]) => state.promise));
  }

  async function schedule(task: ScheduledTask): Promise<void> {
    stopJob(task.id);
    if (
      !started ||
      !globallyEnabled ||
      !task.enabled ||
      (task.workspaceId !== undefined &&
        blockedWorkspaces.has(task.workspaceId))
    ) {
      return;
    }
    const job = new Cron(
      task.cron,
      {
        name: `scheduled:${task.id}`,
        paused: true,
        timezone: task.timezone,
        mode: "5-or-6-parts",
        protect: () => {
          dependencies.warn(
            `Skipped overlapping cron callback for task ${task.id}.`,
          );
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
    if (jobs.get(task.id) !== job || !started || !globallyEnabled) {
      job.stop();
      return;
    }
    job.resume();
  }

  async function rescheduleAll(): Promise<void> {
    for (const job of jobs.values()) job.stop();
    jobs.clear();
    if (!started || !globallyEnabled) return;
    for (const task of await store.list()) {
      if (!task.enabled) continue;
      await withTaskLifecycle(task.id, async () => {
        const latest = await store.get(task.id);
        if (latest?.enabled) await schedule(latest);
      });
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
          let latest: ScheduledTask | undefined;
          latest = await withTaskLifecycle(task.id, async () => {
            try {
              const current = await store.get(task.id);
              if (!current?.enabled) return undefined;
              await schedule(current);
              return current;
            } catch (error) {
              stopJob(task.id);
              const message =
                error instanceof Error ? error.message : String(error);
              dependencies.error(
                `Could not schedule task ${task.id}; it was disabled.`,
                error,
              );
              await store.updateRuntime(task.id, {
                enabled: false,
                nextRunAt: undefined,
                lastResult: "error",
                lastError: `Needs attention: ${message}`,
              });
              return undefined;
            }
          });
          if (!latest) continue;
          const missed =
            latest.nextRunAt !== undefined && latest.nextRunAt < now;
          if (missed) {
            void dispatch(latest.id, { automatic: true }).catch((error) =>
              recordUnexpectedFailure(latest, error),
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
      started = false;
      for (const job of jobs.values()) job.stop();
      jobs.clear();
      for (const state of runningTasks.values()) state.cancelRequested = true;
      execution.cancelAll();
    },

    async stopAndSettle(): Promise<void> {
      this.stop();
      let timer: ReturnType<typeof setTimeout> | undefined;
      const settled = cancelAndSettle();
      await Promise.race([
        settled,
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, 5_000);
          timer.unref?.();
        }),
      ]);
      if (timer) clearTimeout(timer);
      if (runningTasks.size > 0) {
        dependencies.warn(
          `Timed out waiting for ${runningTasks.size} scheduled task run(s) during shutdown.`,
        );
      }
    },

    async save(
      input: ScheduledTaskInput,
      options: { expectedUpdatedAt?: number; signal?: AbortSignal } = {},
    ): Promise<ScheduledTask> {
      if (options.expectedUpdatedAt !== undefined && !input.id) {
        throw new Error(
          "An expected task revision requires an existing task ID.",
        );
      }
      const perform = async () => {
        if (options.signal?.aborted)
          throw new Error("Scheduled task save was cancelled.");
        const rescheduleCurrent = async () => {
          if (!input.id) return;
          const current = await store.get(input.id);
          if (current) await schedule(current);
        };
        if (input.id) {
          stopJob(input.id);
          await cancelAndSettle(input.id);
          if (options.signal?.aborted) {
            await rescheduleCurrent();
            throw new Error("Scheduled task save was cancelled.");
          }
        }
        let saved: Awaited<ReturnType<ScheduleStore["saveWithRollback"]>>;
        try {
          saved = await store.saveWithRollback(
            input,
            () => !options.signal?.aborted,
            options.expectedUpdatedAt,
          );
        } catch (error) {
          await rescheduleCurrent();
          throw error;
        }
        const task = saved.task;
        const rollbackCancellation = async (expectedUpdatedAt: number) => {
          stopJob(task.id);
          await saved.rollback(expectedUpdatedAt);
          await rescheduleCurrent();
          throw new Error("Scheduled task save was cancelled.");
        };
        if (options.signal?.aborted) {
          return rollbackCancellation(task.updatedAt);
        }
        await schedule(task);
        const latest = (await store.get(task.id)) ?? task;
        if (options.signal?.aborted) {
          return rollbackCancellation(latest.updatedAt);
        }
        dependencies.broadcast({ taskId: task.id });
        return latest;
      };
      return input.id ? withTaskLifecycle(input.id, perform) : perform();
    },

    async remove(
      id: string,
      options: { signal?: AbortSignal } = {},
    ): Promise<void> {
      await withTaskLifecycle(id, async () => {
        const current = await store.get(id);
        throwIfAborted(options.signal, "removal");
        stopJob(id);
        await cancelAndSettle(id);
        if (options.signal?.aborted) {
          if (current?.enabled) await schedule(current);
          throwIfAborted(options.signal, "removal");
        }
        await store.remove(id);
        dependencies.broadcast({ taskId: id, removed: true });
      });
    },

    async pause(
      id: string,
      options: { signal?: AbortSignal } = {},
    ): Promise<ScheduledTask> {
      return withTaskLifecycle(id, async () => {
        const current = await store.get(id);
        throwIfAborted(options.signal, "pause");
        stopJob(id);
        await cancelAndSettle(id);
        if (options.signal?.aborted) {
          if (current?.enabled) await schedule(current);
          throwIfAborted(options.signal, "pause");
        }
        const task = await store.setEnabled(id, false);
        if (options.signal?.aborted) {
          const restored = await store.setEnabled(id, true);
          await schedule(restored);
          throwIfAborted(options.signal, "pause");
        }
        dependencies.broadcast({ taskId: id });
        return task;
      });
    },

    async resume(
      id: string,
      options: { signal?: AbortSignal } = {},
    ): Promise<ScheduledTask> {
      return withTaskLifecycle(id, async () => {
        throwIfAborted(options.signal, "resume");
        const task = await store.setEnabled(id, true);
        if (options.signal?.aborted) {
          await store.setEnabled(id, false);
          throwIfAborted(options.signal, "resume");
        }
        await schedule(task);
        if (options.signal?.aborted) {
          stopJob(id);
          await store.setEnabled(id, false);
          throwIfAborted(options.signal, "resume");
        }
        dependencies.broadcast({ taskId: id });
        return (await store.get(id)) ?? task;
      });
    },

    runNow(
      id: string,
      options: { signal?: AbortSignal } = {},
    ): Promise<ScheduledRun> {
      throwIfAborted(options.signal, "run");
      const operation = dispatch(id, { automatic: false });
      if (!options.signal) return operation;
      const cancel = () => {
        const state = runningTasks.get(id);
        if (state) state.cancelRequested = true;
        execution.cancel(id);
      };
      options.signal.addEventListener("abort", cancel, { once: true });
      return operation.finally(() =>
        options.signal?.removeEventListener("abort", cancel),
      );
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

    cancelWorkspace(workspaceId: string): Promise<void> {
      blockedWorkspaces.add(workspaceId);
      return (async () => {
        for (const task of await store.list()) {
          if (task.workspaceId === workspaceId) stopJob(task.id);
        }
        await cancelWorkspaceAndSettle(workspaceId);
      })();
    },

    async resumeWorkspace(workspaceId: string): Promise<void> {
      blockedWorkspaces.delete(workspaceId);
      if (!started || !globallyEnabled) return;
      for (const task of await store.list()) {
        if (task.workspaceId !== workspaceId || !task.enabled) continue;
        await withTaskLifecycle(task.id, async () => {
          const latest = await store.get(task.id);
          if (latest?.enabled && latest.workspaceId === workspaceId)
            await schedule(latest);
        });
      }
    },
  };
}
