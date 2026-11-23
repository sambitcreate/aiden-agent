// Page edits on the design canvas: what the page picker and Aiden's tools do
// to a document.

import assert from "node:assert/strict";
import test from "node:test";
import {
  addPage,
  appendCanvasPages,
  canAddPage,
  deletePage,
  duplicatePage,
  movePage,
  moveFramesToPage,
  nextPageName,
  renamePage,
} from "./pages.js";
import { DESIGN_CANVAS_LIMITS, emptyDesignCanvas, parseDesignCanvas, type DesignCanvas, type DesignFrame } from "./schema.js";

function frame(id: string, pageId: string, extra: Partial<DesignFrame> = {}): DesignFrame {
  return { id, kind: "note", title: id, x: 10, y: 20, w: 200, h: 120, text: id, pageId, createdBy: "person", ...extra };
}

function twoPages(): DesignCanvas {
  return addPage(emptyDesignCanvas(), "p2");
}

const names = (doc: DesignCanvas) => doc.pages.map((page) => page.name);

test("a new page goes at the end and takes the next free name", () => {
  let doc = addPage(emptyDesignCanvas(), "p2");
  assert.deepEqual(names(doc), ["Page 1", "Page 2"]);
  assert.deepEqual(doc.pages[1], { id: "p2", name: "Page 2" });
  doc = addPage(doc, "p3", "Later", "missing");
  assert.deepEqual(names(doc), ["Page 1", "Page 2", "Later"], "an unknown page to add after means the end");
  doc = renamePage(doc, "p2", "page 4");
  assert.equal(nextPageName(doc), "Page 5", "a name in any case is taken");
  assert.equal(addPage(doc, "p2"), doc, "an id already used changes nothing");
});

