import assert from "node:assert/strict";
import test from "node:test";
import { humanizeModelId, resolveModelDisplay } from "./model-display.js";

test("prefers the canonical models.dev name without changing the provider model id", () => {
  assert.deepEqual(resolveModelDisplay("anthropic/claude-fable-5", { name: "Claude Fable 5" }), {
    label: "Claude Fable 5",
    format: null,
  });
});

test("humanizes unlisted hosted model identifiers", () => {
  assert.equal(humanizeModelId("openai/gpt-4o-mini"), "GPT 4o Mini");
  assert.equal(humanizeModelId("claude-3-7-sonnet-latest"), "Claude 3.7 Sonnet Latest");
  assert.equal(humanizeModelId("claude-sonnet-4-20250514"), "Claude Sonnet 4");
});

test("separates local format tags from a readable fallback name", () => {
  assert.deepEqual(resolveModelDisplay("lmstudio-community/Qwen2.5-Coder-7B-Instruct-GGUF"), {
    label: "Qwen 2.5 Coder 7B Instruct",
    format: "GGUF",
  });
  assert.deepEqual(resolveModelDisplay("llama3.2:8b-q4_K_M"), {
    label: "Llama 3.2 8B",
    format: "Q4_K_M",
  });
  assert.deepEqual(resolveModelDisplay("gemma4-26b-a4b-qat"), {
    label: "Gemma 4 26B A4B QAT",
    format: null,
  });
  assert.deepEqual(resolveModelDisplay("qwen3.6-27b-mtp-ud-mlx"), {
    label: "Qwen 3.6 27B MTP UD",
    format: "MLX",
  });
});
