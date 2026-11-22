import assert from "node:assert/strict";
import test from "node:test";
import { AidenRemoteScheduleService } from "./aiden-remote-schedules.js";
import { createScheduleStore } from "./schedule-store.js";
import { scheduledTaskRevision } from "./scheduled-task-application-service.js";
import type { ScheduledRun, ScheduledTask, ScheduledTaskInput } from "./types.js";

function fixture() {
  let clock = 100;
  let runStarts = 0;
  const tasks = new Map<string, ScheduledTask>();
  const histories = new Map<string, ScheduledRun[]>();
  let settingsValue = {
    revision: "rev_settings",
    value: {
      enabled: true, defaultMode: "llm" as const, defaultPermission: "read-only" as const,
      defaultMcpEnabled: false, defaultNotify: true, defaultTimezone: "UTC",
    },
  };
  const application = {
    list: async () => [...tasks.values()],
    get: async (id: string) => {
      const task = tasks.get(id);
      if (!task) throw new Error(`Scheduled task ${id} not found.`);
      return task;
    },
    save: async (input: ScheduledTaskInput, options: { expectedRevision?: string } = {}) => {
      const existing = input.id ? tasks.get(input.id) : undefined;
      if (options.expectedRevision && (!existing || options.expectedRevision !== scheduledTaskRevision(existing))) {
        throw new Error("This automation changed.");
      }
      const updatedAt = ++clock;
      const task: ScheduledTask = {
        id: existing?.id ?? `task-${tasks.size + 1}`, name: input.name, enabled: true,
        mode: input.mode, cron: input.cron, timezone: input.timezone ?? "UTC",
        workspaceId: input.workspaceId, providerId: input.providerId, model: input.model,
        prompt: input.prompt, script: input.script, permission: input.permission ?? "read-only",
        mcpServerIds: input.mcpServerIds, notify: input.notify ?? true,
        providerFingerprint: "private-provider-fingerprint", chatId: "private-chat",
        mcpServerBindings: [{ id: "mcp-1", fingerprint: "private-mcp-fingerprint" }],
        createdAt: existing?.createdAt ?? updatedAt, updatedAt,
      };
      tasks.set(task.id, task);
      return task;
    },
    remove: async (id: string) => { tasks.delete(id); },
    pause: async (id: string) => {
      const next = { ...tasks.get(id)!, enabled: false, updatedAt: ++clock };
      tasks.set(id, next);
      return next;
    },
    resume: async (id: string) => {
      const next = { ...tasks.get(id)!, enabled: true, updatedAt: ++clock };
      tasks.set(id, next);
      return next;
    },
    runNow: async (id: string, runId?: string, revision?: string) => {
      const task = tasks.get(id);
      if (!task || revision !== scheduledTaskRevision(task)) {
        throw new Error("This automation changed.");
      }
      runStarts += 1;
      const run: ScheduledRun = {
        id: runId ?? "run-local", taskId: id, startedAt: 1, finishedAt: 2,
        result: "success", output: "read /Users/private/project and token_secretvalue123456",
        routineTiming: { scheduledFor: 0, timezone: "Pacific/Auckland" },
      };
      histories.set(id, [run]);
      return undefined;
    },
    runs: async (id: string) => histories.get(id) ?? [],
    preview: (_cron: string, _timezone: string, count = 3) => Array.from({ length: count }, (_, index) => 1_000 + index),
    scripts: async () => ["safe.sh"],
    mcpServers: async () => [{ id: "mcp-1", name: "GitHub" }],
    settings: async () => settingsValue,
    updateSettings: async (_revision: string, patch: Record<string, unknown>) => {
      settingsValue = { ...settingsValue, revision: "rev_settings_2", value: { ...settingsValue.value, ...patch } } as typeof settingsValue;
      return settingsValue;
    },
    isRunning: () => false,
  };
  const service = new AidenRemoteScheduleService({
    application,
    models: {
      resolve: async () => ({
        providerId: "provider-1",
        modelId: "model-1",
        thinkingLevels: [],
        supportsImages: true,
      }),
    },
  });
  return { service, tasks, histories, application, runStarts: () => runStarts };
}

const llmMutation = {
  name: "Morning review", schedule: "0 8 * * *", timezone: "UTC", mode: "llm",
  permission: "read-only", prompt: "Summarize the workspace", confirmedForeground: true,
};

