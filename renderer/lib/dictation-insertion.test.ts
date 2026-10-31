import assert from "node:assert/strict";
import test from "node:test";
import { dictationInsertion } from "./dictation-insertion.js";

const at = (draft: string, caret: number, transcript: string) =>
  dictationInsertion(draft, { start: caret, end: caret }, transcript);

test("an empty draft takes the transcript as is", () => {
  assert.equal(at("", 0, "hello there").text, "hello there");
});

test("dictating at the end of a sentence adds one separating space", () => {
  assert.equal(at("Fix the bug", 11, "in the parser").text, "Fix the bug in the parser");
  assert.equal(at("Fix the bug ", 12, "in the parser").text, "Fix the bug in the parser");
  // A new line stays a new line instead of being collapsed.
  assert.equal(at("Steps:\n", 7, "open settings").text, "Steps:\nopen settings");
});

test("dictating between words lands at the caret with spaces on both sides", () => {
  const insertion = at("Fix bug", 3, "the");
  assert.equal(insertion.text, "Fix the bug");
  assert.equal(insertion.text.slice(0, insertion.caret), "Fix the");
});

test("dictating before punctuation does not push a space in front of it", () => {
  assert.equal(at("Thanks.", 6, "a lot").text, "Thanks a lot.");
});

test("a selection is replaced by the transcript", () => {
  const insertion = dictationInsertion("Fix the old bug", { start: 8, end: 11 }, "parser");
  assert.equal(insertion.text, "Fix the parser bug");
  assert.deepEqual([insertion.start, insertion.end], [8, 11]);
});

test("without a caret the transcript is appended", () => {
  assert.equal(dictationInsertion("Fix the bug", null, "today").text, "Fix the bug today");
});

test("a caret beyond the draft (a stale selection) is clamped to the end", () => {
  assert.equal(at("short", 40, "text").text, "short text");
});
