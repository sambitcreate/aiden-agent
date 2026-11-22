import assert from "node:assert/strict";
import test from "node:test";
import { createScheduledTaskApplicationService, scheduledTaskRevision } from "./scheduled-task-application-service.js";
import { scheduledSettingsPatch } from "./scheduled-settings-core.js";
import type { AppSettings, McpServer, ScheduledRun, ScheduledTask, ScheduledTaskInput } from "./types.js";

function fixture(
  mcpServers: McpServer[] = [],
  settingsPatch: (input: Record<string, unknown>) => Partial<AppSettings> = (input) =>
    ({ ...(typeof input.enabled === "boolean" ? { scheduledTasksEnabled: input.enabled } : {}) }),
) {
  let clock = 10;
  let settings: AppSettings = {};
  const tasks = new Map<string, ScheduledTask>();
  const runs = new Map<string, ScheduledRun[]>();
  const savedOptions: Array<{ expectedUpdatedAt?: number; runId?: string }> = [];
  const checkBackSwitches: boolean[] = [];
  const service = createScheduledTaskApplicationService({
    store: {
      list: async () => [...tasks.values()],
      get: async (id) => tasks.get(id),
      runs: async (id) => runs.get(id) ?? [],
      clearOriginChat: async (id, options = {}) => {
        const existing = tasks.get(id);
        if (options.expectedUpdatedAt !== undefined && existing?.updatedAt !== options.expectedUpdatedAt) {
          throw new Error("This automation changed.");
        }
        if (!existing?.originChatId) return undefined;
        clock += 1;
        const { originChatId: _dropped, ...rest } = existing;
        const task: ScheduledTask = { ...rest, updatedAt: clock };
        tasks.set(id, task);
        return task;
      },
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
    listMcpServers: async () => mcpServers,
    validateMcpSelection: () => undefined,
    listScripts: async () => ["safe.sh"],
    nextRuns: (_cron, _timezone, count) => Array.from({ length: count }, (_, index) => index + 1),
    systemTimezone: () => "UTC",
    validateTimezone: (value) => value,
    settingsPatch,
    notifyChanged: () => undefined,
    chatCheckBacksChanged: (enabled) => {
      checkBackSwitches.push(enabled);
    },
  });
  return { service, tasks, savedOptions, checkBackSwitches, storedSettings: () => settings };
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

test("Use its own chat drops a task's chat binding only on the current revision", async () => {
  const value = fixture();
  const task = await value.service.save({ name: "Chat task", mode: "llm", cron: "0 9 * * *", timezone: "UTC", permission: "read-only", prompt: "hello" });
  value.tasks.set(task.id, { ...task, originChatId: "chat-1" });
  const bound = value.tasks.get(task.id)!;
  await assert.rejects(value.service.useOwnChat(task.id, "rev_stale"), /changed/u);
  assert.equal(value.tasks.get(task.id)?.originChatId, "chat-1");
  const moved = await value.service.useOwnChat(task.id, scheduledTaskRevision(bound));
  assert.equal(moved.originChatId, undefined);
  assert.equal(value.tasks.get(task.id)?.originChatId, undefined);
  assert.notEqual(scheduledTaskRevision(moved), scheduledTaskRevision(bound), "the move is a new revision");
  const again = await value.service.useOwnChat(task.id, scheduledTaskRevision(moved));
  assert.equal(again.originChatId, undefined, "moving an unbound task is a no-op");
});

test("Bot routines stay out of the generic automation surfaces", async () => {
  const value = fixture();
  const ordinary = await value.service.save({
    name: "Ordinary", mode: "llm", cron: "* * * * *", timezone: "UTC",
    permission: "read-only", prompt: "hello",
  });
  value.tasks.set("routine-1", {
    ...ordinary,
    id: "routine-1",
    name: "Weekly meal prep",
    botId: "bot-chef",
    routineSchedule: { kind: "weekly", days: [0], time: "08:41" },
  });

  assert.deepEqual((await value.service.list()).map((task) => task.id), [ordinary.id]);
  await assert.rejects(value.service.get("routine-1"), /not found/u);
  await assert.rejects(value.service.runs("routine-1"), /not found/u);
  await assert.rejects(value.service.pause("routine-1"), /not found/u);
  await assert.rejects(value.service.remove("routine-1"), /not found/u);
  await assert.rejects(value.service.runNow("routine-1"), /not found/u);
  await assert.rejects(
    value.service.save({ id: "routine-1", name: "Hijack", mode: "llm", cron: "* * * * *", prompt: "x" }),
    /not found/u,
  );
  assert.equal(value.tasks.get("routine-1")?.name, "Weekly meal prep");
});

test("the schedule server picker (desktop and Remote) lists only servers a schedule can use", async () => {
  const remote = (id: string, patch: Partial<McpServer> = {}): McpServer => ({ id, name: id, transport: "http", url: `https://${id}.test`, enabled: true, ...patch });
  const value = fixture([remote("gmail"), remote("off", { enabled: false }), remote("hidden", { exposure: "hidden" }), remote("partial", { hiddenTools: ["send"] })]);
  assert.deepEqual(await value.service.mcpServers(), [{ id: "gmail", name: "gmail" }, { id: "partial", name: "partial" }]);
});

test("check-backs are on by default, and only a change of the switch reaches follow-through", async () => {
  const value = fixture([], (input) => scheduledSettingsPatch(input, (zone) => zone));
  const initial = await value.service.settings();
  assert.equal(initial.value.chatCheckBacks, true);
  const off = await value.service.updateSettings(initial.revision, { chatCheckBacks: false });
  assert.equal(off.value.chatCheckBacks, false);
  assert.notEqual(off.revision, initial.revision);
  // An unrelated edit, and saving the same value again, cancel nothing more.
  const notify = await value.service.updateSettings(off.revision, { defaultNotify: false });
  await value.service.updateSettings(notify.revision, { chatCheckBacks: false });
  assert.deepEqual(value.checkBackSwitches, [false]);
  const latest = await value.service.settings();
  await value.service.updateSettings(latest.revision, { chatCheckBacks: true });
  assert.deepEqual(value.checkBackSwitches, [false, true]);
});

test("keep this computer awake is on by default and only an off choice is stored", async () => {
  const value = fixture([], (input) => scheduledSettingsPatch(input, (zone) => zone));
  const initial = await value.service.settings();
  assert.equal(initial.value.keepAwakeWhileWorking, true);

  const off = await value.service.updateSettings(initial.revision, { keepAwakeWhileWorking: false });
  assert.equal(off.value.keepAwakeWhileWorking, false);
  assert.equal(value.storedSettings().keepAwakeWhileWorking, false);
  assert.notEqual(off.revision, initial.revision);

  const on = await value.service.updateSettings(off.revision, { keepAwakeWhileWorking: true });
  assert.equal(on.value.keepAwakeWhileWorking, true);
  // Back to the default: nothing is stored, so a saved file never says `true`.
  assert.equal(JSON.parse(JSON.stringify(value.storedSettings())).keepAwakeWhileWorking, undefined);
});
