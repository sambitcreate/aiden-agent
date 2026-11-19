import assert from "node:assert/strict";
import { test } from "node:test";
import { createDesignZoomGate } from "./zoom-gate.ts";

/** Settles pending promise callbacks. */
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

/** Enters the gate and records when the window was let in. */
function track(gate: ReturnType<typeof createDesignZoomGate>, zoom: number, order: string[], name: string, signal?: AbortSignal) {
  let leave: (() => void) | null = null;
  const entered = gate.enter(zoom, signal).then((release) => {
    order.push(name);
    leave = release;
  });
  return {
    entered,
    get inside() {
      return leave !== null;
    },
    leave() {
      assert.ok(leave, `${name} was never let in`);
      leave();
    },
  };
}

test("windows at one zoom open together, and a window at another zoom waits until they have all closed", async () => {
  const gate = createDesignZoomGate();
  const order: string[] = [];
  const inspectA = track(gate, 1, order, "inspect A");
  const inspectB = track(gate, 1, order, "inspect B");
  const png = track(gate, 2, order, "png");
  await flush();
  assert.deepEqual(order, ["inspect A", "inspect B"]);
  assert.equal(png.inside, false);

  inspectA.leave();
  await flush();
  assert.equal(png.inside, false, "one 1x window is still open");

  inspectB.leave();
  await flush();
  assert.deepEqual(order, ["inspect A", "inspect B", "png"]);
});

test("a window that arrives at the open zoom queues behind one already waiting at another, so neither zoom is held back for ever", async () => {
  const gate = createDesignZoomGate();
  const order: string[] = [];
  const first = track(gate, 1, order, "first 1x");
  const png = track(gate, 2, order, "png");
  const late = track(gate, 1, order, "late 1x");
  await flush();
  assert.deepEqual(order, ["first 1x"]);

  first.leave();
  await flush();
  assert.deepEqual(order, ["first 1x", "png"]);
  assert.equal(late.inside, false);

  png.leave();
  await flush();
  assert.deepEqual(order, ["first 1x", "png", "late 1x"]);
});

test("every waiter at the next zoom is let in at once", async () => {
  const gate = createDesignZoomGate();
  const order: string[] = [];
  const inspect = track(gate, 1, order, "inspect");
  track(gate, 2, order, "png A");
  track(gate, 1, order, "inspect 2");
  track(gate, 2, order, "png B");
  await flush();
  inspect.leave();
  await flush();
  assert.deepEqual(order, ["inspect", "png A", "png B"]);
});

test("a stopped waiter leaves the queue, and anyone behind it at the open zoom goes in", async () => {
  const gate = createDesignZoomGate();
  const order: string[] = [];
  const stop = new AbortController();
  track(gate, 1, order, "inspect");
  const png = track(gate, 2, order, "png", stop.signal);
  const late = track(gate, 1, order, "late 1x");
  await flush();
  assert.equal(late.inside, false);

  stop.abort();
  await assert.rejects(png.entered, /stopped/u);
  await flush();
  assert.deepEqual(order, ["inspect", "late 1x"]);
});

test("a window that leaves twice counts once", async () => {
  const gate = createDesignZoomGate();
  const order: string[] = [];
  const a = track(gate, 1, order, "a");
  const b = track(gate, 1, order, "b");
  const png = track(gate, 2, order, "png");
  await flush();
  a.leave();
  a.leave();
  await flush();
  assert.equal(png.inside, false, "b is still open");
  b.leave();
  await flush();
  assert.equal(png.inside, true);
});

test("a request already stopped is refused without waiting", async () => {
  const gate = createDesignZoomGate();
  await assert.rejects(gate.enter(1, AbortSignal.abort()), /stopped/u);
  const order: string[] = [];
  track(gate, 2, order, "png");
  await flush();
  assert.deepEqual(order, ["png"]);
});
