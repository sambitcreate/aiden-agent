import assert from "node:assert/strict";
import test from "node:test";
import { ComputerUseSettingsCoordinator } from "./settings-core.js";

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

test("disable closes and cancels the live gate before persistence settles", async () => {
  const write = deferred<void>();
  const events: string[] = [];
  const coordinator = new ComputerUseSettingsCoordinator({
    readPersisted: async () => true,
    persist: async () => {
      events.push("persist");
      await write.promise;
    },
    setRuntimeEnabled: (enabled) => events.push(`runtime:${String(enabled)}`),
    cancelComputerUseGenerations: () => events.push("cancel"),
  });

  const change = coordinator.setEnabled(false, () => true);
  assert.deepEqual(events, ["runtime:false", "cancel"]);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(events, ["runtime:false", "cancel", "persist"]);
  write.resolve();
  await change;
});

test("a rejected disable write remains fail-closed in memory", async () => {
  const events: string[] = [];
  const coordinator = new ComputerUseSettingsCoordinator({
    readPersisted: async () => true,
    persist: async () => {
      throw new Error("disk full");
    },
    setRuntimeEnabled: (enabled) => events.push(`runtime:${String(enabled)}`),
    cancelComputerUseGenerations: () => events.push("cancel"),
  });

  await assert.rejects(
    coordinator.setEnabled(false, () => true),
    /disk full/u,
  );
  assert.deepEqual(events, ["runtime:false", "cancel"]);
});

test("enable does not open the live gate until persistence succeeds", async () => {
  const write = deferred<void>();
  const runtime: boolean[] = [];
  const coordinator = new ComputerUseSettingsCoordinator({
    readPersisted: async () => false,
    persist: async () => write.promise,
    setRuntimeEnabled: (enabled) => runtime.push(enabled),
    cancelComputerUseGenerations: () => {},
  });

  const change = coordinator.setEnabled(true, () => true);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(runtime, []);
  write.resolve();
  await change;
  assert.deepEqual(runtime, [true]);
});

test("a document replaced during enable is rolled back and never opens the gate", async () => {
  const write = deferred<void>();
  const persisted: boolean[] = [];
  const runtime: boolean[] = [];
  let current = true;
  const coordinator = new ComputerUseSettingsCoordinator({
    readPersisted: async () => false,
    persist: async (enabled) => {
      persisted.push(enabled);
      if (enabled) await write.promise;
    },
    setRuntimeEnabled: (enabled) => runtime.push(enabled),
    cancelComputerUseGenerations: () => {},
  });

  const change = coordinator.setEnabled(true, () => current);
  await new Promise((resolve) => setImmediate(resolve));
  current = false;
  write.resolve();
  await assert.rejects(change, /no longer active/u);
  assert.deepEqual(persisted, [true, false]);
  assert.deepEqual(runtime, [false]);
});

test("shutdown drains a pending disable persistence transaction", async () => {
  const write = deferred<void>();
  let drained = false;
  let durable = true;
  const coordinator = new ComputerUseSettingsCoordinator({
    readPersisted: async () => durable,
    persist: async (enabled) => {
      await write.promise;
      durable = enabled;
    },
    setRuntimeEnabled: () => {},
    cancelComputerUseGenerations: () => {},
  });

  const disabling = coordinator.setEnabled(false, () => true);
  const shutdown = coordinator.shutdown().then(() => {
    drained = true;
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(drained, false);
  write.resolve();
  await Promise.all([disabling, shutdown]);
  assert.equal(drained, true);
});

test("shutdown seals the coordinator before draining and rejects later enables", async () => {
  const persisted: boolean[] = [];
  const runtime: boolean[] = [];
  const coordinator = new ComputerUseSettingsCoordinator({
    readPersisted: async () => false,
    persist: async (enabled) => {
      persisted.push(enabled);
    },
    setRuntimeEnabled: (enabled) => runtime.push(enabled),
    cancelComputerUseGenerations: () => {},
  });

  await coordinator.shutdown();
  await assert.rejects(
    coordinator.setEnabled(true, () => true),
    /shutting down/u,
  );
  assert.deepEqual(persisted, []);
  assert.deepEqual(runtime, []);
});

test("an admitted disable remains durable after its renderer document exits", async () => {
  const blocker = deferred<void>();
  const persisted: boolean[] = [];
  let durable = true;
  let current = true;
  const coordinator = new ComputerUseSettingsCoordinator({
    readPersisted: async () => durable,
    persist: async (enabled) => {
      await blocker.promise;
      persisted.push(enabled);
      durable = enabled;
    },
    setRuntimeEnabled: () => {},
    cancelComputerUseGenerations: () => {},
  });

  const disable = coordinator.setEnabled(false, () => current);
  current = false;
  const shutdown = coordinator.shutdown();
  blocker.resolve();
  await Promise.all([disable, shutdown]);
  assert.deepEqual(persisted, [false]);
});

test("shutdown fails closed when an admitted disable cannot become durable", async () => {
  let durable = true;
  const coordinator = new ComputerUseSettingsCoordinator({
    readPersisted: async () => durable,
    persist: async (enabled) => {
      if (!enabled) throw new Error("disk full");
      durable = enabled;
    },
    setRuntimeEnabled: () => {},
    cancelComputerUseGenerations: () => {},
  });

  await assert.rejects(
    coordinator.setEnabled(false, () => true),
    /disk full/u,
  );
  await assert.rejects(coordinator.shutdown(), /disk full/u);
  assert.equal(durable, true);
});

test("a cancelled quit can reopen the sealed settings coordinator", async () => {
  let durable = false;
  const coordinator = new ComputerUseSettingsCoordinator({
    readPersisted: async () => durable,
    persist: async (enabled) => {
      durable = enabled;
    },
    setRuntimeEnabled: () => {},
    cancelComputerUseGenerations: () => {},
  });

  await coordinator.shutdown();
  coordinator.resumeAfterCancelledShutdown();
  await coordinator.setEnabled(true, () => true);
  assert.equal(durable, true);
});

test("a stale enable cannot reopen runtime or cancel durability after a failed disable", async () => {
  const enableWrite = deferred<void>();
  const runtime: boolean[] = [];
  let durable = true;
  let current = true;
  let rejectDisable = true;
  const coordinator = new ComputerUseSettingsCoordinator({
    readPersisted: async () => durable,
    persist: async (enabled) => {
      if (!enabled && rejectDisable) {
        rejectDisable = false;
        throw new Error("disk full");
      }
      if (enabled) await enableWrite.promise;
      durable = enabled;
    },
    setRuntimeEnabled: (enabled) => runtime.push(enabled),
    cancelComputerUseGenerations: () => {},
  });

  await assert.rejects(
    coordinator.setEnabled(false, () => true),
    /disk full/u,
  );
  const enable = coordinator.setEnabled(true, () => current);
  await new Promise((resolve) => setImmediate(resolve));
  current = false;
  enableWrite.resolve();
  await assert.rejects(enable, /no longer active/u);

  assert.equal(durable, false);
  assert.deepEqual(runtime, [false, false]);
  await coordinator.shutdown();
  assert.equal(durable, false);
});
