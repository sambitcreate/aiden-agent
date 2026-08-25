import assert from "node:assert/strict";
import test from "node:test";
import {
  buildDictationCleanupUserPrompt,
  sanitizeDictationCleanupOutput,
} from "./dictation-cleanup-core.js";

test("cleanup output keeps the original when the model returns empty or padded junk", () => {
  assert.equal(sanitizeDictationCleanupOutput("  ", "hello"), "hello");
  assert.equal(sanitizeDictationCleanupOutput("```\n\n```", "hello"), "hello");
  assert.equal(sanitizeDictationCleanupOutput("x".repeat(50_000), "hi"), "hi");
});

test("cleanup output unwraps a fenced reply", () => {
  assert.equal(
    sanitizeDictationCleanupOutput("```text\nHello there.\n```", "hello there"),
    "Hello there.",
  );
  assert.match(buildDictationCleanupUserPrompt("um hello"), /um hello/u);
});
