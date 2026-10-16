import assert from "node:assert/strict";
import { test } from "node:test";
import type { BotCapabilityCatalog } from "../../shared/bot-capabilities";
import { catalogFixture } from "./test-fixtures";
import {
  botFullAccess,
  chooseBotModel,
  chooseBotVisionModel,
  recommendedBotModelChoice,
  sameBotModelChoice,
} from "./bot-model-choice";

// Text Service/Writer reads text only; Vision Service/Seer reads images.
function catalog(): BotCapabilityCatalog {
  const base = catalogFixture();
  return {
    ...base,
    providers: [
      ...base.providers,
      {
        id: "prov-off",
        label: "Signed Out",
        available: false,
        models: [{ id: "model-off", label: "Ghost", available: true, supportsImages: true }],
      },
      {
        id: "prov-more",
        label: "More Vision",
        available: true,
        models: [{ id: "model-eye", label: "Eye", available: true, supportsImages: true }],
      },
    ],
  };
}

test("the recommended choice is the first model, paired with a photo model when it reads text only", () => {
  assert.deepEqual(recommendedBotModelChoice(catalog()), {
    providerId: "prov-text",
    modelId: "model-text",
    visionProviderId: "prov-vision",
    visionModelId: "model-vision",
  });
});

test("choosing a model that reads images drops the photo model", () => {
  const next = chooseBotModel(catalog(), recommendedBotModelChoice(catalog()), "prov-vision", "model-vision");
  assert.deepEqual(next, {
    providerId: "prov-vision",
    modelId: "model-vision",
    visionProviderId: undefined,
    visionModelId: undefined,
  });
});

test("choosing a text-only model keeps a still-valid photo model the person picked", () => {
  const picked = chooseBotVisionModel(catalog(), recommendedBotModelChoice(catalog()), "prov-more", "model-eye");
  const next = chooseBotModel(catalog(), picked, "prov-text", "model-text");
  assert.equal(next.visionProviderId, "prov-more");
  assert.equal(next.visionModelId, "model-eye");
});

test("choosing a text-only model with no photo model fills the first one available", () => {
  const next = chooseBotModel(catalog(), { providerId: "prov-vision", modelId: "model-vision" }, "prov-text", "model-text");
  assert.equal(next.visionProviderId, "prov-vision");
  assert.equal(next.visionModelId, "model-vision");
});

test("a model from a provider that is not set up, or an unknown one, changes nothing", () => {
  const start = recommendedBotModelChoice(catalog());
  assert.equal(chooseBotModel(catalog(), start, "prov-off", "model-off"), start);
  assert.equal(chooseBotModel(catalog(), start, "prov-text", "missing"), start);
});

test("a text-only model can't become the photo model", () => {
  const start = recommendedBotModelChoice(catalog());
  assert.equal(chooseBotVisionModel(catalog(), start, "prov-text", "model-text"), start);
});

test("sameBotModelChoice compares all four parts", () => {
  const start = recommendedBotModelChoice(catalog());
  assert.equal(sameBotModelChoice(start, { ...start }), true);
  assert.equal(sameBotModelChoice(start, { ...start, visionModelId: "model-eye" }), false);
});

test("Full access carries the chosen model and photo model, and no model keys when there is none", () => {
  const withModel = botFullAccess(catalog(), recommendedBotModelChoice(catalog()));
  assert.equal(withModel.hasModel, true);
  assert.deepEqual(withModel.access, {
    accessMode: "full",
    catalogRevision: "catalog-1",
    confirmedForeground: true,
    providerId: "prov-text",
    modelId: "model-text",
    webSearchEnabled: true,
    visionModel: { providerId: "prov-vision", modelId: "model-vision" },
  });
  const none = botFullAccess(catalogFixture({ models: false }), {});
  assert.equal(none.hasModel, false);
  assert.deepEqual(none.access, {
    accessMode: "full",
    catalogRevision: "catalog-1",
    confirmedForeground: true,
    webSearchEnabled: true,
  });
});
