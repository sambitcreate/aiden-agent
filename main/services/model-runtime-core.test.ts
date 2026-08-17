import assert from "node:assert/strict";
import test from "node:test";
import {
  createModels,
  type AnthropicMessagesCompat,
  type Api,
  type Model,
  type ProviderStreams,
} from "@earendil-works/pi-ai";

import { resolveModelRuntimeWith, type ModelRuntimeDependencies } from "./model-runtime-core.js";
import { CONSERVATIVE_RUNTIME_LIMITS, type RuntimeModelLimits } from "./models-catalog-core.js";
import type { StoredProvider } from "./types.js";

const codexModel: Model<Api> = {
  id: "gpt-5.4",
  name: "GPT-5.4",
  api: "openai-codex-responses",
  provider: "openai-codex",
  baseUrl: "https://chatgpt.com/backend-api",
  reasoning: true,
  input: ["text", "image"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 272_000,
  maxTokens: 128_000,
};

const codexStream = (() => {
  throw new Error("not called");
}) as ProviderStreams["streamSimple"];
const googleModel: Model<Api> = {
  id: "gemini-2.5-pro",
  name: "Gemini 2.5 Pro",
  api: "google-generative-ai",
  provider: "google",
  baseUrl: "https://generativelanguage.googleapis.com/v1beta",
  reasoning: true,
  input: ["text", "image"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 1_048_576,
  maxTokens: 65_536,
};
const googleStream = (() => {
  throw new Error("not called");
}) as ProviderStreams["streamSimple"];

function dependencies(options?: {
  provider?: StoredProvider;
  key?: string | null;
  limits?: RuntimeModelLimits;
  nativeProvider?: StoredProvider;
  nativeModel?: Model<Api>;
}): ModelRuntimeDependencies {
  const models = createModels();
  return {
    getProvider: async () => options?.provider,
    getApiKey: async () => options?.key ?? null,
    resolveRuntimeLimits: async () => options?.limits ?? CONSERVATIVE_RUNTIME_LIMITS,
    codex: {
      models,
      prepareRuntimeModel: async (modelId) => {
        assert.equal(modelId, codexModel.id);
        return codexModel;
      },
      streamSimple: codexStream,
    },
    native: {
      models,
      getProvider: (providerId) =>
        providerId === options?.nativeProvider?.id ? options.nativeProvider : undefined,
      getModel: (providerId, modelId) =>
        providerId === options?.nativeProvider?.id && modelId === options.nativeModel?.id
          ? options.nativeModel
          : undefined,
      streamSimple: googleStream,
    },
  };
}

test("routes Codex through Pi without consulting API-key providers", async () => {
  let legacyReads = 0;
  let receivedSignal: AbortSignal | undefined;
  const deps = dependencies();
  deps.getProvider = async () => {
    legacyReads += 1;
    return undefined;
  };
  deps.getApiKey = async () => {
    legacyReads += 1;
    return "must-not-be-read";
  };
  deps.codex.prepareRuntimeModel = async (modelId, signal) => {
    assert.equal(modelId, codexModel.id);
    receivedSignal = signal;
    return codexModel;
  };
  const controller = new AbortController();

  const runtime = await resolveModelRuntimeWith(deps, "openai-codex", "gpt-5.4", controller.signal);
  assert.equal(legacyReads, 0);
  assert.strictEqual(receivedSignal, controller.signal);
  assert.strictEqual(runtime.model, codexModel);
  assert.strictEqual(runtime.models, deps.codex.models);
  assert.strictEqual(runtime.streams.streamSimple, codexStream);
  assert.equal(runtime.apiKey, undefined);
  assert.equal(runtime.headers, undefined);
  assert.equal(runtime.provider.label, "ChatGPT / Codex");
});

test("keeps the legacy API-key runtime contract unchanged", async () => {
  const provider: StoredProvider = {
    id: "custom-openai",
    kind: "openai",
    label: "Custom OpenAI",
    baseUrl: "https://models.example.test/v1",
    models: ["example-model"],
    needsKey: true,
  };
  const runtime = await resolveModelRuntimeWith(
    dependencies({ provider, key: "  saved-key  " }),
    provider.id,
    "example-model",
  );

  assert.strictEqual(runtime.provider, provider);
  assert.equal(runtime.model.api, "openai-completions");
  assert.equal(runtime.model.baseUrl, provider.baseUrl);
  assert.equal(runtime.apiKey, "saved-key");
  assert.equal(runtime.headers, undefined);
  assert.strictEqual(runtime.models.getModel(provider.id, "example-model"), runtime.model);
});

test("preserves Anthropic adaptive-thinking metadata in the request model", async () => {
  const provider: StoredProvider = {
    id: "anthropic",
    kind: "anthropic",
    label: "Anthropic",
    baseUrl: "https://api.anthropic.com/v1",
    models: ["claude-opus-4-8"],
    needsKey: true,
  };
  const runtime = await resolveModelRuntimeWith(
    dependencies({
      provider,
      key: "saved-key",
      limits: {
        contextWindow: 200_000,
        maxTokens: 128_000,
        reasoning: true,
        input: ["text", "image"],
        thinkingLevelMap: { xhigh: "xhigh", max: "max" },
        forceAdaptiveThinking: true,
      },
    }),
    provider.id,
    "claude-opus-4-8",
  );

  assert.deepEqual(runtime.model.thinkingLevelMap, {
    xhigh: "xhigh",
    max: "max",
  });
  assert.equal(
    runtime.model.api === "anthropic-messages"
      ? (runtime.model.compat as AnthropicMessagesCompat | undefined)?.forceAdaptiveThinking
      : undefined,
    true,
  );
});

test("routes every Pi built-in through its native model and transport", async () => {
  const provider: StoredProvider = {
    id: "google",
    kind: "openai",
    label: "Google Gemini",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta",
    models: ["gemini-2.5-pro"],
    needsKey: true,
    isPreset: true,
  };
  let limitReads = 0;
  const deps = dependencies({
    provider,
    key: "saved-key",
    nativeProvider: provider,
    nativeModel: googleModel,
  });
  deps.resolveRuntimeLimits = async () => {
    limitReads += 1;
    return CONSERVATIVE_RUNTIME_LIMITS;
  };

  const runtime = await resolveModelRuntimeWith(deps, provider.id, "gemini-2.5-pro");

  assert.equal(limitReads, 0);
  assert.strictEqual(runtime.provider, provider);
  assert.strictEqual(runtime.model, googleModel);
  assert.strictEqual(runtime.models, deps.native.models);
  assert.strictEqual(runtime.streams.streamSimple, googleStream);
  assert.equal(runtime.apiKey, undefined);
  assert.equal(runtime.model.api, "google-generative-ai");
  assert.equal(runtime.model.provider, "google");
  assert.equal(runtime.model.baseUrl, "https://generativelanguage.googleapis.com/v1beta");
  assert.equal(runtime.model.contextWindow, 1_048_576);
  assert.equal(runtime.model.maxTokens, 65_536);
  assert.equal(runtime.model.reasoning, true);
});

test("routes non-special Pi providers without reading legacy endpoint configuration", async () => {
  const provider: StoredProvider = {
    id: "deepseek",
    kind: "openai",
    label: "DeepSeek",
    baseUrl: "https://api.deepseek.com",
    models: ["deepseek-chat"],
    needsKey: true,
    isBuiltin: true,
  };
  const model: Model<Api> = {
    id: "deepseek-chat",
    name: "DeepSeek-V3.2",
    api: "openai-completions",
    provider: "deepseek",
    baseUrl: "https://api.deepseek.com",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 163_840,
    maxTokens: 8_192,
  };
  const deps = dependencies({ nativeProvider: provider, nativeModel: model });
  let legacyReads = 0;
  deps.getProvider = async () => {
    legacyReads += 1;
    return undefined;
  };
  deps.getApiKey = async () => {
    legacyReads += 1;
    return "legacy-key";
  };

  const runtime = await resolveModelRuntimeWith(deps, provider.id, model.id);

  assert.equal(legacyReads, 0);
  assert.strictEqual(runtime.provider, provider);
  assert.strictEqual(runtime.model, model);
  assert.strictEqual(runtime.streams.streamSimple, googleStream);
  assert.equal(runtime.apiKey, undefined);
  assert.equal(runtime.headers, undefined);
});

test("rejects models absent from Pi's native catalog", async () => {
  const provider: StoredProvider = {
    id: "google",
    kind: "openai",
    label: "Google Gemini",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta",
    models: ["gemini-retired"],
    needsKey: true,
    isPreset: true,
  };
  await assert.rejects(
    resolveModelRuntimeWith(
      dependencies({ provider, key: "saved-key", nativeProvider: provider }),
      "google",
      "gemini-retired",
    ),
    /not available through Pi's Google Gemini provider/iu,
  );
});

test("keeps missing legacy API keys on the existing actionable error path", async () => {
  const provider: StoredProvider = {
    id: "custom-openai",
    kind: "openai",
    label: "Custom OpenAI",
    baseUrl: "https://models.example.test/v1",
    models: ["example-model"],
    needsKey: true,
  };
  await assert.rejects(
    resolveModelRuntimeWith(dependencies({ provider, key: null }), provider.id, "example-model"),
    /No API key set for Custom OpenAI/u,
  );
});

test("rejects stale legacy model selections before reading provider credentials", async () => {
  const provider: StoredProvider = {
    id: "custom-openai",
    kind: "openai",
    label: "Custom OpenAI",
    baseUrl: "https://models.example.test/v1",
    models: ["current-model"],
    needsKey: true,
  };
  let keyReads = 0;
  const deps = dependencies({ provider, key: "saved-key" });
  deps.getApiKey = async () => {
    keyReads += 1;
    return "saved-key";
  };

  await assert.rejects(
    resolveModelRuntimeWith(deps, provider.id, "removed-model"),
    /no longer available for Custom OpenAI/u,
  );
  assert.equal(keyReads, 0);
});
