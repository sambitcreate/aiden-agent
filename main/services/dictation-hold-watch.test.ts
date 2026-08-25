import assert from "node:assert/strict";
import test from "node:test";
import { startHoldKeyWatch } from "./dictation-hold-watch.js";

test("fires onRelease once when the hold key goes up", async () => {
  const releases: number[] = [];
  let down = true;
  const ticks: Array<() => void> = [];
  const stop = startHoldKeyWatch(2, {
    isKeyDown: async () => down,
    onRelease: () => {
      releases.push(1);
    },
    setIntervalFn: (callback) => {
      ticks.push(callback);
      return 1 as unknown as ReturnType<typeof setInterval>;
    },
    clearIntervalFn: () => {},
  });
  ticks[0]?.();
  await Promise.resolve();
  assert.deepEqual(releases, []);
  down = false;
  ticks[0]?.();
  await Promise.resolve();
  ticks[0]?.();
  await Promise.resolve();
  assert.deepEqual(releases, [1]);
  stop();
});
