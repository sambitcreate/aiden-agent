import assert from "node:assert/strict";
import { test } from "node:test";
import { BrowserBackgroundThrottling } from "./background-throttling.js";

function fixture() {
  let destroyed = false;
  let enabled = true;
  const writes: boolean[] = [];
  const policy = new BrowserBackgroundThrottling({
    isDestroyed: () => destroyed,
    setBackgroundThrottling(value) {
      assert.equal(destroyed, false, "never touch a destroyed native guest");
      enabled = value;
      writes.push(value);
    },
  });
  return { policy, writes, enabled: () => enabled, destroy: () => { destroyed = true; } };
}

test("overlapping capture and automation preserve scheduling until the last owner finishes", () => {
  const f = fixture();
  const capture = f.policy.acquire();
  const automation = f.policy.acquire();
  capture();
  assert.equal(f.enabled(), false);
  capture();
  assert.equal(f.enabled(), false, "duplicate release cannot consume another owner");
  automation();
  assert.equal(f.enabled(), true);
  assert.deepEqual(f.writes, [false, true]);
});

test("cancellation restores idle scheduling even before a native operation settles", () => {
  const f = fixture();
  const abort = new AbortController();
  const release = f.policy.acquire(abort.signal);
  abort.abort();
  assert.equal(f.enabled(), true);
  release();
  f.policy.acquire(abort.signal)();
  assert.deepEqual(f.writes, [false, true]);
});

test("crash reset retires old ownership without releasing a replacement operation", () => {
  const f = fixture();
  const stale = f.policy.acquire();
  f.policy.reset();
  assert.equal(f.enabled(), true);
  const replacement = f.policy.acquire();
  stale();
  assert.equal(f.enabled(), false);
  replacement();
  assert.equal(f.enabled(), true);
});

test("destroyed guests can release all owners without native calls", () => {
  const f = fixture();
  const release = f.policy.acquire();
  f.destroy();
  f.policy.reset();
  release();
  f.policy.acquire()();
  assert.deepEqual(f.writes, [false]);
});
