import assert from "node:assert/strict";
import { test } from "node:test";
import { builtinModels, builtinProviders } from "@earendil-works/pi-ai/providers/all";
import { createInitialSystemMessage, normalizeContext, Type } from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";

test("the pinned Pi release exposes native OpenAI Codex OAuth", async () => {
  const providers = builtinProviders();
  const models = builtinModels();
  const provider = models.getProvider("openai-codex");

  const providerIds = providers.map((entry) => entry.id);
  assert.equal(new Set(providerIds).size, providerIds.length);
  assert.equal(providerIds.length, 41);
  assert.ok(providerIds.includes("radius"));
  assert.deepEqual(
    providers.filter(
      (entry) =>
        typeof entry.auth.apiKey?.login !== "function" &&
        typeof entry.auth.oauth?.login !== "function",
    ).map((entry) => entry.id),
    [],
    "Every pinned built-in must retain an explicit stored-auth setup path for Bots.",
  );
  assert.deepEqual(
    models.getProviders().map((entry) => entry.id),
    providerIds,
  );
  assert.equal(provider?.id, "openai-codex");
  assert.equal(provider?.name, "OpenAI Codex");
  assert.equal(provider?.baseUrl, "https://chatgpt.com/backend-api");
  assert.equal(provider?.auth.oauth?.name, "OpenAI (ChatGPT Plus/Pro)");
  assert.equal(typeof provider?.auth.oauth?.login, "function");
  assert.equal(typeof provider?.auth.oauth?.refresh, "function");
  assert.deepEqual(
    await provider?.auth.oauth?.toAuth({
      type: "oauth",
      access: "lazy-load-smoke",
      refresh: "refresh-test",
      expires: 2_000_000_000_000,
    }),
    { apiKey: "lazy-load-smoke" },
  );

  const codexModels = models.getModels("openai-codex");
  assert.equal(codexModels.length, 8);
  assert.ok(codexModels.some((model) => model.id === "gpt-5.5"));
  assert.ok(codexModels.every((model) => model.api === "openai-codex-responses"));
  assert.deepEqual(await models.getAvailable("openai-codex"), []);
});

test("pinned provider streams serialize transcript prompts for thinking and GPT Responses", async () => {
  const models = builtinModels();
  const providers = builtinProviders();
  const system = createInitialSystemMessage("Follow the host policy", [{
    name: "fixture_read", description: "Read fixture", parameters: Type.Object({}),
  }]);
  assert.ok(system);
  const context = normalizeContext({ messages: [system, { role: "user", content: "Hello", timestamp: 1 }] });
  for (const [providerId, modelId, api] of [
    ["anthropic", "claude-opus-5-5", "anthropic-messages"],
    ["openai", "gpt-6-sol", "openai-responses"],
    ["github-copilot", "gpt-6-sol", "openai-responses"],
  ] as const) {
    const model = models.getModel(providerId, modelId);
    const provider = providers.find((candidate) => candidate.id === providerId);
    assert.ok(model && provider, `${providerId} catalog fixture`);
    assert.equal(model.api, api);
    let payload: unknown;
    const captured = new Error("captured before network");
    await provider.streamSimple(model, context, {
      apiKey: "offline-fixture",
      reasoning: "high",
      onPayload: (request) => { payload = request; throw captured; },
      fetch: async () => { throw new Error("Provider smoke attempted network I/O."); },
    }).result();
    assert.ok(payload && typeof payload === "object", `${providerId} built a request`);
    assert.match(JSON.stringify(payload), /Follow the host policy/u);
    assert.match(JSON.stringify(payload), /fixture_read/u);
  }
});

test("unknown local OpenAI-compatible endpoints omit strict tool mode by default", async () => {
  const template = builtinModels().getModel("openai", "gpt-6-sol");
  assert.ok(template);
  const model = { ...template, provider: "custom:local", api: "openai-completions" as const,
    baseUrl: "http://127.0.0.1:1234/v1", compat: undefined };
  const system = createInitialSystemMessage("Local host policy", [{
    name: "fixture_read", description: "Read fixture", parameters: Type.Object({}),
  }]);
  assert.ok(system);
  let payload: unknown;
  await openAICompletionsApi().streamSimple(model, normalizeContext({
    messages: [system, { role: "user", content: "Hello", timestamp: 1 }],
  }), {
    apiKey: "offline-fixture",
    onPayload: (request) => { payload = request; throw new Error("captured before network"); },
    fetch: async () => { throw new Error("Local provider smoke attempted network I/O."); },
  }).result();
  const tools = (payload as { tools?: Array<{ function?: { strict?: unknown } }> } | undefined)?.tools;
  assert.equal(tools?.length, 1);
  assert.equal(tools?.[0]?.function?.strict, undefined);
});
