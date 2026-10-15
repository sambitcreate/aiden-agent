import assert from "node:assert/strict";
import test from "node:test";
import type { UsageRequestRecord } from "../usage-store-core.js";
import { createWiredImagePort } from "./port-wiring-core.js";
import { fakeImageModels } from "./test-fixture.js";

const NANO = "google/gemini-3.1-flash-image";

function wired() {
  const fake = fakeImageModels();
  const restores: { providerCallsSoFar: number }[] = [];
  const usage: UsageRequestRecord[] = [];
  const port = createWiredImagePort({
    models: fake.models,
    providerLabel: (id) => (id === "openrouter" ? "OpenRouter" : id),
    ready: async () => {
      restores.push({ providerCallsSoFar: fake.calls.length });
    },
    recordUsage: async (record) => {
      usage.push(record);
    },
  });
  return { fake, port, restores, usage };
}

test("listing loads the image registry first and sends nothing to a provider", async () => {
  const { port, restores, fake } = wired();
  assert.equal(restores.length, 0, "nothing is loaded until a listing is requested");
  const models = await port.listModels();
  assert.deepEqual(models.map((model) => model.model), [NANO]);
  assert.equal(restores.length, 1, "the listing loaded the image registry");
  assert.equal(fake.calls.length, 0, "and sent no provider request");
});

test("a request loads the image registry before its synchronous model lookup", async () => {
  const fake = fakeImageModels();
  let loaded = false;
  const port = createWiredImagePort({
    // Like the image registry, lookups see nothing until it has loaded.
    models: {
      getAvailableOfType: (...args) => fake.models.getAvailableOfType(...args),
      getModelOfType: ((type: "image", provider: string, id: string) =>
        loaded ? fake.models.getModelOfType(type, provider, id) : undefined) as typeof fake.models.getModelOfType,
      generateImages: (...args) => fake.models.generateImages(...args),
    },
    providerLabel: (id) => id,
    ready: async () => {
      loaded = true;
    },
    recordUsage: async () => {},
  });
  const result = await port.generate({
    provider: "openrouter",
    model: NANO,
    prompt: "A red bicycle at dawn",
    references: [],
    signal: new AbortController().signal,
  });
  assert.equal(result.kind, "images");
  assert.equal(fake.calls.length, 1);

  const broken = createWiredImagePort({
    models: fake.models,
    providerLabel: (id) => id,
    ready: async () => {
      throw new Error("settings unreadable");
    },
    recordUsage: async () => {},
  });
  const failed = await broken.generate({
    provider: "openrouter",
    model: NANO,
    prompt: "A red bicycle at dawn",
    references: [],
    signal: new AbortController().signal,
  });
  assert.equal(failed.kind, "failed");
  assert.equal(fake.calls.length, 1, "a registry that cannot load sends nothing");
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
