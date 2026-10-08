import assert from "node:assert/strict";
import test from "node:test";
import {
  TRACKPAD_PINCH_START_RADIUS,
  createMultiTouchGesture,
  createTrackpadPinch,
  mirroredPair,
  multiTouchMode,
  pairGeometry,
  translatePair,
  type MultiTouchPhase,
  type TouchPair,
  type TouchPoint,
} from "./device-multitouch.js";

const close = (actual: number, expected: number, label = "") =>
  assert.ok(Math.abs(actual - expected) < 1e-9, `${label} ${actual} ≈ ${expected}`);

function recordingSink() {
  const sent: Array<{ phase: MultiTouchPhase; pair: [TouchPoint, TouchPoint] }> = [];
  return {
    sent,
    sink: { sendMultiTouch: (phase: MultiTouchPhase, a: TouchPoint, b: TouchPoint) => sent.push({ phase, pair: [a, b] }) },
  };
}

test("Option pinches, Option+Shift pans, and other modifiers keep single touches", () => {
  assert.equal(multiTouchMode({ altKey: true, shiftKey: false }), "pinch");
  assert.equal(multiTouchMode({ altKey: true, shiftKey: true }), "pan");
  assert.equal(multiTouchMode({ altKey: false, shiftKey: true }), null);
  assert.equal(multiTouchMode({ altKey: true, shiftKey: false, metaKey: true }), null);
});

test("the second touch mirrors the pointer through the screen centre", () => {
  const pair = mirroredPair({ x: 0.3, y: 0.2 });
  close(pair[1].x, 0.7);
  close(pair[1].y, 0.8);
  close(pairGeometry(pair).center.x, 0.5);
  close(pairGeometry(pair).center.y, 0.5);
  // Mirrors stay on the screen.
  const edge = mirroredPair({ x: 1.2, y: -0.1 });
  assert.deepEqual(edge[0], { x: 1, y: 0 });
  assert.deepEqual(edge[1], { x: 0, y: 1 });
});

test("moving toward the centre pinches in, and moving around it rotates the pair by the same angle", () => {
  const { sink, sent } = recordingSink();
  const gesture = createMultiTouchGesture(sink);
  const start = gesture.begin({ x: 0.8, y: 0.5 }, "pinch");
  const startGeometry = pairGeometry(start);
  close(startGeometry.distance, 0.6);

  const pinched = gesture.move({ x: 0.65, y: 0.5 })!;
  close(pairGeometry(pinched).distance, 0.3, "half the spread");
  close(pairGeometry(pinched).center.x, 0.5);

  // A quarter turn of the pointer around the centre turns the pair a quarter turn.
  const radius = 0.3;
  const rotated = gesture.move({ x: 0.5, y: 0.5 + radius })!;
  const raw = pairGeometry(rotated).angle - startGeometry.angle;
  const turned = Math.atan2(Math.sin(raw), Math.cos(raw));
  const pointerTurn = Math.atan2(radius, 0) - Math.atan2(0, 0.3);
  close(pointerTurn, Math.PI / 2, "the pointer turned a quarter around the centre");
  close(turned, pointerTurn, "the pair turned the same way and as far");
  close(pairGeometry(rotated).distance, 0.6, "rotation keeps the spread");

  gesture.end();
  assert.deepEqual(
    sent.map((entry) => entry.phase),
    ["begin", "move", "move", "end"],
  );
  assert.deepEqual(sent[3]!.pair, rotated, "end lifts both fingers where they were");
  assert.equal(gesture.active(), false);
  assert.equal(gesture.move({ x: 0.1, y: 0.1 }), null);
});

test("Option+Shift moves both touches together, keeping their spacing and staying on screen", () => {
  const { sink } = recordingSink();
  const gesture = createMultiTouchGesture(sink);
  const start = gesture.begin({ x: 0.4, y: 0.4 }, "pan");
  const moved = gesture.move({ x: 0.5, y: 0.45 })!;
  close(moved[0].x - start[0].x, 0.1);
  close(moved[1].x - start[1].x, 0.1);
  close(moved[0].y - start[0].y, 0.05);
  close(pairGeometry(moved).distance, pairGeometry(start).distance, "spacing");
  // A drag past the edge stops when the outer touch reaches it.
  const clamped = translatePair(start, { x: 5, y: 0 });
  close(Math.max(clamped[0].x, clamped[1].x), 1);
  close(pairGeometry(clamped).distance, pairGeometry(start).distance);
});

test("a trackpad pinch begins around the pointer, scales with the wheel, and ends when events stop", () => {
  const { sink, sent } = recordingSink();
  const timers = new Map<number, () => void>();
  let next = 1;
  let ended = 0;
  const pinch = createTrackpadPinch({
    sink,
    setTimeout: (callback) => {
      timers.set(next, callback);
      return next++ as unknown as ReturnType<typeof setTimeout>;
    },
    clearTimeout: (timer) => timers.delete(timer as unknown as number),
    onEnd: () => ended++,
  });
  const out: TouchPair = pinch.wheel({ deltaY: -100, point: { x: 0.5, y: 0.4 } });
  assert.deepEqual(
    sent.map((entry) => entry.phase),
    ["begin", "move"],
  );
  close(pairGeometry(sent[0]!.pair).distance, 2 * TRACKPAD_PINCH_START_RADIUS);
  assert.ok(pairGeometry(out).distance > 2 * TRACKPAD_PINCH_START_RADIUS, "negative delta spreads the fingers");
  close(pairGeometry(out).center.y, 0.4);
  const inward = pinch.wheel({ deltaY: 300, point: { x: 0.9, y: 0.9 } });
  assert.ok(pairGeometry(inward).distance < pairGeometry(out).distance, "positive delta pinches in");
  close(pairGeometry(inward).center.x, 0.5, "the centre stays where the pinch began");
  assert.equal(timers.size, 1, "each event restarts the idle timer");

  [...timers.values()][0]!();
  assert.equal(sent[sent.length - 1]!.phase, "end");
  assert.equal(ended, 1);
  assert.equal(pinch.active(), false);

  // Near an edge the pinch starts where both fingers fit.
  const edge = pinch.wheel({ deltaY: 0, point: { x: 0.01, y: 0.5 } });
  assert.ok(edge[0].x >= 0 && edge[1].x <= 1);
  pinch.cancel();
  assert.equal(sent[sent.length - 1]!.phase, "end");
});
