import { Cron } from "croner";
import { nextScheduledRun, type ScheduleStore } from "./schedule-store-core.js";
import type {
  ScheduledRun,
  ScheduledTask,
  ScheduledTaskInput,
} from "./types.js";

/**
 * What started a run. An automatic run carries the exact scheduled fire time it
 * claimed, so downstream submissions can derive a stable idempotency key
 * (`routine:<taskId>:<fireTime>`); a manual run carries its own unique key.
 * A catch-up re-runs one fire a paused Bot skipped: it names that skipped
 * run, so repeating the catch-up reuses the same idempotency key.
 */
export type ScheduledRunTrigger =
  | { kind: "automatic"; fireTime: number }
  | { kind: "manual"; key: string }
  | { kind: "catch_up"; missedRunId: string; missedAt: number };

interface ScheduleExecutionLike {
  run(task: ScheduledTask, runId?: string, trigger?: ScheduledRunTrigger): Promise<ScheduledRun>;
  cancel(taskId: string): boolean;
  cancelAll(): void;
}

interface RunningTask {
  promise: Promise<ScheduledRun>;
  cancelRequested: boolean;
  automatic: boolean;
  executionStarted: boolean;
  isCurrent(): boolean;
  workspaceId?: string;
  workspaceReady: Promise<void>;
}

type DispatchOptions = { runId?: string; expectedUpdatedAt?: number } & (
  /** `missedAt`: the overdue fire a startup catch-up claims, captured when it was queued. */
  | { automatic: true; isCurrent: () => boolean; missedAt?: number; recovery?: boolean }
  | { automatic: false; catchUp?: Extract<ScheduledRunTrigger, { kind: "catch_up" }> }
);

type DispatchResult =
  | { kind: "skipped"; reason: "already-running" }
  | { kind: "dispatched"; completion: Promise<ScheduledRun> };

/**
 * An automatic dispatch with no fire left to claim: its missed fire was
 * already claimed by the Cron, or its fire time has not arrived yet. Running
 * it would execute early under a future fire's idempotency key.
 */
class UnclaimableScheduledFire extends Error {}

const ignoreUnclaimableFire = (error: unknown): void => {
  if (!(error instanceof UnclaimableScheduledFire)) throw error;
};

export interface CatchUpQueueOptions {
  /** Missed runs allowed to execute at once. */
  concurrency?: number;
  /** Minimum spacing between catch-up starts. */
  staggerMs?: number;
  /** True while catch-up should wait, for example while the screen is locked. */
  shouldDefer?: () => boolean;
}

export const CATCH_UP_CONCURRENCY = 2;
export const CATCH_UP_STAGGER_MS = 3_000;

/**
 * Bounded, staggered admission for missed scheduled runs, so a restart after
 * a long sleep does not start every overdue automation at once. Deferred work
 * waits for `reevaluate()`; entries that stop being current are dropped.
 */
export function createCatchUpQueue(options: CatchUpQueueOptions = {}) {
  const concurrency = Math.max(1, options.concurrency ?? CATCH_UP_CONCURRENCY);
  const staggerMs = Math.max(0, options.staggerMs ?? CATCH_UP_STAGGER_MS);
  let shouldDefer = options.shouldDefer ?? (() => false);
  const pending: Array<{ run: () => Promise<unknown> | undefined; isCurrent: () => boolean }> = [];
  let active = 0;
  let generation = 0;
  let lastStartAt = Number.NEGATIVE_INFINITY;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const deferred = () => {
    try {
      return shouldDefer();
    } catch {
      return false;
    }
  };

  function pump(): void {
    if (timer !== undefined) return;
    while (pending.length > 0 && !pending[0].isCurrent()) pending.shift();
    if (pending.length === 0 || active >= concurrency || deferred()) return;
    const wait = lastStartAt + staggerMs - Date.now();
    if (wait > 0) {
      timer = setTimeout(() => {
        timer = undefined;
        pump();
      }, wait);
      timer.unref?.();
      return;
    }
    const next = pending.shift()!;
    lastStartAt = Date.now();
    active += 1;
    const startedIn = generation;
    let completion: Promise<unknown> | undefined;
    try {
      completion = next.run();
    } catch {
      completion = undefined;
    }
    void Promise.resolve(completion)
      .catch(() => undefined)
      .finally(() => {
        if (startedIn !== generation) return;
        active -= 1;
        pump();
      });
    pump();
  }

  return {
    enqueue(run: () => Promise<unknown> | undefined, isCurrent: () => boolean): void {
      pending.push({ run, isCurrent });
      pump();
    },
    /** Retry deferred or waiting work, for example after resume or unlock. */
    reevaluate(): void {
      pump();
    },
    setDeferPolicy(policy: () => boolean): void {
      shouldDefer = policy;
      pump();
    },
    /** Drop queued work; runs already started are being cancelled and stop counting. */
    clear(): void {
      generation += 1;
      active = 0;
      lastStartAt = Number.NEGATIVE_INFINITY;
      pending.length = 0;
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
    },
    get active(): number {
      return active;
    },
    get pending(): number {
      return pending.length;
    },
  };
}

