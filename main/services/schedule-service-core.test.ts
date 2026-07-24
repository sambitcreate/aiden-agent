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
