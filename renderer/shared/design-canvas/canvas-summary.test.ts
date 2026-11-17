import assert from "node:assert/strict";
import test from "node:test";
import { canvasPromptLine, canvasView, CANVAS_READ_FRAME_LIMIT, describeCanvas } from "./canvas-summary.js";
import { emptyDesignCanvas, type DesignCanvas, type DesignFrame } from "./schema.js";

function note(id: string, x: number, y: number, extra: Partial<DesignFrame> = {}): DesignFrame {
  return { id, kind: "note", title: id, text: `about ${id}`, x, y, w: 240, h: 160, pageId: "page-1", createdBy: "aiden", ...extra };
}

function canvas(frames: DesignFrame[], extra: Partial<DesignCanvas> = {}): DesignCanvas {
  return { ...emptyDesignCanvas(), frames, ...extra };
}

test("the view is what a panned and zoomed canvas shows, in canvas units", () => {
  // Panned so canvas point (500, 250) sits at the top-left, zoomed out to half size.
  const doc = canvas([], { pages: [{ id: "page-1", name: "Page 1", viewport: { x: -250, y: -125, zoom: 0.5 } }] });
  assert.deepEqual(canvasView(doc, { w: 1200, h: 800 }), { x: 500, y: 250, w: 2400, h: 1600 });
  // Zoomed in, the same screen covers less of the canvas.
  assert.deepEqual(canvasView(canvas([], { pages: [{ id: "page-1", name: "Page 1", viewport: { x: 0, y: 0, zoom: 2 } }] }), { w: 1200, h: 800 }), { x: 0, y: 0, w: 600, h: 400 });
});

test("a frame partly in view is listed; one just past the edge is counted as outside", () => {
  const view = { x: 0, y: 0, w: 1000, h: 1000 };
  const doc = canvas([note("edge", 900, 900), note("past", 1000, 0), note("loose", 5000, 5000)]);
  const answer = describeCanvas(doc, { view });
  assert.deepEqual(answer.inView.map((frame) => frame.id), ["edge"]);
  assert.deepEqual(answer.outsideView, [{ groupId: "ungrouped", title: "Not in a group", frames: 2 }]);
  assert.equal(answer.frameCount, 3);
  assert.equal(answer.inView[0]!.text, "about edge");
});

test("a crowded view lists the first frames and says how many it left out", () => {
  const frames = Array.from({ length: CANVAS_READ_FRAME_LIMIT + 5 }, (_, index) => note(`n${index}`, index, index));
  const answer = describeCanvas(canvas(frames), { view: { x: 0, y: 0, w: 2000, h: 2000 } });
  assert.equal(answer.inView.length, CANVAS_READ_FRAME_LIMIT);
  assert.equal(answer.omitted, 5);
  assert.equal(answer.frameCount, CANVAS_READ_FRAME_LIMIT + 5);
});

test("comments on removed frames and resolved comments do not count against a frame", () => {
  const doc = canvas([note("a", 0, 0)], {
    comments: [
      { id: "c1", frameId: "a", x: 1, y: 1, note: "one", state: "open", pageId: "page-1", anchorState: "anchored", createdAt: "2026-11-05T00:00:00Z" },
      { id: "c2", frameId: "a", x: 1, y: 1, note: "two", state: "resolved", pageId: "page-1", anchorState: "anchored", createdAt: "2026-11-05T00:00:00Z" },
      { id: "c3", x: 1, y: 1, note: "loose", state: "open", pageId: "page-1", anchorState: "lost", createdAt: "2026-11-05T00:00:00Z" },
    ],
  });
  const answer = describeCanvas(doc, { view: { x: 0, y: 0, w: 1000, h: 1000 } });
  assert.equal(answer.inView[0]!.openComments, 1);
  assert.equal(answer.openComments, 2, "the total counts every open comment, anchored or not");
});

test("the prompt line names frames, pages and open comments in plain words", () => {
  assert.equal(canvasPromptLine(canvas([])), "The canvas is empty.");
  assert.equal(canvasPromptLine(canvas([note("a", 0, 0)])), "The canvas has 1 frame, 0 open comments.");
  const page: DesignFrame = { id: "p", kind: "file", title: "Home", path: "design/home.html", x: 0, y: 0, w: 640, h: 436, designWidth: 1280, pageId: "page-1", createdBy: "aiden" };
  const doc = canvas([page, note("a", 0, 0)], {
    comments: [{ id: "c1", frameId: "p", x: 1, y: 1, note: "one", state: "open", pageId: "page-1", anchorState: "anchored", createdAt: "2026-11-05T00:00:00Z" }],
  });
  assert.equal(canvasPromptLine(doc), "The canvas has 2 frames, 1 HTML file, 1 open comment.");
});