export interface ScheduleServiceDependencies {
  store: ScheduleStore;
  execution: ScheduleExecutionLike;
  globallyEnabled(): Promise<boolean>;
  broadcast(payload: Record<string, unknown>): void;
  warn(message: string): void;
  error(message: string, cause: unknown): void;
  catchUp?: CatchUpQueueOptions;
  /** Test seam for the periodic pending-fire reconciliation scan. */
  pendingRetryIntervalMs?: number;
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
  let startupRevision = 0;
  let manualRunSequence = 0;
  const catchUp = createCatchUpQueue(dependencies.catchUp);
  const pendingRecoveryQueued = new Map<string, symbol>();
  const pendingRetryAt = new Map<string, { at: number; failures: number }>();
  let pendingRetryTimer: ReturnType<typeof setInterval> | undefined;
  let pendingScanRunning = false;
  const PENDING_RETRY_INTERVAL_MS = Math.max(1, dependencies.pendingRetryIntervalMs ?? 60_000);
  const PENDING_RETRY_MAX_MS = 15 * 60_000;

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

  async function advanceBeforeRun(
    task: ScheduledTask,
    fireTime: number,
    isCurrent: () => boolean,
  ): Promise<ScheduledTask> {
    if (task.botId) {
      const nextRunAt = task.routineSchedule?.kind === "once"
        ? undefined
        : nextScheduledRun(task.cron, task.timezone, new Date(Date.now() + 1));
      return store.claimRoutineFire(task.id, fireTime, nextRunAt, isCurrent);
    }
    // A one-off routine is spent by the claim itself, so cron (which has no
    // year field) can never repeat it on the same date next year.
    if (task.routineSchedule?.kind === "once") {
      return store.updateRuntime(task.id, { enabled: false, nextRunAt: undefined }, isCurrent);
    }
    return store.updateRuntime(task.id, {
      nextRunAt: task.enabled
        ? nextScheduledRun(task.cron, task.timezone, new Date(Date.now() + 1))
        : undefined,
    }, isCurrent);
  }

  async function recordUnexpectedFailure(
    task: ScheduledTask,
    cause: unknown,
    isCurrent: () => boolean,
  ): Promise<void> {
    if (!isCurrent()) return;
    const message = cause instanceof Error ? cause.message : String(cause);
    try {
      await store.recordRun({
        taskId: task.id,
        startedAt: Date.now(),
        finishedAt: Date.now(),
        result: "error",
        output: "",
        error: message,
        chatId: task.chatId,
      }, isCurrent);
      if (!isCurrent()) return;
      dependencies.error(
        `Scheduled task ${task.id} failed outside its execution boundary.`,
        cause,
      );
      dependencies.broadcast({ taskId: task.id });
    } catch (recordError) {
      if (!isCurrent()) return;
      dependencies.error(
        `Could not record failure for scheduled task ${task.id}.`,
        recordError,
      );
    }
  }

