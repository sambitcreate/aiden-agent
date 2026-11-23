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

test("appendCanvasPages: pages with frames merge after the target's, ids kept, with groups, arrows and comments still joined", () => {
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
      { id: "c2", pageId: "page-1", frameId: "a", x: 0, y: 0, note: "On a", state: "open", anchorState: "anchored", createdAt: "t", chatId: "chat-s" },
    ],
  };
  let next = 0;
  const merged = appendCanvasPages(target, source, { label: "Sketches", pathMap: new Map(), newId: () => `n${++next}` });
  assert.ok(merged);
  const { doc } = merged;
  assert.equal(doc.revision, 9, "the target keeps its revision; the store bumps it on save");
  assert.deepEqual(doc.chatPages, { "chat-t": "page-1" }, "the source's chat pages are not copied");
  assert.deepEqual(doc.pages.map((page) => page.name), ["Page 1", "Sketches · Page 1", "Sketches · Ideas"], "a page with nothing on it is left behind");
  assert.deepEqual(merged.pageIds, ["n1", "p3"], "a page id is kept unless the target has it");
  assert.equal(new Set(doc.frames.map((entry) => entry.id)).size, doc.frames.length, "every frame id is unique");
  const byId = new Map(doc.frames.map((entry) => [entry.id, entry]));
  // Only "a" collided with the target, so only it was given a new id.
  assert.deepEqual([...byId.keys()].sort(), ["a", "arrow", "g", "in", "n2"]);
  assert.equal(byId.get("n2")!.pageId, "n1");
  assert.equal(byId.get("in")!.groupId, "g");
  assert.deepEqual(byId.get("arrow")!.ends!.map((end) => end.frameId), ["in", undefined]);
  const comments = new Map(doc.comments.map((entry) => [entry.id, entry]));
  assert.equal(comments.get("c1")!.frameId, "in");
  assert.equal(comments.get("c1")!.pageId, "p3");
  assert.equal(comments.get("c1")!.chatId, "chat-s");
  assert.equal(comments.get("c2")!.frameId, "n2", "a comment follows its frame's new id");
  // The merged document is one the parser accepts as it is.
  const reparsed = parseDesignCanvas(JSON.parse(JSON.stringify(doc)));
  assert.ok(reparsed.ok);
  assert.equal(reparsed.dropped, 0);
});

test("appendCanvasPages: page and image paths follow the copied files, and a frame whose file stayed behind is dropped", () => {
  const source: DesignCanvas = {
    ...emptyDesignCanvas(),
    frames: [
      frame("home", "page-1", { kind: "file", path: "design/home.html", text: undefined }),
      frame("logo", "page-1", { kind: "image", path: "logo.png", text: undefined }),
      frame("left", "page-1", { kind: "file", path: "design/old.html", text: undefined }),
      frame("idea", "page-1"),
    ],
    comments: [{ id: "c", pageId: "page-1", frameId: "left", x: 0, y: 0, note: "", state: "open", anchorState: "anchored", createdAt: "t", chatId: "chat-s" }],
  };
  const pathMap = new Map([
    ["design/home.html", "aiden-scratch/design/home.html"],
    ["logo.png", "aiden-scratch/logo.png"],
  ]);
  const merged = appendCanvasPages(emptyDesignCanvas(), source, { label: "Chat", pathMap, newId: () => "fresh" });
  assert.ok(merged);
  const paths = new Map(merged.doc.frames.map((entry) => [entry.id, entry.path]));
  assert.deepEqual([...paths], [["home", "aiden-scratch/design/home.html"], ["logo", "aiden-scratch/logo.png"], ["idea", undefined]]);
  assert.deepEqual(merged.doc.comments, [], "a comment on a frame left behind goes with it");
  // Nothing whose file came over and no other frame: nothing is merged.
  const onlyFiles: DesignCanvas = { ...source, frames: [source.frames[2]!], comments: [] };
  const none = appendCanvasPages(emptyDesignCanvas(), onlyFiles, { label: "Chat", pathMap, newId: () => "x" });
  assert.deepEqual(none?.pageIds, []);
});

test("appendCanvasPages: a carried comment's source stamp follows its copied file, and one whose file stayed behind is dropped", () => {
  const anchor = (sourcePath: string) => ({ commentId: "old", selector: "h1", text: "Hi", tag: "h1", sourcePath });
  const source: DesignCanvas = {
    ...emptyDesignCanvas(),
    frames: [frame("home", "page-1", { kind: "file", path: "design/index.html", text: undefined })],
    comments: [
      { id: "c1", pageId: "page-1", frameId: "home", x: 0, y: 0, note: "Bigger", state: "open", anchorState: "anchored", createdAt: "t", chatId: "chat-s", anchor: anchor("design/index.html:12") },
      { id: "c2", pageId: "page-1", frameId: "home", x: 0, y: 0, note: "Partial", state: "open", anchorState: "anchored", createdAt: "t", chatId: "chat-s", anchor: anchor("design/part.html") },
    ],
  };
  const pathMap = new Map([["design/index.html", "aiden-scratch/design/index.html"]]);
  // The target already has c1, so the first carried comment gets a new id.
  const target: DesignCanvas = {
    ...emptyDesignCanvas(),
    comments: [{ id: "c1", pageId: "page-1", x: 0, y: 0, note: "Mine", state: "open", anchorState: "anchored", createdAt: "t", chatId: "chat-t" }],
  };
  const merged = appendCanvasPages(target, source, { label: "Chat", pathMap, newId: () => "fresh" });
  assert.ok(merged);
  const carried = merged.doc.comments.filter((entry) => entry.chatId === "chat-s");
  const first = carried.find((entry) => entry.note === "Bigger")!;
  assert.equal(first.id, "fresh");
  assert.equal(first.anchor?.commentId, "fresh", "the anchor names the comment's new id");
  assert.equal(first.anchor?.sourcePath, "aiden-scratch/design/index.html:12", "the stamp points at the copy, never the workspace's own design/index.html");
  const second = carried.find((entry) => entry.note === "Partial")!;
  assert.equal(second.anchor?.sourcePath, undefined, "a stamp whose file was not copied is dropped");
  assert.equal(second.anchor?.selector, "h1", "the rest of the anchor is kept");
});

test("appendCanvasPages: one past any limit is refused whole", () => {
  const target = emptyDesignCanvas();
  const source: DesignCanvas = { ...emptyDesignCanvas(), frames: [frame("s", "page-1")] };
  let next = 0;
  const options = { label: "Chat", pathMap: new Map<string, string>(), newId: () => `n${++next}` };
  const fullPages: DesignCanvas = {
    ...target,
    pages: Array.from({ length: DESIGN_CANVAS_LIMITS.pages }, (_, index) => ({ id: `p${index}`, name: `P${index}` })),
  };
  assert.equal(appendCanvasPages(fullPages, source, options), null);
  const fullFrames: DesignCanvas = {
    ...target,
    pages: Array.from({ length: 10 }, (_, index) => ({ id: `p${index}`, name: `P${index}` })),
    frames: Array.from({ length: DESIGN_CANVAS_LIMITS.frames }, (_, index) => frame(`f${index}`, `p${index % 10}`)),
  };
  assert.equal(appendCanvasPages(fullFrames, source, options), null);
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
  assert.equal(appendCanvasPages(fullComments, withComment, options), null);
});
