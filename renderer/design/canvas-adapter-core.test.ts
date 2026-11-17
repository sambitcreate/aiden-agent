import assert from "node:assert/strict";
import test from "node:test";
import {
  emptyDesignCanvas,
  type DesignCanvas,
  type DesignFrame,
} from "../shared/design-canvas/schema";
import {
  applyNodeChanges,
  duplicateFrames,
  nodesFromCanvas,
  placeFrame,
  presentedFrameIds,
  resolveCanvasFocus,
} from "./canvas-adapter-core";

function frame(id: string, overrides: Partial<DesignFrame> = {}): DesignFrame {
  return { id, kind: "note", title: id, x: 0, y: 0, w: 200, h: 120, text: "", pageId: "page-1", createdBy: "person", ...overrides };
}

function canvas(...frames: DesignFrame[]): DesignCanvas {
  return { ...emptyDesignCanvas(), revision: 3, frames };
}

const byId = (doc: DesignCanvas, id: string) => doc.frames.find((entry) => entry.id === id);
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

test("removing a frame drops only that frame, with its comments", () => {
  const comment = (id: string, frameId?: string) => ({
    id, pageId: "page-1", ...(frameId ? { frameId } : {}), x: 0, y: 0, note: id, state: "open" as const, anchorState: "anchored" as const, createdAt: "2026-11-05T10:00:00.000Z",
  });
  const withComments = { ...grouped, comments: [comment("on-b", "b"), comment("on-a", "a"), comment("free")] };
  const next = applyNodeChanges(withComments, [{ type: "remove", id: "b" }]);
  assert.deepEqual(
    next.frames.map((entry) => entry.id),
    ["a", "g", "loose"],
  );
  assert.deepEqual(next.comments.map((entry) => entry.id), ["on-a", "free"]);
});

test("a new frame on an empty canvas is centred in the view", () => {
  const placed = placeFrame(
    emptyDesignCanvas(),
    { kind: "note", title: "Note", w: 200, h: 100, text: "", pageId: "page-1", createdBy: "person" },
    { x: -500, y: 200, w: 1000, h: 600 },
    () => "n1",
  );
  if ("error" in placed) return assert.fail(placed.error);
  assert.equal(placed.id, "n1");
  assert.deepEqual(box(byId(placed.doc, "n1")), { x: -100, y: 450, w: 200, h: 100 });
});

test("a new frame beside others in view goes 64 px right of the last one, on the same top, not on top of it", () => {
  const view = { x: 0, y: 0, w: 1000, h: 800 };
  const note = { kind: "note", title: "Note", w: 200, h: 100, text: "", pageId: "page-1", createdBy: "person" } as const;
  const first = placeFrame(emptyDesignCanvas(), note, view, () => "n1");
  if ("error" in first) return assert.fail(first.error);
  const second = placeFrame(first.doc, note, view, () => "n2");
  if ("error" in second) return assert.fail(second.error);
  assert.deepEqual(box(byId(second.doc, "n2")), { x: 400 + 200 + 64, y: 350, w: 200, h: 100 });

  // Only frames the person can see count: "loose" is off to the right, and a
  // group member follows its group, so the group is the last frame in view.
  const placed = placeFrame(grouped, note, view, () => "n3");
  if ("error" in placed) return assert.fail(placed.error);
  assert.deepEqual(box(byId(placed.doc, "n3")), { x: 900 + 64, y: 100, w: 200, h: 100 });
});

test("frames added one after another never land on each other, even once the row runs past the view", () => {
  const view = { x: 0, y: 0, w: 800, h: 800 };
  let doc = emptyDesignCanvas();
  const sizes = [
    { w: 200, h: 100 },
    { w: 640, h: 400 },
    { w: 1280, h: 800 },
    { w: 1280, h: 800 },
    { w: 320, h: 240 },
  ];
  sizes.forEach((size, index) => {
    const placed = placeFrame(
      doc,
      { kind: "note", title: `F${index}`, ...size, text: "", pageId: "page-1", createdBy: "person" },
      view,
      () => `f${index}`,
    );
    if ("error" in placed) return assert.fail(placed.error);
    doc = placed.doc;
  });
  for (const a of doc.frames) {
    for (const b of doc.frames) {
      if (a === b) continue;
      const overlap = a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
      assert.equal(overlap, false, `${a.id} overlaps ${b.id}`);
    }
  }
});

