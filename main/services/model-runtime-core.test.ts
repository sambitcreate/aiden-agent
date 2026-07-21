import assert from "node:assert/strict";
import test from "node:test";
import type { Api, Model, ProviderStreams } from "@earendil-works/pi-ai";

import { resolveModelRuntimeWith, type ModelRuntimeDependencies } from "./model-runtime-core.js";
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

function dependencies(options?: {
  provider?: StoredProvider;
  key?: string | null;
}): ModelRuntimeDependencies {
  return {
    getProvider: async () => options?.provider,
    getApiKey: async () => options?.key ?? null,
    codex: {
      prepareRuntimeModel: async (modelId) => {
        assert.equal(modelId, codexModel.id);
        return codexModel;
      },
      streamSimple: codexStream,
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

  const runtime = await resolveModelRuntimeWith(
    deps,
    "openai-codex",
    "gpt-5.4",
    controller.signal,
  );
  assert.equal(legacyReads, 0);
  assert.strictEqual(receivedSignal, controller.signal);
  assert.strictEqual(runtime.model, codexModel);
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
