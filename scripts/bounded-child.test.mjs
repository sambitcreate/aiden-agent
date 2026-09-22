/* global queueMicrotask */

import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { waitForBoundedChild } from "./bounded-child.mjs";

class FakeChild extends EventEmitter {
  signals = [];

  kill(signal) {
    this.signals.push(signal);
    return true;
  }
}

const quickOptions = {
  label: "test child",
  timeoutMs: 5,
  terminationGraceMs: 5,
  forceExitGraceMs: 5,
};

test("bounded child resolves an ordinary exit", async () => {
  const child = new FakeChild();
  const resultPromise = waitForBoundedChild(child, quickOptions);
  queueMicrotask(() => child.emit("close", 0, null));
  assert.deepEqual(await resultPromise, { code: 0, signal: null });
  assert.deepEqual(child.signals, []);
});

test("bounded child waits for stdio close after process exit", async () => {
  const child = new FakeChild();
  let settled = false;
  const resultPromise = waitForBoundedChild(child, quickOptions).then((result) => {
    settled = true;
    return result;
  });
  child.emit("exit", 0, null);
  await Promise.resolve();
  assert.equal(settled, false);
  child.emit("close", 0, null);
  assert.deepEqual(await resultPromise, { code: 0, signal: null });
});

test("bounded child rejects a spawn error", async () => {
  const child = new FakeChild();
  const resultPromise = waitForBoundedChild(child, quickOptions);
  queueMicrotask(() => child.emit("error", new Error("spawn failed")));
  await assert.rejects(resultPromise, /failed to start/u);
});

test("bounded child escalates a hung process and always settles", async () => {
  const child = new FakeChild();
  await assert.rejects(waitForBoundedChild(child, quickOptions), /did not exit after SIGKILL/u);
  assert.deepEqual(child.signals, ["SIGTERM", "SIGKILL"]);
});

test("bounded child reports timeout when SIGTERM ends the process", async () => {
  const child = new FakeChild();
  child.kill = (signal) => {
    child.signals.push(signal);
    if (signal === "SIGTERM") queueMicrotask(() => child.emit("close", null, signal));
    return true;
  };
  await assert.rejects(waitForBoundedChild(child, quickOptions), /timed out/u);
  assert.deepEqual(child.signals, ["SIGTERM"]);
});
