import assert from "node:assert/strict";
import test from "node:test";
import { parseModelCatalog } from "../main/services/models-catalog-core.ts";
import { validateModelsDevSnapshot } from "./model-snapshot-core.mjs";

test("models.dev capability snapshots require at least one provider model", () => {
  const snapshot = {
    openai: {
      models: {
        "openai/example": {
          name: "Example",
          limit: { context: 128_000, output: 16_000 },
        },
      },
    },
  };
  assert.equal(validateModelsDevSnapshot(snapshot), snapshot);
  assert.throws(() => validateModelsDevSnapshot([]), /unexpected payload/u);
  assert.throws(() => validateModelsDevSnapshot({}), /empty catalog/u);
  assert.throws(() => validateModelsDevSnapshot({ openai: { models: {} } }), /empty catalog/u);
  assert.throws(
    () =>
      validateModelsDevSnapshot({
        openai: {
          models: {
            broken: {
              name: "Broken",
              modalities: { input: { length: 1 } },
            },
          },
        },
      }),
    /modalities\.input must be a string array/u,
  );
  assert.throws(
    () =>
      validateModelsDevSnapshot({
        openai: {
          models: {
            broken: { name: "Broken", limit: { context: "many" } },
          },
        },
      }),
    /limit\.context must be a non-negative number/u,
  );
});

test("release and runtime models.dev validators accept the same payload corpus", () => {
  const corpus = [
    {
      openai: {
        models: {
          example: {
            name: "Example",
            attachment: true,
            modalities: { input: ["text", "image"], output: ["text"] },
            limit: { context: 128_000, output: 16_000 },
          },
        },
      },
    },
    { openai: { models: { "": { name: "Empty ID" } } } },
    { openai: { models: { example: { name: "" } } } },
    { openai: { models: { example: { name: "Example", description: 42 } } } },
    { openai: { models: { example: { name: "Example", family: false } } } },
    { openai: { models: { example: { name: "Example", tool_call: "yes" } } } },
    { openai: { models: { example: { name: "Example", modalities: { input: [1] } } } } },
    { openai: { models: { example: { name: "Example", limit: { context: -1 } } } } },
    {
      openai: { models: { example: { name: "Example", limit: { context: 99_000_000_000 } } } },
    },
    { openai: { models: { ["x".repeat(513)]: { name: "Oversized identity" } } } },
    { openai: {} },
    {},
    [],
  ];

  for (const payload of corpus) {
    let releaseAccepted = true;
    let runtimeAccepted = true;
    try {
      validateModelsDevSnapshot(payload);
    } catch {
      releaseAccepted = false;
    }
    try {
      parseModelCatalog(payload);
    } catch {
      runtimeAccepted = false;
    }
    assert.equal(runtimeAccepted, releaseAccepted, JSON.stringify(payload));
  }
});
