import assert from "node:assert/strict";
import test from "node:test";
import { emptyDesignCanvas, type DesignCanvasV1 } from "../shared/design-canvas/schema";
import { record, redo, undo, type CanvasHistory } from "./canvas-history-core";

const state = (label: string): DesignCanvasV1 => ({
  ...emptyDesignCanvas(),
  frames: [{ id: label, kind: "note", title: label, x: 0, y: 0, w: 200, h: 120, text: label, createdBy: "person" }],
});
const label = (doc: DesignCanvasV1 | undefined) => doc?.frames[0]?.id;
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
