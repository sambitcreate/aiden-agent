import assert from "node:assert/strict";
import test from "node:test";
import { canvasPromptLine, canvasView, CANVAS_READ_FRAME_LIMIT, describeCanvas } from "./canvas-summary.js";
import { emptyDesignCanvas, type DesignCanvasV1, type DesignFrame } from "./schema.js";

function note(id: string, x: number, y: number, extra: Partial<DesignFrame> = {}): DesignFrame {
  return { id, kind: "note", title: id, text: `about ${id}`, x, y, w: 240, h: 160, createdBy: "aiden", ...extra };
}

function canvas(frames: DesignFrame[], extra: Partial<DesignCanvasV1> = {}): DesignCanvasV1 {
  return { ...emptyDesignCanvas(), frames, ...extra };
}

test("the view is what a panned and zoomed canvas shows, in canvas units", () => {
  // Panned so canvas point (500, 250) sits at the top-left, zoomed out to half size.
  const doc = canvas([], { viewport: { x: -250, y: -125, zoom: 0.5 } });
  assert.deepEqual(canvasView(doc, { w: 1200, h: 800 }), { x: 500, y: 250, w: 2400, h: 1600 });
  // Zoomed in, the same screen covers less of the canvas.
  assert.deepEqual(canvasView(canvas([], { viewport: { x: 0, y: 0, zoom: 2 } }), { w: 1200, h: 800 }), { x: 0, y: 0, w: 600, h: 400 });
});

test("a frame partly in view is listed; one just past the edge is counted as outside", () => {
  const view = { x: 0, y: 0, w: 1000, h: 1000 };
  const doc = canvas([note("edge", 900, 900), note("past", 1000, 0), note("loose", 5000, 5000)]);
  const answer = describeCanvas(doc, view);
  assert.deepEqual(answer.inView.map((frame) => frame.id), ["edge"]);
  assert.deepEqual(answer.outsideView, [{ groupId: "ungrouped", title: "Not in a group", frames: 2 }]);
  assert.equal(answer.frameCount, 3);
  assert.equal(answer.inView[0]!.text, "about edge");
});

test("a crowded view lists the first frames and says how many it left out", () => {
  const frames = Array.from({ length: CANVAS_READ_FRAME_LIMIT + 5 }, (_, index) => note(`n${index}`, index, index));
  const answer = describeCanvas(canvas(frames), { x: 0, y: 0, w: 2000, h: 2000 });
  assert.equal(answer.inView.length, CANVAS_READ_FRAME_LIMIT);
  assert.equal(answer.omitted, 5);
  assert.equal(answer.frameCount, CANVAS_READ_FRAME_LIMIT + 5);
});

test("comments on removed frames and resolved comments do not count against a frame", () => {
  const doc = canvas([note("a", 0, 0)], {
    comments: [
      { id: "c1", frameId: "a", x: 1, y: 1, note: "one", state: "open", anchorState: "anchored", createdAt: "2026-11-05T00:00:00Z" },
      { id: "c2", frameId: "a", x: 1, y: 1, note: "two", state: "resolved", anchorState: "anchored", createdAt: "2026-11-05T00:00:00Z" },
      { id: "c3", x: 1, y: 1, note: "loose", state: "open", anchorState: "lost", createdAt: "2026-11-05T00:00:00Z" },
    ],
  });
  const answer = describeCanvas(doc, { x: 0, y: 0, w: 1000, h: 1000 });
  assert.equal(answer.inView[0]!.openComments, 1);
  assert.equal(answer.openComments, 2, "the total counts every open comment, anchored or not");
});

test("the prompt line names frames, pages and open comments in plain words", () => {
  assert.equal(canvasPromptLine(canvas([])), "The canvas is empty.");
  assert.equal(canvasPromptLine(canvas([note("a", 0, 0)])), "The canvas has 1 frame, 0 open comments.");
  const page: DesignFrame = { id: "p", kind: "file", title: "Home", path: "design/home.html", x: 0, y: 0, w: 640, h: 436, designWidth: 1280, createdBy: "aiden" };
  const doc = canvas([page, note("a", 0, 0)], {
    comments: [{ id: "c1", frameId: "p", x: 1, y: 1, note: "one", state: "open", anchorState: "anchored", createdAt: "2026-11-05T00:00:00Z" }],
  });
  assert.equal(canvasPromptLine(doc), "The canvas has 2 frames, 1 page, 1 open comment.");
});
