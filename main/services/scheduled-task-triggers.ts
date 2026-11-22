// Chat tasks that run when something happens (docs/scheduled-task-triggers.md).
//
// A watch checks an address or a project script every N minutes on the
// shared event core (bot-routine-events/watch.ts and dispatcher.ts); the
// check itself never runs a model. A change becomes one event, and the event
// runs the task through the schedule service, which lands it through C4's
// `deliverTaskRunToChat` with what happened fenced as data.
//
// Limits per task: one run every 5 minutes and 48 a day; across every task,
// at most 4 trigger runs at once. Accepted events whose run wasn't recorded
// are replayed after a restart. Triggers never hold the computer awake.

import { promises as fs } from "node:fs";
import path from "node:path";
import { BOT_WATCH_LIMITS } from "../../renderer/shared/bot-routine-trigger.js";
import { SCHEDULED_TASK_TRIGGER_LIMITS } from "../../renderer/shared/scheduled-task-trigger.js";
import { createEventRoutineDispatcher } from "./bot-routine-events/dispatcher.js";
import { createEventWatches } from "./bot-routine-events/watch.js";
import type { BotWatchCheck } from "./bot-routine-events/watch-sources.js";
import type { ScriptProcessResult } from "./schedule-script.js";
import type { ScheduledRunTrigger } from "./schedule-service-core.js";
import type { ScheduledTaskTriggerStore, TaskTriggerRoutine } from "./scheduled-task-triggers-store.js";
import type { ScheduledRun, ScheduledTask } from "./types.js";

type EventTrigger = Extract<ScheduledRunTrigger, { kind: "event" }>;

export interface ScheduledTaskTriggersDependencies {
  store: ScheduledTaskTriggerStore;
  /** Scheduled tasks are started and switched on. */
  isActive(): boolean;
  /** Runs the task for one event; resolves with the recorded run. */
  runEvent(taskId: string, event: EventTrigger, runId: string): Promise<ScheduledRun>;
  /** The run recorded under this id, if any (a replayed event that already ran). */
  findRun(taskId: string, runId: string): Promise<ScheduledRun | undefined>;
  fetchUrl(url: string, signal: AbortSignal): Promise<BotWatchCheck>;
  /** The script's path and the folder it runs in (the task's project), or why it can't run. */
  resolveScript(task: ScheduledTask, script: string): Promise<{ path: string; cwd: string }>;
  /** Runs a script check (runScheduledScript in production). */
  execScript(scriptPath: string, options: {
    cwd: string; timeoutMs: number; outputLimit: number; signal: AbortSignal; env: Readonly<Record<string, string>>;
  }): Promise<ScriptProcessResult>;
  /** The folder each task's private check state file lives in. */
  checkStateDir(): Promise<string>;
  /** Three failed checks turned the trigger off: one card in the task's landing chat. */
  paused(task: ScheduledTask, error: string): Promise<void>;
  /** A check's result was saved, so the task's row may show something new. */
  changed?(taskId: string): void;
  now(): number;
  timeZone(): string;
  setTimer(fn: () => void, ms: number): { cancel(): void };
  onError?(error: unknown): void;
}

/** What a script check's process result means for the watch. */
export function scriptCheckResult(script: string, result: ScriptProcessResult): BotWatchCheck {
  const failed = (error: string): BotWatchCheck => ({ ok: false, error });
  if (result.aborted) return failed(`${script} was stopped.`);
  if (result.timedOut) return failed(`${script} ran longer than 60 seconds.`);
  if (result.outputLimitExceeded) return failed(`${script} printed more than 1 MB.`);
  if (result.exitCode !== 0) {
    return failed(result.exitCode === null ? `${script} was stopped by ${result.signal ?? "a signal"}.` : `${script} exited with code ${result.exitCode}.`);
  }
  return { ok: true, bytes: new TextEncoder().encode(result.stdout) };
}

/** A queue of at most `size` holders; waiting callers go in arrival order. */
function createSlots(size: number) {
  let busy = 0;
  const waiting: Array<() => void> = [];
  return {
    async take(): Promise<() => void> {
      if (busy >= size) await new Promise<void>((resolve) => waiting.push(resolve));
      else busy += 1;
      let released = false;
      return () => {
        if (released) return;
        released = true;
        const next = waiting.shift();
        if (next) next();
        else busy -= 1;
      };
    },
  };
}

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

