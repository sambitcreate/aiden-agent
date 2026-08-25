import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import type { ChildProcess } from "node:child_process";
import { queryMacKeyDown, watchMacKeyUntilUp } from "./dictation-key-state.js";

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
  const child = new EventEmitter() as EventEmitter & ChildProcess;
  child.killed = false;
  child.exitCode = null;
  child.kill = (() => {
    child.killed = true;
    child.exitCode = 1;
    child.emit("exit", 1);
    return true;
  }) as ChildProcess["kill"];
  const stop = watchMacKeyUntilUp(2, () => {
    releases.push(1);
  }, (() => child) as never);
  child.emit("exit", 0);
  assert.deepEqual(releases, [1]);
  stop();
});

test("watchMacKeyUntilUp stop kills the child without firing onRelease", async () => {
  const releases: number[] = [];
  const child = new EventEmitter() as EventEmitter & ChildProcess;
  child.killed = false;
  child.exitCode = null;
  child.kill = (() => {
    child.killed = true;
    child.exitCode = null;
    child.emit("exit", null);
    return true;
  }) as ChildProcess["kill"];
  const stop = watchMacKeyUntilUp(49, () => {
    releases.push(1);
  }, (() => child) as never);
  stop();
  assert.equal(child.killed, true);
  assert.deepEqual(releases, []);
});
