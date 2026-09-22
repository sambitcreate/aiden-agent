import assert from "node:assert/strict";
import test from "node:test";
import {
  CREATE_IMAGES_GEMINI_RELEASE_CATALOG,
  createImagesCuratedGeminiModels,
  evaluateCreateImagesProviderBinding,
  type CreateImagesProviderStatus,
} from "./providers.js";
import type { GenerateImageNodeV1 } from "./schema.js";

const generationNode: GenerateImageNodeV1 = {
  id: "generate-1",
  type: "generate-image",
  position: { x: 0, y: 0 },
  data: {
    providerId: "gemini",
    modelId: "gemini-3.1-flash-image",
    aspectRatio: "1:1",
    imageSize: "1K",
    outputMime: "image/png",
    count: 1,
  },
};

function connectedStatus(
  overrides: Partial<CreateImagesProviderStatus> = {},
): CreateImagesProviderStatus {
  return {
    schemaVersion: 1,
    providerId: "gemini",
    displayName: "Google Gemini",
    connectionState: "connected",
    credentialKind: "google-api-key",
    capabilitySnapshot: structuredClone(CREATE_IMAGES_GEMINI_RELEASE_CATALOG),
    ...overrides,
  };
}

test("Gemini release catalog is curated, bounded, and contains no credential or endpoint fields", () => {
  assert.deepEqual(
    CREATE_IMAGES_GEMINI_RELEASE_CATALOG.models.map((model) => model.id),
    ["gemini-3.1-flash-lite-image", "gemini-3.1-flash-image", "gemini-3-pro-image"],
  );
  for (const model of CREATE_IMAGES_GEMINI_RELEASE_CATALOG.models) {
    assert.equal(model.maxOutputs, 1);
    assert.equal(model.supportsCancellation, false);
    assert.ok(model.aspectRatios.length <= 10);
    assert.ok(model.imageSizes.length <= 3);
  }
  const serialized = JSON.stringify(CREATE_IMAGES_GEMINI_RELEASE_CATALOG);
  assert.doesNotMatch(serialized, /api[_-]?key|credential|authorization|endpoint|baseUrl/iu);
});

test("provider binding accepts only a connected current snapshot with compatible exact options", () => {
  const ready = evaluateCreateImagesProviderBinding(generationNode, connectedStatus());
  assert.equal(ready.status, "ready");

  for (const [status, issue] of [
    [connectedStatus({ connectionState: "disconnected" }), "connection-not-ready"],
    [connectedStatus({ capabilitySnapshot: undefined }), "capabilities-unavailable"],
    [
      connectedStatus({
        capabilitySnapshot: { ...CREATE_IMAGES_GEMINI_RELEASE_CATALOG, state: "stale" },
      }),
      "capabilities-stale",
    ],
  ] as const) {
    assert.deepEqual(evaluateCreateImagesProviderBinding(generationNode, status), {
      status: "blocked",
      issue,
    });
  }
});

test("provider binding rejects model and option drift including output fan-out", () => {
  const currentModel = CREATE_IMAGES_GEMINI_RELEASE_CATALOG.models[1]!;
  const cases: Array<[GenerateImageNodeV1, CreateImagesProviderStatus, string]> = [
    [
      { ...generationNode, data: { ...generationNode.data, modelId: "attacker/model" } },
      connectedStatus(),
      "model-not-curated",
    ],
    [
      generationNode,
      connectedStatus({
        capabilitySnapshot: {
          ...CREATE_IMAGES_GEMINI_RELEASE_CATALOG,
          models: CREATE_IMAGES_GEMINI_RELEASE_CATALOG.models.filter(
            (model) => model.id !== generationNode.data.modelId,
          ),
        },
      }),
      "model-no-longer-available",
    ],
    [
      { ...generationNode, data: { ...generationNode.data, imageSize: "4K" } },
      connectedStatus({
        capabilitySnapshot: {
          ...CREATE_IMAGES_GEMINI_RELEASE_CATALOG,
          models: [{ ...currentModel, imageSizes: ["1K"] }],
        },
      }),
      "image-size-no-longer-supported",
    ],
    [
      { ...generationNode, data: { ...generationNode.data, count: 2 } },
      connectedStatus(),
      "output-count-no-longer-supported",
    ],
  ];
  for (const [node, status, issue] of cases) {
    assert.deepEqual(evaluateCreateImagesProviderBinding(node, status), {
      status: "blocked",
      issue,
    });
  }
});

test("connected capabilities are intersected with the release catalog", () => {
  const status = connectedStatus({
    capabilitySnapshot: {
      ...CREATE_IMAGES_GEMINI_RELEASE_CATALOG,
      models: [
        CREATE_IMAGES_GEMINI_RELEASE_CATALOG.models[0]!,
        {
          ...CREATE_IMAGES_GEMINI_RELEASE_CATALOG.models[0]!,
          id: "provider-added-unreviewed-model",
        },
      ],
    },
  });
  assert.deepEqual(
    createImagesCuratedGeminiModels(status).map((model) => model.id),
    ["gemini-3.1-flash-lite-image"],
  );
});
