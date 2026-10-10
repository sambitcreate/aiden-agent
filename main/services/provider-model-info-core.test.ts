import assert from "node:assert/strict";
import test from "node:test";
import { OPENAI_CODEX_PROVIDER_ID } from "./codex-provider.js";
import { createProviderModelInfo, mergeCodexModelInfo } from "./provider-model-info-core.js";
import type { ModelInfo } from "./types.js";

const benchmark: NonNullable<ModelInfo["benchmark"]> = {
  source: "openrouter",
  datasetSource: "artificial-analysis",
  sourceLabel: "Artificial Analysis via OpenRouter",
  sourceUrl: "https://artificialanalysis.ai",
  citation: "Source: Artificial Analysis via OpenRouter.",
  asOf: "2026-06-03T12:00:00.000Z",
  license: "CC BY 4.0",
  coding: 80,
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
    ...(modelId === "gpt-5.4" ? { benchmark } : {}),
    metadataSource: "models-dev",
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
  assert.deepEqual(result, { ...pinned, benchmark, matched: true });
  assert.deepEqual(requests, [{ providerId: OPENAI_CODEX_PROVIDER_ID, modelIds: ["gpt-5.4"] }]);
});

test("benchmark-only Codex enrichment preserves Pi metadata authority", () => {
  const result = mergeCodexModelInfo("gpt-5.4", pinned, {
    id: "gpt-5.4",
    metadataSource: "models-dev",
    matched: true,
    benchmark: {
      source: "openrouter",
      datasetSource: "artificial-analysis",
      sourceLabel: "Artificial Analysis via OpenRouter",
      sourceUrl: "https://artificialanalysis.ai",
      citation: "Source: Artificial Analysis via OpenRouter.",
      asOf: "2026-06-03T12:00:00.000Z",
      license: "CC BY 4.0",
      coding: 80,
    },
  });
  assert.equal(result.metadataSource, "provider");
  assert.equal(result.benchmark?.coding, 80);
  assert.equal(result.contextLength, pinned.contextLength);
});

test("Codex enrichment grafts models.dev cost and canonical id onto Pi metadata", () => {
  const result = mergeCodexModelInfo("gpt-5.4", pinned, {
    id: "gpt-5.4",
    metadataSource: "models-dev",
    matched: true,
    contextLength: 1,
    cost: { input: 1.25, output: 10 },
    canonicalModelId: "openai/gpt-5.4",
  });
  assert.deepEqual(result.cost, { input: 1.25, output: 10 });
  assert.equal(result.canonicalModelId, "openai/gpt-5.4");
  assert.equal(result.metadataSource, "provider");
  assert.equal(result.contextLength, pinned.contextLength);
});

