import assert from "node:assert/strict";
import test from "node:test";
import { latestReasoningLine, reduceReasoningDisclosure } from "./reasoning-disclosure.js";

test("a disclosure opens and closes only when the reader toggles it", () => {
  assert.equal(reduceReasoningDisclosure("closed", { type: "toggle", animate: true }), "open");
  // With motion the body folds before it unmounts; under Reduce Motion it goes at once.
  assert.equal(reduceReasoningDisclosure("open", { type: "toggle", animate: true }), "closing");
  assert.equal(reduceReasoningDisclosure("open", { type: "toggle", animate: false }), "closed");
  assert.equal(reduceReasoningDisclosure("closing", { type: "closed" }), "closed");
});

test("pressing a folding header reopens it, and the stale fold end is ignored", () => {
  const reopened = reduceReasoningDisclosure("closing", { type: "toggle", animate: true });
  assert.equal(reopened, "open");
  assert.equal(reduceReasoningDisclosure(reopened, { type: "closed" }), "open");
  assert.equal(reduceReasoningDisclosure("closed", { type: "closed" }), "closed");
});

test("the live line is the latest finished sentence, never the unfinished tail", () => {
  assert.equal(latestReasoningLine(""), "");
  assert.equal(latestReasoningLine("Still forming the first thought"), "");
  assert.equal(latestReasoningLine("Read the diff. Then group the"), "Read the diff.");
  assert.equal(
    latestReasoningLine("Read the diff. Group the hunks by story! Check the style? "),
    "Check the style?",
  );
  // A sentence is finished only once whitespace follows its punctuation.
  assert.equal(latestReasoningLine("Read the diff. Group by story."), "Read the diff.");
  assert.equal(latestReasoningLine('He said "stage it first." Then '), 'He said "stage it first."');
});

test("decimals and versions do not end a sentence", () => {
  assert.equal(latestReasoningLine("Pin v4.1 before 2.5 ships. And"), "Pin v4.1 before 2.5 ships.");
});

test("a finished line counts even without punctuation, and Markdown markers drop", () => {
  assert.equal(latestReasoningLine("**Mapping hunk boundaries**\n\nREADME has"), "Mapping hunk boundaries");
  assert.equal(latestReasoningLine("## Plan the split\nStart"), "Plan the split");
  assert.equal(latestReasoningLine("- Stage `hunk 1` with the fix\n"), "Stage hunk 1 with the fix");
  assert.equal(latestReasoningLine("1. Check   the build\n\n\n"), "Check the build");
  // Blank lines and bare markers never become the line.
  assert.equal(latestReasoningLine("Read the diff.\n\n**\n\n"), "Read the diff.");
});
