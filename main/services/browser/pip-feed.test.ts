import assert from "node:assert/strict";
import test from "node:test";
import { PipFeed } from "./pip-feed.js";

function harness(options: { viewing?: boolean; intervalMs?: number } = {}) {
  let now = 0;
  let viewing = options.viewing ?? true;
  const timers: Array<{ at: number; run: () => void }> = [];
  const painted: string[] = [];
  const acked: number[] = [];
  const paints: Array<{ resolve: () => void; reject: (error: Error) => void }> = [];
  const feed = new PipFeed({
    paint: (frame) =>
      new Promise<void>((resolve, reject) => {
        painted.push(frame);
        paints.push({ resolve, reject });
      }),
    ack: (sessionId) => acked.push(sessionId),
    viewing: () => viewing,
    intervalMs: options.intervalMs ?? 250,
    now: () => now,
    setTimer: (run, ms) => {
      const timer = { at: now + ms, run };
      timers.push(timer);
      return timer;
    },
    clearTimer: (timer) => {
      const index = timers.indexOf(timer as (typeof timers)[number]);
      if (index >= 0) timers.splice(index, 1);
    },
  });
  const settle = () => new Promise<void>((resolve) => setImmediate(resolve));
  return {
    feed,
    painted,
    acked,
    async finishPaint(error?: Error) {
      const paint = paints.shift();
      assert.ok(paint, "a paint is in progress");
      if (error) paint.reject(error);
      else paint.resolve();
      await settle();
    },
    async advance(ms: number) {
      now += ms;
      for (const timer of timers.filter((candidate) => candidate.at <= now)) {
        timers.splice(timers.indexOf(timer), 1);
        timer.run();
      }
      await settle();
    },
    setViewing(next: boolean) {
      viewing = next;
    },
  };
}

test("a frame is acknowledged only after it has been painted", async () => {
  const pip = harness();
  pip.feed.push("frame-1", 1, true);
  assert.deepEqual(pip.painted, ["frame-1"]);
  assert.deepEqual(pip.acked, [], "Chromium waits for the paint before sending more");
  await pip.finishPaint();
  assert.deepEqual(pip.acked, [1]);
});

test("frames arriving faster than the paint rate collapse to the newest one", async () => {
  const pip = harness();
  pip.feed.push("frame-1", 1, true);
  await pip.finishPaint();
  pip.feed.push("frame-2", 2, true);
  pip.feed.push("frame-3", 3, true);
  await pip.advance(100);
  assert.deepEqual(pip.painted, ["frame-1"], "no repaint inside the interval");
  assert.deepEqual(pip.acked, [1], "the waiting frames stay unacknowledged, pausing the encoder");
  await pip.advance(150);
  assert.deepEqual(pip.painted, ["frame-1", "frame-3"]);
  await pip.finishPaint();
  assert.deepEqual(pip.acked, [1, 2, 3]);
});

test("a hidden or minimized window paints nothing and stalls the screencast until it is shown", async () => {
  const pip = harness({ viewing: false });
  pip.feed.push("frame-1", 1, true);
  pip.feed.push("frame-2", 2, true);
  await pip.advance(1_000);
  assert.deepEqual(pip.painted, []);
  assert.deepEqual(pip.acked, []);
  pip.setViewing(true);
  pip.feed.resume();
  assert.deepEqual(pip.painted, ["frame-2"], "showing the window paints the newest frame");
  await pip.finishPaint();
  assert.deepEqual(pip.acked, [1, 2]);
});

test("a paint that fails still releases the screencast and the next frame paints", async () => {
  const pip = harness();
  pip.feed.push("frame-1", 1, true);
  await pip.finishPaint(new Error("navigating"));
  assert.deepEqual(pip.acked, [1]);
  await pip.advance(250);
  pip.feed.push("frame-2", 2, true);
  assert.deepEqual(pip.painted, ["frame-1", "frame-2"]);
});

test("frames the recording already acknowledged are painted but never acknowledged again", async () => {
  const pip = harness();
  pip.feed.push("frame-1", 1, false);
  await pip.finishPaint();
  assert.deepEqual(pip.painted, ["frame-1"]);
  assert.deepEqual(pip.acked, []);
});

test("a recording that starts takes back the frames the preview was holding", async () => {
  const pip = harness({ viewing: false });
  pip.feed.push("frame-1", 1, true);
  pip.feed.releaseAcks();
  assert.deepEqual(pip.acked, [1]);
});

test("an oversized or empty frame is not painted, but is acknowledged", async () => {
  const pip = harness();
  pip.feed.push("", 1, true);
  pip.feed.push("x".repeat(8_000_001), 2, true);
  assert.deepEqual(pip.painted, []);
  assert.deepEqual(pip.acked, [1, 2]);
});

test("closing the preview acknowledges what it held and ignores later frames", async () => {
  const pip = harness({ viewing: false });
  pip.feed.push("frame-1", 1, true);
  pip.feed.dispose();
  assert.deepEqual(pip.acked, [1]);
  pip.feed.push("frame-2", 2, true);
  pip.setViewing(true);
  pip.feed.resume();
  assert.deepEqual(pip.painted, []);
  assert.deepEqual(pip.acked, [1, 2]);
});
