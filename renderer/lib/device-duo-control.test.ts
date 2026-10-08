// Adapted from t3code packages/client-runtime/src/device/duoControl.test.ts @ 1c127066 (MIT)
import assert from "node:assert/strict";
import test from "node:test";
import {
  createDuoControl,
  createDuoPinch,
  DUO_PINCH_DEGREES,
  duoFoldState,
  duoHoldOrientation,
  duoScreenSettled,
  type DuoCommand,
  type DuoControlState,
} from "./device-duo-control";

/** The newest entry. Equivalent to `.at(-1)`, which the ES2021 lib lacks. */
const last = <T>(items: readonly T[]): T | undefined => items[items.length - 1];

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

test("a pinch drives only a hit device, accumulates past native readback, clamps, and ends once", () => {
  let confirmed = 90;
  const changes: Array<number | null> = [];
  const pinch = createDuoPinch({
    angle: () => confirmed,
    contains: (x, y) => x > 0.2 && y > 0.2,
    change: (angle) => changes.push(angle),
  });
  assert.equal(pinch.begin(0.1, 0.5), false);
  pinch.move(1);
  assert.deepEqual(changes, []);
  assert.equal(pinch.begin(0.5, 0.5), true);
  pinch.move(0.25);
  assert.equal(last(changes), 90 + 0.25 * DUO_PINCH_DEGREES);
  // Native readback lags the fingers; the pinch keeps its own accumulator.
  confirmed = 100;
  pinch.move(0.25);
  assert.equal(last(changes), 90 + 0.5 * DUO_PINCH_DEGREES);
  pinch.move(2);
  assert.equal(last(changes), 180);
  pinch.move(-3);
  assert.equal(last(changes), 0);
  pinch.move(Number.NaN);
  pinch.end();
  assert.equal(last(changes), null);
  const count = changes.length;
  pinch.move(1);
  pinch.end();
  assert.equal(changes.length, count);
  assert.equal(pinch.active, false);
});

// Screen configs as an iPhone Duo simulator reports them for each way of holding the device (recorded by T3).
const held = [
  ["vertical phone, closed", { screenId: 1, orientation: "portrait", hingeAngle: 0 }, "closed", true],
  ["horizontal phone, closed", { screenId: 1, orientation: "landscape_right", hingeAngle: 0 }, "closed", false],
  ["vertical phone opened as a book", { screenId: 3, orientation: "landscape_left", hingeAngle: 180 }, "open", true],
  [
    "horizontal phone opened as a laptop",
    { screenId: 3, orientation: "portrait_upside_down", hingeAngle: 180 },
    "open",
    false,
  ],
  ["half-open book", { screenId: 3, orientation: "landscape_left", hingeAngle: 90 }, "half", true],
] as const;
for (const [name, screen, fold, phoneVertical] of held) {
  test(`reads a ${name}`, () => {
    assert.deepEqual(duoFoldState(screen), { fold, stand: false, phoneVertical, settled: true });
  });
}

test("a display handoff is unsettled while the cover reports the inner display's orientation", () => {
  const handoff = [
    { screenId: 1, orientation: "portrait", hingeAngle: 90 },
    { screenId: 1, orientation: "landscape_left", hingeAngle: 90 },
    { screenId: 3, orientation: "landscape_left", hingeAngle: 90 },
  ] as const;
  assert.deepEqual(
    handoff.map((screen) => duoFoldState(screen).settled),
    [false, false, true],
  );
  assert.equal(duoScreenSettled({ screenId: 3, hingeAngle: 0 }), false);
});

test("stands are marked so the fold group does not claim them, and missing fields fall back like the 3D view", () => {
  assert.deepEqual(duoFoldState({ screenId: 3, orientation: "portrait", hingeAngle: 90, hingePose: "laptop" }), {
    fold: "half",
    stand: true,
    phoneVertical: false,
    settled: true,
  });
  const closed = duoFoldState({ screenId: 1, orientation: "portrait" });
  assert.equal(closed.fold, "closed");
  assert.equal(closed.phoneVertical, true);
  // Without a display ID the 3D view draws the open inner panel, so the controls do too.
  const open = duoFoldState({ orientation: "landscape_left" });
  assert.equal(open.fold, "open");
  assert.equal(open.phoneVertical, true);
});

test("a stand rotates back to how the phone was held, in the frame of the display receiving it", () => {
  assert.equal(duoHoldOrientation(true, 3), "landscape_left");
  assert.equal(duoHoldOrientation(true, 1), "portrait");
  assert.equal(duoHoldOrientation(false, 1), "landscape_left");
  assert.equal(duoHoldOrientation(false, 3), "portrait_upside_down");
  // The rotation it asks for reads back as the hold it meant, on either display.
  for (const screenId of [1, 3]) {
    for (const vertical of [true, false]) {
      assert.equal(duoFoldState({ screenId, orientation: duoHoldOrientation(vertical, screenId) }).phoneVertical, vertical);
    }
  }
});
