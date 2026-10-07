import assert from "node:assert/strict";
import test from "node:test";
import type { StoredProvider } from "../types.js";
import type { UsageRequestRecord } from "../usage-store-core.js";
import { createWiredImagePort } from "./port-wiring-core.js";
import { fakeImageModels } from "./test-fixture.js";

const NANO = "google/gemini-3.1-flash-image";

function wired(providers: readonly StoredProvider[] = []) {
  const fake = fakeImageModels();
  const restores: { providerCallsSoFar: number }[] = [];
  const usage: UsageRequestRecord[] = [];
  const port = createWiredImagePort({
    models: fake.models,
    providerLabel: (id) => (id === "openrouter" ? "OpenRouter" : id),
    restoreOfflineCatalogs: async () => {
      restores.push({ providerCallsSoFar: fake.calls.length });
    },
    listStoredProviders: async () => providers,
    recordUsage: async (record) => {
      usage.push(record);
    },
  });
  return { fake, port, restores, usage };
}

test("listing restores the offline catalogs first and sends nothing to a provider", async () => {
  const { port, restores, fake } = wired();
  assert.equal(restores.length, 0, "nothing is restored until a listing is requested");
  const models = await port.listModels();
  assert.deepEqual(models.map((model) => model.model), [NANO]);
  assert.equal(restores.length, 1, "the listing restored the offline catalogs");
  assert.equal(fake.calls.length, 0, "and sent no provider request");
});

test("a request is accounted once under the create-images source with the provider's reported cost", async () => {
  const { port, usage, fake } = wired();
  const result = await port.generate({
    provider: "openrouter",
    model: NANO,
    prompt: "A red bicycle at dawn",
    references: [],
    signal: new AbortController().signal,
  });
  assert.equal(result.kind, "images");
  assert.equal(fake.calls.length, 1);
  assert.equal(usage.length, 1);
  const [record] = usage;
  assert.deepEqual(
    [record?.source, record?.providerId, record?.modelId, record?.status, record?.costStatus, record?.costUsd, record?.local],
    ["create-images", "openrouter", NANO, "completed", "reported", 0.039, false],
  );
});
