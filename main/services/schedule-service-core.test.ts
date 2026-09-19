import assert from "node:assert/strict";
import test from "node:test";
import { scheduledJobs } from "croner";
import { createScheduleServiceCore } from "./schedule-service-core.js";
import { createScheduleStore } from "./schedule-store.js";
import type { ScheduledRun, ScheduledTask } from "./types.js";

class MemoryPersistence<T> {
  constructor(private data: T) {}

  beforeCommit?: (draft: T) => Promise<void>;

  async load(): Promise<T> {
    return structuredClone(this.data);
  }

  async update<R>(
    mutation: (draft: T) => R | Promise<R>,
    isCurrent: () => boolean = () => true,
  ): Promise<R> {
    if (!isCurrent()) throw new Error("Stale persistence operation.");
    const draft = structuredClone(this.data);
    const result = await mutation(draft);
    await this.beforeCommit?.(draft);
    if (!isCurrent()) throw new Error("Stale persistence operation.");
    this.data = draft;
    return result;
  }
}

function harness(globallyEnabled: () => Promise<boolean> = async () => true) {
  const taskPersistence = new MemoryPersistence<unknown[]>([]);
  const runPersistence = new MemoryPersistence<unknown[]>([]);
  const store = createScheduleStore(
    taskPersistence,
    runPersistence,
  );
  const broadcasts: Array<Record<string, unknown>> = [];
  const errors: string[] = [];
  const pending = new Map<string, (run: ScheduledRun) => void>();
  const deferredCancellations = new Set<string>();
  let deferCancellations = false;
  let cancelAllCalls = 0;
  const execution = {
    run: (task: ScheduledTask) =>
      new Promise<ScheduledRun>((resolve) => {
        pending.set(task.id, resolve);
      }),
    cancel: (taskId: string) => {
      const resolve = pending.get(taskId);
      if (resolve && deferCancellations) {
        deferredCancellations.add(taskId);
        return true;
      }
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
    globallyEnabled,
    broadcast: (payload) => broadcasts.push(payload),
    warn: () => undefined,
    error: (message) => void errors.push(message),
  });
  return {
    store,
    taskPersistence,
    runPersistence,
    service,
    broadcasts,
    errors,
    cancelAllCalls: () => cancelAllCalls,
    hasPending: (taskId: string) => pending.has(taskId),
    holdCancellations: () => void (deferCancellations = true),
    hasDeferredCancellation: (taskId: string) => deferredCancellations.has(taskId),
    releaseCancellation: (taskId: string) => {
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
      deferredCancellations.delete(taskId);
      deferCancellations = false;
    },
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

test("manual runs compare the exact task revision before execution starts", async () => {
  const testbed = harness();
  const task = await addTask(testbed.store);
  await assert.rejects(
    testbed.service.runNow(task.id, { expectedUpdatedAt: task.updatedAt + 1 }),
    /changed.*Refresh/iu,
  );
  assert.equal(testbed.hasPending(task.id), false);
  const run = testbed.service.runNow(task.id, { expectedUpdatedAt: task.updatedAt });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(testbed.hasPending(task.id), true);
  await testbed.service.stopAndSettle();
  await run;
});

test("cancellation after persistence compensates before scheduling the task", async () => {
  const testbed = harness();
  const originalSave = testbed.store.saveWithRollback.bind(testbed.store);
  let entered!: () => void;
  const saveEntered = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let release!: () => void;
  const saveReleased = new Promise<void>((resolve) => {
    release = resolve;
  });
  Object.defineProperty(testbed.store, "saveWithRollback", {
    configurable: true,
    value: async (...args: Parameters<typeof originalSave>) => {
      const saved = await originalSave(...args);
      entered();
      await saveReleased;
      return saved;
    },
  });
  const controller = new AbortController();
  const saving = testbed.service.save(
    {
      name: "Cancelled task",
      mode: "llm",
      cron: "0 9 * * *",
      timezone: "UTC",
      prompt: "Summarize changes.",
    },
    { signal: controller.signal },
  );
  await saveEntered;
  controller.abort();
  release();
  await assert.rejects(saving, /cancelled/iu);
  assert.deepEqual(await testbed.store.list(), []);
  assert.deepEqual(testbed.broadcasts, []);
});

test("cancellation while an edited task run settles leaves the prior task scheduled", async () => {
  const testbed = harness();
  const task = await addTask(testbed.store);
  await testbed.service.start();
  const run = testbed.service.runNow(task.id);
  while (!testbed.hasPending(task.id)) await new Promise((resolve) => setImmediate(resolve));
  testbed.holdCancellations();
  const controller = new AbortController();
  const saving = testbed.service.save(
    {
      ...task,
      name: "Unapproved replacement",
    },
    { expectedUpdatedAt: task.updatedAt, signal: controller.signal },
  );
  while (!testbed.hasDeferredCancellation(task.id)) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  controller.abort();
  testbed.releaseCancellation(task.id);
  await assert.rejects(saving, /cancelled/iu);
  assert.equal((await run).result, "blocked");
  assert.equal((await testbed.store.get(task.id))?.name, task.name);
  testbed.service.stop();
});

test("cancellation while a saved task is being scheduled rolls back persistence and its job", async () => {
  const testbed = harness();
  await testbed.service.start();
  const originalUpdateRuntime = testbed.store.updateRuntime.bind(testbed.store);
  let entered!: () => void;
  const updateEntered = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let release!: () => void;
  const updateReleased = new Promise<void>((resolve) => {
    release = resolve;
  });
  Object.defineProperty(testbed.store, "updateRuntime", {
    configurable: true,
    value: async (...args: Parameters<typeof originalUpdateRuntime>) => {
      entered();
      await updateReleased;
      return originalUpdateRuntime(...args);
    },
  });
  const controller = new AbortController();
  const saving = testbed.service.save(
    {
      name: "Cancelled during scheduling",
      mode: "llm",
      cron: "0 9 * * *",
      timezone: "UTC",
      prompt: "Summarize changes.",
    },
    { signal: controller.signal },
  );
  await updateEntered;
  controller.abort();
  release();
  await assert.rejects(saving, /cancelled/iu);
  assert.deepEqual(await testbed.store.list(), []);
  assert.deepEqual(testbed.broadcasts, []);
  testbed.service.stop();
});

test("aborted pause preserves an already-paused task", async () => {
  const testbed = harness();
  const task = await addTask(testbed.store);
  await testbed.store.setEnabled(task.id, false);
  const original = testbed.store.setEnabled.bind(testbed.store);
  const controller = new AbortController();
  let calls = 0;
  Object.defineProperty(testbed.store, "setEnabled", {
    configurable: true,
    value: async (...args: Parameters<typeof original>) => {
      const result = await original(...args);
      if (++calls === 1) controller.abort();
      return result;
    },
  });
  await assert.rejects(testbed.service.pause(task.id, { signal: controller.signal }), /cancelled/iu);
  assert.equal((await testbed.store.get(task.id))?.enabled, false);
});

test("aborted resume preserves an already-enabled task", async () => {
  const testbed = harness();
  const task = await addTask(testbed.store);
  const original = testbed.store.setEnabled.bind(testbed.store);
  const controller = new AbortController();
  let calls = 0;
  Object.defineProperty(testbed.store, "setEnabled", {
    configurable: true,
    value: async (...args: Parameters<typeof original>) => {
      const result = await original(...args);
      if (++calls === 1) controller.abort();
      return result;
    },
  });
  await assert.rejects(testbed.service.resume(task.id, { signal: controller.signal }), /cancelled/iu);
  assert.equal((await testbed.store.get(task.id))?.enabled, true);
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

test("disabling schedules during startup overrides the pending settings read", async (t) => {
  const settings = deferred<boolean>();
  const testbed = harness(() => settings.promise);
  t.after(() => testbed.service.stop());
  const task = await addTask(testbed.store);
  const overdue = await testbed.store.updateRuntime(task.id, { nextRunAt: 1 });

  const starting = testbed.service.start();
  await testbed.service.setGlobalEnabled(false);
  settings.resolve(true);
  await starting;
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(
    testbed.hasPending(task.id),
    false,
    "the kill switch must prevent catch-up execution",
  );
  assert.deepEqual(
    await testbed.store.get(task.id),
    overdue,
    "cancelled startup must leave the task untouched",
  );
});

test("stopping during startup task lookup preserves the missed run for the next start", async (t) => {
  const testbed = harness();
  t.after(() => testbed.service.stop());
  const task = await addTask(testbed.store);
  const overdue = await testbed.store.updateRuntime(task.id, { nextRunAt: 1 });
  const entered = deferred<void>();
  const release = deferred<void>();
  const originalGet = testbed.store.get.bind(testbed.store);
  let hold = true;
  testbed.store.get = async (id) => {
    const current = await originalGet(id);
    if (hold) {
      hold = false;
      entered.resolve();
      await release.promise;
    }
    return current;
  };

  const starting = testbed.service.start();
  await entered.promise;
  testbed.service.stop();
  release.resolve();
  await starting;
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(await testbed.store.get(task.id), overdue);
  assert.deepEqual(await testbed.store.runs(task.id), [], "shutdown is not a failed task run");
  assert.equal(testbed.hasPending(task.id), false);

  await testbed.service.start();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(testbed.hasPending(task.id), true, "a healthy restart must still catch up");
  assert.ok((await testbed.store.get(task.id))!.nextRunAt! > Date.now());
});

test("an obsolete startup task-read failure cannot disable a task after restart", async (t) => {
  const testbed = harness();
  t.after(() => testbed.service.stop());
  const task = await addTask(testbed.store);
  const entered = deferred<void>();
  const release = deferred<ScheduledTask | undefined>();
  const originalGet = testbed.store.get.bind(testbed.store);
  let hold = true;
  testbed.store.get = async (id) => {
    if (hold) {
      hold = false;
      entered.resolve();
      return release.promise;
    }
    return originalGet(id);
  };

  const starting = testbed.service.start();
  await entered.promise;
  testbed.service.stop();
  const restarting = testbed.service.start();
  release.reject(new Error("obsolete task lookup failed"));
  await Promise.all([starting, restarting]);

  const latest = await testbed.store.get(task.id);
  assert.equal(latest?.enabled, true);
  assert.equal(latest?.lastError, undefined);
  assert.ok(latest?.nextRunAt);
});

test("an obsolete settings failure cannot stop a newer startup", async (t) => {
  const settings = deferred<boolean>();
  let reads = 0;
  const testbed = harness(() => (++reads === 1 ? settings.promise : Promise.resolve(true)));
  t.after(() => testbed.service.stop());
  await addTask(testbed.store);

  const starting = testbed.service.start();
  testbed.service.stop();
  await testbed.service.start();
  settings.reject(new Error("obsolete settings read failed"));
  await starting;
  await testbed.service.start();

  assert.equal(reads, 2, "the restarted service must remain started");
});

test("a current startup settings failure still rejects and permits retry", async (t) => {
  let reads = 0;
  const testbed = harness(async () => {
    if (++reads === 1) throw new Error("settings unavailable");
    return true;
  });
  t.after(() => testbed.service.stop());
  await addTask(testbed.store);

  await assert.rejects(testbed.service.start(), /settings unavailable/u);
  await testbed.service.start();
  await testbed.service.start();
  assert.equal(reads, 2);
});

test("a current startup task-read failure still disables only the affected task", async (t) => {
  const testbed = harness();
  t.after(() => testbed.service.stop());
  const broken = await addTask(testbed.store);
  const healthy = await addTask(testbed.store);
  const originalGet = testbed.store.get.bind(testbed.store);
  testbed.store.get = async (id) => {
    if (id === broken.id) throw new Error("task unavailable");
    return originalGet(id);
  };

  await testbed.service.start();
  const failed = await originalGet(broken.id);
  assert.equal(failed?.enabled, false);
  assert.equal(failed?.lastError, "Needs attention: task unavailable");
  assert.equal((await originalGet(healthy.id))?.enabled, true);
});


for (const invalidation of ["restart", "disable"] as const) {
  test(`startup quarantine cannot commit after ${invalidation} or overwrite newer runtime state`, async (t) => {
    const testbed = harness();
    t.after(() => testbed.service.stop());
    const task = await addTask(testbed.store);
    const entered = deferred<void>();
    const release = deferred<void>();
    const originalUpdate = testbed.store.updateRuntime.bind(testbed.store);
    let failScheduling = true;
    testbed.store.updateRuntime = async (...args) => {
      if (failScheduling) {
        failScheduling = false;
        throw new Error("startup schedule write failed");
      }
      return originalUpdate(...args);
    };
    testbed.taskPersistence.beforeCommit = async (draft) => {
      if ((draft[0] as ScheduledTask).lastError?.includes("startup schedule write failed")) {
        entered.resolve();
        await release.promise;
      }
    };

    const starting = testbed.service.start();
    await entered.promise;
    let restarting: Promise<void> | undefined;
    if (invalidation === "restart") {
      testbed.service.stop();
      restarting = testbed.service.start();
    } else {
      await testbed.service.setGlobalEnabled(false);
    }
    // Runtime writers are independent of the service's per-task lifecycle queue.
    // A stale failure must never roll back a newer completion or chat claim.
    const newer = await originalUpdate(task.id, {
      lastResult: "success",
      lastRunAt: Date.now(),
      chatId: "newer-chat-claim",
    });
    release.resolve();
    await starting;
    await restarting;

    const latest = await testbed.store.get(task.id);
    assert.equal(latest?.enabled, true);
    assert.equal(latest?.lastResult, "success");
    assert.equal(latest?.lastRunAt, newer.lastRunAt);
    assert.equal(latest?.lastError, undefined);
    assert.equal(latest?.chatId, "newer-chat-claim");
    assert.ok(latest!.updatedAt >= newer.updatedAt);
  });
}

test("stopping while startup stages a missed-run claim preserves its due time", async (t) => {
  const testbed = harness();
  t.after(() => testbed.service.stop());
  const task = await addTask(testbed.store);
  const overdue = await testbed.store.updateRuntime(task.id, { nextRunAt: 1 });
  const entered = deferred<void>();
  const release = deferred<void>();
  testbed.taskPersistence.beforeCommit = async () => {
    entered.resolve();
    await release.promise;
  };

  const starting = testbed.service.start();
  await entered.promise;
  testbed.service.stop();
  release.resolve();
  await starting;

  assert.deepEqual(await testbed.store.get(task.id), overdue);
  assert.deepEqual(await testbed.store.runs(task.id), []);
  assert.equal(testbed.hasPending(task.id), false);
});


for (const boundary of ["lookup", "run publication", "runtime publication"] as const) {
  test(`obsolete Cron errors cannot publish after restart during ${boundary}`, async (t) => {
    const testbed = harness();
    t.after(() => testbed.service.stop());
    const task = await addTask(testbed.store);
    await testbed.service.start();
    const job = scheduledJobs.find((entry) => entry.name === `scheduled:${task.id}`)!;
    const catchError = job.options.catch;
    assert.equal(typeof catchError, "function");
    if (typeof catchError !== "function") return;
    const entered = deferred<void>();
    const release = deferred<void>();
    if (boundary === "lookup") {
      const get = testbed.store.get.bind(testbed.store);
      let hold = true;
      testbed.store.get = async (id) => {
        const latest = await get(id);
        if (hold) {
          hold = false;
          entered.resolve();
          await release.promise;
        }
        return latest;
      };
    } else if (boundary === "run publication") {
      testbed.runPersistence.beforeCommit = async () => {
        entered.resolve();
        await release.promise;
      };
    } else {
      testbed.taskPersistence.beforeCommit = async (draft) => {
        if ((draft[0] as ScheduledTask).lastError === "obsolete cron failure") {
          entered.resolve();
          await release.promise;
        }
      };
    }
    const recording = Promise.resolve(catchError(new Error("obsolete cron failure"), job));
    await entered.promise;
    testbed.service.stop();
    await testbed.service.start();
    const newer = await testbed.store.updateRuntime(task.id, {
      lastResult: "success",
      lastRunAt: Date.now(),
      chatId: "newer-cron-chat",
    });
    const broadcasts = testbed.broadcasts.length;
    release.resolve();
    await recording;
    await new Promise((resolve) => setImmediate(resolve));

    assert.deepEqual(await testbed.store.get(task.id), newer);
    assert.equal(testbed.broadcasts.length, broadcasts);
    assert.deepEqual(testbed.errors, []);
    if (boundary !== "runtime publication") {
      assert.deepEqual(await testbed.store.runs(task.id), []);
    }
  });
}

test("a current Cron error still records and broadcasts the failure", async (t) => {
  const testbed = harness();
  t.after(() => testbed.service.stop());
  const task = await addTask(testbed.store);
  await testbed.service.start();
  const job = scheduledJobs.find((entry) => entry.name === `scheduled:${task.id}`)!;
  const catchError = job.options.catch;
  assert.equal(typeof catchError, "function");
  if (typeof catchError !== "function") return;
  await catchError(new Error("current cron failure"), job);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal((await testbed.store.get(task.id))?.lastError, "current cron failure");
  assert.equal((await testbed.store.runs(task.id)).length, 1);
  assert.deepEqual(testbed.broadcasts[testbed.broadcasts.length - 1], { taskId: task.id });
});


test("an error from a replaced Cron job cannot update the current task", async (t) => {
  const testbed = harness();
  t.after(() => testbed.service.stop());
  const task = await addTask(testbed.store);
  await testbed.service.start();
  const oldJob = scheduledJobs.find((entry) => entry.name === `scheduled:${task.id}`)!;
  const catchError = oldJob.options.catch;
  assert.equal(typeof catchError, "function");
  if (typeof catchError !== "function") return;
  await testbed.service.pause(task.id);
  const resumed = await testbed.service.resume(task.id);
  const broadcasts = testbed.broadcasts.length;

  await catchError(new Error("replaced cron failure"), oldJob);
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(await testbed.store.get(task.id), resumed);
  assert.deepEqual(await testbed.store.runs(task.id), []);
  assert.equal(testbed.broadcasts.length, broadcasts);
  assert.deepEqual(testbed.errors, []);
});

for (const boundary of ["lookup", "claim publication"] as const) {
  test(`cancelled startup catch-up at ${boundary} remains due and runs after restart`, async (t) => {
    const testbed = harness();
    t.after(() => testbed.service.stop());
    const task = await addTask(testbed.store);
    const overdue = await testbed.store.updateRuntime(task.id, { nextRunAt: 1 });
    const entered = deferred<void>();
    const release = deferred<void>();
    let held = false;
    const holdCatchup = async () => {
      if (!held && testbed.service.isRunning(task.id)) {
        held = true;
        entered.resolve();
        await release.promise;
      }
    };
    if (boundary === "lookup") {
      const get = testbed.store.get.bind(testbed.store);
      testbed.store.get = async (id) => {
        const latest = await get(id);
        await holdCatchup();
        return latest;
      };
    } else {
      testbed.taskPersistence.beforeCommit = holdCatchup;
    }

    await testbed.service.start();
    await entered.promise;
    testbed.service.stop();
    const restarting = testbed.service.start();
    release.resolve();
    await restarting;
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(testbed.hasPending(task.id), true, "restart must execute the missed run");
    assert.deepEqual(await testbed.store.runs(task.id), []);
    assert.deepEqual(testbed.errors, []);
    assert.ok((await testbed.store.get(task.id))!.nextRunAt! > overdue.nextRunAt!);
  });
}

test("cancelling a catch-up claim leaves the durable missed-run timestamp unchanged", async (t) => {
  const testbed = harness();
  t.after(() => testbed.service.stop());
  const task = await addTask(testbed.store);
  const overdue = await testbed.store.updateRuntime(task.id, { nextRunAt: 1 });
  const entered = deferred<void>();
  const release = deferred<void>();
  testbed.taskPersistence.beforeCommit = async () => {
    if (testbed.service.isRunning(task.id)) {
      entered.resolve();
      await release.promise;
    }
  };

  await testbed.service.start();
  await entered.promise;
  testbed.service.stop();
  release.resolve();
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(await testbed.store.get(task.id), overdue);
  assert.equal(testbed.hasPending(task.id), false);
  assert.deepEqual(await testbed.store.runs(task.id), []);
  assert.deepEqual(testbed.errors, []);
});

test("a current Cron trigger still claims and executes the scheduled task", async (t) => {
  const testbed = harness();
  t.after(() => testbed.service.stop());
  const task = await addTask(testbed.store);
  await testbed.service.start();
  const before = (await testbed.store.get(task.id))!;
  const job = scheduledJobs.find((entry) => entry.name === `scheduled:${task.id}`)!;
  const triggering = job.trigger();
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(testbed.hasPending(task.id), true);
  const claimed = (await testbed.store.get(task.id))!;
  assert.ok(claimed.updatedAt > before.updatedAt);
  assert.ok(claimed.nextRunAt! > Date.now());
  testbed.service.stop();
  await triggering;
  assert.deepEqual(testbed.errors, []);
});

test("explicit manual runs still work while scheduling and the task are paused", async (t) => {
  const testbed = harness();
  t.after(() => testbed.service.stop());
  const task = await addTask(testbed.store);
  await testbed.service.start();
  const paused = await testbed.service.pause(task.id);
  await testbed.service.setGlobalEnabled(false);
  const run = testbed.service.runNow(task.id);
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(testbed.hasPending(task.id), true);
  assert.deepEqual(await testbed.store.get(task.id), paused);
  testbed.service.stop();
  assert.equal((await run).result, "blocked");
});

for (const staleOnArrival of [true, false]) {
  test(`replacement Cron can run when predecessor ${staleOnArrival ? "arrives stale" : "loses ownership during lookup"}`, async (t) => {
    const testbed = harness();
    t.after(() => testbed.service.stop());
    const task = await addTask(testbed.store);
    await testbed.service.start();
    const oldJob = scheduledJobs.find((entry) => entry.name === `scheduled:${task.id}`)!;
    const entered = deferred<void>();
    const release = deferred<void>();
    const get = testbed.store.get.bind(testbed.store);
    let invokingOld = false;
    let oldLookups = 0;
    testbed.store.get = async (id) => {
      const hold = invokingOld;
      const latest = await get(id);
      if (hold) {
        oldLookups += 1;
        entered.resolve();
        await release.promise;
      }
      return latest;
    };
    if (staleOnArrival) await testbed.service.resume(task.id);
    invokingOld = true;
    const obsolete = oldJob.trigger();
    invokingOld = false;
    if (!staleOnArrival) {
      await entered.promise;
      assert.throws(() => testbed.service.runNow(task.id), /already running/u);
      await testbed.service.resume(task.id);
    }
    const currentJob = scheduledJobs.find((entry) => entry.name === `scheduled:${task.id}`)!;
    const current = currentJob.trigger();
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(testbed.hasPending(task.id), true, "obsolete lookup must not block replacement execution");
    release.resolve();
    await obsolete;
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(testbed.service.isRunning(task.id), true, "obsolete cleanup must preserve the replacement slot");
    assert.throws(() => testbed.service.runNow(task.id), /already running/u);
    assert.deepEqual(testbed.errors, []);
    assert.deepEqual(await testbed.store.runs(task.id), []);
    if (staleOnArrival) assert.equal(oldLookups, 0);
    testbed.service.stop();
    await current;
  });
}

test("delayed workspace cancellation cannot cancel a replacement run through the old slot", async (t) => {
  const testbed = harness();
  t.after(() => testbed.service.stop());
  const task = await testbed.store.save({
    name: "Workspace brief",
    mode: "llm",
    cron: "0 9 * * *",
    timezone: "UTC",
    workspaceId: "workspace-handoff",
    prompt: "Summarize changes.",
  });
  await testbed.service.start();
  const oldJob = scheduledJobs.find((entry) => entry.name === `scheduled:${task.id}`)!;
  const entered = deferred<void>();
  const release = deferred<void>();
  const get = testbed.store.get.bind(testbed.store);
  let hold = true;
  testbed.store.get = async (id) => {
    const latest = await get(id);
    if (hold) {
      hold = false;
      entered.resolve();
      await release.promise;
    }
    return latest;
  };
  const obsolete = oldJob.trigger();
  await entered.promise;
  const cancelling = testbed.service.cancelWorkspace("workspace-handoff");
  await new Promise((resolve) => setImmediate(resolve));
  await testbed.service.resumeWorkspace("workspace-handoff");
  const currentJob = scheduledJobs.find((entry) => entry.name === `scheduled:${task.id}`)!;
  const current = currentJob.trigger();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(testbed.hasPending(task.id), true);
  release.resolve();
  await Promise.all([obsolete, cancelling]);

  assert.equal(testbed.hasPending(task.id), true, "cancelling the obsolete snapshot must not cancel the new owner");
  assert.equal(testbed.service.isRunning(task.id), true);
  assert.deepEqual(testbed.errors, []);
  assert.deepEqual(await testbed.store.runs(task.id), []);
  testbed.service.stop();
  await current;
});

test("a replaced job keeps its run slot once execution has started", async (t) => {
  const testbed = harness();
  t.after(() => testbed.service.stop());
  const task = await addTask(testbed.store);
  await testbed.service.start();
  const job = scheduledJobs.find((entry) => entry.name === `scheduled:${task.id}`)!;
  const running = job.trigger();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(testbed.hasPending(task.id), true);
  await testbed.service.resume(task.id);
  assert.throws(() => testbed.service.runNow(task.id), /already running/u);
  assert.equal(testbed.hasPending(task.id), true);
  testbed.service.stop();
  await running;
});

test("a pending manual run keeps its reservation when Cron ownership changes", async (t) => {
  const testbed = harness();
  t.after(() => testbed.service.stop());
  const task = await addTask(testbed.store);
  await testbed.service.start();
  const entered = deferred<void>();
  const release = deferred<void>();
  const get = testbed.store.get.bind(testbed.store);
  let hold = true;
  testbed.store.get = async (id) => {
    const latest = await get(id);
    if (hold) {
      hold = false;
      entered.resolve();
      await release.promise;
    }
    return latest;
  };
  const running = testbed.service.runNow(task.id);
  await entered.promise;
  await testbed.service.resume(task.id);
  assert.throws(() => testbed.service.runNow(task.id), /already running/u);
  release.resolve();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(testbed.hasPending(task.id), true);
  testbed.service.stop();
  await running;
});

test("replacement Cron reclaims an obsolete pending claim without stale publication or cleanup", async (t) => {
  const testbed = harness();
  t.after(() => testbed.service.stop());
  const task = await addTask(testbed.store);
  await testbed.service.start();
  const oldJob = scheduledJobs.find((entry) => entry.name === `scheduled:${task.id}`)!;
  const entered = deferred<void>();
  const release = deferred<void>();
  let hold = true;
  testbed.taskPersistence.beforeCommit = async () => {
    if (hold && testbed.service.isRunning(task.id)) {
      hold = false;
      entered.resolve();
      await release.promise;
    }
  };
  const obsolete = oldJob.trigger();
  await entered.promise;
  await testbed.service.resume(task.id);
  const currentJob = scheduledJobs.find((entry) => entry.name === `scheduled:${task.id}`)!;
  const current = currentJob.trigger();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(testbed.hasPending(task.id), true);
  const newer = await testbed.store.get(task.id);
  release.resolve();
  await obsolete;

  assert.deepEqual(await testbed.store.get(task.id), newer);
  assert.equal(testbed.service.isRunning(task.id), true);
  assert.equal(testbed.hasPending(task.id), true);
  assert.deepEqual(testbed.errors, []);
  assert.deepEqual(await testbed.store.runs(task.id), []);
  testbed.service.stop();
  await current;
});
