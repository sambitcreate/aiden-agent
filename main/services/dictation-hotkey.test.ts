import assert from "node:assert/strict";
import test from "node:test";
import {
  DICTATION_PRESS_DEBOUNCE_MS,
  shouldAcceptDictationPress,
} from "./dictation-hotkey.js";

test("rejects a second press inside the debounce window", () => {
  assert.equal(shouldAcceptDictationPress(1_000, 1_000 + DICTATION_PRESS_DEBOUNCE_MS - 1), false);
  assert.equal(shouldAcceptDictationPress(1_000, 1_000 + DICTATION_PRESS_DEBOUNCE_MS), true);
});
