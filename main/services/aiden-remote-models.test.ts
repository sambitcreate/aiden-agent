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
      "chat-model": { source: "provider", name: "Chat Model", type: "llm", thinkingLevels: ["low", "high"] },
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
  assert.deepEqual(projection.providers[0]?.models, [{
    id: "chat-model",
    label: "Chat Model",
    thinkingLevels: ["low", "high"],
  }]);
  const serialized = JSON.stringify(projection);
  assert.equal(serialized.includes("secret-endpoint"), false);
  assert.equal(serialized.includes("authMethods"), false);
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
  });
  await assert.rejects(
    service.resolve("provider-1", "missing"),
    (error: unknown) => (error as { code?: string }).code === "invalid_request",
  );
});
