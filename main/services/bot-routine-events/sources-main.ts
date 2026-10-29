// Production wiring of Bot event routines: the per-Bot store, the dispatcher's
// limits, a dedicated routine executor (runs recorded in schedule-runs.json
// under the event routine's id), folder watches, watch checks and the
// webhook handler. Started once Bots are open, never during onboarding; at
// start, watches only arm timers for their persisted next-check times.

import { watch as fsWatch } from "node:fs";
import { BOT_WATCH_LIMITS } from "../../../renderer/shared/bot-routine-trigger.js";
import { app, ipcMain, logger } from "../../platform.js";
import { botRoutineRequestId, createBotRoutineExecutor } from "../scheduled-bot-routines.js";
import { scheduleStore } from "../schedule-store.js";
import type { ScheduledRun, ScheduledTask } from "../types.js";
import { createBotRoutineEventDispatcher } from "./dispatcher.js";
import { createBotFolderWatches } from "./folder-watch.js";
import { createBotEventRoutineStore, type BotEventRoutine } from "./store.js";
import { createBotWatches } from "./watch.js";
import { checkBotWatchSource } from "./watch-sources.js";
import { createBotWebhookHandler } from "./webhook.js";

const REARM_INTERVAL_MS = 5 * 60_000;

export const botEventRoutines = createBotEventRoutineStore({ profileDir: () => app.getPath("userData") });

/**
 * The link a person can call for a webhook routine's token, from the Remote
 * listener's address; null while Aiden On The Go is off. Shown to the person
 * only, never to the Bot.
 */
export async function botRoutineWebhookLink(token: string): Promise<string | null> {
  const { getAidenRemoteService } = await import("../aiden-remote-service-main.js");
  const status = await (await getAidenRemoteService()).status().catch(() => undefined);
  // Tailscale first: it reaches this Mac from anywhere the person's devices are.
  const base = status?.running ? status.tailscaleEndpoint ?? status.lanEndpoint : undefined;
  return base ? `${base.replace(/\/+$/u, "")}/hooks/bot-routines/${token}` : null;
}

/** A Bot's event routines changed: re-arm watches and refresh its views. */
export function botEventRoutinesChanged(botId: string): void {
  void rearmBotEventRoutines();
  ipcMain.broadcast("bots:changed", { botId });
  ipcMain.broadcast("bots:eventRoutines:changed", { botId });
}

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

/** Event runs whose result didn't reach the delivery log yet: their receipt stays for replay. */
const undelivered = new Set<string>();

const executor = createBotRoutineExecutor({
  store: scheduleStore,
  ports: async () => (await import("../scheduled-bot-routines-main.js")).botRoutinePorts(),
  deliver: async (input) => {
    try {
      const outcome = await (await import("../bot-delivery/funnel-main.js")).botDeliveryFunnel().deliver(input);
      if (input.requestId) undelivered.delete(input.requestId);
      return outcome;
    } catch (error) {
      if (input.requestId) undelivered.add(input.requestId);
      throw error;
    }
  },
  broadcast: (payload) => ipcMain.broadcast("bots:changed", payload),
  afterRun: async (task, run) => {
    await eventRoutineAfterRun(task, run).catch((error: unknown) =>
      logger.warn("bots", `Bot event routine ${task.id} follow-up failed.`, error));
  },
});

/**
 * Healing for event routines (spec §5 S2, adapted): a failure only the person
 * can fix raises one card; three failed runs in a row of the same kind turn
 * the routine off with one card. No retries: the next event is the retry.
 */
