// Where pins and marks sit on the design canvas.

import assert from "node:assert/strict";
import test from "node:test";
import { emptyDesignCanvas, type DesignCanvas, type DesignComment } from "../shared/design-canvas/schema";
import { commentNumbers, marksFromCanvas, marksOnCanvas, pinPlace } from "./comment-geometry";

const page = { id: "hero", kind: "file" as const, title: "Hero", x: 100, y: 200, w: 640, h: 436, designWidth: 1280 as const, path: "design/hero.html", pageId: "page-1", createdBy: "aiden" as const };
const note = { id: "note", kind: "note" as const, title: "Note", x: 1000, y: 0, w: 200, h: 100, text: "", pageId: "page-1", createdBy: "person" as const };
const doc: DesignCanvas = { ...emptyDesignCanvas(), frames: [page, note] };

function comment(extra: Partial<DesignComment>): DesignComment {
  return { id: "c", pageId: "page-1", x: 0, y: 0, note: "", state: "open", anchorState: "anchored", createdAt: "2026-11-05T10:00:00.000Z", ...extra };
}

test("a pin on a page's element is scaled to the frame, below its title bar, and moves with the page's scroll", () => {
  const onElement = comment({ frameId: "hero", anchor: { commentId: "c", selector: "h1", text: "", tag: "h1", point: [400, 300] } });
  // 640 / 1280 = half size; the title bar is 36 canvas units.
  assert.deepEqual(pinPlace(doc, onElement), { x: 300, y: 386, hidden: false });
  assert.deepEqual(pinPlace(doc, onElement, new Map([["hero", { x: 0, y: 200 }]])), { x: 300, y: 286, hidden: false });
  assert.equal(pinPlace(doc, onElement, new Map([["hero", { x: 0, y: 700 }]])).hidden, true, "scrolled above the frame");
});

test("a pin on a frame keeps its spot on it, and a free pin stays put", () => {
  assert.deepEqual(pinPlace(doc, comment({ frameId: "note", x: 20, y: 30 })), { x: 1020, y: 30, hidden: false });
  assert.deepEqual(pinPlace(doc, comment({ frameId: "note", x: 900, y: 30 })), { x: 1200, y: 30, hidden: false }, "kept on the frame after it shrank");
  assert.deepEqual(pinPlace(doc, comment({ x: -50, y: 70 })), { x: -50, y: 70, hidden: false });
});

test("marks on a frame are stored as fractions of it and follow it when it moves", () => {
  const strokes: [number, number][][] = [[[1000, 0], [1100, 50], [1200, 100]], [[5, 5]]];
  const stored = marksFromCanvas(note, strokes);
  assert.deepEqual(stored, [{ points: [[0, 0], [0.5, 0.5], [1, 1]] }], "a dot with one point is not a mark");
  const moved = { ...note, x: 0, y: 0, w: 400, h: 200 };
  assert.deepEqual(marksOnCanvas(moved, stored), [[[0, 0], [200, 100], [400, 200]]]);
  assert.deepEqual(marksFromCanvas(undefined, [[[1, 2], [3, 4]]]), [{ points: [[1, 2], [3, 4]] }], "free marks stay in canvas units");
  assert.equal(marksFromCanvas(note, []), undefined);
});

test("pins are numbered per page, oldest first", () => {
  const numbered = commentNumbers({
    ...doc,
    comments: [
      comment({ id: "late", createdAt: "2026-11-05T12:00:00.000Z" }),
      comment({ id: "other-page", pageId: "p2", createdAt: "2026-11-05T09:00:00.000Z" }),
      comment({ id: "early", createdAt: "2026-11-05T08:00:00.000Z" }),
    ],
  });
  assert.deepEqual([...numbered.entries()].sort(), [["early", 1], ["late", 2], ["other-page", 1]]);
});