test("scheduled-task projections omit runtime authority and script selections are opaque and device bound", async () => {
  const value = fixture();
  const created = await value.service.create("device-1", "create-key-123456", llmMutation);
  const serialized = JSON.stringify(created);
  assert.doesNotMatch(serialized, /fingerprint|private-chat|\/Users\//u);
  assert.equal(created.providerId, "provider-1");
  assert.equal(created.prompt, "Summarize the workspace");

  const inventory = await value.service.scripts("device-1", "workspace-1");
  assert.match(inventory.scripts[0]!.id, /^script_[A-Za-z0-9_-]{43}$/u);
  await assert.rejects(
    value.service.create("device-2", "script-key-123456", {
      name: "Script", schedule: "0 9 * * *", timezone: "UTC", mode: "script",
      permission: "full", scriptId: inventory.scripts[0]!.id, workspaceId: "workspace-1",
      confirmedForeground: true,
    }),
    /another device/u,
  );
  const script = await value.service.create("device-1", "script-key-654321", {
    name: "Script", schedule: "0 9 * * *", timezone: "UTC", mode: "script",
    permission: "full", scriptId: inventory.scripts[0]!.id, workspaceId: "workspace-1",
    confirmedForeground: true,
  });
  assert.ok(script.scriptId);
  assert.doesNotMatch(JSON.stringify(script), /safe\.sh|\/Users\//u);
  assert.deepEqual(await value.service.mcpServers(), {
    servers: [{ id: "mcp-1", name: "GitHub" }],
  });
});

test("scheduled task run retries reuse one accepted run and history is bounded and redacted", async () => {
  const value = fixture();
  const created = await value.service.create("device-1", "create-key-123456", llmMutation);
  await assert.rejects(
    value.service.run("device-1", created.id, "revision:stale", "stale-run-key-1234"),
    /changed/u,
  );
  assert.equal(value.runStarts(), 0);
  const first = await value.service.run("device-1", created.id, created.revision, "run-key-12345678");
  const replay = await value.service.run("device-1", created.id, created.revision, "run-key-12345678");
  assert.deepEqual(replay, first);
  assert.equal(value.runStarts(), 1);
  const updated = await value.service.update("device-1", created.id, created.revision, {
    ...llmMutation,
    name: "Updated morning review",
  });
  await assert.rejects(
    value.service.run("device-1", created.id, updated.revision, "run-key-12345678"),
    (error: unknown) => (
      (error as { code?: string; status?: number }).code === "idempotency_conflict"
      && (error as { status?: number }).status === 409
    ),
  );
  assert.equal(value.runStarts(), 1);
  const history = await value.service.runs(created.id);
  assert.equal(history.runs[0]?.id, first.runId);
  assert.match(history.runs[0]?.summary ?? "", /\[local path\]/u);
  assert.doesNotMatch(history.runs[0]?.summary ?? "", /secretvalue|\/Users\//u);
  assert.equal("routineTiming" in history.runs[0]!, false, "private occurrence metadata does not expand the legacy run DTO");
});

test("accepted execution remains scheduler-owned after the remote caller disconnects", async () => {
  const value = fixture();
  const created = await value.service.create("device-1", "create-key-123456", llmMutation);
  let finish!: () => void;
  const completion = new Promise<void>((resolve) => { finish = resolve; });
  value.application.runNow = async (id: string, runId?: string) => {
    void completion.then(() => {
      value.histories.set(id, [{
        id: runId ?? "run-local", taskId: id, startedAt: 1, finishedAt: 2,
        result: "success", output: "completed without the caller",
      }]);
    });
    return undefined;
  };

  const accepted = await value.service.run("device-1", created.id, created.revision, "disconnect-key-1234");
  assert.deepEqual((await value.service.runs(created.id)).runs, []);
  finish();
  await completion;
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal((await value.service.runs(created.id)).runs[0]?.id, accepted.runId);
});

test("scheduled notifications aggregate completed runs across tasks since a cursor", async () => {
  const value = fixture();
  const first = await value.service.create("device-1", "create-key-123456", llmMutation);
  const second = await value.service.create("device-1", "create-key-654321", { ...llmMutation, name: "Evening sweep" });
  await value.service.run("device-1", first.id, first.revision, "run-key-12345678");
  await value.service.run("device-1", second.id, second.revision, "run-key-87654321");

  const all = await value.service.notifications();
  assert.equal(all.notifications.length, 2);
  assert.equal(typeof all.now, "number");
  assert.deepEqual(
    all.notifications.map((item) => item.taskName).sort(),
    ["Evening sweep", "Morning review"],
  );
  assert.ok(all.notifications.every((item) => item.status === "succeeded" && item.notify === true));
  assert.ok(all.notifications.every((item) => !("routineTiming" in item)), "legacy notifications retain their negotiated shape");

  // Inclusive cursor: runs exactly at the boundary are re-delivered (clients
  // dedupe by run id) so same-millisecond siblings can never be skipped.
  const boundary = await value.service.notifications(2);
  assert.equal(boundary.notifications.length, 2);

  const filtered = await value.service.notifications(3);
  assert.equal(filtered.notifications.length, 0);

  const future = await value.service.notifications(1);
  assert.equal(future.notifications.length, 2);

  const serialized = JSON.stringify(all);
  assert.doesNotMatch(serialized, /fingerprint|private-chat/u);
  assert.match(serialized, /\[local path\]/u);
});

test("scheduled task mutations require foreground confirmation and stale edits fail explicitly", async () => {
  const value = fixture();
  await assert.rejects(
    value.service.create("device-1", "create-key-123456", { ...llmMutation, confirmedForeground: false }),
    /foreground review/u,
  );
  const created = await value.service.create("device-1", "create-key-654321", llmMutation);
  await assert.rejects(
    value.service.update("device-1", created.id, "rev_stale", llmMutation),
    /changed/u,
  );
  await assert.rejects(
    value.service.updateSettings("rev_settings", {
      confirmedForeground: true,
      defaultMode: "garbage",
    }),
    /settings are invalid/u,
  );
});

class MemoryPersistence<T> {
  constructor(private data: T) {}
  async load(): Promise<T> { return structuredClone(this.data); }
  async update<R>(mutation: (draft: T) => R | Promise<R>): Promise<R> {
    const draft = structuredClone(this.data);
    const result = await mutation(draft);
    this.data = draft;
    return result;
  }
}

test("a phone edit keeps the chat a task posts into, and the phone never sees which chat it is", async () => {
  const store = createScheduleStore(new MemoryPersistence<unknown[]>([]), new MemoryPersistence<unknown[]>([]), () => 1_800_000_000_000);
  const seeded = await store.save({
    name: "Morning review", mode: "llm", cron: "0 8 * * *", timezone: "UTC", workspaceId: "workspace-1",
    prompt: "Summarize the workspace", originChatId: "chat-private-1",
  });
  const base = fixture().application;
  const service = new AidenRemoteScheduleService({
    application: {
      ...base,
      list: () => store.list(),
      get: async (id: string) => (await store.list()).find((task) => task.id === id)!,
      save: async (input: ScheduledTaskInput, options: { expectedRevision?: string } = {}) => {
        const existing = (await store.list()).find((task) => task.id === input.id);
        if (options.expectedRevision && (!existing || options.expectedRevision !== scheduledTaskRevision(existing))) {
          throw new Error("This automation changed.");
        }
        return store.save(input);
      },
    },
    models: { resolve: async () => ({ providerId: "provider-1", modelId: "model-1", thinkingLevels: [], supportsImages: true }) },
  });

  const projected = await service.get("device-1", seeded.id);
  const edited = await service.update("device-1", seeded.id, projected.revision, {
    ...llmMutation, name: "Evening review", schedule: "0 18 * * *", workspaceId: "workspace-1",
  });
  assert.equal(edited.name, "Evening review");
  assert.doesNotMatch(JSON.stringify(edited), /chat-private-1|originChatId/u);
  const stored = (await store.list()).find((task) => task.id === seeded.id);
  assert.equal(stored?.originChatId, "chat-private-1");
  assert.equal(stored?.cron, "0 18 * * *");

  await assert.rejects(
    service.update("device-1", seeded.id, edited.revision, { ...llmMutation, workspaceId: "workspace-1", originChatId: "chat-2" }),
    "a phone cannot name the chat",
  );
  await assert.rejects(
    service.update("device-1", seeded.id, edited.revision, { ...llmMutation, workspaceId: "workspace-1", schedule: "*/5 * * * *" }),
    /15 minutes/u,
    "a phone cannot speed a chat task past the floor",
  );
  assert.equal((await store.list()).find((task) => task.id === seeded.id)?.originChatId, "chat-private-1");
});