test("a new frame is centred when every other frame is out of view", () => {
  const placed = placeFrame(
    grouped,
    { kind: "note", title: "Note", w: 200, h: 100, text: "", pageId: "page-1", createdBy: "person" },
    { x: 5000, y: 5000, w: 1000, h: 800 },
    () => "n4",
  );
  if ("error" in placed) return assert.fail(placed.error);
  assert.deepEqual(box(byId(placed.doc, "n4")), { x: 5400, y: 5350, w: 200, h: 100 });
});

test("a new frame in a group goes 64 px right of the group's last frame, on the same top", () => {
  const placed = placeFrame(
    grouped,
    { kind: "file", title: "Pricing", w: 390, h: 844, groupId: "g", path: "design/pricing.html", pageId: "page-1", createdBy: "aiden" },
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
    { kind: "note", title: "Here", x: 10, y: 20, w: 1, h: 99_999, text: "", pageId: "page-1", createdBy: "person" },
    { x: 0, y: 0, w: 1000, h: 800 },
    () => "p1",
  );
  if ("error" in placed) return assert.fail(placed.error);
  assert.deepEqual(box(byId(placed.doc, "p1")), { x: 10, y: 20, w: 40, h: 8000 });
});

test("a page holds at most 400 frames, and the canvas 1 000", () => {
  const note = { kind: "note" as const, title: "One more", w: 200, h: 100, text: "", createdBy: "person" as const };
  const view = { x: 0, y: 0, w: 1000, h: 800 };
  const full = canvas(...Array.from({ length: 400 }, (_, index) => frame(`f${index}`)));
  assert.deepEqual(placeFrame(full, { ...note, pageId: "page-1" }, view, () => "extra"), { error: "limit" });
  const almost = canvas(...Array.from({ length: 399 }, (_, index) => frame(`f${index}`)));
  assert.equal("doc" in placeFrame(almost, { ...note, pageId: "page-1" }, view, () => "last"), true);

  // Another page still has room until the canvas as a whole is full.
  const second = { ...full, pages: [...full.pages, { id: "page-2", name: "Page 2", viewport: { x: 0, y: 0, zoom: 1 } }] };
  assert.equal("doc" in placeFrame(second, { ...note, pageId: "page-2" }, view, () => "other"), true);
  const everywhere = {
    ...second,
    frames: [
      ...second.frames,
      ...Array.from({ length: 600 }, (_, index) => frame(`g${index}`, { pageId: "page-2" })),
    ],
  };
  assert.deepEqual(placeFrame(everywhere, { ...note, pageId: "page-2" }, view, () => "over"), { error: "limit" });
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

test("a duplicate that would pass 400 frames on a page changes nothing", () => {
  const full = canvas(...Array.from({ length: 399 }, (_, index) => frame(`f${index}`)));
  assert.equal(duplicateFrames(full, ["f0", "f1"], newId), full);
  assert.equal(duplicateFrames(full, ["f0"], newId).frames.length, 400);
});

test("an arrow is drawn where its ends are, and only its line takes the pointer", () => {
  const doc = canvas(
    frame("a", { kind: "shape", shape: "rect", x: 0, y: 0, w: 100, h: 60 }),
    frame("b", { kind: "shape", shape: "rect", x: 400, y: 0, w: 100, h: 60 }),
    // Stored box out of date on purpose: the node follows the ends, not the stored box.
    frame("ab", {
      kind: "connector",
      x: 9999,
      y: 9999,
      w: 1,
      h: 1,
      ends: [
        { x: 0, y: 0, frameId: "a" },
        { x: 0, y: 0, frameId: "b" },
      ],
    }),
  );
  const node = nodesFromCanvas(doc, new Set()).find((entry) => entry.id === "ab")!;
  assert.deepEqual(node.data.ends, [
    { x: 100, y: 30 },
    { x: 400, y: 30 },
  ]);
  assert.deepEqual({ ...node.position, w: node.width }, { x: 88, y: 18, w: 324 });
  assert.equal(node.style?.pointerEvents, "none");
  assert.equal(nodesFromCanvas(doc, new Set()).find((entry) => entry.id === "a")!.style, undefined);
});

test("an artboard draws under what is in it and carries it when moved", () => {
  const doc = canvas(
    frame("card", { kind: "shape", shape: "rect", x: 50, y: 50, groupId: "board" }),
    frame("board", { kind: "frame", x: 0, y: 0, w: 800, h: 600 }),
  );
  assert.deepEqual(
    nodesFromCanvas(doc, new Set()).map((node) => node.id),
    ["board", "card"],
  );
  const moved = applyNodeChanges(doc, [{ type: "position", id: "board", position: { x: 100, y: 0 }, dragging: true }]);
  assert.deepEqual(box(byId(moved, "card")), { x: 150, y: 50, w: 200, h: 120 });
});

test("a shape can be resized small, but an arrow's box is not resized at all", () => {
  const doc = canvas(
    frame("s", { kind: "shape", shape: "oval" }),
    frame("c", { kind: "connector", ends: [{ x: 0, y: 0 }, { x: 100, y: 0 }] }),
  );
  const next = applyNodeChanges(doc, [
    { type: "dimensions", id: "s", dimensions: { width: 10, height: 2 }, resizing: true },
    { type: "dimensions", id: "c", dimensions: { width: 500, height: 500 }, resizing: true },
  ]);
  assert.deepEqual([byId(next, "s")!.w, byId(next, "s")!.h], [10, 8]);
  assert.deepEqual(byId(next, "c")!.ends, byId(doc, "c")!.ends);
});

test("duplicating boxes with the arrow between them joins the copied arrow to the copies", () => {
  counter = 0;
  const doc = canvas(
    frame("a", { kind: "shape", shape: "rect", x: 0, y: 0, w: 100, h: 60 }),
    frame("b", { kind: "shape", shape: "rect", x: 400, y: 0, w: 100, h: 60 }),
    frame("ab", {
      kind: "connector",
      ends: [
        { x: 100, y: 30, frameId: "a" },
        { x: 400, y: 30, frameId: "b" },
      ],
    }),
  );
  const all = duplicateFrames(doc, ["a", "b", "ab"], newId);
  const copied = all.frames.find((entry) => entry.kind === "connector" && entry.id !== "ab")!;
  assert.deepEqual(
    copied.ends!.map((end) => end.frameId),
    ["new-1", "new-2"],
  );
  // Copied alone, the arrow's ends become free ends beside the original's.
  counter = 0;
  const alone = duplicateFrames(doc, ["ab"], newId);
  assert.deepEqual(alone.frames.find((entry) => entry.id === "new-1")!.ends, [
    { x: 132, y: 62 },
    { x: 432, y: 62 },
  ]);
});

test("a hidden frame is not drawn, and an artboard's items hide with it", () => {
  const doc = canvas(
    frame("board", { kind: "frame", hidden: true }),
    frame("inside", { groupId: "board" }),
    frame("shown"),
  );
  const hidden = new Map(nodesFromCanvas(doc, new Set()).map((node) => [node.id, node.hidden === true]));
  assert.deepEqual(Object.fromEntries(hidden), { board: true, inside: true, shown: false });
});

test("a locked frame does not move, resize or go away, and its copy is unlocked", () => {
  const doc = canvas(frame("pinned", { locked: true, x: 10, y: 20 }), frame("free"));
  const after = applyNodeChanges(doc, [
    { type: "position", id: "pinned", position: { x: 500, y: 500 } },
    { type: "dimensions", id: "pinned", dimensions: { width: 900, height: 900 }, resizing: true },
    { type: "remove", id: "pinned" },
  ]);
  assert.equal(after, doc);
  assert.deepEqual(box(byId(applyNodeChanges(doc, [{ type: "remove", id: "free" }]), "pinned")), { x: 10, y: 20, w: 200, h: 120 });
  const node = nodesFromCanvas(doc, new Set(["pinned"])).find((entry) => entry.id === "pinned")!;
  assert.equal(node.draggable, false);
  assert.equal(node.deletable, false);
  const copied = duplicateFrames(doc, ["pinned"], newId);
  assert.equal(copied.frames[copied.frames.length - 1]!.locked, undefined);
});

test("presenting a frame shows it with what is in it and its own arrows, never a neighbour on top of it", () => {
  const doc = canvas(
    frame("board", { kind: "frame", x: 0, y: 0, w: 1000, h: 800 }),
    frame("inner", { kind: "group", groupId: "board", x: 50, y: 50, w: 400, h: 300 }),
    frame("deep", { groupId: "inner", x: 60, y: 60 }),
    frame("title", { groupId: "board", x: 500, y: 50 }),
    // Lies over the artboard without being part of it.
    frame("overlap", { x: 100, y: 100 }),
    frame("beside", { x: 1010, y: 0 }),
    frame("inside-arrow", {
      kind: "connector",
      ends: [
        { x: 0, y: 0, frameId: "deep", side: "right" },
        { x: 0, y: 0, frameId: "title", side: "left" },
      ],
    }),
    frame("outward-arrow", {
      kind: "connector",
      ends: [
        { x: 0, y: 0, frameId: "title", side: "right" },
        { x: 0, y: 0, frameId: "beside", side: "left" },
      ],
    }),
    frame("loose-arrow", { kind: "connector", ends: [{ x: 10, y: 10 }, { x: 90, y: 90 }] }),
  );
  assert.deepEqual([...presentedFrameIds(doc, "board")].sort(), ["board", "deep", "inner", "inside-arrow", "title"]);
  assert.deepEqual([...presentedFrameIds(doc, "beside")], ["beside"]);
  assert.equal(presentedFrameIds(doc, "gone").size, 0);
});

test("canvas focus waits until every target frame is present and measured before fitting", () => {
  const measured = new Set(["f1"]);
  assert.deepEqual(
    resolveCanvasFocus({
      requestedIds: ["f1", "f2"],
      nodeIds: ["f1", "f2"],
      isMeasured: (id) => measured.has(id),
      waitedMs: 200,
      maxWaitMs: 3_000,
    }),
    { action: "wait" },
    "having only the first frame measured is not enough when fitting two",
  );
  assert.deepEqual(
    resolveCanvasFocus({
      requestedIds: [],
      nodeIds: ["f1", "f2"],
      isMeasured: (id) => measured.has(id),
      waitedMs: 200,
      maxWaitMs: 3_000,
    }),
    { action: "wait" },
    "whole-page focus waits for every page frame to be measured too",
  );

  measured.add("f2");
  assert.deepEqual(
    resolveCanvasFocus({
      requestedIds: ["f1", "f2"],
      nodeIds: ["f1", "f2", "other"],
      isMeasured: (id) => measured.has(id),
      waitedMs: 200,
      maxWaitMs: 3_000,
    }),
    { action: "fit", ids: ["f1", "f2"] },
  );
  assert.deepEqual(
    resolveCanvasFocus({
      requestedIds: [],
      nodeIds: ["f1", "f2"],
      isMeasured: (id) => measured.has(id),
      waitedMs: 200,
      maxWaitMs: 3_000,
    }),
    { action: "fit", ids: [] },
  );
  assert.deepEqual(
    resolveCanvasFocus({
      requestedIds: ["gone"],
      nodeIds: ["f1"],
      isMeasured: () => true,
      waitedMs: 3_000,
      maxWaitMs: 3_000,
    }),
    { action: "drop" },
  );
});

test("hidden frames never stall canvas focus or enter fitView targets", () => {
  const measured = new Set(["f1"]);
  assert.deepEqual(
    resolveCanvasFocus({
      requestedIds: [],
      nodeIds: ["f1", "hidden-1"],
      hiddenIds: ["hidden-1"],
      isMeasured: (id) => measured.has(id),
      waitedMs: 0,
      maxWaitMs: 3_000,
    }),
    { action: "fit", ids: [] },
    "whole-page focus fits immediately once visible frames are measured, ignoring unmeasured hidden frames",
  );
  assert.deepEqual(
    resolveCanvasFocus({
      requestedIds: ["f1", "hidden-1"],
      nodeIds: ["f1", "hidden-1"],
      hiddenIds: ["hidden-1"],
      isMeasured: (id) => measured.has(id),
      waitedMs: 0,
      maxWaitMs: 3_000,
    }),
    { action: "fit", ids: ["f1"] },
    "targeted focus fits only visible requested frames without waiting on hidden ones",
  );
  assert.deepEqual(
    resolveCanvasFocus({
      requestedIds: ["hidden-1"],
      nodeIds: ["f1", "hidden-1"],
      hiddenIds: ["hidden-1"],
      isMeasured: (id) => measured.has(id),
      waitedMs: 0,
      maxWaitMs: 3_000,
    }),
    { action: "drop" },
    "focusing only hidden frames drops immediately instead of stalling 3 s",
  );
  assert.deepEqual(
    resolveCanvasFocus({
      requestedIds: [],
      nodeIds: ["hidden-1"],
      hiddenIds: ["hidden-1"],
      isMeasured: () => false,
      waitedMs: 0,
      maxWaitMs: 3_000,
    }),
    { action: "drop" },
    "whole-page focus drops immediately when every frame on the page is hidden",
  );
});
