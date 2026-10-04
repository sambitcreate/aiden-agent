import assert from "node:assert/strict";
import test from "node:test";
import type { NotificationChannel } from "../../renderer/preload-channels.js";
import { GenerationDeltaCoalescer } from "./generation-delta-coalescer.js";

function harness(options: { maxBufferedChars?: number } = {}) {
  const timers = new Map<number, () => void>();
  let nextTimer = 1;
  const sent: Array<{ channel: NotificationChannel; payload: { streamId: string; delta: string } }> =
    [];
  let destroyed = false;
  const recipient = {
    isDestroyed: () => destroyed,
    send: (channel: NotificationChannel, payload: unknown) => {
      sent.push({ channel, payload: payload as { streamId: string; delta: string } });
    },
  };
  const coalescer = new GenerationDeltaCoalescer({
    windowMs: 16,
    ...options,
    setTimer: (callback) => {
      const id = nextTimer++;
      timers.set(id, callback);
      return id;
    },
    clearTimer: (handle) => {
      timers.delete(handle as number);
    },
  });
  const fireTimers = () => {
    const due = [...timers.values()];
    timers.clear();
    for (const callback of due) callback();
  };
  return {
    coalescer,
    recipient,
    sent,
    fireTimers,
    pendingTimers: () => timers.size,
    destroy: () => {
      destroyed = true;
    },
  };
}

/** Rebuild the text and reasoning a renderer would have accumulated. */
function accumulate(sent: ReturnType<typeof harness>["sent"]) {
  let text = "";
  let reasoning = "";
  for (const { channel, payload } of sent) {
    if (channel === "chat:delta") text += payload.delta;
    if (channel === "chat:reasoning-delta") reasoning += payload.delta;
  }
  return { text, reasoning };
}

test("a 2,000-token stream reaches the renderer intact in far fewer messages", () => {
  const h = harness();
  const tokens = Array.from({ length: 2_000 }, (_, index) => `t${index} `);
  // About 200 tokens/s: twenty tokens arrive in each 100 ms, i.e. ~3 per 16 ms window.
  tokens.forEach((token, index) => {
    assert.equal(h.coalescer.push("s1", "chat:delta", { streamId: "s1", delta: token }, h.recipient), true);
    if (index % 3 === 2) h.fireTimers();
  });
  h.coalescer.flush("s1");

  assert.equal(accumulate(h.sent).text, tokens.join(""));
  assert.ok(h.sent.length <= Math.ceil(tokens.length / 3) + 1, `sent ${h.sent.length} messages`);
  assert.ok(h.sent.every(({ payload }) => payload.streamId === "s1"));
});

test("interleaved reasoning and text keep their relative order", () => {
  const h = harness();
  const events: Array<[NotificationChannel, string]> = [
    ["chat:reasoning-delta", "plan "],
    ["chat:reasoning-delta", "first"],
    ["chat:delta", "Hello"],
    ["chat:delta", " world"],
    ["chat:reasoning-delta", " then"],
  ];
  for (const [channel, delta] of events) {
    h.coalescer.push("s1", channel, { streamId: "s1", delta }, h.recipient);
  }
  h.fireTimers();
  assert.deepEqual(
    h.sent.map(({ channel, payload }) => [channel, payload.delta]),
    [
      ["chat:reasoning-delta", "plan first"],
      ["chat:delta", "Hello world"],
      ["chat:reasoning-delta", " then"],
    ],
  );
});

test("resets and non-delta notifications are not buffered and flush must precede them", () => {
  const h = harness();
  h.coalescer.push("s1", "chat:delta", { streamId: "s1", delta: "partial" }, h.recipient);
  assert.equal(
    h.coalescer.push("s1", "chat:delta", { streamId: "s1", delta: "", reset: true }, h.recipient),
    false,
  );
  assert.equal(
    h.coalescer.push("s1", "chat:done", { streamId: "s1", content: "x" }, h.recipient),
    false,
  );
  // The caller's contract: flush, then send the pass-through notification.
  h.coalescer.flush("s1");
  assert.deepEqual(accumulate(h.sent), { text: "partial", reasoning: "" });
  assert.equal(h.pendingTimers(), 0);
});

test("a large burst flushes immediately without waiting for the window", () => {
  const h = harness({ maxBufferedChars: 10 });
  h.coalescer.push("s1", "chat:delta", { streamId: "s1", delta: "12345" }, h.recipient);
  assert.equal(h.sent.length, 0);
  h.coalescer.push("s1", "chat:delta", { streamId: "s1", delta: "67890" }, h.recipient);
  assert.deepEqual(accumulate(h.sent).text, "1234567890");
  assert.equal(h.coalescer.hasPending("s1"), false);
});

test("streams are isolated and a destroyed document receives nothing", () => {
  const h = harness();
  h.coalescer.push("a", "chat:delta", { streamId: "a", delta: "A" }, h.recipient);
  h.coalescer.push("b", "chat:delta", { streamId: "b", delta: "B" }, h.recipient);
  h.coalescer.flush("a");
  assert.deepEqual(h.sent.map(({ payload }) => payload), [{ streamId: "a", delta: "A" }]);
  h.destroy();
  h.fireTimers();
  assert.equal(h.sent.length, 1);
});

test("discard drops buffered deltas", () => {
  const h = harness();
  h.coalescer.push("s1", "chat:delta", { streamId: "s1", delta: "gone" }, h.recipient);
  h.coalescer.discard("s1");
  h.fireTimers();
  h.coalescer.flush("s1");
  assert.equal(h.sent.length, 0);
});
