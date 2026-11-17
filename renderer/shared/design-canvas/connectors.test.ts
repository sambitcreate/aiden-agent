// Arrows and lines: where their ends sit on the frames they join, and what
// happens to them as those frames move, go away or change page.

import assert from "node:assert/strict";
import test from "node:test";
import { applyNodeChanges } from "../../design/canvas-adapter-core.js";
import { attachTargetAt, connectorGeometry, syncConnectors } from "./connectors.js";
import { moveFramesToPage } from "./pages.js";
import { emptyDesignCanvas, parseDesignCanvas, type DesignCanvas, type DesignFrame } from "./schema.js";

function box(id: string, x: number, y: number, overrides: Partial<DesignFrame> = {}): DesignFrame {
  return { id, kind: "shape", shape: "rect", title: id, x, y, w: 100, h: 60, pageId: "page-1", createdBy: "person", ...overrides };
}

function arrow(id: string, ends: NonNullable<DesignFrame["ends"]>, overrides: Partial<DesignFrame> = {}): DesignFrame {
  return { id, kind: "connector", title: "Arrow", x: 0, y: 0, w: 1, h: 1, ends, arrow: "end", pageId: "page-1", createdBy: "person", ...overrides };
}

function canvas(...frames: DesignFrame[]): DesignCanvas {
  return syncConnectors({ ...emptyDesignCanvas(), revision: 1, frames });
}

const frameOf = (doc: DesignCanvas, id: string) => doc.frames.find((entry) => entry.id === id)!;
const endsOf = (doc: DesignCanvas, id: string) =>
  connectorGeometry(new Map(doc.frames.map((entry) => [entry.id, entry])), frameOf(doc, id)).ends;

test("an arrow between two boxes leaves from the sides that face each other, and follows a box that moves", () => {
  const doc = canvas(
    box("a", 0, 0),
    box("b", 400, 0),
    arrow("ab", [
      { x: 0, y: 0, frameId: "a" },
      { x: 0, y: 0, frameId: "b" },
    ]),
  );
  assert.deepEqual(endsOf(doc, "ab"), [
    { x: 100, y: 30 },
    { x: 400, y: 30 },
  ]);
  // Its stored ends and box are kept in step, with room around the line.
  assert.deepEqual(
    frameOf(doc, "ab").ends!.map((end) => [end.x, end.y]),
    [
      [100, 30],
      [400, 30],
    ],
  );
  assert.deepEqual(
    { x: frameOf(doc, "ab").x, y: frameOf(doc, "ab").y, w: frameOf(doc, "ab").w },
    { x: 88, y: 18, w: 324 },
  );

  // Drag b below a: the arrow now runs from a's bottom to b's top.
  const moved = applyNodeChanges(doc, [{ type: "position", id: "b", position: { x: 0, y: 300 }, dragging: false }]);
  assert.deepEqual(endsOf(moved, "ab"), [
    { x: 50, y: 60 },
    { x: 50, y: 300 },
  ]);
});

test("a side named on an end is kept wherever the other end goes", () => {
  const doc = canvas(
    box("a", 0, 0),
    arrow("free", [
      { x: 0, y: 0, frameId: "a", side: "top" },
      { x: 500, y: 30 },
    ]),
  );
  assert.deepEqual(endsOf(doc, "free"), [
    { x: 50, y: 0 },
    { x: 500, y: 30 },
  ]);
});

test("removing a box leaves the arrow's end where it was, as a free end", () => {
  const doc = canvas(
    box("a", 0, 0),
    box("b", 400, 0),
    arrow("ab", [
      { x: 0, y: 0, frameId: "a" },
      { x: 0, y: 0, frameId: "b" },
    ]),
  );
  const removed = applyNodeChanges(doc, [{ type: "remove", id: "b" }]);
  const ends = frameOf(removed, "ab").ends!;
  assert.deepEqual(ends[1], { x: 400, y: 30 });
  assert.equal(ends[0].frameId, "a", "the other end stays joined");
  // A free end stays put when the box it used to point at would have moved.
  const after = applyNodeChanges(removed, [{ type: "position", id: "a", position: { x: 0, y: 500 }, dragging: false }]);
  assert.deepEqual(endsOf(after, "ab")[1], { x: 400, y: 30 });
});