async function eventRoutineAfterRun(task: ScheduledTask, run: ScheduledRun): Promise<void> {
  const botId = task.botId;
  if (!botId) return;
  const { botIssues } = await import("../bot-issues/service-main.js");
  const key = `event_failed:${task.id}`;
  if (run.result === "success" && run.failure?.kind !== "tool_error") {
    await botIssues.resolve(botId, key, "fixed");
    return;
  }
  if (run.result !== "error" && run.failure?.kind !== "tool_error") return;
  const { failureStreak, fireOutcomes, BOT_ROUTINE_FAILURE_PAUSE_THRESHOLD } = await import("../bot-routine-recovery.js");
  const streak = failureStreak(fireOutcomes(await scheduleStore.runs(task.id)));
  const kind = run.failure?.kind ?? "other";
  const needsPerson = kind === "sign_in" || kind === "access_changed" || kind === "model_setup";
  if (streak.count >= BOT_ROUTINE_FAILURE_PAUSE_THRESHOLD) {
    await botEventRoutines.update(botId, task.id, { enabled: false });
    rearmBotEventRoutines();
    await botIssues.raise({
      botId,
      kind: "routine_paused",
      dedupeKey: key,
      title: `Turned off ${task.name}`,
      body: `It failed ${BOT_ROUTINE_FAILURE_PAUSE_THRESHOLD} times in a row. Turn it back on in the Bot's profile when it's fixed.`,
      routineId: task.id,
      actions: [],
    });
  } else if (needsPerson) {
    await botIssues.raise({
      botId,
      kind: "routine_failed",
      dedupeKey: key,
      title: `${task.name} needs you`,
      body: kind === "sign_in" ? "Sign in to your AI provider again so it can run." : kind === "model_setup" ? "This Bot needs a working AI model." : "This Bot's model or access changed. Check its settings.",
      routineId: task.id,
      actions: [{ kind: "open_settings", section: kind === "sign_in" ? "providers" : kind === "model_setup" ? "model" : "access" }],
    });
  }
}

/** An event routine is gone: its runs and notes go with it. */
export async function forgetBotEventRoutine(botId: string, routineId: string): Promise<void> {
  await scheduleStore.removeRuns(routineId);
  const { botRoutineNotes } = await import("../scheduled-bot-routines-main.js");
  await botRoutineNotes.clear(botId, routineId).catch(() => undefined);
}

/** A Bot is deleted: every event routine's runs go (the routine file goes with the Bot's folder). */
export async function forgetBotEventRoutines(botId: string): Promise<void> {
  for (const routine of await botEventRoutines.list(botId)) await forgetBotEventRoutine(botId, routine.id);
}

const dispatcher = createBotRoutineEventDispatcher({
  store: botEventRoutines,
  run: async (routine, event) => {
    const trigger = { kind: "event" as const, eventId: event.eventId, source: event.source, payload: event.payload };
    // The event's own request id as the run id: a replay after a restart
    // reads the recorded run or the admitted turn instead of sending again.
    const requestId = botRoutineRequestId(routine.id, trigger);
    const run = await executor.run(eventRoutineTask(routine), {
      trigger,
      runId: requestId,
      signal: new AbortController().signal,
    });
    // Only a run recorded under the event's own id, and handed to the
    // delivery log, is settled; anything else is replayed on next start
    // (the replay reads the saved run and only retries its delivery).
    return { settled: run.id === requestId && !undelivered.has(requestId) };
  },
  isPaused: async (botId) => (await import("../bot-pause-main.js")).isBotPaused(botId),
  now: Date.now,
  timeZone: () => Intl.DateTimeFormat().resolvedOptions().timeZone,
  setTimer: (fn, ms) => {
    const timer = setTimeout(fn, ms);
    timer.unref?.();
    return { cancel: () => clearTimeout(timer) };
  },
  onError: (error) => logger.warn("bots", "A Bot event routine did not run.", error),
});

const refusedOnce = new Set<string>();

const folders = createBotFolderWatches({
  routines: () => botEventRoutines.all(),
  homePath: async (botId) => {
    const { botManagedWorkspace } = await import("../bot-capability-services-main.js");
    return (await botManagedWorkspace.resolve(botId)).homePath;
  },
  watch: (folder, listener, onError) => {
    const handle = fsWatch(folder, { recursive: true, persistent: false }, (_event, file) =>
      listener(typeof file === "string" ? file : file === null ? null : String(file)));
    handle.on("error", (error) => {
      logger.warn("bots", "A Bot folder watch stopped.", error);
      onError();
    });
    return { close: () => handle.close() };
  },
  dispatcher,
  refused: (routine) => {
    if (refusedOnce.has(routine.id)) return;
    refusedOnce.add(routine.id);
    void import("../bot-issues/service-main.js").then(({ botIssues }) => botIssues.raise({
      botId: routine.botId,
      kind: "routine_failed",
      dedupeKey: `event_folder:${routine.id}`,
      title: `${routine.name} can't watch its folder`,
      body: "Its folder is missing or outside the Bot's folder. Edit the routine to pick another one.",
      routineId: routine.id,
      actions: [],
    })).catch((error: unknown) => logger.warn("bots", "Could not report a Bot folder problem.", error));
  },
  accepted: (routine) => {
    // Also after a restart, when the card outlived this process's memory.
    refusedOnce.delete(routine.id);
    void import("../bot-issues/service-main.js")
      .then(({ botIssues }) => botIssues.resolve(routine.botId, `event_folder:${routine.id}`, "fixed"))
      .catch((error: unknown) => logger.warn("bots", "Could not clear a Bot folder problem.", error));
  },
  now: Date.now,
  setTimer: (fn, ms) => {
    const timer = setTimeout(fn, ms);
    timer.unref?.();
    return { cancel: () => clearTimeout(timer) };
  },
});

