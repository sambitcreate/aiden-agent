import assert from "node:assert/strict";
import test from "node:test";
import type { DesignFrame } from "../shared/design-canvas/schema";
import { DESIGN_LIVE_LIMIT, selectLiveFrames } from "./live-set-core";

function file(id: string, x: number, y: number, w = 200, h = 200): DesignFrame {
  return { id, kind: "file", title: id, x, y, w, h, path: `design/${id}.html`, pageId: "page-1", createdBy: "aiden" };
}

const view = { w: 1000, h: 800 };
const atOrigin = { x: 0, y: 0, zoom: 1 };
const none = new Set<string>();
const sorted = (set: Set<string>) => [...set].sort();

function live(
  frames: DesignFrame[],
  options: {
    viewport?: { x: number; y: number; zoom: number };
    selected?: string[];
    entered?: string | null;
    previous?: Iterable<string>;
  } = {},
) {
  return selectLiveFrames({
    frames,
    viewport: options.viewport ?? atOrigin,
    view,
    selected: new Set(options.selected ?? []),
    entered: options.entered ?? null,
    previous: new Set(options.previous ?? none),
  });
}

test("only file and artifact frames are ever live", () => {
  const frames: DesignFrame[] = [
    file("page", 0, 0),
    { id: "art", kind: "artifact", title: "Art", x: 300, y: 0, w: 200, h: 200, mediaId: "a1", pageId: "page-1", createdBy: "aiden" },
    { id: "note", kind: "note", title: "Note", x: 0, y: 300, w: 200, h: 200, text: "", pageId: "page-1", createdBy: "person" },
    { id: "pic", kind: "image", title: "Pic", x: 300, y: 300, w: 200, h: 200, path: "a.png", pageId: "page-1", createdBy: "person" },
    { id: "group", kind: "group", title: "Group", x: 0, y: 0, w: 900, h: 700, pageId: "page-1", createdBy: "person" },
  ];
  assert.deepEqual(sorted(live(frames, { selected: ["note", "group"], entered: "pic" })), ["art", "page"]);
});

test("below 25 % zoom nothing is live, not even the selection or the entered frame", () => {
  const frames = [file("a", 0, 0), file("b", 300, 0)];
  assert.deepEqual(sorted(live(frames, { viewport: { x: 0, y: 0, zoom: 0.2 }, selected: ["a"], entered: "b" })), []);
  assert.deepEqual(sorted(live(frames, { viewport: { x: 0, y: 0, zoom: 0.25 }, entered: "b" })), ["a", "b"]);
});

test("the entered frame is live even off-screen, ahead of everything else", () => {
  const onScreen = Array.from({ length: 10 }, (_, index) => file(`on${index}`, (index % 5) * 200, Math.floor(index / 5) * 300));
  const result = live([...onScreen, file("far", 50_000, 50_000)], { entered: "far" });
  assert.equal(result.has("far"), true);
  assert.equal(result.size, DESIGN_LIVE_LIMIT);
});

test("selected frames come before frames that are only in view, even off-screen", () => {
  const onScreen = Array.from({ length: 10 }, (_, index) => file(`on${index}`, (index % 5) * 200, Math.floor(index / 5) * 300));
  const result = live([...onScreen, file("far", 50_000, 0), file("far2", -50_000, 0)], { selected: ["far", "far2"] });
  assert.equal(result.has("far"), true);
  assert.equal(result.has("far2"), true);
  assert.equal(result.size, DESIGN_LIVE_LIMIT);
});

test("frames in view are ranked by the screen area they cover", () => {
  const frames = [
    file("small", 0, 0, 50, 50),
    file("large", 100, 0, 400, 400),
    // Larger than any frame here, but only 20 x 300 px of it is on screen.
    file("clipped", 980, 0, 800, 300),
    ...Array.from({ length: 5 }, (_, index) => file(`mid${index}`, index * 160, 500, 150, 150)),
  ];
  const result = live(frames);
  assert.equal(result.size, DESIGN_LIVE_LIMIT);
  assert.equal(result.has("large"), true);
  assert.equal(result.has("small"), false, "the smallest frame on screen loses its place");
  assert.equal(result.has("clipped"), false, "a clipped frame counts only the part on screen");
});

test("with 40 frames in view at most 6 are live", () => {
  const frames = Array.from({ length: 40 }, (_, index) => file(`f${index}`, (index % 8) * 120, Math.floor(index / 8) * 150, 100, 100));
  assert.equal(live(frames).size, DESIGN_LIVE_LIMIT);
});

test("frames fully off-screen are not live unless entered or selected", () => {
  const frames = [file("left", -500, 0), file("below", 0, 900), file("here", 0, 0)];
  assert.deepEqual(sorted(live(frames)), ["here"]);
  // Pan so the canvas moves 600 px right: "left" now sits at screen x 100.
  assert.deepEqual(sorted(live(frames, { viewport: { x: 600, y: 0, zoom: 1 } })), ["here", "left"]);
});

test("a live frame still half in view keeps its place over a newcomer of the same size", () => {
  const row = Array.from({ length: 5 }, (_, index) => file(`f${index}`, 100 + index * 140, 0, 120, 200));
  // After a small pan "edge" is exactly half off the left edge: 60 x 200 px show.
  const edge = file("edge", -60, 300, 120, 200);
  // The newcomer shows the same 60 x 200 px, and comes first in the document.
  const newcomer = file("new", 400, 300, 60, 200);
  const result = live([...row, newcomer, edge], { previous: ["f0", "f1", "f2", "f3", "f4", "edge"] });
  assert.equal(result.has("edge"), true, "a small pan does not swap the live frame out");
  assert.equal(result.has("new"), false);
  assert.equal(result.size, DESIGN_LIVE_LIMIT);
  // Without the history the newcomer, first in the document, would win the tie.
  assert.equal(live([...row, newcomer, edge]).has("new"), true);
});

test("a live frame less than half in view gives way to a newcomer that shows more", () => {
  const row = Array.from({ length: 5 }, (_, index) => file(`f${index}`, 100 + index * 140, 0, 120, 200));
  // Only 30 of its 120 px width shows.
  const edge = file("edge", -90, 300, 120, 200);
  const newcomer = file("new", 400, 300, 60, 200);
  const result = live([...row, edge, newcomer], { previous: ["f0", "f1", "f2", "f3", "f4", "edge"] });
  assert.equal(result.has("edge"), false);
  assert.equal(result.has("new"), true);
});

test("zoom scales the on-screen area and the view in canvas coordinates", () => {
  // At zoom 0.5 the 1000 x 800 view shows canvas 0..2000 x 0..1600.
  const frames = [file("in", 1700, 1300), file("out", 2100, 0)];
  assert.deepEqual(sorted(live(frames, { viewport: { x: 0, y: 0, zoom: 0.5 } })), ["in"]);
});
