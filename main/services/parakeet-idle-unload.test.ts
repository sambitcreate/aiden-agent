import assert from "node:assert/strict";
import test from "node:test";
import { ParakeetIdleUnloader } from "./parakeet-idle-unload.js";

interface FakeTimer {
  callback: () => void;
  delayMs: number;
  cleared: boolean;
}

function harness(initialIdleMs: number | null | (() => Promise<number | null>) = 60_000) {
  const timers: FakeTimer[] = [];
  let unloads = 0;
  let idle = initialIdleMs;
  const unloader = new ParakeetIdleUnloader<FakeTimer>({
    setTimer: (callback, delayMs) => {
      const timer = { callback, delayMs, cleared: false };
      timers.push(timer);
      return timer;
    },
    clearTimer: (timer) => {
      timer.cleared = true;
    },
    idleMs: () => (typeof idle === "function" ? idle() : idle),
    unload: () => {
      unloads += 1;
    },
  });
  const live = () => timers.filter((timer) => !timer.cleared);
  return {
    unloader,
    live,
    unloads: () => unloads,
    setIdle: (value: number | null) => {
      idle = value;
    },
    /** Fire every armed timer, as if the idle period elapsed. */
    elapse: () => {
      for (const timer of live()) {
        timer.cleared = true;
        timer.callback();
      }
    },
  };
}

const settle = () => new Promise((resolve) => setImmediate(resolve));

test("the model unloads once after the idle period that follows its last use", async () => {
  const h = harness(5 * 60_000);
  const end = h.unloader.begin();
  assert.equal(h.live().length, 0, "no countdown while transcription is in flight");
  end();
  await settle();
  assert.deepEqual(
    h.live().map((timer) => timer.delayMs),
    [5 * 60_000],
  );
  h.elapse();
  assert.equal(h.unloads(), 1);
  await h.unloader.reconfigure();
  assert.equal(h.live().length, 0, "nothing left to unload until the model is used again");
});

test("new use cancels a pending unload and restarts the countdown afterwards", async () => {
  const h = harness(60_000);
  h.unloader.begin()();
  await settle();
  const first = h.live()[0];
  const end = h.unloader.begin();
  assert.equal(first?.cleared, true);
  end();
  await settle();
  assert.equal(h.live().length, 1);
  h.elapse();
  assert.equal(h.unloads(), 1);
});

test("overlapping work keeps the model loaded until the last lease ends", async () => {
  const h = harness(60_000);
  const warm = h.unloader.begin();
  const transcribe = h.unloader.begin();
  warm();
  await settle();
  assert.equal(h.live().length, 0);
  warm();
  await settle();
  assert.equal(h.live().length, 0, "ending a lease twice does not release another caller");
  transcribe();
  await settle();
  assert.equal(h.live().length, 1);
});

test("a lease that starts while the idle period is being read wins", async () => {
  let resolveIdle!: (value: number) => void;
  const h = harness(() => new Promise<number>((resolve) => (resolveIdle = resolve)));
  h.unloader.begin()();
  const next = h.unloader.begin();
  resolveIdle(1_000);
  await settle();
  assert.equal(h.live().length, 0, "the stale read cannot arm an unload under active work");
  next();
});

test("'never' keeps the model loaded and a Settings change re-arms the countdown", async () => {
  const h = harness(null);
  h.unloader.begin()();
  await settle();
  assert.equal(h.live().length, 0);
  h.setIdle(2 * 60_000);
  await h.unloader.reconfigure();
  assert.deepEqual(
    h.live().map((timer) => timer.delayMs),
    [2 * 60_000],
  );
  h.setIdle(null);
  await h.unloader.reconfigure();
  assert.equal(h.live().length, 0);
  assert.equal(h.unloads(), 0);
});

test("an externally released model is not unloaded again", async () => {
  const h = harness(60_000);
  h.unloader.begin()();
  await settle();
  h.unloader.forget();
  assert.equal(h.live().length, 0);
  await h.unloader.reconfigure();
  assert.equal(h.live().length, 0);
  assert.equal(h.unloads(), 0);
});
