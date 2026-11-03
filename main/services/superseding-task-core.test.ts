import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createSupersedingTaskGate } from "./superseding-task-core";

function deferred(): {
  promise: Promise<void>;
  reject: (error: Error) => void;
  resolve: () => void;
} {
  let reject!: (error: Error) => void;
  let resolve!: () => void;
  const promise = new Promise<void>((resolvePromise, rejectPromise) => {
    reject = rejectPromise;
    resolve = resolvePromise;
  });
  return { promise, reject, resolve };
}

test("concurrent waiters follow a replacement without settling the obsolete task", { timeout: 1_000 }, async () => {
  const gate = createSupersedingTaskGate();
  const second = deferred();
  const firstToken = gate.replace(new Promise<void>(() => undefined));
  const firstWaiter = gate.wait();
  const secondWaiter = gate.wait();
  const secondToken = gate.replace(second.promise);

  assert.equal(gate.isCurrent(firstToken), false);
  assert.equal(gate.isCurrent(secondToken), true);

  second.resolve();
  await Promise.all([firstWaiter, secondWaiter]);
});

test("clearing the gate releases every waiter without settling the current task", { timeout: 1_000 }, async () => {
  const gate = createSupersedingTaskGate();
  gate.replace(new Promise<void>(() => undefined));
  const firstWaiter = gate.wait();
  const secondWaiter = gate.wait();

  gate.clear();
  await Promise.all([firstWaiter, secondWaiter]);
});

test("a stale rejection cannot displace the replacement", async () => {
  const gate = createSupersedingTaskGate();
  const first = deferred();
  const second = deferred();
  const firstToken = gate.replace(first.promise);
  const waiting = gate.wait();
  const secondToken = gate.replace(second.promise);

  first.reject(new Error("obsolete renderer failed"));
  await Promise.resolve();
  assert.equal(gate.isCurrent(firstToken), false);
  assert.equal(gate.isCurrent(secondToken), true);

  second.resolve();
  await waiting;
});

test("the current task still reports its own failure", async () => {
  const gate = createSupersedingTaskGate();
  const task = deferred();
  gate.replace(task.promise);
  const waiting = gate.wait();
  task.reject(new Error("current renderer failed"));
  await assert.rejects(waiting, /current renderer failed/u);
});

test("a failed current task keeps failing waiters until a retry replaces it", async () => {
  const gate = createSupersedingTaskGate();
  const failed = deferred();
  gate.replace(failed.promise);
  failed.reject(new Error("renderer load failed"));
  await assert.rejects(gate.wait(), /renderer load failed/u);
  await assert.rejects(gate.wait(), /renderer load failed/u);

  const retry = deferred();
  let attempts = 0;
  const token = gate.retryFailed(() => {
    attempts += 1;
    return retry.promise;
  });
  assert.equal(attempts, 1);
  assert.ok(token && gate.isCurrent(token));
  const waiting = gate.wait();
  retry.resolve();
  await waiting;
});

test("retryFailed never restarts work that is still loading or already loaded", async () => {
  const gate = createSupersedingTaskGate();
  let attempts = 0;
  const start = () => {
    attempts += 1;
    return Promise.resolve();
  };
  assert.equal(gate.retryFailed(start), null, "nothing to retry before any task");

  const loading = deferred();
  const loadingToken = gate.replace(loading.promise);
  assert.equal(gate.retryFailed(start), null);
  assert.ok(gate.isCurrent(loadingToken));

  loading.resolve();
  await gate.wait();
  const loadedToken = gate.replace(Promise.resolve());
  await Promise.resolve();
  assert.equal(gate.retryFailed(start), null);
  assert.ok(gate.isCurrent(loadedToken));
  assert.equal(attempts, 0);
});

test("main destroys a window only when the failed recovery still owns loading", () => {
  const main = readFileSync(new URL("../index.ts", import.meta.url), "utf8");
  assert.match(
    main,
    /if \(!mainWindowLoads\.isCurrent\(recovery\)\) return;/u,
  );
  assert.match(main, /await mainWindowLoads\.wait\(\)/u);
});