  function dispatch(
    taskId: string,
    options: DispatchOptions,
  ): DispatchResult {
    if (options.automatic && !options.isCurrent()) {
      throw new Error("This scheduled task was cancelled.");
    }
    const previous = runningTasks.get(taskId);
    if (previous) {
      if (!previous.automatic || previous.executionStarted || previous.isCurrent()) {
        return { kind: "skipped", reason: "already-running" };
      }
      // Supersede only obsolete automatic preparation. It cannot enter execution
      // or publish its pending claim once cancelled; real runs retain their slot.
      previous.cancelRequested = true;
    }
    let resolveWorkspaceReady: () => void = () => {};
    let workspaceResolved = false;
    const state: RunningTask = {
      cancelRequested: false,
      automatic: options.automatic,
      executionStarted: false,
      isCurrent: () => !state.cancelRequested && (!options.automatic || options.isCurrent()),
      promise: Promise.resolve(undefined as never),
      workspaceReady: new Promise<void>((resolve) => {
        resolveWorkspaceReady = resolve;
      }),
    };
    const isCurrent = state.isCurrent;
    const operation = (async () => {
      try {
        const task = await store.get(taskId);
        if (!task) throw new Error(`Scheduled task ${taskId} not found.`);
        if (
          options.expectedUpdatedAt !== undefined &&
          task.updatedAt !== options.expectedUpdatedAt
        ) {
          throw new Error("This automation changed. Refresh it before trying again.");
        }
        state.workspaceId = task.workspaceId;
        workspaceResolved = true;
        resolveWorkspaceReady();
        if (task.workspaceId && blockedWorkspaces.has(task.workspaceId)) {
          throw new Error(
            "This scheduled task's workspace is changing or unavailable.",
          );
        }
        // A one-time Bot routine is disabled as soon as its fire is claimed.
        // Its recorded paused skip may still be caught up after the person
        // resumes the Bot, but only for that exact, most recent fire.
        let spentOnceCatchUp = false;
        if (
          !options.automatic && options.catchUp !== undefined &&
          !task.enabled && task.routineSchedule?.kind === "once"
        ) {
          const [latest] = await store.runs(task.id);
          spentOnceCatchUp =
            latest?.id === options.catchUp.missedRunId &&
            latest.result === "skipped" && latest.reason === "bot_paused";
        }
        if (
          (options.automatic || options.catchUp !== undefined) &&
          (!started || !globallyEnabled || (!task.enabled && !spentOnceCatchUp && !options.automatic))
        ) {
          throw new Error("This scheduled task is paused.");
        }
        if (options.automatic && !options.recovery && !task.enabled)
          throw new Error("This scheduled task is paused.");
        if (!isCurrent())
          throw new Error("This scheduled task was cancelled.");
        const fireTime = options.automatic
          ? options.missedAt ?? task.nextRunAt ?? Date.now()
          : undefined;
        const missedFireClaimed =
          options.automatic && !options.recovery && options.missedAt !== undefined && task.nextRunAt !== options.missedAt;
        if (missedFireClaimed || (fireTime !== undefined && fireTime > Date.now())) {
          throw new UnclaimableScheduledFire(`Scheduled task ${taskId} has no due fire to claim.`);
        }
        const pendingFire = options.automatic && options.recovery
          ? task.pendingRoutineFires?.find((fire) => fire.fireTime === fireTime)
          : undefined;
        if (options.automatic && options.recovery && !pendingFire)
          throw new UnclaimableScheduledFire(`Routine ${taskId} has no pending fire to recover.`);
        const claimed = options.automatic && !options.recovery
          ? await advanceBeforeRun(task, fireTime!, isCurrent)
          : task;
        if (!isCurrent())
          throw new Error("This scheduled task was cancelled.");
        if (options.automatic && !claimed.enabled) {
          stopJob(task.id);
          dependencies.broadcast({ taskId: task.id });
        }
        state.executionStarted = true;
        const trigger: ScheduledRunTrigger = options.automatic
          ? { kind: "automatic", fireTime: fireTime! }
          : options.catchUp ?? { kind: "manual", key: options.runId ?? `${Date.now()}-${++manualRunSequence}` };
        const executionTask = pendingFire
          ? { ...claimed, prompt: pendingFire.prompt, name: pendingFire.name }
          : claimed;
        return execution.run(executionTask, pendingFire?.requestId ?? options.runId, trigger);
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
    return { kind: "dispatched", completion: state.promise };
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
      if (runningTasks.get(taskId) === state) execution.cancel(taskId);
    }
    await Promise.allSettled(selected.map(([, state]) => state.promise));
  }

  async function schedule(
    task: ScheduledTask,
    isCurrent: () => boolean = () => true,
    preserveNextRunAt = false,
  ): Promise<void> {
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
        catch: async (error) => {
          if (!ownsJob()) return;
          try {
            const latest = await store.get(task.id);
            if (latest) await recordUnexpectedFailure(latest, error, ownsJob);
          } catch (readError) {
            if (ownsJob()) {
              dependencies.error(`Could not read failed scheduled task ${task.id}.`, readError);
            }
          }
        },
      },
      async () => {
        const result = dispatch(task.id, { automatic: true, isCurrent: ownsJob });
        if (result.kind === "dispatched") await result.completion.catch(ignoreUnclaimableFire);
      },
    );
    const ownsJob = () =>
      isCurrent() && started && globallyEnabled && jobs.get(task.id) === job;
    jobs.set(task.id, job);
    const nextRunAt = job.nextRun()?.getTime();
    // An overdue startup task stays due until dispatch publishes its claim.
    if (!preserveNextRunAt) await store.updateRuntime(task.id, { nextRunAt }, isCurrent);
    if (!ownsJob()) {
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

  async function recoverPendingTask(taskId: string, isCurrent: () => boolean): Promise<void> {
    const task = await store.get(taskId);
    if (!task?.pendingRoutineFires?.length) return;
    for (const fire of task.pendingRoutineFires) {
      while (isCurrent()) {
        const result = dispatch(taskId, {
          automatic: true, isCurrent, missedAt: fire.fireTime, recovery: true,
        });
        if (result.kind === "skipped") {
          await runningTasks.get(taskId)?.promise.catch(() => undefined);
          continue;
        }
        await result.completion.catch((error) =>
          error instanceof UnclaimableScheduledFire
            ? undefined
            : recordUnexpectedFailure(task, error, isCurrent));
        break;
      }
    }
  }

  function queuePendingRecovery(
    taskId: string,
    isCurrent: () => boolean,
    after?: () => Promise<void>,
  ): void {
    if (pendingRecoveryQueued.has(taskId)) return;
    const recoveryToken = Symbol(taskId);
    pendingRecoveryQueued.set(taskId, recoveryToken);
    catchUp.enqueue(async () => {
      try {
        await recoverPendingTask(taskId, isCurrent);
        if (isCurrent()) await after?.();
      } catch (error) {
        if (isCurrent()) dependencies.error(`Could not reconcile routine ${taskId}.`, error);
      } finally {
        if (pendingRecoveryQueued.get(taskId) === recoveryToken) pendingRecoveryQueued.delete(taskId);
        if (isCurrent()) {
          try {
            const remaining = (await store.get(taskId))?.pendingRoutineFires?.length ?? 0;
            if (!remaining) pendingRetryAt.delete(taskId);
            else {
              const failures = Math.min((pendingRetryAt.get(taskId)?.failures ?? 0) + 1, 4);
              pendingRetryAt.set(taskId, {
                at: Date.now() + Math.min(PENDING_RETRY_INTERVAL_MS * 2 ** (failures - 1), PENDING_RETRY_MAX_MS),
                failures,
              });
            }
          } catch (error) {
            dependencies.error(`Could not read pending routine ${taskId}.`, error);
          }
        }
      }
    }, isCurrent);
  }

  async function scanPendingRoutines(): Promise<void> {
    if (pendingScanRunning || !started || !globallyEnabled) return;
    pendingScanRunning = true;
    const revision = startupRevision;
    const isCurrent = () => started && globallyEnabled && startupRevision === revision;
    try {
      for (const task of await store.list()) {
        if (!isCurrent()) break;
        if (!task.pendingRoutineFires?.length || pendingRecoveryQueued.has(task.id)) continue;
        if (Date.now() < (pendingRetryAt.get(task.id)?.at ?? 0)) continue;
        queuePendingRecovery(task.id, isCurrent);
      }
    } catch (error) {
      if (isCurrent()) dependencies.error("Could not scan pending Bot routines.", error);
    } finally {
      pendingScanRunning = false;
    }
  }

  function startPendingRetryTimer(): void {
    if (pendingRetryTimer) return;
    pendingRetryTimer = setInterval(() => void scanPendingRoutines(), PENDING_RETRY_INTERVAL_MS);
    pendingRetryTimer.unref?.();
  }

  function stopPendingRetryTimer(): void {
    if (pendingRetryTimer) clearInterval(pendingRetryTimer);
    pendingRetryTimer = undefined;
    pendingRecoveryQueued.clear();
    pendingRetryAt.clear();
  }

  return {
    async start(): Promise<void> {
      if (started) return;
      started = true;
      const revision = ++startupRevision;
      const isCurrent = () => started && startupRevision === revision;
      try {
        const enabled = await dependencies.globallyEnabled();
        if (!isCurrent()) return;
        globallyEnabled = enabled;
        if (!globallyEnabled) return;
        startPendingRetryTimer();
        const now = Date.now();
        const tasks = await store.list();
        if (!isCurrent()) return;
        for (const task of tasks) {
          if (!task.enabled && !task.pendingRoutineFires?.length) continue;
          let latest: ScheduledTask | undefined;
          latest = await withTaskLifecycle(task.id, async () => {
            if (!isCurrent()) return undefined;
            try {
              // A restart must not lose its catch-up to the cancelled predecessor
              // still occupying runningTasks while its persistence settles.
              if (runningTasks.get(task.id)?.cancelRequested) await cancelAndSettle(task.id);
              if (!isCurrent()) return undefined;
              const current = await store.get(task.id);
              if (!isCurrent() || !current || (!current.enabled && !current.pendingRoutineFires?.length)) return undefined;
              const missed = current.nextRunAt !== undefined && current.nextRunAt < now;
              await schedule(current, isCurrent, missed);
              return current;
            } catch (error) {
              if (!isCurrent()) return undefined;
              stopJob(task.id);
              const message =
                error instanceof Error ? error.message : String(error);
              await store.updateRuntime(task.id, {
                enabled: false,
                nextRunAt: undefined,
                lastResult: "error",
                lastError: `Needs attention: ${message}`,
              }, isCurrent);
              if (!isCurrent()) return undefined;
              dependencies.error(
                `Could not schedule task ${task.id}; it was disabled.`,
                error,
              );
              return undefined;
            }
          });
          if (!isCurrent()) return;
          if (!latest) continue;
          if (latest.pendingRoutineFires?.length) {
            queuePendingRecovery(latest.id, isCurrent, async () => {
              const current = await store.get(latest.id);
              if (!isCurrent() || !current?.enabled || current.nextRunAt === undefined || current.nextRunAt >= Date.now()) return;
              const job = jobs.get(latest.id);
              if (!job) return;
              const result = dispatch(latest.id, {
                automatic: true, isCurrent: () => isCurrent() && jobs.get(latest.id) === job,
                missedAt: current.nextRunAt,
              });
              if (result.kind === "dispatched") await result.completion.catch(ignoreUnclaimableFire);
            });
            continue;
          }
          const missed =
            latest.nextRunAt !== undefined && latest.nextRunAt < now;
          if (missed) {
            const job = jobs.get(latest.id);
            if (!job) continue;
            const ownsCatchup = () => isCurrent() && jobs.get(latest.id) === job;
            // Claim exactly the fire that was missed: if the Cron claims it first
            // while this entry waits (deferred or staggered), there is nothing to run.
            const missedAt = latest.nextRunAt;
            catchUp.enqueue(() => {
              const result = dispatch(latest.id, { automatic: true, isCurrent: ownsCatchup, missedAt });
              if (result.kind !== "dispatched") return undefined;
              return result.completion.catch((error) =>
                error instanceof UnclaimableScheduledFire
                  ? undefined
                  : recordUnexpectedFailure(latest, error, ownsCatchup),
              );
            }, ownsCatchup);
          }
        }
      } catch (error) {
        if (!isCurrent()) return;
        started = false;
        stopPendingRetryTimer();
        for (const job of jobs.values()) job.stop();
        jobs.clear();
        throw error;
      }
    },

    stop(): void {
      startupRevision += 1;
      started = false;
      stopPendingRetryTimer();
      catchUp.clear();
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
      options: { signal?: AbortSignal; expectedUpdatedAt?: number } = {},
    ): Promise<void> {
      await withTaskLifecycle(id, async () => {
        const current = await store.get(id);
        if (options.expectedUpdatedAt !== undefined && current?.updatedAt !== options.expectedUpdatedAt) {
          throw new Error("This automation changed. Refresh it before trying again.");
        }
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
      options: { signal?: AbortSignal; expectedUpdatedAt?: number } = {},
    ): Promise<ScheduledTask> {
      return withTaskLifecycle(id, async () => {
        const current = await store.get(id);
        if (options.expectedUpdatedAt !== undefined && current?.updatedAt !== options.expectedUpdatedAt) {
          throw new Error("This automation changed. Refresh it before trying again.");
        }
        throwIfAborted(options.signal, "pause");
        stopJob(id);
        await cancelAndSettle(id);
        if (options.signal?.aborted) {
          if (current?.enabled) await schedule(current);
          throwIfAborted(options.signal, "pause");
        }
        const task = await store.setEnabled(id, false);
        if (options.signal?.aborted) {
          if (current) {
            const restored = await store.setEnabled(id, current.enabled);
            if (current.enabled) await schedule(restored);
            else stopJob(id);
          }
          throwIfAborted(options.signal, "pause");
        }
        dependencies.broadcast({ taskId: id });
        return task;
      });
    },

    async resume(
      id: string,
      options: { signal?: AbortSignal; expectedUpdatedAt?: number } = {},
    ): Promise<ScheduledTask> {
      return withTaskLifecycle(id, async () => {
        const current = await store.get(id);
        if (options.expectedUpdatedAt !== undefined && current?.updatedAt !== options.expectedUpdatedAt) {
          throw new Error("This automation changed. Refresh it before trying again.");
        }
        throwIfAborted(options.signal, "resume");
        const task = await store.setEnabled(id, true);
        const restore = async () => {
          if (!current) return;
          const restored = await store.setEnabled(id, current.enabled);
          if (current.enabled) await schedule(restored);
          else stopJob(id);
        };
        if (options.signal?.aborted) {
          await restore();
          throwIfAborted(options.signal, "resume");
        }
        await schedule(task);
        if (options.signal?.aborted) {
          stopJob(id);
          await restore();
          throwIfAborted(options.signal, "resume");
        }
        dependencies.broadcast({ taskId: id });
        return (await store.get(id)) ?? task;
      });
    },

    runNow(
      id: string,
      options: { signal?: AbortSignal; runId?: string; expectedUpdatedAt?: number } = {},
    ): Promise<ScheduledRun> {
      throwIfAborted(options.signal, "run");
      const result = dispatch(id, {
        automatic: false,
        runId: options.runId,
        expectedUpdatedAt: options.expectedUpdatedAt,
      });
      if (result.kind === "skipped") throw new Error("This scheduled task is already running.");
      const operation = result.completion;
      if (!options.signal) return operation;
      const state = runningTasks.get(id);
      const cancel = () => {
        if (runningTasks.get(id) !== state) return;
        if (state) state.cancelRequested = true;
        execution.cancel(id);
      };
      options.signal.addEventListener("abort", cancel, { once: true });
      return operation.finally(() =>
        options.signal?.removeEventListener("abort", cancel),
      );
    },

    /**
     * Run one missed fire again (a Bot routine skipped while its Bot was
     * paused). Unlike `runNow` it honours the same gates as an automatic run
     * (scheduler started, globally enabled, task enabled, or a spent one-time
     * routine with this exact paused fire) and never advances the schedule.
     * `undefined` when the task is already running.
     */
    catchUp(
      id: string,
      missed: { runId: string; at: number },
    ): Promise<ScheduledRun> | undefined {
      const result = dispatch(id, {
        automatic: false,
        catchUp: { kind: "catch_up", missedRunId: missed.runId, missedAt: missed.at },
      });
      return result.kind === "dispatched" ? result.completion : undefined;
    },

    async setGlobalEnabled(enabled: boolean): Promise<void> {
      // Explicit settings changes own scheduling from this point onward;
      // pending startup reads must not restore old settings or dispatch catch-up.
      startupRevision += 1;
      globallyEnabled = enabled;
      if (!enabled) {
        stopPendingRetryTimer();
        for (const job of jobs.values()) job.stop();
        jobs.clear();
        await cancelAndSettle();
      } else {
        await rescheduleAll();
        startPendingRetryTimer();
        void scanPendingRoutines();
      }
      dependencies.broadcast({ globallyEnabled: enabled });
    },

    /** Re-check deferred catch-up, for example after resume or unlock. */
    reevaluateCatchUp(): void {
      catchUp.reevaluate();
    },

    setCatchUpDeferPolicy(policy: () => boolean): void {
      catchUp.setDeferPolicy(policy);
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
