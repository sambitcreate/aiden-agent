import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createTelegramQueue,
  classifyMessage,
  type QueuedTelegramTurn,
  type QueueLane,
} from "./telegram-queue.js";

/** Mutable deps so tests can flip gate state mid-scenario. */
function makeDeps() {
  const state = { active: false, pending: false };
  return {
    state,
    isActive: () => state.active,
    hasPendingDispatch: () => state.pending,
  };
}

function turn(lane: QueueLane, text: string, chatId = 1): QueuedTelegramTurn {
  return { lane, text, chatId, ownerUserId: chatId };
}

test("dequeue order is control, then priority, then default", () => {
  const deps = makeDeps();
  const queue = createTelegramQueue(deps);
  // Enqueue out of lane precedence order to prove ordering is lane-driven.
  queue.enqueue(turn("default", "d1"));
  queue.enqueue(turn("priority", "p1"));
  queue.enqueue(turn("control", "c1"));

  assert.equal(queue.size(), 3);
  assert.equal(queue.dequeue()?.text, "c1");
  assert.equal(queue.dequeue()?.text, "p1");
  assert.equal(queue.dequeue()?.text, "d1");
  assert.equal(queue.dequeue(), null);
});

test("gates block non-control lanes when isActive() is true", () => {
  const deps = makeDeps();
  const queue = createTelegramQueue(deps);
  queue.enqueue(turn("priority", "p1"));
  queue.enqueue(turn("default", "d1"));
  deps.state.active = true;

  assert.equal(queue.peek(), null);
  assert.equal(queue.dequeue(), null);
  // Gates block dispatch without dropping queued content.
  assert.equal(queue.size(), 2);

  // Releasing the gate resumes dispatch in lane order.
  deps.state.active = false;
  assert.equal(queue.peek()?.text, "p1");
  assert.equal(queue.dequeue()?.text, "p1");
});

test("gates block non-control lanes when hasPendingDispatch() is true", () => {
  const deps = makeDeps();
  const queue = createTelegramQueue(deps);
  queue.enqueue(turn("priority", "p1"));
  queue.enqueue(turn("default", "d1"));
  deps.state.pending = true;

  assert.equal(queue.peek(), null);
  assert.equal(queue.dequeue(), null);
  assert.equal(queue.size(), 2);

  deps.state.pending = false;
  assert.equal(queue.dequeue()?.text, "p1");
});

test("control lane bypasses gates and peeks even when active", () => {
  const deps = makeDeps();
  const queue = createTelegramQueue(deps);
  queue.enqueue(turn("default", "d1"));
  queue.enqueue(turn("control", "c1"));
  // Both gates held — non-control lanes must stay blocked.
  deps.state.active = true;
  deps.state.pending = true;

  assert.equal(queue.peek()?.text, "c1");
  assert.equal(queue.dequeue()?.text, "c1");
  // Control drained → gates now block the remaining default item.
  assert.equal(queue.peek(), null);
  assert.equal(queue.dequeue(), null);
  assert.equal(queue.size(), 1);
});

test("drainControl() removes and returns all control items", () => {
  const deps = makeDeps();
  const queue = createTelegramQueue(deps);
  queue.enqueue(turn("control", "c1"));
  queue.enqueue(turn("control", "c2"));
  queue.enqueue(turn("default", "d1"));
  assert.equal(queue.size(), 3);

  const drained = queue.drainControl();
  assert.deepEqual(
    drained.map((t) => t.text),
    ["c1", "c2"],
  );
  assert.equal(queue.size(), 1);
  // No control items remain after draining.
  assert.deepEqual(queue.drainControl(), []);
});

test("clear() empties all lanes", () => {
  const deps = makeDeps();
  const queue = createTelegramQueue(deps);
  queue.enqueue(turn("control", "c1"));
  queue.enqueue(turn("priority", "p1"));
  queue.enqueue(turn("default", "d1"));
  assert.equal(queue.isEmpty(), false);

  queue.clear();
  assert.equal(queue.size(), 0);
  assert.equal(queue.isEmpty(), true);
  assert.equal(queue.peek(), null);
});

test("classifyMessage routes slash commands to control and the rest to default", () => {
  assert.equal(classifyMessage("/start"), "control");
  assert.equal(classifyMessage("/stop"), "control");
  assert.equal(classifyMessage("/status"), "control");
  assert.equal(classifyMessage("hello"), "default");
  // Leading whitespace is trimmed before classification.
  assert.equal(classifyMessage("   /start"), "control");
  assert.equal(classifyMessage("   hello"), "default");
});

test("FIFO ordering within the control lane", () => {
  const deps = makeDeps();
  const queue = createTelegramQueue(deps);
  queue.enqueue(turn("control", "c1"));
  queue.enqueue(turn("control", "c2"));
  queue.enqueue(turn("control", "c3"));

  assert.equal(queue.dequeue()?.text, "c1");
  assert.equal(queue.dequeue()?.text, "c2");
  assert.equal(queue.dequeue()?.text, "c3");
  assert.equal(queue.dequeue(), null);
});

test("FIFO ordering within the priority lane", () => {
  const deps = makeDeps();
  const queue = createTelegramQueue(deps);
  queue.enqueue(turn("priority", "p1"));
  queue.enqueue(turn("priority", "p2"));

  assert.equal(queue.dequeue()?.text, "p1");
  assert.equal(queue.dequeue()?.text, "p2");
});

test("FIFO ordering within the default lane", () => {
  const deps = makeDeps();
  const queue = createTelegramQueue(deps);
  queue.enqueue(turn("default", "d1"));
  queue.enqueue(turn("default", "d2"));
  queue.enqueue(turn("default", "d3"));

  assert.equal(queue.dequeue()?.text, "d1");
  assert.equal(queue.dequeue()?.text, "d2");
  assert.equal(queue.dequeue()?.text, "d3");
});
