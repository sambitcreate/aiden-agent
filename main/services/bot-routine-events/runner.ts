// Runs one accepted event through the routine executor and says whether the
// event is settled. Stopping event routines aborts every run in flight: the
// executor records a cancelled event run as uncertain (under a fresh id), so
// the event keeps its receipt and is replayed on the next start.

import { randomUUID } from "node:crypto";
import { botRoutineRequestId, type BotRoutineExecutor, type BotRoutineExecutorDependencies } from "../scheduled-bot-routines.js";
import type { ScheduledRun, ScheduledTask } from "../types.js";
import type { BotRoutineTriggerKind } from "../../../renderer/shared/bot-routine-trigger.js";
import type { BotEventRoutine } from "./store.js";

/** An event routine as the executor's task: read-only, notify, never scheduled by cron. */
export function eventRoutineTask(routine: BotEventRoutine): ScheduledTask {
  return {
    id: routine.id,
    name: routine.name,
    enabled: routine.enabled,
    mode: "llm",
    cron: "",
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    prompt: routine.prompt,
    permission: "read-only",
    notify: true,
    botId: routine.botId,
    createdAt: routine.createdAt,
    updatedAt: routine.updatedAt,
  } as ScheduledTask;
}

type RunStore = BotRoutineExecutorDependencies["store"];

/**
 * The executor's run store for event routines. An event routine is not a
 * scheduled task, so the schedule store saves its run and then fails to
 * update a task summary that doesn't exist; the saved run is the record, so
 * it is returned instead of the error. A real failure to save still throws.
 */
export function eventRoutineRunStore(store: RunStore): RunStore {
  return {
    runById: (taskId, runId) => store.runById(taskId, runId),
    get: (taskId) => store.get(taskId),
    settleRoutineFire: (taskId, requestId) => store.settleRoutineFire(taskId, requestId),
    recordRun: async (run: Omit<ScheduledRun, "id"> & { id?: string }) => {
      const id = run.id ?? randomUUID();
      try {
        return await store.recordRun({ ...run, id });
      } catch (error) {
        const saved = await store.runById(run.taskId, id).catch(() => undefined);
        if (saved && !(await store.get(run.taskId).catch(() => undefined))) return saved;
        throw error;
      }
    },
  };
}

export interface BotEventRunnerDependencies {
  executor: Pick<BotRoutineExecutor, "run">;
  /** True while the run's result hasn't reached the delivery log: its receipt stays. */
  undelivered(requestId: string): boolean;
  /** A routine's run starts and ends (several may overlap), for the folder watch. */
  runStarted?(routine: BotEventRoutine): void;
  runEnded?(routine: BotEventRoutine): void;
}

export function createBotEventRunner(dependencies: BotEventRunnerDependencies) {
  const inFlight = new Set<AbortController>();
  return {
    async run(routine: BotEventRoutine, event: { eventId: string; source: BotRoutineTriggerKind; payload: string }): Promise<{ settled: boolean }> {
      const trigger = { kind: "event" as const, eventId: event.eventId, source: event.source, payload: event.payload };
      // The event's own request id as the run id: a replay after a restart
      // reads the recorded run or the admitted turn instead of sending again.
      const requestId = botRoutineRequestId(routine.id, trigger);
      const controller = new AbortController();
      inFlight.add(controller);
      dependencies.runStarted?.(routine);
      try {
        const run = await dependencies.executor.run(eventRoutineTask(routine), {
          trigger,
          runId: requestId,
          signal: controller.signal,
        });
        // Only a run recorded under the event's own id, and handed to the
        // delivery log, is settled; anything else is replayed on next start
        // (the replay reads the saved run and only retries its delivery).
        return { settled: run.id === requestId && !dependencies.undelivered(requestId) };
      } finally {
        inFlight.delete(controller);
        dependencies.runEnded?.(routine);
      }
    },
    /** Cancels every run in flight; the dispatcher's `idle()` resolves once each is recorded. */
    abortAll(): void {
      for (const controller of inFlight) controller.abort();
      inFlight.clear();
    },
  };
}
