import assert from "node:assert/strict";
import test from "node:test";
import {
  NO_AUTH_API_KEY,
  resolveRuntimeApiKey,
  terminalAssistantText,
  terminalAssistantTextFallback,
  terminalGenerationError,
  terminalGenerationWasAborted,
} from "./generation-runtime.js";

test("uses an in-memory non-secret credential for an explicitly keyless provider", () => {
  assert.equal(resolveRuntimeApiKey({ needsKey: false }, null), NO_AUTH_API_KEY);
  assert.equal(resolveRuntimeApiKey({ needsKey: false }, "old saved key"), NO_AUTH_API_KEY);
});

test("preserves normal API-key requirements for authenticated providers", () => {
  assert.equal(resolveRuntimeApiKey({ needsKey: true }, "  live-key  "), "live-key");
  assert.equal(resolveRuntimeApiKey({ needsKey: true }, "   "), undefined);
  assert.equal(resolveRuntimeApiKey({ needsKey: true }, null), undefined);
});

test("classifies terminal Pi errors without turning an aborted turn into an error", () => {
  assert.equal(
    terminalGenerationError({
      role: "assistant",
      stopReason: "error",
      errorMessage: "No API key for provider: lmstudio",
    }),
    "No API key for provider: lmstudio",
  );
  assert.equal(
    terminalGenerationError({ role: "assistant", stopReason: "error", errorMessage: "   " }),
    "The model couldn't complete this response.",
  );
  assert.equal(terminalGenerationError({ role: "assistant", stopReason: "aborted" }), null);
  assert.equal(terminalGenerationWasAborted({ role: "assistant", stopReason: "aborted" }), true);
  assert.equal(terminalGenerationWasAborted({ role: "toolResult", stopReason: "aborted" }), false);
});

test("uses final assistant text when a provider does not stream text deltas", () => {
  assert.equal(
    terminalAssistantText({
      role: "assistant",
      content: [
        { type: "thinking", text: "hidden reasoning" },
        { type: "text", text: "Final answer" },
        { type: "text", text: " from the provider" },
      ],
    }),
    "Final answer from the provider",
  );
  assert.equal(
    terminalAssistantText({ role: "toolResult", content: [{ type: "text", text: "Nope" }] }),
    "",
  );
});

test("falls back per assistant turn instead of dropping a later terminal-only result", () => {
  let full = "I'll check the workspace.\n";
  full += terminalAssistantTextFallback(
    { role: "assistant", content: [{ type: "text", text: "Found the issue." }] },
    false,
  );
  assert.equal(full, "I'll check the workspace.\nFound the issue.");
  assert.equal(
    terminalAssistantTextFallback(
      { role: "assistant", content: [{ type: "text", text: "Already streamed." }] },
      true,
    ),
    "",
  );
});