export function createScheduledTaskTriggers(deps: ScheduledTaskTriggersDependencies) {
  const slots = createSlots(SCHEDULED_TASK_TRIGGER_LIMITS.runningOverall);
  let stopped = true;

  async function runOnce(routine: TaskTriggerRoutine, event: { eventId: string; payload: string }): Promise<{ settled: boolean }> {
    const release = await slots.take();
    try {
      if (stopped) return { settled: false };
      const runId = `event:${routine.id}:${event.eventId}`;
      const recorded = await deps.findRun(routine.id, runId);
      if (recorded && recorded.result !== "blocked") return { settled: true };
      try {
        await deps.runEvent(routine.id, { kind: "event", eventId: event.eventId, source: "watch", payload: event.payload }, runId);
        // A run cut short by Aiden stopping runs again at the next start.
        return { settled: !stopped };
      } catch (error) {
        if (stopped) return { settled: false };
        // The task was paused, turned off or lost its trigger: the event is dropped.
        deps.onError?.(error);
        return { settled: true };
      }
    } finally {
      release();
    }
  }

  const dispatcher = createEventRoutineDispatcher<TaskTriggerRoutine>({
    ownerKey: (routine) => routine.id,
    store: deps.store,
    run: (routine, event) => runOnce(routine, event),
    isPaused: async () => !deps.isActive(),
    limits: () => ({ minGapMs: SCHEDULED_TASK_TRIGGER_LIMITS.minGapMs, perDay: SCHEDULED_TASK_TRIGGER_LIMITS.perDay }),
    now: deps.now,
    timeZone: deps.timeZone,
    setTimer: deps.setTimer,
    onError: deps.onError,
  });

  async function checkState(taskId: string): Promise<string> {
    const dir = await deps.checkStateDir();
    await fs.mkdir(dir, { recursive: true, mode: 0o700 });
    const file = path.join(dir, `${taskId.replace(/[^A-Za-z0-9_-]/gu, "_")}.state`);
    const handle = await fs.open(file, "a", 0o600);
    await handle.close();
    return file;
  }

  /** Keeps a script's state file within 8 KB, keeping the start. */
  async function capState(file: string): Promise<void> {
    const stat = await fs.stat(file).catch(() => undefined);
    if (stat && stat.size > SCHEDULED_TASK_TRIGGER_LIMITS.checkStateBytes) {
      await fs.truncate(file, SCHEDULED_TASK_TRIGGER_LIMITS.checkStateBytes);
    }
  }

  async function check(routine: TaskTriggerRoutine, signal: AbortSignal): Promise<BotWatchCheck> {
    const source = routine.task.trigger.source;
    if (source.type === "url") return deps.fetchUrl(source.url, signal);
    let resolved: { path: string; cwd: string };
    try {
      resolved = await deps.resolveScript(routine.task, source.script);
    } catch (error) {
      return { ok: false, error: errorText(error).slice(0, 200) };
    }
    const state = await checkState(routine.id);
    let result: ScriptProcessResult;
    try {
      result = await deps.execScript(resolved.path, {
        cwd: resolved.cwd,
        timeoutMs: BOT_WATCH_LIMITS.scriptTimeoutMs,
        outputLimit: BOT_WATCH_LIMITS.scriptBytes,
        signal,
        env: { AIDEN_CHECK_STATE: state, AIDEN_CHECK_RUNS: String(routine.checkRuns) },
      });
    } catch {
      return { ok: false, error: `${source.script} couldn't start.` };
    } finally {
      await capState(state).catch((error: unknown) => deps.onError?.(error));
    }
    await deps.store.countCheckRun(routine.id).catch((error: unknown) => deps.onError?.(error));
    return scriptCheckResult(source.script, result);
  }

  const watches = createEventWatches<TaskTriggerRoutine>({
    ownerKey: (routine) => routine.id,
    routines: () => deps.store.all(),
    store: deps.store,
    check,
    dispatcher,
    isPaused: async () => !deps.isActive(),
    paused: async (routine, error) => {
      await deps.paused(routine.task, error);
      deps.changed?.(routine.id);
    },
    recovered: async () => undefined,
    reportsOutput: (routine) => routine.task.trigger.source.type === "script",
    now: deps.now,
    setTimer: deps.setTimer,
    onError: deps.onError,
    checked: (routine) => deps.changed?.(routine.id),
  });

  return {
    /** Arms every enabled watch and replays accepted events after a restart. */
    start(): Promise<void> {
      stopped = false;
      dispatcher.resume();
      watches.resume();
      return this.rearm();
    },
    /** Re-read the tasks: watch what's new, stop watching what's gone. */
    async rearm(): Promise<void> {
      if (stopped) return;
      await watches.rearm();
      await dispatcher.rearm(deps.store.all());
    },
    stop(): void {
      stopped = true;
      watches.dispose();
      dispatcher.dispose();
    },
    /** One check now (tests and the timer). */
    checkNow: (taskId: string) => watches.checkNow(taskId, taskId),
    async idle(): Promise<void> {
      await watches.idle();
      await dispatcher.idle();
    },
  };
}

export type ScheduledTaskTriggers = ReturnType<typeof createScheduledTaskTriggers>;
