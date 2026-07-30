import assert from "node:assert/strict";
import test from "node:test";
import { createScheduleServiceCore } from "./schedule-service-core.js";
import { createScheduleStore } from "./schedule-store.js";
import type { ScheduledRun, ScheduledTask } from "./types.js";

class MemoryPersistence<T> {
  constructor(private data: T) {}

  async load(): Promise<T> {
    return structuredClone(this.data);
  }

  async update<R>(mutation: (draft: T) => R | Promise<R>): Promise<R> {
    const draft = structuredClone(this.data);
    const result = await mutation(draft);
    this.data = draft;
    return result;
  }
}

function harness() {
  const store = createScheduleStore(
    new MemoryPersistence<unknown[]>([]),
    new MemoryPersistence<unknown[]>([]),
  );
  const broadcasts: Array<Record<string, unknown>> = [];
  const pending = new Map<string, (run: ScheduledRun) => void>();
  let cancelAllCalls = 0;
  const execution = {
    run: (task: ScheduledTask) =>
      new Promise<ScheduledRun>((resolve) => {
        pending.set(task.id, resolve);
      }),
    cancel: (taskId: string) => {
      const resolve = pending.get(taskId);
      resolve?.({
        id: `run-${taskId}`,
        taskId,
        startedAt: 1,
        finishedAt: 2,
        result: "blocked",
        output: "",
        error: "cancelled",
      });
      pending.delete(taskId);
      return Boolean(resolve);
    },
    cancelAll: () => {
      cancelAllCalls += 1;
      for (const [taskId, resolve] of pending) {
        resolve({
          id: `run-${taskId}`,
          taskId,
          startedAt: 1,
          finishedAt: 2,
          result: "blocked",
          output: "",
          error: "cancelled",
        });
      }
      pending.clear();
    },
  };
  const service = createScheduleServiceCore({
    store,
    execution,
    globallyEnabled: async () => true,
    broadcast: (payload) => broadcasts.push(payload),
    warn: () => undefined,
    error: () => undefined,
  });
  return {
    store,
    service,
    broadcasts,
    cancelAllCalls: () => cancelAllCalls,
    hasPending: (taskId: string) => pending.has(taskId),
  };
}

async function addTask(store: ReturnType<typeof harness>["store"]) {
  return store.save({
    name: "Daily brief",
    mode: "llm",
    cron: "0 9 * * *",
    timezone: "UTC",
    prompt: "Summarize changes.",
  });
}

test("global kill switch cancels and settles live runs without deleting or pausing tasks", async () => {
  const testbed = harness();
  const task = await addTask(testbed.store);
  await testbed.service.start();
  const run = testbed.service.runNow(task.id);
  while (!testbed.hasPending(task.id)) await new Promise((resolve) => setImmediate(resolve));
  assert.equal(testbed.service.isRunning(task.id), true);
  await testbed.service.setGlobalEnabled(false);
  assert.equal((await run).result, "blocked");
  assert.equal(testbed.service.isRunning(task.id), false);
  assert.equal((await testbed.store.get(task.id))?.enabled, true);
  assert.equal(testbed.cancelAllCalls(), 1);
  assert.deepEqual(testbed.broadcasts[testbed.broadcasts.length - 1], { globallyEnabled: false });
  testbed.service.stop();
});

test("removing a live task waits for cancellation before deleting its state", async () => {
  const testbed = harness();
  const task = await addTask(testbed.store);
  await testbed.service.start();
  const run = testbed.service.runNow(task.id);
  while (!testbed.hasPending(task.id)) await new Promise((resolve) => setImmediate(resolve));
  await testbed.service.remove(task.id);
  assert.equal((await run).result, "blocked");
  assert.equal(await testbed.store.get(task.id), undefined);
  assert.equal(testbed.service.isRunning(task.id), false);
  testbed.service.stop();
});

test("pausing a live task waits for cancellation before persisting the pause", async () => {
  const testbed = harness();
  const task = await addTask(testbed.store);
  await testbed.service.start();
  const run = testbed.service.runNow(task.id);
  while (!testbed.hasPending(task.id)) await new Promise((resolve) => setImmediate(resolve));
  const paused = await testbed.service.pause(task.id);
  assert.equal((await run).result, "blocked");
  assert.equal(paused.enabled, false);
  assert.equal(testbed.service.isRunning(task.id), false);
  testbed.service.stop();
});

