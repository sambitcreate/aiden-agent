import assert from "node:assert/strict";
import test from "node:test";
import {
  CURATED_FAL_IMAGE_MODELS,
  CURATED_REPLICATE_IMAGE_MODELS,
  inferImageModelMaker,
} from "./catalog.js";
import { REPLICATE_REFERENCE_FIELDS } from "./types.js";

test("maker inference reads model families before owners", () => {
  const cases: [string, string, string | undefined][] = [
    ["fal", "fal-ai/flux/schnell", "black-forest-labs"],
    ["fal", "fal-ai/flux-pro/kontext/max", "black-forest-labs"],
    ["openrouter", "black-forest-labs/flux.2-pro", "black-forest-labs"],
    ["openrouter", "bytedance-seed/seedream-4.5", "bytedance"],
    ["fal", "fal-ai/nano-banana-pro", "google"],
    ["replicate", "google/imagen-4-ultra", "google"],
    ["openrouter", "google/gemini-3-pro-image", "google"],
    ["openrouter", "openai/gpt-image-2", "openai"],
    ["openrouter", "openai/gpt-5-image-mini", "openai"],
    ["openrouter", "x-ai/grok-imagine-image-2.0", "xai"],
    ["fal", "alibaba/qwen-image-3/text-to-image", "qwen"],
    ["fal", "fal-ai/hunyuan-image/v3/instruct/text-to-image", "tencent-hunyuan"],
    ["fal", "fal-ai/kling-image/v3/text-to-image", "kling"],
    ["replicate", "ideogram-ai/ideogram-v4-turbo", "ideogram"],
    ["replicate", "recraft-ai/recraft-v4.1-pro", "recraft"],
    ["fal", "krea/v2/large/text-to-image", "krea"],
    ["fal", "fal-ai/stable-diffusion-v35-large", "stability-ai"],
    ["fal", "bria/fibo-gen-1.5/text-to-image", "bria"],
    ["replicate", "luma/photon", "luma"],
    ["fal", "microsoft/mai-image-2.5-pro", "microsoft"],
    ["fal", "meta/muse-image/text-to-image", "meta"],
    ["replicate", "nvidia/sana", "nvidia"],
    ["replicate", "prunaai/hidream-l1-fast", "pruna-ai"],
    ["openrouter", "openrouter/auto", "openrouter"],
    ["replicate", "openrouter/auto", undefined],
    ["openrouter", "sourceful/riverflow-v2-pro", undefined],
    ["fal", "fal-ai/some-unknown-model", undefined],
    ["fal", "", undefined],
  ];
  for (const [provider, id, maker] of cases) {
    assert.equal(inferImageModelMaker(provider, id), maker, `${provider} ${id}`);
  }
});

test("curated entries are unique and their reference metadata is self-consistent", () => {
  for (const list of [CURATED_REPLICATE_IMAGE_MODELS, CURATED_FAL_IMAGE_MODELS]) {
    const ids = list.map((entry) => entry.id);
    assert.equal(new Set(ids).size, ids.length);
    for (const entry of list) {
      if (entry.adapter.kind === "replicate") {
        assert.equal(entry.acceptsReferenceImages, entry.adapter.referenceField !== undefined, entry.id);
        if (entry.adapter.referenceField) {
          assert.ok(Object.prototype.hasOwnProperty.call(REPLICATE_REFERENCE_FIELDS, entry.adapter.referenceField));
        }
      } else if (entry.adapter.kind === "fal") {
        assert.equal(entry.adapter.textEndpoint, entry.id);
        assert.equal(entry.acceptsReferenceImages, entry.adapter.editEndpoint !== undefined, entry.id);
      } else {
        assert.fail(`${entry.id} has a foreign adapter`);
      }
    }
  }
});
