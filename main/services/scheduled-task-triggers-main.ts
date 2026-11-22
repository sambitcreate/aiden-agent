// Production wiring for chat tasks that run when something happens: the
// bookkeeping file, the schedule service and execution, and the watch sources.

import { randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { ipcMain, logger } from "../platform.js";
import { fetchBotWatchUrl } from "./bot-routine-events/watch-sources.js";
import { publicOnlyFetch } from "./public-only-fetch.js";
import { DataStore } from "./data-store.js";
import { scheduleExecution } from "./schedule-execution.js";
import { resolveScheduledScript, runScheduledScript } from "./schedule-script.js";
import { scheduleService } from "./schedule-service.js";
import { scheduleStore } from "./schedule-store.js";
import { createScheduledTaskTriggers, taskCheckStateFile } from "./scheduled-task-triggers.js";
import { taskConnectorTriggers } from "./scheduled-task-connector-main.js";
import { TASK_CONNECTOR_NEEDS_SOURCE, type TaskConnectorSource } from "./scheduled-task-connector-trigger.js";
import type { BotConnectorWatchSourceList } from "../../renderer/shared/bot-connector-watches.js";
import { SCHEDULED_TASK_TRIGGERS_FILE, createScheduledTaskTriggerStore, hashTaskLinkToken, type TaskLinkLogEntry } from "./scheduled-task-triggers-store.js";
import { secrets } from "./secrets.js";

/** Where a link task's signing secret lives; the agent and phones never see it. */
const linkSecretKey = (taskId: string) => `aiden-internal:task-hook:${taskId}`;

async function checkStateDir(): Promise<string> {
  return path.join((await import("../platform.js")).app.getPath("userData"), "scheduled-task-check-state");
}

const triggerStore = createScheduledTaskTriggerStore({
  persistence: new DataStore<unknown>(SCHEDULED_TASK_TRIGGERS_FILE, { version: 1, tasks: {} }),
  tasks: () => scheduleStore.list(),
  pauseTask: async (taskId, reason, afterFailures) => {
    await scheduleStore.updateRuntime(taskId, {
      enabled: false,
      lastError: `${afterFailures ? "Paused after 3 failed checks" : "Paused"}${reason ? `: ${reason}` : "."}`.slice(0, 4_096),
    });
    ipcMain.broadcast("schedule:updated", { taskId });
  },
  // A task that stopped being a link or script task (or lost its trigger)
  // leaves no signing secret or script state file behind.
  released: (taskId) => {
    void secrets.deleteKey(linkSecretKey(taskId)).catch((error: unknown) => logger.warn("schedule", "Could not remove a task link's secret.", error));
    void checkStateDir()
      .then((dir) => fs.rm(taskCheckStateFile(dir, taskId), { force: true }))
      .catch((error: unknown) => logger.warn("schedule", "Could not remove a task's check state.", error));
  },
  now: Date.now,
});

const timer = (fn: () => void, ms: number) => {
  const handle = setTimeout(fn, ms);
  handle.unref?.();
  return { cancel: () => clearTimeout(handle) };
};

const triggers = createScheduledTaskTriggers({
  store: triggerStore,
  isActive: () => scheduleService.isActive(),
  runEvent: (taskId, event, runId) => scheduleService.runEvent(taskId, event, runId),
  findRun: (taskId, runId) => scheduleStore.runById(taskId, runId),
  fetchUrl: (url, signal, options) => fetchBotWatchUrl(url, { signal, ...(options.publicOnly ? { fetch: publicOnlyFetch } : {}) }),
  resolveScript: async (task, script) => {
    if (task.permission !== "full") throw new Error("A script watch needs Full permission.");
    const folder = await scheduleExecution.taskWorkspaceFolder(task);
    const scriptPath = await resolveScheduledScript({ script, workspaceRoot: folder });
    return { path: scriptPath, cwd: folder ?? path.dirname(scriptPath) };
  },
  execScript: (scriptPath, options) => runScheduledScript(scriptPath, options),
  linkSecret: (taskId) => secrets.getKey(linkSecretKey(taskId)),
  connector: taskConnectorTriggers,
  checkStateDir,
  paused: async (task, error, afterFailures) => {
    await scheduleExecution.recordInLandingChat(task, {
      tone: "failure",
      summary: afterFailures ? "Paused after 3 failed checks" : "Paused",
      text: !afterFailures
        ? `Scheduled task "${task.name}" was paused: ${error || "its source couldn't be checked."} Then turn the task back on.`
        : `Scheduled task "${task.name}" was paused: its watch failed 3 times in a row${error ? ` (${error})` : ""}. ${
          task.trigger?.kind === "connector" ? "Check the connected app in Settings → Connectors" : "Check the address or script"
        }, then turn the task back on.`,
    });
  },
  needsSource: (task) => markTaskNeedsSource(task.id),
  dropped: async (task, card) => {
    await scheduleExecution.recordInLandingChat(task, { tone: "info", ...card });
  },
  changed: (taskId) => ipcMain.broadcast("schedule:updated", { taskId }),
  now: Date.now,
  timeZone: () => Intl.DateTimeFormat().resolvedOptions().timeZone,
  setTimer: timer,
  onError: (error) => logger.warn("schedule", "A task trigger step did not finish.", error),
});

let started = false;

export async function startScheduledTaskTriggers(): Promise<void> {
  if (started) return;
  started = true;
  await triggers.start().catch((error: unknown) => logger.warn("schedule", "Could not arm task triggers.", error));
}

/** Re-read the tasks after a save, removal or switch change. */
export function rearmScheduledTaskTriggers(payload: Record<string, unknown> = {}): void {
  // A removed task's link secret goes with it.
  if (payload.removed === true && typeof payload.taskId === "string") {
    void secrets.deleteKey(linkSecretKey(payload.taskId)).catch((error: unknown) => logger.warn("schedule", "Could not remove a task link's secret.", error));
  }
  if (!started) return;
  void triggers.rearm().catch((error: unknown) => logger.warn("schedule", "Could not re-arm task triggers.", error));
}

export function stopScheduledTaskTriggers(): void {
  if (!started) return;
  started = false;
  triggers.stop();
}

/** The listener's base address (Tailscale first, then the local network), or null while Aiden On The Go is off. */
async function listenerBase(): Promise<string | null> {
  const { getAidenRemoteService } = await import("./aiden-remote-service-main.js");
  const status = await (await getAidenRemoteService()).status().catch(() => undefined);
  const base = status?.running ? status.tailscaleEndpoint ?? status.lanEndpoint : undefined;
  return base ? base.replace(/\/+$/u, "") : null;
}

/** `POST /hooks/tasks/<token>`, before the body is read. */
export async function admitTaskTriggerWebhook(request: { token: string; contentType?: string }) {
  if (!started) return { status: 404 as const };
  return triggers.webhook.admit(request);
}

/** `POST /hooks/tasks/<token>`, with the body (at most 256 KB) and the signature header. */
export async function deliverTaskTriggerWebhook(request: { token: string; admission?: string; contentType?: string; signature?: string; body: Uint8Array }) {
  if (!started) return { status: 404 as const };
  return triggers.webhook.deliver(request);
}

/** `POST /hooks/tasks/<token>` with a body over 256 KB: 413, and the call's capacity given back. */
export async function taskTriggerWebhookTooLarge(request: { token: string; admission?: string }) {
  if (!started) return { status: 404 as const };
  return triggers.webhook.tooLarge(request);
}

/**
 * A new link for a link task, shown to the person once: the old link stops
 * working at once. A signed link also gets a new signing secret.
 */
export async function rotateTaskTriggerLink(taskId: string): Promise<{ url: string; secret?: string }> {
  const task = await scheduleStore.get(taskId);
  if (!task || task.trigger?.kind !== "webhook" || task.botId !== undefined) throw new Error("This task doesn't run from a link.");
  const base = await listenerBase();
  if (!base) throw new Error("Turn on Aiden On The Go in Settings to give this task a link.");
  const token = randomBytes(32).toString("base64url");
  let secret: string | undefined;
  if (task.trigger.signatureHeader) {
    secret = randomBytes(32).toString("hex");
    await secrets.setInternalKey(linkSecretKey(taskId), secret, 128);
  } else {
    await secrets.deleteKey(linkSecretKey(taskId));
  }
  if (!(await triggerStore.setTokenHash(taskId, hashTaskLinkToken(token)))) throw new Error("This task doesn't run from a link.");
  ipcMain.broadcast("schedule:updated", { taskId });
  return { url: `${base}/hooks/tasks/${token}`, ...(secret ? { secret } : {}) };
}

/** Whether a link task has a link, whether the listener is on, and its recent calls (never the link). */
export async function taskTriggerLinkState(taskId: string): Promise<{ hasLink: boolean; needsNewLink: boolean; listenerOn: boolean; log: TaskLinkLogEntry[] }> {
  const state = await triggerStore.linkState(taskId);
  return { hasLink: state?.hasLink ?? false, needsNewLink: state?.needsNewLink ?? false, listenerOn: (await listenerBase()) !== null, log: state?.log ?? [] };
}

/** The foreground Find sources step of a connected-app task: lists sources through connections that are already open. */
export function findTaskConnectorSources(signal: AbortSignal): Promise<BotConnectorWatchSourceList> {
  return taskConnectorTriggers.findSources(signal);
}

/** The Find sources choices a save swaps for an exact source and then uses up (see the schedule:save handler). */
export const taskConnectorChoices = {
  takeChoice: taskConnectorTriggers.takeChoice,
  forgetChoice: taskConnectorTriggers.forgetChoice,
};

/** Bind a saved connected-app task to its source; its first check then records a baseline. */
export async function bindTaskConnectorSource(taskId: string, source: TaskConnectorSource): Promise<void> {
  await triggers.bindConnectorSource(taskId, source);
  if ((await scheduleStore.get(taskId))?.lastError === TASK_CONNECTOR_NEEDS_SOURCE) {
    await scheduleStore.updateRuntime(taskId, { lastError: undefined });
  }
  ipcMain.broadcast("schedule:updated", { taskId });
}

/** A connected-app task that is on without a bound source shows that it needs one. */
export async function markTaskNeedsSource(taskId: string): Promise<void> {
  const task = await scheduleStore.get(taskId);
  if (!task || task.lastError === TASK_CONNECTOR_NEEDS_SOURCE) return;
  await scheduleStore.updateRuntime(taskId, { lastError: TASK_CONNECTOR_NEEDS_SOURCE });
  ipcMain.broadcast("schedule:updated", { taskId });
}
