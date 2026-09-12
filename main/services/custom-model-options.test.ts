import assert from "node:assert/strict";
import test from "node:test";
import {
  parseCustomModelOptions,
  mergeDiscoveredModelMetadata,
  assertCustomModelImageLimit,
} from "../../renderer/shared/custom-model-options.js";
import { resolveProviderRuntimeLimits } from "./models-catalog-core.js";
import { createProviderModelInfo } from "./provider-model-info-core.js";
import { AidenRemoteModelService } from "./aiden-remote-models.js";
import {
  composeStoredProvider,
  splitStoredProvider,
} from "./portable-config-core.js";
import type { Provider, ModelInfo } from "./types.js";

const provider: Provider = {
  id: "custom:tailnet",
  label: "Private server",
  kind: "openai",
  baseUrl: "http://server.ts.net:1234/v1",
  needsKey: false,
  hasKey: false,
  models: ["custom-model"],
  modelMetadata: {
    "custom-model": {
      source: "provider",
      vision: true,
      reasoning: true,
      contextLength: 128000,
      manuallyAdded: true,
      overrides: {
        vision: false,
        reasoning: false,
        toolCall: false,
        contextLength: 4096,
        outputLimit: 1024,
        maxImages: 2,
        video: true,
      },
    },
  },
};

test("custom options reject malformed values and preserve explicit false and zero", () => {
  assert.deepEqual(parseCustomModelOptions({ vision: false, maxImages: 0 }), {
    vision: false,
    maxImages: 0,
  });
  for (const value of [
    null,
    [],
    { vision: "true" },
    { maxImages: -1 },
    { contextLength: 0 },
    { outputLimit: 1.5 },
    { contextLength: Infinity },
    { maxImages: NaN },
    { contextLength: 1, outputLimit: 2 },
  ]) {
    assert.throws(() => parseCustomModelOptions(value));
  }
});

test("discovery refresh preserves overrides and manually entered IDs' metadata", () => {
  const merged = mergeDiscoveredModelMetadata(
    {
      "custom-model": {
        source: "provider" as const,
        vision: true,
        contextLength: 256000,
      },
    },
    provider.modelMetadata!,
  );
  assert.deepEqual(
    merged["custom-model"].overrides,
    provider.modelMetadata!["custom-model"].overrides,
  );
  assert.equal(merged["custom-model"].contextLength, 256000);
  assert.equal(merged["custom-model"].manuallyAdded, true);
});

test("persistence split and composition retain custom model settings", () => {
  const split = splitStoredProvider(provider);
  assert.deepEqual(
    composeStoredProvider(split.intent, split.cache).modelMetadata,
    provider.modelMetadata,
  );
});

test("runtime uses custom limits and negative capability overrides", () => {
  const limits = resolveProviderRuntimeLimits({}, provider, "custom-model");
  assert.equal(limits.contextWindow, 4096);
  assert.equal(limits.maxTokens, 1024);
  assert.equal(limits.reasoning, false);
  assert.deepEqual(limits.input, ["text"]);
});

test("manual capability values win over matched display catalogs", async () => {
  const catalog: ModelInfo = {
    id: "custom-model",
    vision: true,
    reasoning: true,
    contextLength: 128000,
    matched: true,
    metadataSource: "provider",
    inputModalities: ["text", "image"],
  };
  const service = createProviderModelInfo({
    legacyProvider: async () => provider,
    modelsCatalog: {
      info: async () => catalog,
      infoMany: async () => ({ "custom-model": catalog }),
    },
    codexModelInfo: () => undefined,
  });
  for (const actual of [
    await service.info(provider.id, "custom-model"),
    (await service.infoMany(provider.id, ["custom-model"]))["custom-model"],
  ]) {
    assert.equal(actual.vision, false);
    assert.equal(actual.reasoning, false);
    assert.equal(actual.contextLength, 4096);
    assert.deepEqual(actual.inputModalities, ["text", "video"]);
  }
});

