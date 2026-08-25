import assert from "node:assert/strict";
import test from "node:test";
import {
  buildDictationCleanupUserPrompt,
  dictationCleanupUsageIsLocal,
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

test("cleanup usage local flag follows the resolved provider, then preset ids", () => {
  assert.equal(
    dictationCleanupUsageIsLocal(
      {
        id: "openai",
        label: "OpenAI",
        baseUrl: "https://api.openai.com/v1",
        needsKey: true,
      },
      "openai",
    ),
    false,
  );
  assert.equal(
    dictationCleanupUsageIsLocal(
      {
        id: "custom:ollama",
        label: "Ollama",
        baseUrl: "http://127.0.0.1:11434",
        needsKey: false,
        deployment: "local",
      },
      "custom:ollama",
    ),
    true,
  );
  assert.equal(dictationCleanupUsageIsLocal(undefined, "custom:lmstudio"), true);
  assert.equal(dictationCleanupUsageIsLocal(undefined, "openai"), false);
});
