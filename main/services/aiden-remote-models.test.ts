import assert from "node:assert/strict";
import test from "node:test";
import { AidenRemoteModelService } from "./aiden-remote-models.js";
import type { Provider } from "./types.js";

function provider(overrides: Partial<Provider> = {}): Provider {
  return {
    id: "provider-1",
    kind: "openai",
    label: "Provider",
    baseUrl: "https://secret-endpoint.example/v1",
    models: ["chat-model", "embedding-model"],
    modelMetadata: {
      "chat-model": {
        source: "provider",
        name: "Chat Model",
        type: "llm",
        thinkingLevels: ["low", "high"],
        thinkingCanDisable: false,
      },
      "embedding-model": { source: "provider", type: "embedding" },
    },
    needsKey: true,
    hasKey: true,
    authMethods: [{ type: "api_key", label: "Secret", canLogin: true }],
    ...overrides,
  };
}

test("model projection includes only configured chat models and no connection secrets", async () => {
  const service = new AidenRemoteModelService({
    listProviders: async () => [provider(), provider({ id: "missing-key", hasKey: false })],
    getSettings: async () => ({ lastProviderId: "provider-1", lastModel: "chat-model" }),
  });
  const projection = await service.list();
  assert.deepEqual(projection.defaults, { providerId: "provider-1", modelId: "chat-model" });
  assert.equal(projection.providers.length, 1);
  assert.deepEqual(projection.providers[0]?.models, [
    {
      id: "chat-model",
      label: "Chat Model",
      supportsImages: false,
      thinkingLevels: ["low", "high"],
      defaultThinkingLevel: "high",
      thinkingCanDisable: false,
    },
  ]);
  const serialized = JSON.stringify(projection);
  assert.equal(serialized.includes("secret-endpoint"), false);
  assert.equal(serialized.includes("authMethods"), false);
});

test("custom provider artwork crosses the remote catalog only as bounded normalized PNG data", async () => {
  const artwork = {
    mimeType: "image/png" as const,
    dataBase64: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  };
  const service = new AidenRemoteModelService({
    listProviders: async () => [provider({ artwork })],
    getSettings: async () => ({}),
  });
  assert.deepEqual((await service.list()).providers[0]?.artwork, artwork);
});

test("model selection rejects missing providers and models", async () => {
  const service = new AidenRemoteModelService({
    listProviders: async () => [provider()],
    getSettings: async () => ({}),
  });
  assert.deepEqual(await service.resolve(), {
    providerId: "provider-1",
    modelId: "chat-model",
    thinkingLevels: ["low", "high"],
    supportsImages: false,
  });
  await assert.rejects(
    service.resolve("provider-1", "missing"),
    (error: unknown) => (error as { code?: string }).code === "invalid_request",
  );
});

test("hidden models are projected for clients, skipped by defaults, and remain resolvable", async () => {
  const service = new AidenRemoteModelService({
    listProviders: async () => [
      provider({
        models: ["hidden-model", "visible-model"],
        defaultModel: "hidden-model",
        modelMetadata: {
          "hidden-model": { source: "provider", name: "Hidden Model", type: "llm" },
          "visible-model": { source: "provider", name: "Visible Model", type: "llm" },
        },
      }),
    ],
    getSettings: async () => ({
      lastProviderId: "provider-1",
      lastModel: "hidden-model",
      hiddenModelsByProvider: { "provider-1": ["hidden-model"] },
    }),
  });

  const projection = await service.list();
  assert.deepEqual(projection.defaults, {
    providerId: "provider-1",
    modelId: "visible-model",
  });
  assert.deepEqual(projection.providers[0]?.models, [
    { id: "hidden-model", label: "Hidden Model", supportsImages: false, hidden: true },
    { id: "visible-model", label: "Visible Model", supportsImages: false },
  ]);
  assert.deepEqual(await service.resolve("provider-1", "hidden-model"), {
    providerId: "provider-1",
    modelId: "hidden-model",
    thinkingLevels: [],
    supportsImages: false,
  });
});

test("a provider with every model hidden has no remote default", async () => {
  const service = new AidenRemoteModelService({
    listProviders: async () => [provider({ models: ["chat-model"] })],
    getSettings: async () => ({
      hiddenModelsByProvider: { "provider-1": ["chat-model"] },
    }),
  });

  assert.deepEqual((await service.list()).defaults, {});
});

test("remote catalog omits oversized model identities instead of truncating or colliding", async () => {
  const prefix = "x".repeat(256);
  const service = new AidenRemoteModelService({
    listProviders: async () => [provider({ models: [`${prefix}a`, `${prefix}b`, "safe"] })],
    getSettings: async () => ({}),
  });

  assert.deepEqual((await service.list()).providers[0]?.models.map((model) => model.id), ["safe"]);
});

test("remote model projection remains below the generic iOS response ceiling", async () => {
  const models = Array.from({ length: 20_000 }, (_, index) =>
    `model-${index.toString().padStart(5, "0")}-${"x".repeat(120)}`,
  );
  const service = new AidenRemoteModelService({
    listProviders: async () => [provider({ models })],
    getSettings: async () => ({}),
  });

  const projection = await service.list();
  assert.ok(projection.providers[0]!.models.length < models.length);
  assert.ok(Buffer.byteLength(JSON.stringify(projection), "utf8") <= 900 * 1024);
});

test("OpenCode Go projects remotely refreshed Ox Alpha metadata and thinking choices to iOS", async () => {
  const service = new AidenRemoteModelService({
    listProviders: async () => [provider({
      id: "opencode-go",
      label: "OpenCode Go",
      models: ["ox-alpha-free"],
      defaultModel: "ox-alpha-free",
      modelMetadata: {
        "ox-alpha-free": {
          source: "provider",
          name: "Ox Alpha Free (Unlimited)",
          type: "llm",
          reasoning: true,
          thinkingLevels: ["low", "high", "max"],
          thinkingCanDisable: false,
        },
      },
    })],
    getSettings: async () => ({
      providerThinkingByModel: { "opencode-go": { "ox-alpha-free": "max" } },
    }),
  });
  assert.deepEqual((await service.list()).providers[0]?.models, [{
    id: "ox-alpha-free",
    label: "Ox Alpha Free (Unlimited)",
    supportsImages: false,
    thinkingLevels: ["low", "high", "max"],
    defaultThinkingLevel: "max",
    thinkingCanDisable: false,
  }]);
});
