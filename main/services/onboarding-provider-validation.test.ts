import assert from "node:assert/strict";
import test from "node:test";
import {
  normalizeOnboardingValidationProvider,
  validateOnboardingProviderCredential,
} from "./onboarding-provider-validation.js";
import type { StoredProvider } from "./types.js";

const provider: StoredProvider = {
  id: "openai",
  kind: "openai",
  label: "OpenAI",
  baseUrl: "https://api.openai.com/v1",
  models: ["model-a", "model-b"],
  needsKey: true,
};

test("Anthropic onboarding validation uses the versioned models endpoint", () => {
  assert.equal(
    normalizeOnboardingValidationProvider({
      ...provider,
      id: "anthropic",
      kind: "anthropic",
      baseUrl: "https://api.anthropic.com",
    }).baseUrl,
    "https://api.anthropic.com/v1",
  );
  assert.equal(
    normalizeOnboardingValidationProvider({
      ...provider,
      id: "anthropic",
      kind: "anthropic",
      baseUrl: "https://gateway.example/anthropic",
    }).baseUrl,
    "https://gateway.example/anthropic",
  );
});

test("onboarding validation commits only after the catalog proves a supported model", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ data: [{ id: "model-b" }, { id: "unknown-model" }] }), {
      status: 200,
    })) as typeof fetch;
  const committed: string[] = [];

  const usable = await validateOnboardingProviderCredential({
    provider,
    apiKey: "validated-key",
    installedModelIds: provider.models,
    isCurrent: () => true,
    commit: async (apiKey) => {
      committed.push(apiKey);
    },
  });

  assert.deepEqual(usable, ["model-b", "unknown-model"]);
  assert.deepEqual(committed, ["validated-key"]);
});

test("failed, unsupported, or stale validation never reaches the credential commit", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  let writes = 0;
  const validate = (isCurrent = () => true) =>
    validateOnboardingProviderCredential({
      provider,
      apiKey: "candidate-key",
      installedModelIds: provider.models,
      isCurrent,
      commit: async () => {
        writes += 1;
      },
    });

  globalThis.fetch = (async () => new Response("unauthorized", { status: 401 })) as typeof fetch;
  await assert.rejects(validate(), /rejected those credentials/u);

  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ data: [{ id: "unsupported-model" }] }), {
      status: 200,
    })) as typeof fetch;
  await assert.rejects(validate(), /no supported chat models/u);

  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ data: [{ id: "model-a" }] }), { status: 200 })) as typeof fetch;
  await assert.rejects(validate(() => false), /no longer active/u);
  assert.equal(writes, 0);
});
