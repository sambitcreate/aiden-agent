import assert from "node:assert/strict";
import test from "node:test";
import {
  emptyDesignCanvas,
  type DesignCanvasV1,
  type DesignFrame,
} from "../shared/design-canvas/schema";
import {
  applyNodeChanges,
  duplicateFrames,
  nodesFromCanvas,
  placeFrame,
} from "./canvas-adapter-core";

function frame(id: string, overrides: Partial<DesignFrame> = {}): DesignFrame {
  return { id, kind: "note", title: id, x: 0, y: 0, w: 200, h: 120, text: "", createdBy: "person", ...overrides };
}

function canvas(...frames: DesignFrame[]): DesignCanvasV1 {
  return { ...emptyDesignCanvas(), revision: 3, frames };
}

const byId = (doc: DesignCanvasV1, id: string) => doc.frames.find((entry) => entry.id === id);
const box = (entry: DesignFrame | undefined) => entry && { x: entry.x, y: entry.y, w: entry.w, h: entry.h };
let counter = 0;
const newId = () => `new-${++counter}`;

const grouped = canvas(
  frame("a", { groupId: "g", x: 120, y: 140 }),
  frame("g", { kind: "group", x: 100, y: 100, w: 800, h: 400 }),
  frame("b", { groupId: "g", x: 400, y: 140 }),
  frame("loose", { x: 2000, y: 0 }),
);

test("groups come first so their frames draw above them, and selection and box carry over", () => {
  const nodes = nodesFromCanvas(grouped, new Set(["b"]));
  assert.deepEqual(
    nodes.map((node) => node.id),
    ["g", "a", "b", "loose"],
  );
  const b = nodes.find((node) => node.id === "b")!;
  assert.equal(b.type, "note");
  assert.deepEqual(b.position, { x: 400, y: 140 });
  assert.equal(b.width, 200);
  assert.equal(b.height, 120);
  assert.equal(b.selected, true);
  assert.equal(nodes.find((node) => node.id === "a")!.selected, false);
  assert.equal(b.data.frame, byId(grouped, "b"));
});

test("moving a frame inside a group moves only that frame", () => {
  const next = applyNodeChanges(grouped, [{ type: "position", id: "a", position: { x: 150, y: 160 } }]);
  assert.deepEqual(box(byId(next, "a")), { x: 150, y: 160, w: 200, h: 120 });
  assert.deepEqual(box(byId(next, "g")), box(byId(grouped, "g")));
  assert.deepEqual(box(byId(next, "b")), box(byId(grouped, "b")));
  assert.equal(grouped.frames[0]!.x, 120, "the input document is not mutated");
});

test("moving a group carries its frames by the same delta and leaves other frames", () => {
  const next = applyNodeChanges(grouped, [{ type: "position", id: "g", position: { x: 130, y: 90 } }]);
  assert.deepEqual(box(byId(next, "g")), { x: 130, y: 90, w: 800, h: 400 });
  assert.deepEqual(box(byId(next, "a")), { x: 150, y: 130, w: 200, h: 120 });
  assert.deepEqual(box(byId(next, "b")), { x: 430, y: 130, w: 200, h: 120 });
  assert.deepEqual(box(byId(next, "loose")), box(byId(grouped, "loose")));
});

test("dragging a group together with one of its selected frames moves that frame once", () => {
  const next = applyNodeChanges(grouped, [
    { type: "position", id: "g", position: { x: 130, y: 100 } },
    { type: "position", id: "a", position: { x: 150, y: 140 } },
  ]);
  assert.deepEqual(box(byId(next, "a")), { x: 150, y: 140, w: 200, h: 120 });
  assert.deepEqual(box(byId(next, "b")), { x: 430, y: 140, w: 200, h: 120 });
});

test("a resize is clamped to 40-8000 px on each side", () => {
  const small = applyNodeChanges(grouped, [
    { type: "dimensions", id: "a", dimensions: { width: 5, height: 20_000 }, resizing: true, setAttributes: true },
  ]);
  assert.deepEqual(box(byId(small, "a")), { x: 120, y: 140, w: 40, h: 8000 });
});

test("React Flow measuring a node is not an edit", () => {
  const next = applyNodeChanges(grouped, [
    { type: "dimensions", id: "a", dimensions: { width: 333, height: 222 } },
    { type: "select", id: "a", selected: true },
  ]);
  assert.equal(next, grouped, "the same document comes back, so nothing is saved");
});