const timer = (fn: () => void, ms: number) => {
  const handle = setTimeout(fn, ms);
  handle.unref?.();
  return { cancel: () => clearTimeout(handle) };
};

const watches = createBotWatches({
  routines: () => botEventRoutines.all(),
  store: botEventRoutines,
  check: (routine) => {
    if (routine.trigger.kind !== "watch") return Promise.resolve({ ok: false as const, error: "Not a watch." });
    return checkBotWatchSource(routine.trigger.source, async () => {
      const { botManagedWorkspace } = await import("../bot-capability-services-main.js");
      return (await botManagedWorkspace.resolve(routine.botId)).homePath;
    }, {
      // A script runs only under the Bot's current Shell access.
      authorize: async () => (await import("../bot-runtime/bot-session-main.js")).admitBotShellWork(routine.botId),
    });
  },
  dispatcher,
  isPaused: async (botId) => (await import("../bot-pause-main.js")).isBotPaused(botId),
  paused: async (routine, error) => {
    const { botIssues } = await import("../bot-issues/service-main.js");
    await botIssues.raise({
      botId: routine.botId,
      kind: "routine_paused",
      dedupeKey: `watch_failed:${routine.id}`,
      title: `Turned off ${routine.name}`,
      body: `Its check failed ${BOT_WATCH_LIMITS.failuresBeforePause} times in a row${error ? `: ${error}` : "."} Turn it back on in the Bot's profile when it's fixed.`,
      routineId: routine.id,
      actions: [],
    });
    ipcMain.broadcast("bots:changed", { botId: routine.botId });
  },
  recovered: async (routine) => {
    const { botIssues } = await import("../bot-issues/service-main.js");
    await botIssues.resolve(routine.botId, `watch_failed:${routine.id}`, "fixed");
  },
  now: Date.now,
  setTimer: timer,
  onError: (error) => logger.warn("bots", "A Bot watch check did not finish.", error),
  // The profile's rows show when a watch last checked and whether it's on.
  checked: (routine) => ipcMain.broadcast("bots:eventRoutines:changed", { botId: routine.botId }),
});

const webhook = createBotWebhookHandler({ store: botEventRoutines, dispatcher, now: Date.now });

let started = false;
let interval: ReturnType<typeof setInterval> | undefined;

/** Re-read the routines: watch what's new, stop watching what's gone. */
export function rearmBotEventRoutines(): void {
  if (!started) return;
  void folders.rearm().catch((error: unknown) => logger.warn("bots", "Could not arm Bot folder watches.", error));
  void watches.rearm().catch((error: unknown) => logger.warn("bots", "Could not arm Bot watch checks.", error));
}

export function startBotEventRoutines(): void {
  if (started) return;
  started = true;
  rearmBotEventRoutines();
  void botEventRoutines.all().then((routines) => dispatcher.rearm(routines)).catch(() => undefined);
  interval = setInterval(rearmBotEventRoutines, REARM_INTERVAL_MS);
  interval.unref?.();
}

export function stopBotEventRoutines(): void {
  started = false;
  if (interval) clearInterval(interval);
  interval = undefined;
  folders.dispose();
  watches.dispose();
  dispatcher.dispose();
}

/** `POST /hooks/bot-routines/{token}`; only while Bots are open. */
export async function handleBotRoutineWebhook(request: { token: string; contentType?: string; body: Uint8Array }): Promise<{ status: number }> {
  if (!started) return { status: 404 };
  return webhook(request);
}
