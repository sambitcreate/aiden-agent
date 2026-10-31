import assert from "node:assert/strict";
import test from "node:test";
import { USER_MESSAGE_FOLD_LINES, userMessageFolds, userMessageMayFold } from "./user-message-fold";

test("a short prompt or a couple of sentences never folds on first paint", () => {
  assert.equal(userMessageMayFold("Hi there"), false);
  assert.equal(
    userMessageMayFold("Add the Umbrel server to the global MCP config. Then say hello and tell me what you find."),
    false,
  );
  assert.equal(userMessageMayFold(""), false);
});

test("a long paste or a many-line prompt folds before its height is known", () => {
  assert.equal(userMessageMayFold("word ".repeat(80)), true);
  // One unbroken token wraps over many lines in a bubble, so length alone counts.
  assert.equal(userMessageMayFold(`Bearer ${"a1b2c3d4".repeat(48)}`), true);
  assert.equal(userMessageMayFold(Array.from({ length: 8 }, (_, i) => `line ${i}`).join("\n")), true);
});

test("a prompt only one line past the fold stays open rather than hiding a single line", () => {
  const justPast = Array.from({ length: USER_MESSAGE_FOLD_LINES + 1 }, (_, i) => `step ${i}`).join("\n");
  assert.equal(userMessageMayFold(justPast), false);
  const lineHeight = 20;
  assert.equal(userMessageFolds(lineHeight * (USER_MESSAGE_FOLD_LINES + 1), lineHeight), false);
  assert.equal(userMessageFolds(lineHeight * (USER_MESSAGE_FOLD_LINES + 2), lineHeight), true);
});

test("the measured height decides once the bubble has wrapped, whatever the guess was", () => {
  // 400 characters that wrap to four lines in a wide chat do not fold.
  assert.equal(userMessageMayFold("x ".repeat(200)), true);
  assert.equal(userMessageFolds(4 * 20, 20), false);
  // A short prompt that wraps to ten lines in a narrow chat does.
  assert.equal(userMessageFolds(10 * 22, 22), true);
});

test("an unmeasured body (no layout yet, or no line height) never folds", () => {
  assert.equal(userMessageFolds(0, 20), false);
  assert.equal(userMessageFolds(400, Number.NaN), false);
  assert.equal(userMessageFolds(400, 0), false);
});