test("addPage inserts after the given page and leaves chatPages alone", () => {
  const base: DesignCanvas = { ...twoPages(), chatPages: { "chat-1": "p2", "chat-2": "page-1" } };
  const doc = addPage(base, "p3", "  Pricing   options ", "page-1");
  assert.deepEqual(names(doc), ["Page 1", "Pricing options", "Page 2"]);
  assert.equal(doc.chatPages, base.chatPages);
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
  assert.deepEqual(copy.pages[1], { id: "copy", name: "Page 1 copy" });
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

test("deleting a page removes its frames and comments", () => {
  const base = addPage(twoPages(), "p3");
  const doc: DesignCanvas = {
    ...base,
    frames: [frame("a", "page-1"), frame("b", "p3")],
    comments: [{ id: "c", pageId: "p3", frameId: "b", x: 0, y: 0, note: "", state: "open", anchorState: "anchored", createdAt: "t" }],
  };
  const after = deletePage(doc, "p3");
  assert.deepEqual(after.pages.map((page) => page.id), ["page-1", "p2"]);
  assert.deepEqual(after.frames.map((entry) => entry.id), ["a"]);
  assert.deepEqual(after.comments, []);
  const single = emptyDesignCanvas();
  assert.equal(deletePage(single, "page-1"), single, "the last page stays");
});

test("deletePage drops chatPages entries for the deleted page", () => {
  const doc: DesignCanvas = { ...addPage(twoPages(), "p3"), chatPages: { "chat-1": "p3", "chat-2": "p2", "chat-3": "p3" } };
  assert.deepEqual(deletePage(doc, "p3").chatPages, { "chat-2": "p2" });
});

test("pages move one place at a time and stop at the ends", () => {
  const doc = addPage(twoPages(), "p3", undefined, "page-1");
  // Order is Page 1, then p3 (added after Page 1), then p2.
  assert.deepEqual(doc.pages.map((page) => page.id), ["page-1", "p3", "p2"]);
  assert.deepEqual(movePage(doc, "p2", -1).pages.map((page) => page.id), ["page-1", "p2", "p3"]);
  assert.deepEqual(movePage(doc, "page-1", 1).pages.map((page) => page.id), ["p3", "page-1", "p2"]);
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

test("a copied page's arrows join the copies of their boxes", () => {
  const doc: DesignCanvas = {
    ...emptyDesignCanvas(),
    frames: [
      { id: "a", kind: "shape", shape: "rect", title: "A", x: 0, y: 0, w: 100, h: 60, pageId: "page-1", createdBy: "person" },
      {
        id: "ab",
        kind: "connector",
        title: "Arrow",
        x: 0,
        y: 0,
        w: 1,
        h: 1,
        ends: [
          { x: 100, y: 30, frameId: "a" },
          { x: 400, y: 30 },
        ],
        pageId: "page-1",
        createdBy: "person",
      },
    ],
  };
  let next = 0;
  const copy = duplicatePage(doc, "page-1", "page-2", () => `copy-${++next}`);
  const arrow = copy.frames.find((frame) => frame.pageId === "page-2" && frame.kind === "connector")!;
  assert.deepEqual(arrow.ends, [
    { x: 100, y: 30, frameId: "copy-1" },
    { x: 400, y: 30 },
  ]);
});

test("appendCanvasPages: pages with frames merge after the target's, with groups, arrows and comments still joined", () => {
  const target: DesignCanvas = { ...emptyDesignCanvas(), revision: 9, frames: [frame("a", "page-1")], chatPages: { "chat-t": "page-1" } };
  const source: DesignCanvas = {
    ...emptyDesignCanvas(),
    pages: [{ id: "page-1", name: "Page 1" }, { id: "empty", name: "Nothing" }, { id: "p3", name: "Ideas" }],
    chatPages: { "chat-s": "p3" },
    frames: [
      frame("a", "page-1"),
      frame("g", "p3", { kind: "group" }),
      frame("in", "p3", { groupId: "g" }),
      {
        ...frame("arrow", "p3", { kind: "connector", w: 1, h: 1 }),
        ends: [{ x: 0, y: 0, frameId: "in" }, { x: 50, y: 50 }],
      },
    ],
    comments: [
      { id: "c1", pageId: "p3", frameId: "in", x: 1, y: 2, note: "Tighter", state: "open", anchorState: "anchored", createdAt: "t", chatId: "chat-s", queued: true },
      { id: "c2", pageId: "page-1", x: 0, y: 0, note: "Free", state: "open", anchorState: "anchored", createdAt: "t" },
    ],
  };
  let next = 0;
  const merged = appendCanvasPages(target, source, () => `n${++next}`, "Sketches");
  assert.ok(merged);
  assert.equal(merged.revision, 9, "the target keeps its revision; the store bumps it on save");
  assert.deepEqual(merged.chatPages, { "chat-t": "page-1" }, "the source's chat pages are not copied");
  assert.deepEqual(
    merged.pages.map((page) => page.name),
    ["Page 1", "Sketches · Page 1", "Sketches · Ideas"],
    "a page with nothing on it is left behind",
  );
  const [, first, ideas] = merged.pages;
  const ids = new Set(merged.frames.map((entry) => entry.id));
  assert.equal(ids.size, merged.frames.length, "every frame id is unique");
  assert.equal(merged.frames.filter((entry) => entry.pageId === first!.id).length, 1);
  const onIdeas = merged.frames.filter((entry) => entry.pageId === ideas!.id);
  const group = onIdeas.find((entry) => entry.kind === "group")!;
  const member = onIdeas.find((entry) => entry.title === "in")!;
  const arrow = onIdeas.find((entry) => entry.kind === "connector")!;
  assert.equal(member.groupId, group.id);
  assert.equal(arrow.ends![0].frameId, member.id);
  const comment = merged.comments.find((entry) => entry.note === "Tighter")!;
  assert.equal(comment.frameId, member.id);
  assert.equal(comment.pageId, ideas!.id);
  assert.equal(comment.chatId, "chat-s");
  const free = merged.comments.find((entry) => entry.note === "Free")!;
  assert.equal(free.pageId, first!.id);
  // The merged document is one the parser accepts as it is.
  const reparsed = parseDesignCanvas(JSON.parse(JSON.stringify(merged)));
  assert.ok(reparsed.ok);
  assert.equal(reparsed.dropped, 0);
});

test("appendCanvasPages: a source with nothing on it changes nothing, and one past any limit is refused whole", () => {
  const target = emptyDesignCanvas();
  assert.equal(appendCanvasPages(target, emptyDesignCanvas(), () => "x", "Empty"), target);
  const source: DesignCanvas = { ...emptyDesignCanvas(), frames: [frame("s", "page-1")] };
  let next = 0;
  const newId = () => `n${++next}`;
  const fullPages: DesignCanvas = {
    ...target,
    pages: Array.from({ length: DESIGN_CANVAS_LIMITS.pages }, (_, index) => ({ id: `p${index}`, name: `P${index}` })),
  };
  assert.equal(appendCanvasPages(fullPages, source, newId, "Chat"), null);
  const fullFrames: DesignCanvas = {
    ...target,
    pages: Array.from({ length: 10 }, (_, index) => ({ id: `p${index}`, name: `P${index}` })),
    frames: Array.from({ length: DESIGN_CANVAS_LIMITS.frames }, (_, index) => frame(`f${index}`, `p${index % 10}`)),
  };
  assert.equal(appendCanvasPages(fullFrames, source, newId, "Chat"), null);
  const fullComments: DesignCanvas = {
    ...target,
    comments: Array.from({ length: DESIGN_CANVAS_LIMITS.comments }, (_, index) => ({
      id: `c${index}`, pageId: "page-1", x: 0, y: 0, note: "", state: "open" as const, anchorState: "anchored" as const, createdAt: "t",
    })),
  };
  const withComment: DesignCanvas = {
    ...source,
    comments: [{ id: "one", pageId: "page-1", x: 0, y: 0, note: "", state: "open", anchorState: "anchored", createdAt: "t" }],
  };
  assert.equal(appendCanvasPages(fullComments, withComment, newId, "Chat"), null);
});
