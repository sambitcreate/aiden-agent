import assert from "node:assert/strict";
import test from "node:test";
import { emptyDesignCanvas, type DesignCanvas } from "../shared/design-canvas/schema";
import { addPage, deletePage, showPage } from "../shared/design-canvas/pages";
import { changesBetween, record, redo, undo, type CanvasHistory } from "./canvas-history-core";

const state = (label: string): DesignCanvas => ({
  ...emptyDesignCanvas(),
  frames: [{ id: label, kind: "note", title: label, x: 0, y: 0, w: 200, h: 120, text: label, pageId: "page-1", createdBy: "person" }],
});
const label = (doc: DesignCanvas | undefined) => doc?.frames[0]?.id;
const fresh: CanvasHistory = { past: [], future: [] };

test("undo walks back through recorded edits and redo walks forward again", () => {
  const [s0, s1, s2] = [state("s0"), state("s1"), state("s2")];
  let history = record(fresh, s0); // s0 -> s1
  history = record(history, s1); // s1 -> s2
  const back = undo(history, s2);
  assert.equal(label(back?.doc), "s1");
  const backAgain = undo(back!.history, back!.doc);
  assert.equal(label(backAgain?.doc), "s0");
  assert.equal(undo(backAgain!.history, backAgain!.doc), null, "nothing older to undo");

  const forward = redo(backAgain!.history, backAgain!.doc);
  assert.equal(label(forward?.doc), "s1");
  const forwardAgain = redo(forward!.history, forward!.doc);
  assert.equal(label(forwardAgain?.doc), "s2");
  assert.equal(redo(forwardAgain!.history, forwardAgain!.doc), null, "nothing newer to redo");
});

test("a new edit after an undo clears the redo stack", () => {
  const history = record(record(fresh, state("s0")), state("s1"));
  const back = undo(history, state("s2"))!;
  assert.equal(back.history.future.length, 1);
  const edited = record(back.history, back.doc);
  assert.deepEqual(edited.future, []);
  assert.equal(redo(edited, state("s3")), null);
});

test("history keeps the newest 100 states and drops the oldest", () => {
  let history = fresh;
  for (let index = 0; index < 101; index += 1) history = record(history, state(`s${index}`));
  assert.equal(history.past.length, 100);
  assert.equal(label(history.past[0]), "s1");
  assert.equal(label(history.past[history.past.length - 1]), "s100");
  assert.equal(record(fresh, state("a"), 2).past.length, 1);
  assert.equal(record(record(record(fresh, state("a"), 2), state("b"), 2), state("c"), 2).past.map(label).join(), "b,c");
});

test("undoing a page delete brings the page and its frames back, and keeps a frame someone else added meanwhile", () => {
  const withPage = addPage(state("kept"), "p2", "Pricing");
  const before: DesignCanvas = {
    ...withPage,
    frames: [...withPage.frames, { ...withPage.frames[0]!, id: "on-p2", pageId: "p2" }],
  };
  const deleted = deletePage(before, "p2");
  assert.equal(deleted.activePageId, "page-1");
  // Aiden adds a note while the delete is on screen.
  const elsewhere: DesignCanvas = { ...deleted, frames: [...deleted.frames, { ...deleted.frames[0]!, id: "aiden" }] };
  const restored = changesBetween(deleted, before)(elsewhere);
  assert.deepEqual(restored.pages.map((page) => page.name), ["Page 1", "Pricing"]);
  assert.equal(restored.activePageId, "p2", "the restored page is shown again");
  assert.deepEqual(restored.frames.map((frame) => frame.id).sort(), ["aiden", "kept", "on-p2"]);
});

test("an undo never shows a page that no longer exists", () => {
  const two = addPage(state("a"), "p2");
  const back = showPage(two, "page-1");
  // Someone else deleted p2 before the undo of "show Page 1" ran.
  const gone = deletePage(back, "p2");
  const undone = changesBetween(back, two)(gone);
  assert.ok(undone.pages.some((page) => page.id === undone.activePageId));
});

test("undoing a comment edit keeps comments someone else changed, and a comment goes with its frame", () => {
  const comment = (id: string, frameId?: string) => ({
    id, pageId: "page-1", ...(frameId ? { frameId } : {}), x: 0, y: 0, note: id, state: "open" as const, anchorState: "anchored" as const, createdAt: "2026-11-05T10:00:00.000Z",
  });
  const pinned = comment("pinned", "frame");
  const before: DesignCanvas = { ...state("frame"), comments: [comment("mine"), pinned] };
  const after: DesignCanvas = { ...before, comments: [{ ...comment("mine"), note: "edited" }, pinned] };
  // Aiden's turn marks the pinned comment resolved while the edit is on screen.
  const meanwhile: DesignCanvas = { ...after, comments: [after.comments[0]!, { ...pinned, state: "resolved" }] };
  const undone = changesBetween(after, before)(meanwhile);
  assert.equal(undone.comments.find((entry) => entry.id === "mine")?.note, "mine");
  assert.equal(undone.comments.find((entry) => entry.id === "pinned")?.state, "resolved");

  const removed = changesBetween(before, { ...before, frames: [] })({ ...before });
  assert.deepEqual(removed.comments.map((entry) => entry.id), ["mine"], "removing a frame removes its comments");
});
