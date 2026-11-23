import assert from "node:assert/strict";
import test from "node:test";
import { emptyDesignCanvas, type DesignCanvas } from "../shared/design-canvas/schema";
import { addPage, deletePage, movePage, renamePage } from "../shared/design-canvas/pages";
import { changesBetween, keepUnchanged, record, redo, takeIn, undo, type CanvasHistory } from "./canvas-history-core";

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
  // Aiden adds a note while the delete is on screen.
  const elsewhere: DesignCanvas = { ...deleted, frames: [...deleted.frames, { ...deleted.frames[0]!, id: "aiden" }] };
  const restored = changesBetween(deleted, before)(elsewhere);
  assert.deepEqual(restored.pages.map((page) => page.name), ["Page 1", "Pricing"]);
  assert.deepEqual(restored.frames.map((frame) => frame.id).sort(), ["aiden", "kept", "on-p2"]);
});

test("undo after another chat switched pages does not change any page", () => {
  // Two pages; this chat moves a frame on Page 1 while another chat looks at Pricing.
  const two = addPage(state("a"), "p2", "Pricing");
  const moved: DesignCanvas = { ...two, frames: [{ ...two.frames[0]!, x: 300 }] };
  // Meanwhile the other chat renamed nothing and only switched pages, which is
  // not in the document at all: the document it saved is `moved` exactly.
  const undone = changesBetween(moved, two)({ ...moved });
  assert.deepEqual(undone, two, "the undo gives back exactly the document before the move, with no view state in it");
  // A page change made by someone else meanwhile is kept by an undo that did not touch pages.
  const renamedElsewhere = renamePage(moved, "p2", "Plans");
  const kept = changesBetween(moved, two)(renamedElsewhere);
  assert.deepEqual(kept, { ...renamedElsewhere, frames: two.frames });
});

test("undoing a page edit takes the pages back whole, and drops chat pages that point at a page gone", () => {
  const two: DesignCanvas = { ...addPage(state("a"), "p2"), chatPages: { "chat-1": "p2" } };
  const reordered = movePage(two, "p2", -1);
  assert.deepEqual(changesBetween(reordered, two)(reordered).pages.map((page) => page.id), ["page-1", "p2"]);
  // Undoing the add of p2 takes it away again, and the chat that used it no longer names it.
  const withoutP2 = changesBetween(two, state("a"))(two);
  assert.deepEqual(withoutP2.pages.map((page) => page.id), ["page-1"]);
  assert.deepEqual(withoutP2.chatPages, {});
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

const note = (id: string, x = 0) => ({
  id, kind: "note" as const, title: id, x, y: 0, w: 200, h: 120, text: id, pageId: "page-1", createdBy: "person" as const,
});
const withFrames = (...frames: ReturnType<typeof note>[]): DesignCanvas => ({ ...emptyDesignCanvas(), frames });
const ids = (doc: DesignCanvas | undefined) => doc?.frames.map((frame) => frame.id);

test("every change from one reply undoes as one step, and a second reply is a step of its own", () => {
  const start = withFrames(note("a"));
  const first = withFrames(note("a"), note("b"));
  const second = withFrames(note("a"), note("b"), note("c"));
  const third = withFrames(note("a"), note("b"), note("c"), note("d"));
  let history = takeIn(fresh, { before: start, from: start, to: first, aidenTurn: "reply-1" });
  history = takeIn(history, { before: first, from: first, to: second, aidenTurn: "reply-1" });
  history = takeIn(history, { before: second, from: second, to: third, aidenTurn: "reply-2" });

  const back = undo(history, third);
  assert.deepEqual(ids(back?.doc), ["a", "b", "c"], "the second reply goes first");
  const backAgain = undo(back!.history, back!.doc);
  assert.deepEqual(ids(backAgain?.doc), ["a"], "both of the first reply's changes go together");
  assert.equal(undo(backAgain!.history, backAgain!.doc), null);
});

test("a change from another writer is carried into earlier steps rather than becoming a step", () => {
  const start = withFrames(note("a"));
  const moved = withFrames(note("a", 100));
  let history = record(fresh, start); // the person moved a to 100
  const elsewhere = keepUnchanged(moved, withFrames(note("a", 100), note("z")));
  history = takeIn(history, { before: moved, from: moved, to: elsewhere });
  const back = undo(history, elsewhere);
  assert.deepEqual(back?.doc.frames.map((frame) => [frame.id, frame.x]), [["a", 0], ["z", 0]], "undo takes back the move and keeps z");
  assert.equal(undo(back!.history, back!.doc), null, "z's arrival is not an undo step");
});

test("a fetched canvas keeps the objects of frames that did not change, so undo leaves them alone", () => {
  const local = withFrames(note("a"), note("b"));
  const fetched = withFrames(note("a"), note("b", 300));
  const merged = keepUnchanged(local, fetched);
  assert.equal(merged.frames[0], local.frames[0]);
  assert.notEqual(merged.frames[1], local.frames[1]);
  assert.equal(merged.frames[1]?.x, 300);
  // Only b differs, so carrying the change into an old snapshot touches only b.
  const carried = changesBetween(local, merged)(withFrames(note("a", 50), note("b")));
  assert.deepEqual(carried.frames.map((frame) => [frame.id, frame.x]), [["a", 50], ["b", 300]]);
});
