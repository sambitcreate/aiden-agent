import assert from "node:assert/strict";
import test from "node:test";

import { dictationPlatformBehavior } from "./dictation-platform.js";

test("Linux dictation is toggle-only clipboard delivery", () => {
  assert.deepEqual(dictationPlatformBehavior("linux"), {
    accessibilityPaste: false,
    holdToTalk: false,
  });
});
test("macOS dictation can use attended paste and hold-to-talk", () => {
  assert.deepEqual(dictationPlatformBehavior("darwin"), {
    accessibilityPaste: true,
    holdToTalk: true,
  });
});
