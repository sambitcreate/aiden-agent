import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { queryMacKeyDown, watchMacKeyUntilUp } from "./dictation-key-state.js";

interface FakeHoldChild extends EventEmitter {
  killed: boolean;
  exitCode: number | null;
  kill: () => boolean;
}

function fakeChild(): FakeHoldChild {
  const child = new EventEmitter() as FakeHoldChild;
  child.killed = false;
  child.exitCode = null;
  child.kill = () => {
    child.killed = true;
    child.exitCode = 1;
    child.emit("exit", 1);
    return true;
  };
  return child;
}

test("queryMacKeyDown coalesces overlapping queries for the same key", async () => {
  let calls = 0;
  const execFileFn = (
    _command: string,
    _args: readonly string[],
    _options: unknown,
    callback: (error: Error | null, stdout: string) => void,
  ) => {
    calls += 1;
    queueMicrotask(() => callback(null, "1\n"));
    return {} as never;
  };
  const first = queryMacKeyDown(2, execFileFn as never);
  const second = queryMacKeyDown(2, execFileFn as never);
  assert.equal(await first, true);
  assert.equal(await second, true);
  assert.equal(calls, 1);
});

test("watchMacKeyUntilUp fires onRelease when the watcher exits cleanly", async () => {
  const releases: number[] = [];
  const child = fakeChild();
  const stop = watchMacKeyUntilUp(2, () => {
    releases.push(1);
  }, (() => child) as never);
  child.emit("exit", 0);
  assert.deepEqual(releases, [1]);
  stop();
});

test("watchMacKeyUntilUp stop kills the child without firing onRelease", async () => {
  const releases: number[] = [];
  const child = fakeChild();
  child.kill = () => {
    child.killed = true;
    child.exitCode = null;
    child.emit("exit", null);
    return true;
  };
  const stop = watchMacKeyUntilUp(49, () => {
    releases.push(1);
  }, (() => child) as never);
  stop();
  assert.equal(child.killed, true);
  assert.deepEqual(releases, []);
});
