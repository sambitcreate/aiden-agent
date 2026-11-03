// Production wiring of Bot event routines: the per-Bot store, the dispatcher's
// limits, a dedicated routine executor (runs recorded in schedule-runs.json
// under the event routine's id), folder watches, watch checks and the
// webhook handler. Started after Bot storage restoration, independently of the visible screen; at
// start, watches only arm timers for their persisted next-check times.

import { promises as fsPromises, watch as fsWatch } from "node:fs";
import { app, ipcMain, logger, powerMonitor } from "../../platform.js";
import { createBotRoutineExecutor } from "../scheduled-bot-routines.js";
import { scheduleStore } from "../schedule-store.js";
import { eventRoutineAfterRun } from "./after-run.js";
import { createBotRoutineEventDispatcher } from "./dispatcher.js";
import { createBotFolderWatches } from "./folder-watch.js";
import { botOwnWrites } from "./own-writes.js";
import { createBotEventRunner, eventRoutineRunStore } from "./runner.js";
import { createBotEventRoutineStore, type BotEventRoutine } from "./store.js";
import { createBotWatches } from "./watch.js";
import { productionConnectorWatchService } from "./connector-host-main.js";
import { checkBotWatchSource } from "./watch-sources.js";
import { createKeyedSerial } from "../bot-routine-notes.js";
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
  ipcMain.broadcast("bots:connectorWatches:changed", { botId });
}

/** Event runs whose result didn't reach the delivery log yet: their receipt stays for replay. */
const undelivered = new Set<string>();

const executor = createBotRoutineExecutor({
  store: eventRoutineRunStore(scheduleStore),
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
    await eventRoutineAfterRun(task, run, { store: botEventRoutines, runs: (id) => scheduleStore.runs(id),
      issues: (await import("../bot-issues/service-main.js")).botIssues, changed: botEventRoutinesChanged }).catch((error: unknown) =>
      logger.warn("bots", `Bot event routine ${task.id} follow-up failed.`, error));
  },
});

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

/**
 * Event runs in flight. Stopping event routines (quit, or Bots closing)
 * cancels them; a cancelled event run is recorded as uncertain, so the event
 * is replayed on the next start instead of being lost.
 */
const runner = createBotEventRunner({
  executor,
  undelivered: (requestId) => undelivered.has(requestId),
  // The folder watch holds a routine's folder changes while it runs.
  runStarted: (routine) => folders.runStarted(routine),
  runEnded: (routine) => folders.runEnded(routine),
});

