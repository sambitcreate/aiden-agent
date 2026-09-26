// Adapted from t3code packages/client-runtime/src/device/duoControl.test.ts @ 1c127066 (MIT)
import assert from "node:assert/strict";
import test from "node:test";
import { createDuoControl, type DuoCommand, type DuoControlState } from "./device-duo-control";

type Request = { requestId: number; command: DuoCommand };

function harness(sendResult: () => boolean = () => true, timeoutMs?: number) {
  const sent: Request[] = [];
  const states: DuoControlState[] = [];
  const timers = new Map<number, () => void>();
  let nextTimer = 1;
  const queue = createDuoControl({
    send: (request) => {
      sent.push(request);
      return sendResult();
    },
    onChange: (state) => states.push(state),
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
    setTimeout: (callback) => {
      const id = nextTimer++;
      timers.set(id, callback);
      return id as unknown as ReturnType<typeof setTimeout>;
    },
    clearTimeout: (timer) => timers.delete(timer as unknown as number),
  });
  const fireTimers = () => {
    const pending = [...timers.values()];
    timers.clear();
    for (const callback of pending) callback();
  };
  return { queue, sent, states, last: () => states[states.length - 1], fireTimers };
}

test("keeps a failed send visible, including a disconnect while draining queued motion", () => {
  let connected = false;
  const h = harness(() => connected);
  h.queue.enqueue({ control: "angle", value: 40 });
  assert.deepEqual(h.last(), { pending: false, requested: null, error: "Device is disconnected." });
  connected = true;
  h.queue.enqueue({ control: "pose", value: "book" });
  connected = false;
  h.queue.enqueue({ control: "angle", value: 60 });
  h.queue.receive({ requestId: 2, ok: true });
  assert.deepEqual(h.last(), { pending: false, requested: null, error: "Device is disconnected." });
});

test("coalesces hinge edits behind acknowledgements and lets a preset replace queued edits", () => {
  const h = harness();
  h.queue.enqueue({ control: "angle", value: 40 });
  h.queue.enqueue({ control: "angle", value: 50 });
  h.queue.enqueue({ control: "angle", value: 60 });
  assert.equal(h.sent.length, 1);
  h.queue.receive({ requestId: 1, ok: true });
  assert.deepEqual(h.sent[1], { requestId: 2, command: { control: "angle", value: 60 } });
  h.queue.enqueue({ control: "angle", value: 100 });
  h.queue.enqueue({ control: "pose", value: "tent" });
  h.queue.receive({ requestId: 2, ok: true });
  assert.deepEqual(h.sent[2], { requestId: 3, command: { control: "pose", value: "tent" } });
  h.queue.receive({ requestId: 3, ok: true });
  assert.deepEqual(h.last(), { pending: false, requested: null, error: null });
});

test("drops queued commands on failure, timeout and disconnect; late replies cannot acknowledge later work", () => {
  const h = harness(() => true, 100);
  h.queue.enqueue({ control: "angle", value: 90 });
  h.queue.enqueue({ control: "angle", value: 100 });
  h.fireTimers();
  assert.match(h.last()!.error ?? "", /timed out/u);
  h.queue.enqueue({ control: "pose", value: "open" });
  h.queue.receive({ requestId: 1, ok: true });
  assert.equal(h.last()!.pending, true);
  h.queue.enqueue({ control: "angle", value: 130 });
  h.queue.receive({ requestId: 2, ok: false, error: "native refused" });
  assert.deepEqual(h.last(), { pending: false, requested: null, error: "native refused" });
  h.queue.enqueue({ control: "pose", value: "book" });
  h.queue.enqueue({ control: "pose", value: "closed" });
  h.queue.clear();
  h.queue.receive({ requestId: 3, ok: true });
  assert.equal(h.sent.length, 3);
  h.queue.enqueue({ control: "angle", value: Infinity });
  h.queue.enqueue({ control: "angle", value: 181 });
  assert.equal(h.sent.length, 3);
});
