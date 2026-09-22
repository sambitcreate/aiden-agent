import assert from "node:assert/strict";
import test from "node:test";
import { createScheduledTaskApplicationService, scheduledTaskRevision } from "./scheduled-task-application-service.js";
import type { AppSettings, ScheduledRun, ScheduledTask, ScheduledTaskInput } from "./types.js";

function fixture() {
  let clock = 10;
  let settings: AppSettings = {};
  const tasks = new Map<string, ScheduledTask>();
  const runs = new Map<string, ScheduledRun[]>();
  const savedOptions: Array<{ expectedUpdatedAt?: number; runId?: string }> = [];
  const service = createScheduledTaskApplicationService({
    store: {
      list: async () => [...tasks.values()],
      get: async (id) => tasks.get(id),
      runs: async (id) => runs.get(id) ?? [],
    },
    service: {
      save: async (input: ScheduledTaskInput, options = {}) => {
        savedOptions.push({ expectedUpdatedAt: options.expectedUpdatedAt });
        const existing = input.id ? tasks.get(input.id) : undefined;
        if (options.expectedUpdatedAt !== undefined && existing?.updatedAt !== options.expectedUpdatedAt) {
          throw new Error("revision");
        }
        clock += 1;
        const task: ScheduledTask = {
          id: existing?.id ?? "task-1", name: input.name, enabled: input.enabled ?? true,
          mode: input.mode, cron: input.cron, timezone: input.timezone ?? "UTC",
          workspaceId: input.workspaceId, providerId: input.providerId, model: input.model,
          prompt: input.prompt, script: input.script, permission: input.permission ?? "read-only",
          mcpServerIds: input.mcpServerIds, notify: input.notify ?? true,
          createdAt: existing?.createdAt ?? clock, updatedAt: clock,
        };
        tasks.set(task.id, task);
        return task;
      },
      remove: async (id, options = {}) => {
        savedOptions.push({ expectedUpdatedAt: options.expectedUpdatedAt });
        if (tasks.get(id)?.updatedAt !== options.expectedUpdatedAt) throw new Error("revision");
        tasks.delete(id);
      },
      pause: async (id, options = {}) => {
        savedOptions.push({ expectedUpdatedAt: options.expectedUpdatedAt });
        const task = tasks.get(id)!;
        if (task.updatedAt !== options.expectedUpdatedAt) throw new Error("revision");
        const next = { ...task, enabled: false, updatedAt: ++clock };
        tasks.set(id, next);
        return next;
      },
      resume: async (id, options = {}) => {
        const task = tasks.get(id)!;
        if (task.updatedAt !== options.expectedUpdatedAt) throw new Error("revision");
        const next = { ...task, enabled: true, updatedAt: ++clock };
        tasks.set(id, next);
        return next;
      },
      runNow: async (id, options = {}) => {
        savedOptions.push({ runId: options.runId, expectedUpdatedAt: options.expectedUpdatedAt });
        if (options.expectedUpdatedAt !== undefined && tasks.get(id)?.updatedAt !== options.expectedUpdatedAt) {
          throw new Error("revision");
        }
        const run: ScheduledRun = { id: options.runId ?? "run-local", taskId: id, startedAt: 1, finishedAt: 2, result: "success", output: "ok" };
        runs.set(id, [run]);
        return run;
      },
      setGlobalEnabled: async () => undefined,
      isRunning: () => false,
    },
    getSettings: async () => settings,
    setSettings: async (patch) => (settings = { ...settings, ...patch }),
    getWorkspace: async (id) => id === "workspace-1" ? ({ id, name: "One", permission: "full", folderPath: "/safe", createdAt: 1, updatedAt: 1 }) : undefined,
    listMcpServers: async () => [],
    validateMcpSelection: () => undefined,
    listScripts: async () => ["safe.sh"],
    nextRuns: (_cron, _timezone, count) => Array.from({ length: count }, (_, index) => index + 1),
    systemTimezone: () => "UTC",
    validateTimezone: (value) => value,
    settingsPatch: (input) => ({ ...(typeof input.enabled === "boolean" ? { scheduledTasksEnabled: input.enabled } : {}) }),
    notifyChanged: () => undefined,
  });
  return { service, tasks, savedOptions };
}

test("shared scheduled-task service validates inventory and carries revisions into lifecycle commits", async () => {
  const value = fixture();
  await assert.rejects(
    value.service.save({ name: "Unsafe", mode: "script", cron: "* * * * *", timezone: "UTC", permission: "full", script: "raw.sh" }),
    /inventory/u,
  );
  const task = await value.service.save({ name: "Safe", mode: "script", cron: "* * * * *", timezone: "UTC", permission: "full", script: "safe.sh", workspaceId: "workspace-1" });
  const revision = scheduledTaskRevision(task);
  await assert.rejects(value.service.pause(task.id, "rev_stale"), /changed/u);
  const paused = await value.service.pause(task.id, revision);
  assert.equal(paused.enabled, false);
  assert.equal(value.savedOptions[value.savedOptions.length - 1]?.expectedUpdatedAt, task.updatedAt);
});

test("shared scheduled-task service carries a caller-owned run ID, task revision, and revision-checks settings", async () => {
  const value = fixture();
  const task = await value.service.save({ name: "Run", mode: "llm", cron: "* * * * *", timezone: "UTC", permission: "read-only", prompt: "hello" });
  await assert.rejects(value.service.runNow(task.id, undefined, "rev_stale"), /changed/u);
  await value.service.runNow(task.id, "run_remote", scheduledTaskRevision(task));
  assert.equal(value.savedOptions[value.savedOptions.length - 1]?.runId, "run_remote");
  assert.equal(value.savedOptions[value.savedOptions.length - 1]?.expectedUpdatedAt, task.updatedAt);
  const current = await value.service.settings();
  await assert.rejects(value.service.updateSettings("rev_stale", { enabled: false }), /changed/u);
  const updated = await value.service.updateSettings(current.revision, { enabled: false });
  assert.equal(updated.value.enabled, false);
});

test("concurrent desktop and remote lifecycle edits admit only one revision", async () => {
  const value = fixture();
  const task = await value.service.save({
    name: "Concurrent", mode: "llm", cron: "* * * * *", timezone: "UTC",
    permission: "read-only", prompt: "hello",
  });
  const revision = scheduledTaskRevision(task);
  const results = await Promise.allSettled([
    value.service.pause(task.id, revision),
    value.service.pause(task.id, revision),
  ]);
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal(results.filter((result) => result.status === "rejected").length, 1);
});