test("workspace revocation cancels and settles matching scheduled runs only", async () => {
  const testbed = harness();
  const first = await testbed.store.save({
    name: "First",
    mode: "llm",
    cron: "0 9 * * *",
    timezone: "UTC",
    workspaceId: "workspace-a",
    prompt: "Summarize changes.",
  });
  const second = await testbed.store.save({
    name: "Second",
    mode: "llm",
    cron: "0 10 * * *",
    timezone: "UTC",
    workspaceId: "workspace-b",
    prompt: "Summarize changes.",
  });
  await testbed.service.start();
  const firstRun = testbed.service.runNow(first.id);
  const secondRun = testbed.service.runNow(second.id);
  while (!testbed.hasPending(first.id) || !testbed.hasPending(second.id)) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  await testbed.service.cancelWorkspace("workspace-a");
  assert.equal((await firstRun).result, "blocked");
  assert.equal(testbed.service.isRunning(first.id), false);
  assert.equal(testbed.service.isRunning(second.id), true);
  await assert.rejects(testbed.service.runNow(first.id), /workspace is changing or unavailable/iu);
  await testbed.service.resumeWorkspace("workspace-a");
  const resumedFirstRun = testbed.service.runNow(first.id);
  while (!testbed.hasPending(first.id)) await new Promise((resolve) => setImmediate(resolve));
  testbed.service.stop();
  assert.equal((await secondRun).result, "blocked");
  assert.equal((await resumedFirstRun).result, "blocked");
});

test("resumeWorkspace clears admission after cancelWorkspace enumeration fails", async () => {
  const testbed = harness();
  const task = await testbed.store.save({
    name: "Recoverable",
    mode: "llm",
    cron: "0 9 * * *",
    timezone: "UTC",
    workspaceId: "workspace-a",
    prompt: "Summarize changes.",
  });
  await testbed.service.start();
  const originalList = testbed.store.list;
  Object.defineProperty(testbed.store, "list", {
    configurable: true,
    value: async () => {
      throw new Error("simulated list failure");
    },
  });
  await assert.rejects(testbed.service.cancelWorkspace("workspace-a"), /simulated list failure/u);
  Object.defineProperty(testbed.store, "list", {
    configurable: true,
    value: originalList,
  });
  await testbed.service.resumeWorkspace("workspace-a");

  const run = testbed.service.runNow(task.id);
  while (!testbed.hasPending(task.id)) await new Promise((resolve) => setImmediate(resolve));
  testbed.service.stop();
  assert.equal((await run).result, "blocked");
});

test("concurrent lifecycle mutations serialize per task", async () => {
  const testbed = harness();
  const task = await addTask(testbed.store);
  await testbed.service.start();
  await Promise.all([testbed.service.pause(task.id), testbed.service.resume(task.id)]);
  const latest = await testbed.store.get(task.id);
  assert.equal(latest?.enabled, true);
  assert.ok(latest?.nextRunAt);
  testbed.service.stop();
});

test("revision-checked saves update one task and reject stale overwrites", async () => {
  const testbed = harness();
  const task = await addTask(testbed.store);
  const edited = await testbed.service.save(
    {
      id: task.id,
      name: task.name,
      enabled: task.enabled,
      mode: task.mode,
      cron: task.cron,
      timezone: "America/New_York",
      prompt: task.prompt,
      permission: task.permission,
      notify: task.notify,
    },
    { expectedUpdatedAt: task.updatedAt },
  );
  assert.equal(edited.id, task.id);
  assert.equal(edited.timezone, "America/New_York");
  assert.equal((await testbed.store.list()).length, 1);

  await assert.rejects(
    testbed.service.save(
      {
        id: task.id,
        name: task.name,
        enabled: task.enabled,
        mode: task.mode,
        cron: "0 10 * * *",
        timezone: task.timezone,
        prompt: task.prompt,
        permission: task.permission,
        notify: task.notify,
      },
      { expectedUpdatedAt: task.updatedAt },
    ),
    /changed before the edit was saved/iu,
  );
  assert.equal((await testbed.store.get(task.id))?.cron, "0 9 * * *");
});