const dispatcher = createBotRoutineEventDispatcher({
  store: botEventRoutines,
  run: (routine, event, signal) => runner.run(routine, event, signal),
  authorizeRun: async (routine) => {
    const grant = await admitWatchDispatch(routine);
    if ("error" in grant) {
      const paused = await botEventRoutines.mutate(routine.botId, routine.id, (fresh) => {
        if (!fresh.enabled || fresh.updatedAt !== routine.updatedAt || !fresh.watch) return { result: undefined };
        const next = { ...fresh, enabled: false, watch: { ...fresh.watch, failures: fresh.watch.failures + 1,
          unsettledFailure: true as const, lastResult: "error" as const, lastError: grant.error.slice(0, 200) } };
        return { next, result: next };
      });
      if (paused) await reportWatchPaused(paused, grant.error);
    }
    return grant;
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
  ownWrite: (routine, absolutePath, since) => botOwnWrites.writtenSince(routine.botId, absolutePath, since),
  stat: async (absolutePath) => {
    const stats = await fsPromises.stat(absolutePath).catch(() => undefined);
    return stats ? { mtimeMs: stats.mtimeMs, size: stats.size } : undefined;
  },
  refused: (routine) => {
    if (refusedOnce.has(routine.id)) return;
    refusedOnce.add(routine.id);
    void import("../bot-issues/service-main.js").then(({ botIssues }) => botIssues.raise({
      botId: routine.botId,
      kind: "routine_failed",
      dedupeKey: `event_folder:${routine.id}`,
      title: `${routine.name} can't watch its folder`,
      body: "Its folder is missing, outside the Bot's folder, or can't be watched. Edit the routine to pick another one.",
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

async function admitWatchDispatch(routine: BotEventRoutine) {
  if (routine.trigger.kind === "watch" && routine.trigger.source.type === "connector") return botConnectorWatches.authorize(routine);
  if (routine.trigger.kind === "watch" && routine.trigger.source.type === "script") {
    return (await import("../bot-runtime/bot-session-main.js")).admitBotShellWork(routine.botId);
  }
  return { signal: new AbortController().signal, release() {} };
}

const watchIssueSerial = createKeyedSerial();

async function reportWatchPaused(routine: BotEventRoutine, error: string): Promise<void> {
  return watchIssueSerial(`${routine.botId}:${routine.id}`, async () => {
    const fresh = (await botEventRoutines.list(routine.botId)).find((item) => item.id === routine.id);
    if (!fresh || fresh.watch?.lastResult !== "error") return;
    const { botIssues } = await import("../bot-issues/service-main.js");
    await botIssues.raise({
      botId: routine.botId, kind: "routine_paused", dedupeKey: `watch_failed:${routine.id}`,
      title: `Turned off ${routine.name}`,
      body: `Its watch couldn't continue${error ? `: ${error}` : "."} Check its source or access, then turn it back on.`,
      routineId: routine.id, actions: [],
    });
    ipcMain.broadcast("bots:changed", { botId: routine.botId });
    ipcMain.broadcast("bots:eventRoutines:changed", { botId: routine.botId });
  });
}

const watches = createBotWatches({
  routines: () => botEventRoutines.all(),
  store: botEventRoutines,
  check: (routine, signal) => {
    if (routine.trigger.kind !== "watch") return Promise.resolve({ ok: false as const, error: "Not a watch." });
    if (routine.trigger.source.type === "connector") return botConnectorWatches.check(routine, signal);
    return checkBotWatchSource(routine.trigger.source, async () => {
      const { botManagedWorkspace } = await import("../bot-capability-services-main.js");
      return (await botManagedWorkspace.resolve(routine.botId)).homePath;
    }, {
      signal,
      // A script runs only under the Bot's current Shell access.
      authorize: async () => (await import("../bot-runtime/bot-session-main.js")).admitBotShellWork(routine.botId),
    });
  },
  dispatcher,
  isPaused: async (botId) => (await import("../bot-pause-main.js")).isBotPaused(botId),
  paused: reportWatchPaused,
  authorizeDispatch: admitWatchDispatch,
  recovered: async (routine) => {
    await watchIssueSerial(`${routine.botId}:${routine.id}`, async () => {
      const fresh = (await botEventRoutines.list(routine.botId)).find((item) => item.id === routine.id);
      if (!fresh?.enabled || fresh.watch?.failures !== 0 || fresh.watch.unsettledFailure) return;
      const { botIssues } = await import("../bot-issues/service-main.js");
      await botIssues.resolve(routine.botId, `watch_failed:${routine.id}`, "fixed");
    });
  },
  now: Date.now,
  setTimer: timer,
  onError: (error) => logger.warn("bots", "A Bot watch check did not finish.", error),
  // The profile's rows show when a watch last checked and whether it's on.
  checked: (routine) => {
    ipcMain.broadcast("bots:eventRoutines:changed", { botId: routine.botId });
    if (routine.connector) {
      ipcMain.broadcast("bots:connectorWatches:changed", { botId: routine.botId });
      ipcMain.broadcast("bots:changed", { botId: routine.botId });
    }
  },
});

export const botConnectorWatches = productionConnectorWatchService({ store: botEventRoutines, dispatcher,
  changed: botEventRoutinesChanged,
  isPaused: async (botId) => (await import("../bot-pause-main.js")).isBotPaused(botId),
});

const webhook = createBotWebhookHandler({ store: botEventRoutines, dispatcher, now: Date.now });

let started = false;
let interval: ReturnType<typeof setInterval> | undefined;

/** Re-read the routines: watch what's new, stop watching what's gone. */
export function rearmBotEventRoutines(): void {
  if (!started) return;
  void botEventRoutines.all().then((rows) => botConnectorWatches.rearmSources(rows)).catch((error: unknown) => logger.warn("bots", "Connector session retention failed.", error));
  void folders.rearm().catch((error: unknown) => logger.warn("bots", "Could not arm Bot folder watches.", error));
  void watches.rearm().catch((error: unknown) => logger.warn("bots", "Could not arm Bot watch checks.", error));
  void dispatcher.rearm(botEventRoutines.all()).catch((error: unknown) => logger.warn("bots", "Could not resume Bot event receipts.", error));
}

let listeningForPower = false;
let sleeping = false;
let hostStopped = false;
let powerTransition: Promise<unknown> = Promise.resolve();
export function startBotEventRoutines(): void {
  if (!listeningForPower) {
    listeningForPower = true;
    powerMonitor.on("suspend", () => {
      sleeping = true; botConnectorWatches.suspend();
      powerTransition = stopBotEventRoutines({ forSleep: true }).catch((error) => logger.warn("bots", "Watch sleep suspension did not finish.", error));
    });
    powerMonitor.on("resume", () => {
      sleeping = false;
      void powerTransition.then(() => { if (!sleeping && !hostStopped) startBotEventRoutines(); });
    });
  }
  if (started || sleeping) return;
  hostStopped = false;
  botConnectorWatches.resume();
  started = true;
  dispatcher.resume();
  watches.resume();
  rearmBotEventRoutines();
  interval = setInterval(rearmBotEventRoutines, REARM_INTERVAL_MS);
  interval.unref?.();
}

/**
 * Stops every trigger and cancels the runs in flight. Resolves once each
 * cancelled run is recorded (as uncertain, so its event is replayed on the
 * next start) and its receipt is written; the caller bounds the wait.
 */
export async function stopBotEventRoutines(options: { forSleep?: boolean } = {}): Promise<void> {
  if (!options.forSleep) hostStopped = true;
  started = false;
  botConnectorWatches.suspend();
  if (interval) clearInterval(interval);
  interval = undefined;
  folders.dispose();
  watches.dispose();
  dispatcher.dispose();
  runner.abortAll();
  await Promise.allSettled([dispatcher.idle(), folders.idle()]);
}

/** `POST /hooks/bot-routines/{token}`; only while Bots are open. */
export async function handleBotRoutineWebhook(request: { token: string; contentType?: string; body: Uint8Array }): Promise<{ status: number }> {
  if (!started) return { status: 404 };
  return webhook(request);
}
