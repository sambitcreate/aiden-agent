import assert from "node:assert/strict";
import test from "node:test";
import { ghosttyConsumedMods, ghosttyKeyForCode, ghosttyUnshiftedCodepoint } from "./keyCodes";

test("ghosttyKeyForCode keeps the tail of the pinned Ghostty key enum in order", () => {
  assert.equal(ghosttyKeyForCode("F25"), ghosttyKeyForCode("F24") + 1);
  assert.equal(ghosttyKeyForCode("PrintScreen"), ghosttyKeyForCode("FnLock") + 1);
  assert.equal(ghosttyKeyForCode("Pause"), ghosttyKeyForCode("ScrollLock") + 1);
  assert.equal(ghosttyKeyForCode("Paste"), ghosttyKeyForCode("Cut") + 1);
});

test("ghosttyConsumedMods only consumes a lone Shift producing a character", () => {
  const shifted = { altKey: false, ctrlKey: false, key: "@", metaKey: false, shiftKey: true };
  assert.equal(ghosttyConsumedMods(shifted), 1);
  assert.equal(ghosttyConsumedMods({ ...shifted, ctrlKey: true }), 0);
  assert.equal(ghosttyConsumedMods({ ...shifted, key: "Tab" }), 0);
  assert.equal(ghosttyConsumedMods({ ...shifted, key: " " }), 1);
});

test("ghosttyUnshiftedCodepoint provides the logical base character", () => {
  assert.equal(
    ghosttyUnshiftedCodepoint({ code: "KeyC", key: "c", shiftKey: false }),
    "c".codePointAt(0),
  );
  assert.equal(
    ghosttyUnshiftedCodepoint({ code: "KeyC", key: "C", shiftKey: true }),
    "c".codePointAt(0),
  );
  assert.equal(
    ghosttyUnshiftedCodepoint({ code: "Digit1", key: "!", shiftKey: true }),
    "1".codePointAt(0),
  );
  assert.equal(ghosttyUnshiftedCodepoint({ code: "Enter", key: "Enter", shiftKey: false }), 0);
});
