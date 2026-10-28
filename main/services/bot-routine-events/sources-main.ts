// Production wiring of Bot event routines: the per-Bot store, the dispatcher's
// limits, a dedicated routine executor (runs recorded in schedule-runs.json
// under the event routine's id), folder watches and the webhook handler.
// Started once Bots are open, never during onboarding.

import { watch as fsWatch } from "node:fs";
import { app, ipcMain, logger } from "../../platform.js";
import { createBotRoutineExecutor } from "../scheduled-bot-routines.js";
import { scheduleStore } from "../schedule-store.js";
import type { ScheduledTask } from "../types.js";
import { createBotRoutineEventDispatcher } from "./dispatcher.js";
import { createBotFolderWatches } from "./folder-watch.js";
import { createBotEventRoutineStore, type BotEventRoutine } from "./store.js";
import { createBotWebhookHandler } from "./webhook.js";

const REARM_INTERVAL_MS = 5 * 60_000;

export const botEventRoutines = createBotEventRoutineStore({ profileDir: () => app.getPath("userData") });

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

const executor = createBotRoutineExecutor({
  store: scheduleStore,
  ports: async () => (await import("../scheduled-bot-routines-main.js")).botRoutinePorts(),
  deliver: async (input) => (await import("../bot-delivery/funnel-main.js")).botDeliveryFunnel().deliver(input),
  broadcast: (payload) => ipcMain.broadcast("bots:changed", payload),
});

const dispatcher = createBotRoutineEventDispatcher({
  store: botEventRoutines,
  run: async (routine, event) => {
    await executor.run(eventRoutineTask(routine), {
      trigger: { kind: "event", eventId: event.eventId, source: event.source, payload: event.payload },
      signal: new AbortController().signal,
    });
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
  watch: (folder, listener) => {
    const handle = fsWatch(folder, { recursive: true, persistent: false }, (_event, file) =>
      listener(typeof file === "string" ? file : file === null ? null : String(file)));
    handle.on("error", (error) => logger.warn("bots", "A Bot folder watch stopped.", error));
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
  now: Date.now,
  setTimer: (fn, ms) => {
    const timer = setTimeout(fn, ms);
    timer.unref?.();
    return { cancel: () => clearTimeout(timer) };
  },
});

const webhook = createBotWebhookHandler({ store: botEventRoutines, dispatcher, now: Date.now });

let started = false;
let interval: ReturnType<typeof setInterval> | undefined;

/** Re-read the routines: watch what's new, stop watching what's gone. */
export function rearmBotEventRoutines(): void {
  if (!started) return;
  void folders.rearm().catch((error: unknown) => logger.warn("bots", "Could not arm Bot folder watches.", error));
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
  dispatcher.dispose();
}

/** `POST /hooks/bot-routines/{token}`; only while Bots are open. */
export async function handleBotRoutineWebhook(request: { token: string; contentType?: string; body: Uint8Array }): Promise<{ status: number }> {
  if (!started) return { status: 404 };
  return webhook(request);
}
