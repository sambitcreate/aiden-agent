import assert from "node:assert/strict";
import test from "node:test";
import { createModels, type Model } from "@earendil-works/pi-ai";
import {
  CONCENTRATE_BASE_URL,
  concentrateProvider,
  parseConcentrateModels,
  registerAidenBuiltinProviders,
} from "./concentrate-provider.js";

const modelRow = {
  id: "gpt-5.6-terra",
  display_name: "GPT 5.6 Terra",
  max_input_tokens: 1_050_000,
  max_tokens: 128_000,
  capabilities: {
    image_input: { supported: true },
    thinking: { supported: true },
    effort: {
      supported: true,
      low: { supported: true },
      medium: { supported: true },
      high: { supported: true },
      xhigh: { supported: true },
      max: { supported: true },
    },
  },
};

test("Concentrate catalog parsing keeps executable identities and reviewed capabilities", () => {
  const models = parseConcentrateModels({
    data: [
      { ...modelRow, id: "text-only", display_name: "Text only", capabilities: {} },
      modelRow,
      { ...modelRow, display_name: "duplicate is ignored" },
      { ...modelRow, id: "x".repeat(257) },
    ],
  });

  assert.deepEqual(
    models.map((model) => model.id),
    ["gpt-5.6-terra", "text-only"],
  );
  assert.deepEqual(models[0].input, ["text", "image"]);
  assert.equal(models[0].api, "openai-responses");
  assert.equal(models[0].provider, "concentrate");
  assert.equal(models[0].baseUrl, CONCENTRATE_BASE_URL);
  assert.equal(models[0].reasoning, true);
  assert.deepEqual(models[0].thinkingLevelMap, {
    off: null,
    minimal: null,
    low: "low",
    medium: "medium",
    high: "high",
    xhigh: "xhigh",
    max: "max",
  });
  assert.equal(models[0].contextWindow, 1_050_000);
  assert.equal(models[0].maxTokens, 128_000);
  assert.deepEqual(models[0].cost, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
  assert.deepEqual(models[1].input, ["text"]);
  assert.equal(models[1].reasoning, false);
});

test("Concentrate is an Aiden built-in with bounded dynamic refresh and no secret projection", async () => {
  let request: Request | undefined;
  const provider = concentrateProvider(async (input, init) => {
    request = new Request(input, init);
    return Response.json({ data: [modelRow] });
  });
  const writes: Model<"openai-responses">[][] = [];
  await provider.refreshModels?.({
    allowNetwork: true,
    force: true,
    credential: { type: "api_key", key: "sk-cn-test-secret" },
    store: {
      read: async () => undefined,
      write: async (catalog) => {
        writes.push(catalog.models as Model<"openai-responses">[]);
      },
      delete: async () => undefined,
    },
  });

  assert.equal(request?.url, `${CONCENTRATE_BASE_URL}/models`);
  assert.equal(request?.headers.get("authorization"), "Bearer sk-cn-test-secret");
  assert.equal(provider.name, "Concentrate");
  assert.equal(provider.baseUrl, CONCENTRATE_BASE_URL);
  assert.equal(provider.auth.apiKey?.name, "Concentrate API key");
  assert.equal(provider.getModels()[0]?.id, "gpt-5.6-terra");
  assert.equal(JSON.stringify(writes).includes("sk-cn-test-secret"), false);

  const models = registerAidenBuiltinProviders(createModels());
  assert.equal(models.getProvider("concentrate")?.name, "Concentrate");
});

test("Concentrate rejects empty, malformed, and oversized catalogs", async () => {
  assert.throws(() => parseConcentrateModels({ data: [] }), /no usable chat models/u);
  assert.throws(() => parseConcentrateModels({ object: "list" }), /invalid model catalog/u);

  const provider = concentrateProvider(async () =>
    Response.json({ data: [modelRow] }, { headers: { "content-length": "1048577" } }),
  );
  assert.ok(provider.refreshModels);
  await assert.rejects(
    provider.refreshModels({
      allowNetwork: true,
      store: {
        read: async () => undefined,
        write: async () => undefined,
        delete: async () => undefined,
      },
    }),
    /oversized model catalog/u,
  );
});
