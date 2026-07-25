import assert from "node:assert/strict";
import test from "node:test";
import {
  localModelIdsMatch,
  normalizeLocalModelId,
  parseLmStudioModelsLoaded,
  parseOllamaPsLoaded,
} from "./local-runtime-status.js";

test("normalizes :latest suffixes for local model ids", () => {
  assert.equal(normalizeLocalModelId("gemma4:latest"), "gemma4");
  assert.equal(localModelIdsMatch("gemma4", "gemma4:latest"), true);
  assert.equal(localModelIdsMatch("qwen2.5:7b", "qwen2.5:7b-instruct"), false);
  assert.equal(localModelIdsMatch("foo:bar", "foo:bar:baz"), true);
});

test("parses Ollama /api/ps loaded models", () => {
  assert.equal(
    parseOllamaPsLoaded(
      {
        models: [
          { name: "gemma4", model: "gemma4", size_vram: 1 },
          { name: "other:latest", model: "other:latest" },
        ],
      },
      "gemma4:latest",
    ),
    "loaded",
  );
  assert.equal(parseOllamaPsLoaded({ models: [] }, "gemma4"), "unloaded");
  assert.equal(parseOllamaPsLoaded({ models: "nope" }, "gemma4"), "unknown");
  assert.equal(parseOllamaPsLoaded(null, "gemma4"), "unknown");
});

test("parses LM Studio v0 model state", () => {
  assert.equal(
    parseLmStudioModelsLoaded(
      {
        data: [
          { id: "google/gemma-3-4b", state: "not-loaded" },
          { id: "meta-llama-3.1-8b-instruct", state: "loaded" },
        ],
      },
      "meta-llama-3.1-8b-instruct",
    ),
    "loaded",
  );
  assert.equal(
    parseLmStudioModelsLoaded(
      {
        data: [{ id: "google/gemma-3-4b", state: "not-loaded" }],
      },
      "google/gemma-3-4b",
    ),
    "unloaded",
  );
  assert.equal(
    parseLmStudioModelsLoaded(
      {
        data: [{ id: "other", state: "loaded" }],
      },
      "missing-model",
    ),
    "unloaded",
  );
});

test("parses LM Studio v1 loaded_instances", () => {
  assert.equal(
    parseLmStudioModelsLoaded(
      {
        models: [
          {
            key: "gemma-4-26b-a4b",
            loaded_instances: [{ id: "inst-1" }],
          },
        ],
      },
      "gemma-4-26b-a4b",
    ),
    "loaded",
  );
  assert.equal(
    parseLmStudioModelsLoaded(
      {
        models: [
          {
            key: "gemma-4-26b-a4b",
            loaded_instances: [],
          },
        ],
      },
      "gemma-4-26b-a4b",
    ),
    "unloaded",
  );
});
