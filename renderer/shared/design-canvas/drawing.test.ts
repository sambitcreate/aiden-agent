// What the drawing tools make: boxes from drags, pencil and pen strokes, and
// which group or artboard a drawn or dragged item belongs to.

import assert from "node:assert/strict";
import test from "node:test";
import {
  boxFromDrag,
  containerAt,
  regroupFrames,
  simplifyStroke,
  snapAngle,
  strokeFromCanvas,
  strokeOnCanvas,
  strokePath,
} from "./drawing.js";
import { emptyDesignCanvas, type DesignCanvas, type DesignFrame } from "./schema.js";

function item(id: string, overrides: Partial<DesignFrame> = {}): DesignFrame {
  return { id, kind: "shape", shape: "rect", title: id, x: 0, y: 0, w: 100, h: 60, pageId: "page-1", createdBy: "person", ...overrides };
}

const canvas = (...frames: DesignFrame[]): DesignCanvas => ({ ...emptyDesignCanvas(), frames });
const close = (a: number, b: number, within = 0.01) => Math.abs(a - b) <= within;

test("a drag draws the same box whichever way it goes, and Shift keeps it square", () => {
  const expected = { x: 10, y: 20, w: 90, h: 40 };
  assert.deepEqual(boxFromDrag({ x: 10, y: 20 }, { x: 100, y: 60 }), expected);
  assert.deepEqual(boxFromDrag({ x: 100, y: 60 }, { x: 10, y: 20 }), expected);
  assert.deepEqual(boxFromDrag({ x: 100, y: 20 }, { x: 10, y: 60 }), expected);
  // Square grows from where the drag started, towards the pointer.
  assert.deepEqual(boxFromDrag({ x: 100, y: 60 }, { x: 10, y: 20 }, { square: true }), { x: 10, y: -30, w: 90, h: 90 });
});

test("Shift turns a line to the nearest 45° and keeps its length", () => {
  const end = snapAngle({ x: 0, y: 0 }, { x: 100, y: 10 });
  assert.ok(close(end.x, Math.hypot(100, 10)) && close(end.y, 0));
  const diagonal = snapAngle({ x: 0, y: 0 }, { x: 100, y: 90 });
  assert.ok(close(diagonal.x, diagonal.y), "a near-diagonal becomes exactly 45°");
});

test("a pencil line keeps its corners, drops jitter along straight runs, and never passes 2 000 points", () => {
  const run = Array.from({ length: 50 }, (_, index) => ({ x: index * 2, y: index % 2 === 0 ? 0 : 0.3 }));
  const corner = [...run, ...Array.from({ length: 50 }, (_, index) => ({ x: 98, y: index * 2 }))];
  const simplified = simplifyStroke(corner, 1);
  assert.deepEqual(simplified[0], corner[0]);
  assert.deepEqual(simplified.at(-1), corner.at(-1));
  assert.ok(simplified.length <= 4, `kept ${simplified.length} points`);
  assert.ok(simplified.some((point) => point.x === 98 && point.y === 0), "the corner stays");

  const scribble = Array.from({ length: 6000 }, (_, index) => ({ x: index, y: (index * 37) % 101 }));
  assert.ok(simplifyStroke(scribble).length <= 2000);
});

test("a stroke's points come back where they were drawn, and scale with its box", () => {
  const drawn = [
    { x: 100, y: 200 },
    { x: 180, y: 260 },
    { x: 300, y: 210 },
  ];
  const stroke = strokeFromCanvas(drawn, 4)!;
  // The box holds the line with room for its width.
  assert.ok(stroke.x <= 98 && stroke.y <= 198);
  assert.ok(stroke.x + stroke.w >= 302 && stroke.y + stroke.h >= 262);
  const frame = item("s", { kind: "stroke", ...stroke });
  strokeOnCanvas(frame).points.forEach((point, index) => {
    assert.ok(close(point.x, drawn[index]!.x, 0.1) && close(point.y, drawn[index]!.y, 0.1));
  });
  // Twice as wide: the line stretches with it.
  const wider = strokeOnCanvas({ ...frame, w: frame.w * 2 }).points;
  assert.ok(close(wider[2]!.x - wider[0]!.x, 2 * (drawn[2]!.x - drawn[0]!.x), 0.5));
  assert.equal(strokeFromCanvas([{ x: 0, y: 0 }], 3), null, "one point is not a line");
});

test("a pen path follows its curve handles, and a closed one returns to its start", () => {
  const stroke = strokeFromCanvas(
    [
      { x: 0, y: 0 },
      { x: 100, y: 0 },
    ],
    2,
    [
      { x: 0, y: 0 },
      { x: 0, y: 40 },
    ],
  )!;
  // The curve's handle counts towards the box.
  assert.ok(stroke.y + stroke.h >= 40);
  const open = strokePath({ ...stroke, closed: undefined });
  assert.match(open, /^M[\d.]+,[\d.]+ C/u);
  assert.doesNotMatch(open, /Z$/u);
  assert.match(strokePath({ ...stroke, closed: true }), / Z$/u);
});

test("an item drawn or dropped in an artboard belongs to it; dragged out, it leaves", () => {
  const board = item("board", { kind: "frame", shape: undefined, x: 0, y: 0, w: 800, h: 600 });
  const group = item("group", { kind: "group", shape: undefined, x: 2000, y: 0, w: 800, h: 600 });
  const doc = canvas(board, group, item("card", { x: 100, y: 100 }), item("far", { x: 5000, y: 0, groupId: "board" }));
  assert.equal(containerAt(doc, "page-1", { x: 100, y: 100, w: 100, h: 60 })?.id, "board");
  assert.equal(containerAt(doc, "page-1", { x: 2100, y: 100, w: 100, h: 60 })?.id, "group");

  const regrouped = regroupFrames(doc, ["card", "far"]);
  assert.equal(regrouped.frames.find((frame) => frame.id === "card")!.groupId, "board");
  assert.equal(regrouped.frames.find((frame) => frame.id === "far")!.groupId, undefined);
  assert.equal(regroupFrames(regrouped, ["card", "far"]), regrouped, "nothing to change returns the same document");
});

test("an item dragged along with its artboard stays in it, and artboards never join one another", () => {
  const doc = canvas(
    item("board", { kind: "frame", shape: undefined, x: 0, y: 0, w: 800, h: 600 }),
    item("inner", { kind: "frame", shape: undefined, x: 100, y: 100, w: 200, h: 200 }),
    item("card", { x: 5000, y: 0, groupId: "board" }),
  );
  assert.equal(regroupFrames(doc, ["board", "card", "inner"]), doc);
});
