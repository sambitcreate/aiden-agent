import assert from "node:assert/strict";
import test from "node:test";
import { OPENAI_CODEX_PROVIDER_ID } from "./codex-provider.js";
import { createProviderModelInfo } from "./provider-model-info-core.js";
import type { ModelInfo } from "./types.js";

const ranking = {
  capabilityPercentile: 0.9,
  responseTimePercentile: 0.2,
  source: "Artificial Analysis · Intelligence Index v4.1",
};

const pinned: ModelInfo = {
  id: "gpt-5.4",
  name: "GPT-5.4",
  vision: true,
  toolCall: true,
  reasoning: true,
  openWeights: false,
  contextLength: 272_000,
  outputLimit: 128_000,
  inputModalities: ["text", "image"],
  metadataSource: "provider",
  matched: true,
};

function fixture() {
  const requests: Array<{ providerId: string; modelIds: string[] }> = [];
  const catalogInfo = (modelId: string): ModelInfo => ({
    id: modelId,
    name: `Catalog ${modelId}`,
    vision: false,
    toolCall: false,
    reasoning: false,
    openWeights: true,
    contextLength: 1,
    ranking: modelId === "gpt-5.4" ? ranking : undefined,
    metadataSource: "artificial-analysis",
    matched: true,
  });
  const service = createProviderModelInfo({
    modelsCatalog: {
      info: async (provider, modelId) => {
        requests.push({ providerId: provider.id, modelIds: [modelId] });
        return catalogInfo(modelId);
      },
      infoMany: async (provider, modelIds) => {
        requests.push({ providerId: provider.id, modelIds });
        return Object.fromEntries(modelIds.map((modelId) => [modelId, catalogInfo(modelId)]));
      },
    },
    legacyProvider: async (providerId) => ({ id: providerId, baseUrl: "https://example.test" }),
    codexModelInfo: (modelId) => (modelId === "gpt-5.4" ? pinned : undefined),
  });
  return { service, requests };
}

test("enriches pinned Codex models without replacing Pi-authoritative capabilities", async () => {
  const { service, requests } = fixture();
  const result = await service.info(OPENAI_CODEX_PROVIDER_ID, "gpt-5.4");
  assert.deepEqual(result, {
    ...pinned,
    ranking,
    metadataSource: "artificial-analysis",
    matched: true,
  });
  assert.deepEqual(requests, [{ providerId: OPENAI_CODEX_PROVIDER_ID, modelIds: ["gpt-5.4"] }]);
});

test("keeps unknown Codex ids unavailable and enriches batches consistently", async () => {
  const { service } = fixture();
  const result = await service.infoMany(OPENAI_CODEX_PROVIDER_ID, ["gpt-5.4", "unknown"]);
  assert.equal(result["gpt-5.4"].ranking, ranking);
  assert.deepEqual(result.unknown, {
    id: "unknown",
    vision: false,
    toolCall: false,
    reasoning: false,
    openWeights: false,
    metadataSource: "fallback",
    matched: false,
  });
});

test("retains the existing catalog path for non-Codex providers", async () => {
  const { service, requests } = fixture();
  const result = await service.info("anthropic", "claude-example");
  assert.equal(result.name, "Catalog claude-example");
  assert.deepEqual(requests, [{ providerId: "anthropic", modelIds: ["claude-example"] }]);
});

test("uses provider-owned metadata when a newly published model is absent from bundled catalogs", async () => {
  const service = createProviderModelInfo({
    modelsCatalog: {
      info: async (_provider, modelId) => ({
        id: modelId,
        vision: false,
        toolCall: false,
        reasoning: false,
        openWeights: false,
        metadataSource: "fallback",
        matched: false,
      }),
      infoMany: async (_provider, modelIds) => Object.fromEntries(modelIds.map((modelId) => [modelId, {
        id: modelId,
        metadataSource: "fallback" as const,
        matched: false,
      }])),
    },
    legacyProvider: async (providerId) => ({
      id: providerId,
      baseUrl: "https://opencode.ai/zen/v1",
      modelMetadata: {
        "ox-alpha-free": {
          source: "provider",
          name: "Ox Alpha Free (Unlimited)",
          type: "llm",
          vision: true,
          reasoning: true,
          contextLength: 1_000_000,
        },
      },
    }),
    codexModelInfo: () => undefined,
  });
  assert.deepEqual(await service.info("opencode-go", "ox-alpha-free"), {
    id: "ox-alpha-free",
    name: "Ox Alpha Free (Unlimited)",
    vision: true,
    toolCall: false,
    reasoning: true,
    openWeights: false,
    modelType: "llm",
    parameterCount: undefined,
    format: undefined,
    contextLength: 1_000_000,
    inputModalities: ["text", "image"],
    metadataSource: "provider",
    matched: true,
  });
});