test("keeps unknown Codex ids unavailable and enriches batches consistently", async () => {
  const { service } = fixture();
  const result = await service.infoMany(OPENAI_CODEX_PROVIDER_ID, ["gpt-5.4", "unknown"]);
  assert.equal(result["gpt-5.4"].benchmark, benchmark);
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
      infoMany: async (_provider, modelIds) =>
        Object.fromEntries(
          modelIds.map((modelId) => [
            modelId,
            {
              id: modelId,
              metadataSource: "fallback" as const,
              matched: false,
            },
          ]),
        ),
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

test("private connection image and reasoning switches follow request capabilities, not a public model name", async () => {
  const { resolveProviderRuntimeLimits } = await import("./models-catalog-core.js");
  const provider = { id: "custom:private", baseUrl: "https://private.example.test/v1", kind: "openai" as const,
    modelMetadata: { "glm-5.3-flash": { source: "provider" as const, overrides: { maxImages: 6, contextLength: 249972 } } } };
  const publicInfo: ModelInfo = { id: "glm-5.3-flash", name: "GLM-5.3-Flash", vision: true, reasoning: true, matched: true, metadataSource: "models-dev", inputModalities: ["text", "image"] };
  const service = createProviderModelInfo({
    legacyProvider: async () => provider,
    modelsCatalog: { info: async () => publicInfo, infoMany: async () => ({ "glm-5.3-flash": publicInfo }) },
    codexModelInfo: () => undefined,
  });
  const first = await service.info(provider.id, publicInfo.id);
  assert.equal(first.name, "GLM-5.3-Flash");
  assert.equal(first.vision, false);
  assert.equal(first.reasoning, false);
  assert.deepEqual(first.inputModalities, ["text"]);
  assert.equal(resolveProviderRuntimeLimits({}, provider, publicInfo.id).input.includes("image"), false);
  Object.assign(provider.modelMetadata["glm-5.3-flash"].overrides, { vision: true, reasoning: true });
  const enabled = (await service.infoMany(provider.id, [publicInfo.id]))[publicInfo.id]!;
  assert.equal(enabled.vision, true);
  assert.equal(enabled.reasoning, true);
  assert.equal(resolveProviderRuntimeLimits({}, provider, publicInfo.id).input.includes("image"), true);
  Object.assign(provider.modelMetadata["glm-5.3-flash"].overrides, { maxImages: 0 });
  assert.equal((await service.info(provider.id, publicInfo.id)).vision, false);
});

async function openRouterGatewayService(overrides?: { contextLength: number }) {
  const { parseModelCatalog, resolveModelInfo } = await import("./models-catalog-core.js");
  const { buildOpenRouterBenchmarkCache } = await import("./openrouter-benchmark-catalog-core.js");
  const benchmarks = buildOpenRouterBenchmarkCache({
    data: [{
      source: "artificial-analysis",
      model_permaslug: "acme/fresh-model-20261001",
      display_name: "Fresh Model",
      intelligence_index: 61.5,
      coding_index: 70.2,
      agentic_index: 55.8,
    }],
    meta: {
      as_of: "2026-10-01T00:00:00.000Z",
      version: "v1",
      source: "artificial-analysis",
      source_url: "https://artificialanalysis.ai",
      citation: "Source: Artificial Analysis (artificialanalysis.ai) via OpenRouter (openrouter.ai/rankings).",
      model_count: 1,
      task_type: null,
    },
  });
  // models.dev knows an unrelated model only, so the gateway model is unmatched.
  const modelsDev = parseModelCatalog({ openrouter: { models: { "other/model": { name: "Other Model" } } } });
  const modelId = "acme/fresh-model-20261001";
  const provider = {
    id: "openrouter",
    baseUrl: "https://openrouter.ai/api/v1",
    modelMetadata: {
      [modelId]: {
        source: "provider" as const,
        name: "Fresh Model (gateway)",
        contextLength: 128_000,
        ...(overrides ? { overrides } : {}),
      },
    },
  };
  const service = createProviderModelInfo({
    modelsCatalog: {
      info: async (catalogProvider, id) =>
        resolveModelInfo(modelsDev, catalogProvider, id, benchmarks),
      infoMany: async (catalogProvider, ids) =>
        Object.fromEntries(ids.map((id) => [
          id,
          resolveModelInfo(modelsDev, catalogProvider, id, benchmarks),
        ])),
    },
    legacyProvider: async () => provider,
    codexModelInfo: () => undefined,
  });
  return { service, provider, modelId };
}

test("provider metadata fallback keeps exact OpenRouter benchmark scores when models.dev has no match", async () => {
  const { service, provider, modelId } = await openRouterGatewayService();
  const single = await service.info(provider.id, modelId);
  assert.equal(single.name, "Fresh Model (gateway)");
  assert.equal(single.metadataSource, "provider");
  assert.equal(single.benchmark?.intelligence, 61.5);
  assert.equal(single.benchmark?.coding, 70.2);
  assert.equal(single.benchmark?.agentic, 55.8);
  assert.equal(single.benchmark?.asOf, "2026-10-01T00:00:00.000Z");
  const batch = (await service.infoMany(provider.id, [modelId]))[modelId]!;
  assert.equal(batch.benchmark?.coding, 70.2);
});

test("provider metadata overrides still apply and keep the benchmark through the fallback", async () => {
  const { service, provider, modelId } = await openRouterGatewayService({ contextLength: 64_000 });
  const info = await service.info(provider.id, modelId);
  assert.equal(info.contextLength, 64_000);
  assert.equal(info.detectedCapabilities?.contextLength, 128_000);
  assert.equal(info.benchmark?.intelligence, 61.5);
  assert.equal(info.benchmark?.agentic, 55.8);
  const batch = (await service.infoMany(provider.id, [modelId]))[modelId]!;
  assert.equal(batch.contextLength, 64_000);
  assert.equal(batch.benchmark?.coding, 70.2);
});
