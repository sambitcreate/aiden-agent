// Page edits on the design canvas: what the page picker and Aiden's tools do
// to a document.

import assert from "node:assert/strict";
import test from "node:test";
import {
  addPage,
  canAddPage,
  deletePage,
  duplicatePage,
  movePage,
  moveFramesToPage,
  nextPageName,
  renamePage,
  showPage,
} from "./pages.js";
import { DESIGN_CANVAS_LIMITS, emptyDesignCanvas, type DesignCanvas, type DesignFrame } from "./schema.js";

function frame(id: string, pageId: string, extra: Partial<DesignFrame> = {}): DesignFrame {
  return { id, kind: "note", title: id, x: 10, y: 20, w: 200, h: 120, text: id, pageId, createdBy: "person", ...extra };
}

function twoPages(): DesignCanvas {
  const doc = addPage(emptyDesignCanvas(), "p2");
  return showPage(doc, "page-1");
}

const names = (doc: DesignCanvas) => doc.pages.map((page) => page.name);

test("a new page goes after the one on screen, takes the next free name and is shown", () => {
  let doc = addPage(emptyDesignCanvas(), "p2");
  assert.deepEqual(names(doc), ["Page 1", "Page 2"]);
  assert.equal(doc.activePageId, "p2");
  assert.deepEqual(doc.pages[1]!.viewport, { x: 0, y: 0, zoom: 1 });
  doc = addPage(showPage(doc, "page-1"), "p3", "  Pricing   options ");
  assert.deepEqual(names(doc), ["Page 1", "Pricing options", "Page 2"]);
  doc = renamePage(doc, "p2", "page 4");
  assert.equal(nextPageName(doc), "Page 5", "a name in any case is taken");
  assert.equal(addPage(doc, "p2"), doc, "an id already used changes nothing");
});

test("pages stop at the limit", () => {
  let doc = emptyDesignCanvas();
  for (let index = 2; index <= DESIGN_CANVAS_LIMITS.pages; index += 1) doc = addPage(doc, `p${index}`);
  assert.equal(doc.pages.length, DESIGN_CANVAS_LIMITS.pages);
  assert.equal(canAddPage(doc), false);
  assert.equal(addPage(doc, "one-more"), doc);
  assert.equal(duplicatePage(doc, "page-1", "copy", () => "x"), doc);
});

test("renaming refuses an empty name and cuts a long one", () => {
  const doc = twoPages();
  assert.equal(renamePage(doc, "p2", "   "), doc);
  assert.equal(renamePage(doc, "nope", "Name"), doc);
  const long = renamePage(doc, "p2", "x".repeat(200));
  assert.equal(long.pages[1]!.name.length, DESIGN_CANVAS_LIMITS.pageNameChars);
});

test("duplicating copies the page's frames with new ids and keeps groups together", () => {
  const base = twoPages();
  const doc: DesignCanvas = {
    ...base,
    frames: [frame("g", "page-1", { kind: "group" }), frame("n", "page-1", { groupId: "g" }), frame("other", "p2")],
  };
  let next = 0;
  const copy = duplicatePage(doc, "page-1", "copy", () => `new-${next++}`);
  assert.deepEqual(names(copy), ["Page 1", "Page 1 copy", "Page 2"]);
  assert.equal(copy.activePageId, "copy");
  const copied = copy.frames.filter((entry) => entry.pageId === "copy");
  assert.equal(copied.length, 2);
  const group = copied.find((entry) => entry.kind === "group")!;
  const member = copied.find((entry) => entry.kind === "note")!;
  assert.notEqual(group.id, "g");
  assert.equal(member.groupId, group.id, "the copy's member points at the copy's group");
  assert.deepEqual([member.x, member.y, member.text], [10, 20, "n"]);
  assert.equal(copy.frames.filter((entry) => entry.pageId === "page-1").length, 2, "the original stays");
});

test("a duplicate that would pass the frame limit changes nothing", () => {
  const frames = Array.from({ length: DESIGN_CANVAS_LIMITS.frames / 2 + 1 }, (_, index) => frame(`f${index}`, "page-1"));
  const doc = { ...emptyDesignCanvas(), frames };
  assert.equal(duplicatePage(doc, "page-1", "copy", () => crypto.randomUUID()), doc);
});

test("deleting a page removes its frames and comments and shows the page before it", () => {
  const base = addPage(twoPages(), "p3");
  const doc: DesignCanvas = {
    ...base,
    frames: [frame("a", "page-1"), frame("b", "p3")],
    comments: [{ id: "c", pageId: "p3", frameId: "b", x: 0, y: 0, note: "", state: "open", anchorState: "anchored", createdAt: "t" }],
  };
  assert.equal(doc.activePageId, "p3");
  const after = deletePage(doc, "p3");
  assert.deepEqual(after.pages.map((page) => page.id), ["page-1", "p2"]);
  assert.equal(after.activePageId, "page-1", "the page before the deleted one is shown");
  assert.deepEqual(after.frames.map((entry) => entry.id), ["a"]);
  assert.deepEqual(after.comments, []);
  const first = deletePage(showPage(doc, "page-1"), "page-1");
  assert.equal(first.activePageId, "p3", "deleting the first page shows the new first page");
  const single = emptyDesignCanvas();
  assert.equal(deletePage(single, "page-1"), single, "the last page stays");
});

test("pages move one place at a time and stop at the ends", () => {
  const doc = addPage(twoPages(), "p3");
  // Order is Page 1, then p3 (added after the page on screen), then p2.
  assert.deepEqual(doc.pages.map((page) => page.id), ["page-1", "p3", "p2"]);
  assert.deepEqual(movePage(doc, "p2", -1).pages.map((page) => page.id), ["page-1", "p2", "p3"]);
  assert.deepEqual(movePage(doc, "page-1", 1).pages.map((page) => page.id), ["p3", "page-1", "p2"]);
  assert.equal(movePage(doc, "p3", -1).activePageId, doc.activePageId, "moving does not change the page on screen");
  assert.equal(movePage(doc, "page-1", -1), doc);
  assert.equal(movePage(doc, "p2", 1), doc);
});

test("moving frames to another page brings a group's members and comments, and a lone member leaves its group", () => {
  const base = twoPages();
  const doc: DesignCanvas = {
    ...base,
    frames: [frame("g", "page-1", { kind: "group" }), frame("m", "page-1", { groupId: "g" }), frame("solo", "page-1", { groupId: "g" })],
    comments: [{ id: "c", pageId: "page-1", frameId: "m", x: 0, y: 0, note: "", state: "open", anchorState: "anchored", createdAt: "t" }],
  };
  const moved = moveFramesToPage(doc, ["g"], "p2");
  assert.deepEqual(moved.frames.map((entry) => [entry.id, entry.pageId, entry.groupId]), [
    ["g", "p2", undefined],
    ["m", "p2", "g"],
    ["solo", "p2", "g"],
  ]);
  assert.equal(moved.comments[0]!.pageId, "p2");
  const lone = moveFramesToPage(doc, ["m"], "p2");
  assert.equal(lone.frames[1]!.pageId, "p2");
  assert.deepEqual([lone.frames[1]!.x, lone.frames[1]!.y], [10, 20], "the frame keeps its box");
  assert.equal(lone.frames[2]!.pageId, "page-1");
  assert.equal(lone.frames[1]!.groupId, undefined);
  assert.equal(moveFramesToPage(doc, ["m"], "nowhere"), doc);
});