test("dragging an arrow moves its free ends and leaves the joined ones on their box", () => {
  const doc = canvas(
    box("a", 0, 0),
    arrow("out", [
      { x: 0, y: 0, frameId: "a" },
      { x: 400, y: 30 },
    ]),
  );
  const before = frameOf(doc, "out");
  const dragged = applyNodeChanges(doc, [
    { type: "position", id: "out", position: { x: before.x + 50, y: before.y + 100 }, dragging: false },
  ]);
  const ends = endsOf(dragged, "out");
  assert.deepEqual(ends[1], { x: 450, y: 130 });
  assert.equal(frameOf(dragged, "out").ends![0].frameId, "a");
});

test("an arrow moved to another page without its boxes lets go of them", () => {
  const doc = {
    ...canvas(
      box("a", 0, 0),
      box("b", 400, 0),
      arrow("ab", [
        { x: 0, y: 0, frameId: "a" },
        { x: 0, y: 0, frameId: "b" },
      ]),
    ),
  };
  const twoPages = { ...doc, pages: [...doc.pages, { id: "page-2", name: "Page 2", viewport: { x: 0, y: 0, zoom: 1 } }] };
  const moved = moveFramesToPage(twoPages, ["ab"], "page-2");
  assert.deepEqual(
    frameOf(moved, "ab").ends,
    [
      { x: 100, y: 30 },
      { x: 400, y: 30 },
    ],
  );
});

test("an end dropped on the canvas joins the topmost box there, never a line or the artboard under it", () => {
  const doc = canvas(
    box("board", 0, 0, { kind: "frame", shape: undefined, w: 1000, h: 800 }),
    box("card", 100, 100),
    arrow("line", [
      { x: 0, y: 0 },
      { x: 300, y: 300 },
    ]),
  );
  const page = doc.activePageId;
  assert.equal(attachTargetAt(doc, page, { x: 120, y: 120 })?.id, "card");
  assert.equal(attachTargetAt(doc, page, { x: 600, y: 600 })?.id, "board", "the artboard is a target where nothing is above it");
  assert.equal(attachTargetAt(doc, page, { x: 5000, y: 5000 }), undefined);
  assert.equal(attachTargetAt(doc, page, { x: 120, y: 120 }, new Set(["card"]))?.id, "board");
});

test("reading a document lets go of an end on a frame that is not there, another page's, or another arrow", () => {
  const result = parseDesignCanvas({
    version: 2,
    revision: 1,
    pages: [
      { id: "p1", name: "One", viewport: { x: 0, y: 0, zoom: 1 } },
      { id: "p2", name: "Two", viewport: { x: 0, y: 0, zoom: 1 } },
    ],
    activePageId: "p1",
    frames: [
      { ...box("here", 0, 0), pageId: "p1" },
      { ...box("there", 0, 0), pageId: "p2" },
      { ...arrow("other", [{ x: 1, y: 1 }, { x: 2, y: 2 }]), pageId: "p1" },
      {
        ...arrow("a1", [
          { x: 10, y: 10, frameId: "there" },
          { x: 20, y: 20, frameId: "missing" },
        ]),
        pageId: "p1",
      },
      {
        ...arrow("a2", [
          { x: 10, y: 10, frameId: "other" },
          { x: 900, y: 30, frameId: "here", side: "right" },
        ]),
        pageId: "p1",
      },
    ],
    comments: [],
  });
  assert.ok(result.ok);
  const doc = result.doc;
  assert.deepEqual(frameOf(doc, "a1").ends, [
    { x: 10, y: 10 },
    { x: 20, y: 20 },
  ]);
  assert.deepEqual(frameOf(doc, "a2").ends, [
    { x: 10, y: 10 },
    { x: 100, y: 30, frameId: "here", side: "right" },
  ]);
});
