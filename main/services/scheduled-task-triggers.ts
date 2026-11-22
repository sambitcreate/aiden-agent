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
import { createTaskLinkWebhook, linkEventText, mergeLinkBatches } from "./scheduled-task-link-trigger.js";
import type { TaskConnectorSource, TaskConnectorTriggers } from "./scheduled-task-connector-trigger.js";
import { TASK_TRIGGER_PAYLOAD_CHARS, type ScheduledTaskTriggerStore, type TaskTriggerRoutine } from "./scheduled-task-triggers-store.js";
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
  /** One GET of a watched address; `publicOnly` for a watch Aiden proposed (never this computer or a private network). */
  fetchUrl(url: string, signal: AbortSignal, options: { publicOnly: boolean }): Promise<BotWatchCheck>;
  /** The script's path and the folder it runs in (the task's project), or why it can't run. */
  resolveScript(task: ScheduledTask, script: string): Promise<{ path: string; cwd: string }>;
  /** Runs a script check (runScheduledScript in production). */
  execScript(scriptPath: string, options: {
    cwd: string; timeoutMs: number; outputLimit: number; signal: AbortSignal; env: Readonly<Record<string, string>>;
  }): Promise<ScriptProcessResult>;
  /** The folder each task's private check state file lives in. */
  checkStateDir(): Promise<string>;
  /** Connected-app checks (scheduled-task-connector-trigger.ts); they never connect or sign in. */
  connector?: Pick<TaskConnectorTriggers, "check">;
  /** A link's signing secret, when it has one. */
  linkSecret(taskId: string): Promise<string | null>;
  /** Three failed checks (or one revoked connected app) turned the trigger off: one card in the task's landing chat. */
  paused(task: ScheduledTask, error: string, afterFailures: boolean): Promise<void>;
  /**
   * A connected-app task that is on but has no source bound (a save that
   * stopped before binding it): show that it needs one, since it never checks.
   */
  needsSource?(task: ScheduledTask): Promise<void>;
  /**
   * What the task held was dropped (today's 48 runs were used up, or its chat
   * stayed busy through every retry). One card where its runs land.
   */
  dropped?(task: ScheduledTask, card: { summary: string; text: string }): Promise<void>;
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

/**
 * Two undelivered payloads as one (a change held inside the gap, or a run
 * skipped for a busy chat): a link's calls join one batch (20 at most, saying
 * how many were dropped); a watch's newest change comes first, then the
 * earlier one, and the end is cut at the payload bound.
 */
function combineHeld(link: boolean, older: string, newer: string | undefined): string {
  if (newer === undefined) return older;
  if (link) return mergeLinkBatches(older, newer, TASK_TRIGGER_PAYLOAD_CHARS);
  return `${newer}\n\nAn earlier change that wasn't delivered yet:\n${older}`;
}

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** A script watch's private state file (`AIDEN_CHECK_STATE`) in the check state folder. */
export function taskCheckStateFile(dir: string, taskId: string): string {
  return path.join(dir, `${taskId.replace(/[^A-Za-z0-9_-]/gu, "_")}.state`);
}

/** A chat that used its task runs for the hour has room again within the hour. */
export const CHAT_BUDGET_RETRY_MS = 60 * 60_000;
/** Times a run that delivered nothing (busy chat, chat out of task runs) is held again before its payload is dropped. */
export const TASK_TRIGGER_RETRIES = 6;

/** A link's log changes at most this often reach the task list. */
const LOG_BROADCAST_MS = 2_000;

/** A run that went ahead but delivered nothing: its chat was busy or out of task runs this hour. */
const undelivered = (run: ScheduledRun | undefined) =>
  run?.result === "skipped" && (run.reason === "chat_busy" || run.reason === "chat_budget");

