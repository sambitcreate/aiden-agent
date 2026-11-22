// Production wiring for chat tasks that run when something happens: the
// bookkeeping file, the schedule service and execution, and the watch sources.

import { randomBytes } from "node:crypto";
import path from "node:path";
import { ipcMain, logger } from "../platform.js";
import { fetchBotWatchUrl } from "./bot-routine-events/watch-sources.js";
import { DataStore } from "./data-store.js";
import { scheduleExecution } from "./schedule-execution.js";
import { resolveScheduledScript, runScheduledScript } from "./schedule-script.js";
import { scheduleService } from "./schedule-service.js";
import { scheduleStore } from "./schedule-store.js";
import { createScheduledTaskTriggers } from "./scheduled-task-triggers.js";
import { SCHEDULED_TASK_TRIGGERS_FILE, createScheduledTaskTriggerStore, hashTaskLinkToken, type TaskLinkLogEntry } from "./scheduled-task-triggers-store.js";
import { secrets } from "./secrets.js";

/** Where a link task's signing secret lives; the agent and phones never see it. */
const linkSecretKey = (taskId: string) => `aiden-internal:task-hook:${taskId}`;

const triggerStore = createScheduledTaskTriggerStore({
  persistence: new DataStore<unknown>(SCHEDULED_TASK_TRIGGERS_FILE, { version: 1, tasks: {} }),
  tasks: () => scheduleStore.list(),
  pauseTask: async (taskId, reason) => {
    await scheduleStore.updateRuntime(taskId, {
      enabled: false,
      lastError: `Paused after 3 failed checks${reason ? `: ${reason}` : "."}`.slice(0, 4_096),
    });
    ipcMain.broadcast("schedule:updated", { taskId });
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
  fetchUrl: (url, signal) => fetchBotWatchUrl(url, { signal }),
  resolveScript: async (task, script) => {
    if (task.permission !== "full") throw new Error("A script watch needs Full permission.");
    const folder = await scheduleExecution.taskWorkspaceFolder(task);
    const scriptPath = await resolveScheduledScript({ script, workspaceRoot: folder });
    return { path: scriptPath, cwd: folder ?? path.dirname(scriptPath) };
  },
  execScript: (scriptPath, options) => runScheduledScript(scriptPath, options),
  linkSecret: (taskId) => secrets.getKey(linkSecretKey(taskId)),
  checkStateDir: async () => path.join((await import("../platform.js")).app.getPath("userData"), "scheduled-task-check-state"),
  paused: async (task, error) => {
    await scheduleExecution.recordInLandingChat(task, {
      tone: "failure",
      summary: "Paused after 3 failed checks",
      text: `Scheduled task "${task.name}" was paused: its watch failed 3 times in a row${error ? ` (${error})` : ""}. Check the address or script, then turn the task back on.`,
    });
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
export async function deliverTaskTriggerWebhook(request: { token: string; contentType?: string; signature?: string; body: Uint8Array }) {
  if (!started) return { status: 404 as const };
  return triggers.webhook.deliver(request);
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
export async function taskTriggerLinkState(taskId: string): Promise<{ hasLink: boolean; listenerOn: boolean; log: TaskLinkLogEntry[] }> {
  const state = await triggerStore.linkState(taskId);
  return { hasLink: state?.hasLink ?? false, listenerOn: (await listenerBase()) !== null, log: state?.log ?? [] };
}
