import assert from "node:assert/strict";
import test from "node:test";
import { shouldPositionDictationPill } from "./pill-window-platform.js";

test("dictation pill positioning respects Wayland compositor ownership", () => {
  assert.equal(shouldPositionDictationPill("darwin", undefined), true);
  assert.equal(shouldPositionDictationPill("linux", "x11"), true);
  assert.equal(shouldPositionDictationPill("linux", "wayland"), false);
  assert.equal(shouldPositionDictationPill("linux", "WAYLAND"), false);
});
