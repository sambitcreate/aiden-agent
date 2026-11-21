import assert from "node:assert/strict";
import test from "node:test";
import {
  buildDictationCleanupUserPrompt,
  dictationCleanupUsageIsLocal,
  requestDictationCleanup,
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

test("the cleanup request is a one-off that writes no prompt cache", async () => {
  const sent: Array<{ context: { systemPrompt?: string; messages: unknown[] }; options: Record<string, unknown> }> = [];
  const runtime = {
    model: { id: "model-a", api: "openai-completions", provider: "openai", input: ["text"] },
    apiKey: "cleanup-secret",
    headers: undefined,
    streams: {
      streamSimple: (_model: unknown, context: unknown, options: unknown) => {
        sent.push({ context: context as never, options: options as Record<string, unknown> });
        return { result: async () => ({ role: "assistant", content: [{ type: "text", text: "Hello." }] }) };
      },
    },
  } as unknown as Parameters<typeof requestDictationCleanup>[0];
  await requestDictationCleanup(runtime, "um hello", new AbortController().signal);
  assert.equal(sent.length, 1);
  assert.equal(sent[0]!.options.cacheRetention, "none");
  assert.equal(sent[0]!.options.apiKey, "cleanup-secret");
  assert.match(JSON.stringify(sent[0]!.context.messages), /um hello/u);
});
