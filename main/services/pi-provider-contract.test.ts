import assert from "node:assert/strict";
import { test } from "node:test";
import { builtinModels, builtinProviders } from "@earendil-works/pi-ai/providers/all";

test("the pinned Pi release exposes native OpenAI Codex OAuth", async () => {
  const providers = builtinProviders();
  const models = builtinModels();
  const provider = models.getProvider("openai-codex");

  const providerIds = providers.map((entry) => entry.id);
  assert.equal(new Set(providerIds).size, providerIds.length);
  assert.equal(providerIds.length, 36);
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
  assert.equal(codexModels.length, 7);
  assert.ok(codexModels.some((model) => model.id === "gpt-5.4"));
  assert.ok(codexModels.every((model) => model.api === "openai-codex-responses"));
  assert.deepEqual(await models.getAvailable("openai-codex"), []);
});
