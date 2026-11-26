import assert from "node:assert/strict";
import test from "node:test";
import { startProviderCatalogRevalidation } from "./provider-catalog-revalidation";

function fakeTimer() {
  let tick: (() => void) | undefined;
  let interval: number | undefined;
  let cleared = false;
  return {
    setInterval: (callback: () => void, ms: number) => {
      tick = callback;
      interval = ms;
      return 1;
    },
    clearInterval: () => {
      cleared = true;
    },
    tick: () => tick?.(),
    interval: () => interval,
    cleared: () => cleared,
  };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

test("each tick revalidates the lists and hands the new providers on; nothing runs before the first tick", async () => {
  const timer = fakeTimer();
  const seen: string[][] = [];
  let calls = 0;
  startProviderCatalogRevalidation({
    refresh: async () => ({ providers: [`list-${++calls}`] }),
    onProviders: (providers) => seen.push(providers),
    ...timer,
  });
  assert.equal(timer.interval(), 4 * 60 * 60 * 1000);
  assert.equal(calls, 0, "the launch refresh already ran; the timer waits a full interval");
  timer.tick();
  await settle();
  timer.tick();
  await settle();
  assert.deepEqual(seen, [["list-1"], ["list-2"]]);
});

test("a slow refresh is not stacked, a failed one is quiet, and stopping drops a late answer", async () => {
  const timer = fakeTimer();
  const seen: unknown[] = [];
  let release: (() => void) | undefined;
  let calls = 0;
  const stop = startProviderCatalogRevalidation<string>({
    refresh: () => {
      calls += 1;
      if (calls === 1) return Promise.reject(new Error("offline"));
      return new Promise((resolve) => {
        release = () => resolve({ providers: "late" });
      });
    },
    onProviders: (providers) => seen.push(providers),
    ...timer,
  });
  timer.tick();
  await settle();
  assert.deepEqual(seen, [], "a failure changes nothing");
  timer.tick();
  timer.tick();
  assert.equal(calls, 2, "the second tick waits for the refresh in flight");
  stop();
  release?.();
  await settle();
  assert.deepEqual(seen, []);
  assert.equal(timer.cleared(), true);
});
