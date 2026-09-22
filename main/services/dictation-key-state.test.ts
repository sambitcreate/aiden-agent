import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { watchMacKeyUntilUp } from "./dictation-key-state.js";

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

test("watchMacKeyUntilUp returns null when spawn fails", () => {
  const stop = watchMacKeyUntilUp(2, () => {}, {
    spawnFn: () => {
      throw new Error("spawn failed");
    },
  });
  assert.equal(stop, null);
});

test("watchMacKeyUntilUp fires onRelease when the watcher exits cleanly", () => {
  const releases: number[] = [];
  const failures: number[] = [];
  const child = fakeChild();
  const stop = watchMacKeyUntilUp(
    2,
    () => {
      releases.push(1);
    },
    {
      spawnFn: () => child as never,
      onFailed: () => {
        failures.push(1);
      },
    },
  );
  child.emit("exit", 0);
  assert.deepEqual(releases, [1]);
  assert.deepEqual(failures, []);
  stop?.();
});

test("watchMacKeyUntilUp reports failure on a non-zero exit without releasing", () => {
  const releases: number[] = [];
  const failures: number[] = [];
  const child = fakeChild();
  watchMacKeyUntilUp(
    2,
    () => {
      releases.push(1);
    },
    {
      spawnFn: () => child as never,
      onFailed: () => {
        failures.push(1);
      },
    },
  );
  child.emit("exit", 1);
  assert.deepEqual(releases, []);
  assert.deepEqual(failures, [1]);
});

test("watchMacKeyUntilUp stop kills the child without firing onRelease or onFailed", () => {
  const releases: number[] = [];
  const failures: number[] = [];
  const child = fakeChild();
  child.kill = () => {
    child.killed = true;
    child.exitCode = null;
    child.emit("exit", null);
    return true;
  };
  const stop = watchMacKeyUntilUp(
    49,
    () => {
      releases.push(1);
    },
    {
      spawnFn: () => child as never,
      onFailed: () => {
        failures.push(1);
      },
    },
  );
  stop?.();
  assert.equal(child.killed, true);
  assert.deepEqual(releases, []);
  assert.deepEqual(failures, []);
});