export function createScheduledTaskTriggers(deps: ScheduledTaskTriggersDependencies) {
  const slots = createSlots(SCHEDULED_TASK_TRIGGER_LIMITS.runningOverall);
  let stopped = true;

  async function runOnce(routine: TaskTriggerRoutine, event: { eventId: string; payload: string; watchRevision?: number; retries?: number }): Promise<{ settled: boolean }> {
    const release = await slots.take();
    try {
      if (stopped) return { settled: false };
      const runId = `event:${routine.id}:${event.eventId}`;
      const recorded = await deps.findRun(routine.id, runId);
      // A run that delivered nothing (Aiden may have stopped before its
      // payload was held again) runs again, like one that was cut short.
      if (recorded && recorded.result !== "blocked" && !undelivered(recorded)) return { settled: true };
      try {
        const link = routine.task.trigger.kind === "webhook";
        const run = await deps.runEvent(routine.id, {
          kind: "event",
          eventId: event.eventId,
          source: link ? "webhook" : "watch",
          payload: link ? linkEventText(event.payload, TASK_TRIGGER_PAYLOAD_CHARS) : event.payload,
        }, runId);
        // Its chat was busy or out of task runs this hour: what happened waits
        // for the next allowed run instead of being lost, and the run doesn't
        // count toward the day's 48. A chat out of runs has room within the hour.
        if (!stopped && undelivered(run)) {
          await dispatcher.requeue(routine.id, routine.id, {
            eventId: `${event.eventId.slice(0, 120)}~${deps.now().toString(36)}`,
            payload: event.payload,
            ...(event.watchRevision !== undefined ? { watchRevision: event.watchRevision } : {}),
            ...(event.retries ? { retries: event.retries } : {}),
          }, (older, newer) => combineHeld(link, older, newer), {
            settles: event.eventId,
            refund: true,
            maxRetries: TASK_TRIGGER_RETRIES,
            ...(run.reason === "chat_budget" ? { notBefore: deps.now() + CHAT_BUDGET_RETRY_MS } : {}),
          });
        }
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
    // A link chooses its own gap (1–60 minutes); a watch waits 5.
    limits: (routine) => ({
      minGapMs: routine.task.trigger.kind === "webhook" ? routine.task.trigger.gapMinutes * 60_000 : SCHEDULED_TASK_TRIGGER_LIMITS.minGapMs,
      perDay: SCHEDULED_TASK_TRIGGER_LIMITS.perDay,
    }),
    payloadChars: TASK_TRIGGER_PAYLOAD_CHARS,
    // Calls inside a link's gap are batched (20 at most); a watch keeps its
    // newest change first, then earlier ones not yet delivered.
    mergeHeld: (held, incoming, routine) => combineHeld(routine.task.trigger.kind === "webhook", held.payload, incoming.payload),
    heldDropped: async (routine, _held, reason) => {
      const link = routine.task.trigger.kind === "webhook";
      const what = link ? "the calls" : "the change";
      const were = link ? "were" : "was";
      const card = reason === "daily_limit"
        ? {
          summary: `Today's ${SCHEDULED_TASK_TRIGGER_LIMITS.perDay} runs were used up`,
          text: `Scheduled task "${routine.task.name}" already ran ${SCHEDULED_TASK_TRIGGER_LIMITS.perDay} times today, so ${what} it was holding ${were} dropped. It runs again tomorrow.`,
        }
        : {
          summary: "Couldn't deliver, dropped",
          text: `Scheduled task "${routine.task.name}" tried ${TASK_TRIGGER_RETRIES + 1} times but its chat was busy or out of task runs each time, so ${what} it was holding ${were} dropped. It runs again on the next ${link ? "call" : "change"}.`,
        };
      if (link) {
        await deps.store.appendLog(routine.id, reason === "daily_limit"
          ? { at: deps.now(), outcome: "daily_limit", preview: "Held calls dropped: today's runs were used up." }
          : { at: deps.now(), outcome: "dropped", preview: "Held calls dropped: the chat stayed busy." });
      }
      await deps.dropped?.(routine.task, card);
      deps.changed?.(routine.id);
    },
    now: deps.now,
    timeZone: deps.timeZone,
    setTimer: deps.setTimer,
    onError: deps.onError,
  });

  async function checkState(taskId: string): Promise<string> {
    const dir = await deps.checkStateDir();
    await fs.mkdir(dir, { recursive: true, mode: 0o700 });
    const file = taskCheckStateFile(dir, taskId);
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
    if (routine.task.trigger.kind === "connector") {
      if (!deps.connector) return { ok: false, error: "Connected-app checks aren't available here." };
      const trigger = routine.task.trigger;
      return deps.connector.check({ id: routine.id, trigger }, routine.connectorSource, routine.watch?.connectorBaseline, signal);
    }
    if (routine.task.trigger.kind !== "watch") return { ok: false, error: "This task has no watch." };
    const source = routine.task.trigger.source;
    if (source.type === "url") return deps.fetchUrl(source.url, signal, { publicOnly: routine.task.trigger.agentProposed === true });
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
      await deps.paused(routine.task, error, (routine.watch?.failures ?? 0) >= BOT_WATCH_LIMITS.failuresBeforePause);
      deps.changed?.(routine.id);
    },
    recovered: async () => undefined,
    reportsOutput: (routine) => routine.task.trigger.kind === "watch" && routine.task.trigger.source.type === "script",
    now: deps.now,
    setTimer: deps.setTimer,
    onError: deps.onError,
    checked: (routine) => deps.changed?.(routine.id),
  });

  /** A busy link tells the task list at most once every 2 seconds, and always about its latest call. */
  const logBroadcasts = new Map<string, { at: number; pending?: { cancel(): void } }>();
  function broadcastLog(taskId: string): void {
    if (!deps.changed) return;
    const now = deps.now();
    const state = logBroadcasts.get(taskId) ?? { at: -Infinity };
    if (state.pending) return;
    if (now - state.at >= LOG_BROADCAST_MS) {
      logBroadcasts.set(taskId, { at: now });
      deps.changed(taskId);
      return;
    }
    state.pending = deps.setTimer(() => {
      logBroadcasts.set(taskId, { at: deps.now() });
      deps.changed?.(taskId);
    }, state.at + LOG_BROADCAST_MS - now);
    logBroadcasts.set(taskId, state);
  }

  const webhook = createTaskLinkWebhook({
    active: () => !stopped && deps.isActive(),
    tokenTask: (token) => deps.store.tokenTask(token),
    findByToken: (token) => deps.store.findByToken(token),
    secret: (taskId) => deps.linkSecret(taskId),
    emit: (taskId, event) => dispatcher.emit(taskId, taskId, event),
    log: async (taskId, entry, options) => {
      await deps.store.appendLog(taskId, entry, options);
      broadcastLog(taskId);
    },
    now: deps.now,
  });

  return {
    webhook,
    /** Arms every enabled watch and replays accepted events after a restart. */
    async start(): Promise<void> {
      stopped = false;
      dispatcher.resume();
      watches.resume();
      await this.rearm();
      if (!deps.needsSource) return;
      for (const routine of await deps.store.all()) {
        if (!routine.task.enabled || routine.task.trigger.kind !== "connector" || routine.connectorSource) continue;
        await deps.needsSource(routine.task).catch((error: unknown) => deps.onError?.(error));
      }
    },
    /** Re-read the tasks: watch what's new, stop watching what's gone. */
    async rearm(): Promise<void> {
      if (stopped) return;
      await watches.rearm();
      await dispatcher.rearm(deps.store.all());
    },
    /** A save after Find sources: bind the task's exact source and check it right away. */
    async bindConnectorSource(taskId: string, source: TaskConnectorSource): Promise<boolean> {
      const bound = await deps.store.setConnectorSource(taskId, source);
      await this.rearm();
      return bound;
    },
    stop(): void {
      stopped = true;
      for (const state of logBroadcasts.values()) state.pending?.cancel();
      logBroadcasts.clear();
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