test("a canvas with pages describes one page at a time and lists them all", () => {
  const doc = canvas([note("home", 0, 0), note("pricing", 0, 0, { pageId: "p2" }), note("faq", 9000, 9000, { pageId: "p2" })], {
    pages: [
      { id: "page-1", name: "Home", viewport: { x: 0, y: 0, zoom: 1 } },
      { id: "p2", name: "Pricing", viewport: { x: 0, y: 0, zoom: 1 } },
    ],
    activePageId: "p2",
    comments: [{ id: "c", frameId: "home", x: 0, y: 0, note: "", state: "open", pageId: "page-1", anchorState: "anchored", createdAt: "t" }],
  });
  const onScreen = describeCanvas(doc);
  assert.deepEqual(onScreen.page, { id: "p2", name: "Pricing" });
  assert.deepEqual(onScreen.inView.map((frame) => frame.id), ["pricing"]);
  assert.equal(onScreen.frameCount, 2);
  assert.equal(onScreen.openComments, 0, "comments on other pages are not counted");
  assert.deepEqual(onScreen.pages, [
    { id: "page-1", name: "Home", frames: 1, onScreen: false },
    { id: "p2", name: "Pricing", frames: 2, onScreen: true },
  ]);
  const home = describeCanvas(doc, { pageId: "page-1" });
  assert.deepEqual(home.inView.map((frame) => frame.id), ["home"]);
  assert.equal(home.openComments, 1);
  assert.equal(
    canvasPromptLine(doc),
    'The canvas has 3 frames, 1 open comment. It has 2 pages; the person is looking at "Pricing".',
  );
});

test("Aiden reads which pages the person shows dark or tweaked, and which items they hid", () => {
  const view = { x: 0, y: 0, w: 2000, h: 2000 };
  const page = note("page", 0, 0, { kind: "file", path: "design/a.html", text: undefined, dark: true, tweaks: { "--accent": "#ff0055" } });
  const answer = describeCanvas(canvas([page, note("gone", 300, 0, { hidden: true }), note("plain", 600, 0)]), { view });
  const byId = new Map(answer.inView.map((frame) => [frame.id, frame]));
  assert.equal(byId.get("page")!.dark, true);
  assert.deepEqual(byId.get("page")!.tweaks, { "--accent": "#ff0055" });
  assert.equal(byId.get("gone")!.hidden, true);
  assert.deepEqual([byId.get("plain")!.dark, byId.get("plain")!.tweaks, byId.get("plain")!.hidden], [undefined, undefined, undefined]);
});

test("frames outside the view are listed one by one with their boxes, within the shared frame budget", () => {
  const view = { x: 0, y: 0, w: 1000, h: 1000 };
  const locked = note("far", 9000, 0, { locked: true, groupId: "g", text: "x".repeat(500) });
  const board: DesignFrame = { id: "g", kind: "frame", title: "Board", x: 8800, y: -100, w: 1000, h: 800, radius: 12, guide: "grid-8", pageId: "page-1", createdBy: "person" };
  const answer = describeCanvas(canvas([note("near", 0, 0), board, locked]), { view });
  assert.deepEqual(
    answer.outsideFrames.map((frame) => [frame.id, frame.box, frame.groupId]),
    [
      ["g", { x: 8800, y: -100, w: 1000, h: 800 }, undefined],
      ["far", { x: 9000, y: 0, w: 240, h: 160 }, "g"],
    ],
  );
  const [boardSummary, farSummary] = answer.outsideFrames;
  assert.deepEqual([boardSummary!.radius, boardSummary!.guide], [12, "grid-8"]);
  assert.equal(farSummary!.locked, true);
  assert.ok(farSummary!.text!.length < 200, "long words outside the view are cut short");
  assert.equal(answer.outsideOmitted, 0);

  const crowded = Array.from({ length: CANVAS_READ_FRAME_LIMIT + 3 }, (_, index) => note(`o${index}`, 5000 + index * 300, 5000));
  const full = describeCanvas(canvas([note("near", 0, 0), ...crowded]), { view });
  assert.equal(full.inView.length + full.outsideFrames.length, CANVAS_READ_FRAME_LIMIT);
  assert.equal(full.outsideOmitted, 4);
});
