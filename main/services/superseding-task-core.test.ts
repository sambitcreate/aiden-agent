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

test("main destroys a window only when the failed recovery still owns loading", () => {
  const main = readFileSync(new URL("../index.ts", import.meta.url), "utf8");
  assert.match(
    main,
    /if \(!mainWindowLoads\.isCurrent\(recovery\)\) return;/u,
  );
  assert.match(main, /await mainWindowLoads\.wait\(\)/u);
});