test("removing a group keeps its frames and clears their group", () => {
  const next = applyNodeChanges(grouped, [{ type: "remove", id: "g" }]);
  assert.deepEqual(
    next.frames.map((entry) => entry.id),
    ["a", "b", "loose"],
  );
  assert.equal(byId(next, "a")!.groupId, undefined);
  assert.equal(byId(next, "b")!.groupId, undefined);
  assert.deepEqual(box(byId(next, "a")), box(byId(grouped, "a")));
});

test("removing a frame drops only that frame", () => {
  const next = applyNodeChanges(grouped, [{ type: "remove", id: "b" }]);
  assert.deepEqual(
    next.frames.map((entry) => entry.id),
    ["a", "g", "loose"],
  );
});

test("a new frame on an empty canvas is centred in the view", () => {
  const placed = placeFrame(
    emptyDesignCanvas(),
    { kind: "note", title: "Note", w: 200, h: 100, text: "", createdBy: "person" },
    { x: -500, y: 200, w: 1000, h: 600 },
    () => "n1",
  );
  if ("error" in placed) return assert.fail(placed.error);
  assert.equal(placed.id, "n1");
  assert.deepEqual(box(byId(placed.doc, "n1")), { x: -100, y: 450, w: 200, h: 100 });
});

test("a new frame in a group goes 64 px right of the group's last frame, on the same top", () => {
  const placed = placeFrame(
    grouped,
    { kind: "file", title: "Pricing", w: 390, h: 844, groupId: "g", path: "design/pricing.html", createdBy: "aiden" },
    { x: 0, y: 0, w: 1000, h: 800 },
    () => "f1",
  );
  if ("error" in placed) return assert.fail(placed.error);
  assert.deepEqual(box(byId(placed.doc, "f1")), { x: 664, y: 140, w: 390, h: 844 });
  assert.equal(byId(placed.doc, "f1")!.groupId, "g");
  assert.equal(placed.doc.frames.length, grouped.frames.length + 1);
});

test("an explicit position is kept, and a size outside the limits is clamped", () => {
  const placed = placeFrame(
    grouped,
    { kind: "note", title: "Here", x: 10, y: 20, w: 1, h: 99_999, text: "", createdBy: "person" },
    { x: 0, y: 0, w: 1000, h: 800 },
    () => "p1",
  );
  if ("error" in placed) return assert.fail(placed.error);
  assert.deepEqual(box(byId(placed.doc, "p1")), { x: 10, y: 20, w: 40, h: 8000 });
});

test("a canvas holds at most 200 frames", () => {
  const full = canvas(...Array.from({ length: 200 }, (_, index) => frame(`f${index}`)));
  const result = placeFrame(
    full,
    { kind: "note", title: "One more", w: 200, h: 100, text: "", createdBy: "person" },
    { x: 0, y: 0, w: 1000, h: 800 },
    () => "extra",
  );
  assert.deepEqual(result, { error: "limit" });
  const almost = canvas(...Array.from({ length: 199 }, (_, index) => frame(`f${index}`)));
  assert.equal(
    "doc" in
      placeFrame(almost, { kind: "note", title: "Last", w: 200, h: 100, text: "", createdBy: "person" }, { x: 0, y: 0, w: 1000, h: 800 }, () => "last"),
    true,
  );
});

test("duplicating frames copies them 32 px down and right with new ids", () => {
  counter = 0;
  const next = duplicateFrames(grouped, ["a", "loose"], newId);
  assert.equal(next.frames.length, grouped.frames.length + 2);
  assert.deepEqual(box(byId(next, "new-1")), { x: 152, y: 172, w: 200, h: 120 });
  assert.equal(byId(next, "new-1")!.groupId, "g", "a copy stays in its group");
  assert.deepEqual(box(byId(next, "new-2")), { x: 2032, y: 32, w: 200, h: 120 });
  assert.deepEqual(box(byId(next, "a")), box(byId(grouped, "a")));
});

test("duplicating a group copies its frames into the new group", () => {
  counter = 0;
  const next = duplicateFrames(grouped, ["g"], newId);
  const copy = next.frames.find((entry) => entry.kind === "group" && entry.id !== "g")!;
  const members = next.frames.filter((entry) => entry.groupId === copy.id);
  assert.deepEqual(box(copy), { x: 132, y: 132, w: 800, h: 400 });
  assert.deepEqual(
    members.map((entry) => [entry.x, entry.y]),
    [
      [152, 172],
      [432, 172],
    ],
  );
  assert.equal(next.frames.filter((entry) => entry.groupId === "g").length, 2, "the originals stay put");
});

test("a duplicate that would pass 200 frames changes nothing", () => {
  const full = canvas(...Array.from({ length: 199 }, (_, index) => frame(`f${index}`)));
  assert.equal(duplicateFrames(full, ["f0", "f1"], newId), full);
});