test("native clients receive overridden image support and existing visibility policy", async () => {
  const service = new AidenRemoteModelService({
    listProviders: async () => [provider],
    getSettings: async () => ({
      hiddenModelsByProvider: { [provider.id]: ["custom-model"] },
    }),
  });
  const result = await service.list();
  assert.equal(result.providers[0].models[0].supportsImages, false);
  assert.equal(result.providers[0].models[0].hidden, true);
});

test("image count enforcement accepts the limit and rejects excess for native and desktop requests", () => {
  const messages = [{ attachments: [{ kind: "image" }, { kind: "text" }] }];
  assert.doesNotThrow(() =>
    assertCustomModelImageLimit({ maxImages: 1 }, messages),
  );
  assert.throws(
    () => assertCustomModelImageLimit({ maxImages: 0 }, messages),
    /at most 0/,
  );
  assert.doesNotThrow(() => assertCustomModelImageLimit(undefined, messages));
});

test("portable intent restores manual IDs and overrides without a discovery cache", () => {
  const { intent } = splitStoredProvider(provider);
  const restored = composeStoredProvider(intent, undefined);
  assert.deepEqual(restored.models, ["custom-model"]);
  assert.deepEqual(
    restored.modelMetadata?.["custom-model"].overrides,
    provider.modelMetadata?.["custom-model"].overrides,
  );
});

test("reset removes portable overrides while keeping manual IDs", () => {
  const reset = {
    ...provider,
    modelMetadata: {
      "custom-model": { source: "provider" as const, manuallyAdded: true },
    },
  };
  const { intent } = splitStoredProvider(reset);
  assert.deepEqual(intent.customModelOptions, {
    "custom-model": { manuallyAdded: true },
  });
});

test("zero images consistently disables desktop, runtime and native capability", async () => {
  const zero = {
    ...provider,
    modelMetadata: {
      "custom-model": {
        source: "provider" as const,
        vision: true,
        overrides: { maxImages: 0 },
      },
    },
  };
  const catalog: ModelInfo = {
    id: "custom-model",
    vision: true,
    matched: true,
    metadataSource: "provider",
    inputModalities: ["text", "image"],
  };
  const info = createProviderModelInfo({
    legacyProvider: async () => zero,
    modelsCatalog: {
      info: async () => catalog,
      infoMany: async () => ({ "custom-model": catalog }),
    },
    codexModelInfo: () => undefined,
  });
  const result = await info.info(zero.id, "custom-model");
  assert.equal(result.vision, false);
  assert.deepEqual(result.inputModalities, ["text"]);
  assert.equal(result.detectedCapabilities?.vision, true);
  assert.equal(
    (await info.infoMany(zero.id, ["custom-model"]))["custom-model"].vision,
    false,
  );
  assert.deepEqual(
    resolveProviderRuntimeLimits({}, zero, "custom-model").input,
    ["text"],
  );
  const remote = new AidenRemoteModelService({
    listProviders: async () => [zero],
    getSettings: async () => ({}),
  });
  assert.equal(
    (await remote.list()).providers[0].models[0].supportsImages,
    false,
  );
});

test("portable intent clears cached overrides and handles prototype-shaped IDs as data", () => {
  const { intent, cache } = splitStoredProvider(provider);
  const cleared = composeStoredProvider(
    { ...intent, customModelOptions: {} },
    cache,
  );
  assert.equal(cleared.modelMetadata?.["custom-model"].overrides, undefined);
  const manual = composeStoredProvider(
    {
      ...intent,
      customModelOptions: JSON.parse(
        '{"__proto__":{"vision":true,"manuallyAdded":true}}',
      ),
    },
    undefined,
  );
  assert.ok(
    Object.prototype.hasOwnProperty.call(manual.modelMetadata, "__proto__"),
  );
  assert.equal(manual.modelMetadata?.["__proto__"].overrides?.vision, true);
  assert.ok(manual.models.includes("__proto__"));
});
