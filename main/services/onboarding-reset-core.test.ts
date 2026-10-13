import assert from "node:assert/strict";
import test from "node:test";
import { buildOpenRouterBenchmarkCache } from "./openrouter-benchmark-catalog-core.js";
import { OpenRouterBenchmarkRuntime } from "./openrouter-benchmark-runtime-core.js";
import {
  clearEveryCredential,
  deleteEveryCredential,
  OnboardingResetError,
  performOnboardingReset,
  type OnboardingResetOperations,
} from "./onboarding-reset-core.js";

test("credential cleanup attempts every provider after an individual deletion fails", async () => {
  const deleted: string[] = [];
  await assert.rejects(
    deleteEveryCredential(["alpha", "beta", "gamma"], async (providerId) => {
      deleted.push(providerId);
      if (providerId === "beta") throw new Error("locked credential");
    }),
    /not fully cleared/u,
  );
  assert.deepEqual(new Set(deleted), new Set(["alpha", "beta", "gamma"]));
});

test("clearing every credential stops serving benchmarks remembered under a deleted key", async () => {
  const PAD_KEY = "aiden-internal:model-pad-openrouter-benchmarks-v1";
  const store = new Map([
    ["openai", "sk-openai"],
    ["locked", "sk-locked"],
    [PAD_KEY, "pad-key"],
  ]);
  const cache = buildOpenRouterBenchmarkCache({
    data: [
      {
        source: "artificial-analysis",
        model_permaslug: "openai/gpt-example",
        display_name: "GPT Example",
        coding_index: 80,
      },
    ],
    meta: {
      as_of: "2026-06-03T12:00:00.000Z",
      version: "v1",
      source: "artificial-analysis",
      source_url: "https://artificialanalysis.ai",
      citation: "Source: Artificial Analysis via OpenRouter.",
      model_count: 1,
    },
  });
  const benchmarks = new OpenRouterBenchmarkRuntime({
    credentials: {
      read: async () => store.get(PAD_KEY) ?? null,
      write: async (key) => {
        store.set(PAD_KEY, key);
      },
      deleteKey: async () => {
        store.delete(PAD_KEY);
      },
    },
    cache: { read: async () => cache, write: async () => undefined, clear: async () => undefined },
    fetchCatalog: async () => cache,
  });
  assert.equal(await benchmarks.catalog(), cache);

  // One provider's deletion fails; the pass still deletes the rest and forgets them.
  await assert.rejects(
    clearEveryCredential(
      [...store.keys()],
      async (providerId) => {
        if (providerId === "locked") throw new Error("locked credential");
        store.delete(providerId);
      },
      () => benchmarks.invalidate(),
    ),
    /not fully cleared/u,
  );
  assert.deepEqual([...store.keys()], ["locked"]);
  assert.equal(await benchmarks.catalog(), null);
});

function operations(
  events: string[],
  failures: Partial<Record<keyof OnboardingResetOperations, Error>> = {},
): OnboardingResetOperations {
  const run = async (name: keyof OnboardingResetOperations): Promise<void> => {
    events.push(name);
    const failure = failures[name];
    if (failure) throw failure;
  };
  return {
    disconnectArtificialAnalysis: () => run("disconnectArtificialAnalysis"),
    clearModelInsights: () => run("clearModelInsights"),
    clearModelPace: () => run("clearModelPace"),
    resetConfiguration: () => run("resetConfiguration"),
    clearLegacySecrets: () => run("clearLegacySecrets"),
    clearPiCredentials: () => run("clearPiCredentials"),
    clearMcpOAuth: () => run("clearMcpOAuth"),
  };
}

test("reset disconnects model data before clearing every setup-owned store", async () => {
  const events: string[] = [];

  await performOnboardingReset(operations(events));

  assert.deepEqual(
    new Set(events.slice(0, 3)),
    new Set(["disconnectArtificialAnalysis", "clearModelInsights", "clearModelPace"]),
  );
  assert.deepEqual(
    new Set(events.slice(3)),
    new Set(["resetConfiguration", "clearLegacySecrets", "clearPiCredentials", "clearMcpOAuth"]),
  );
});

test("reset attempts every cleanup and returns a retryable aggregate failure", async () => {
  const events: string[] = [];
  const credentialFailure = new Error("credential sentinel");
  const oauthFailure = new Error("oauth sentinel");

  await assert.rejects(
    performOnboardingReset(
      operations(events, {
        clearPiCredentials: credentialFailure,
        clearMcpOAuth: oauthFailure,
      }),
    ),
    (error: unknown) => {
      assert.ok(error instanceof OnboardingResetError);
      assert.match(error.message, /Retry Reset onboarding/u);
      assert.doesNotMatch(error.message, /sentinel/u);
      assert.deepEqual(error.failures, [credentialFailure, oauthFailure]);
      return true;
    },
  );

  assert.deepEqual(
    new Set(events),
    new Set([
      "disconnectArtificialAnalysis",
      "clearModelInsights",
      "clearModelPace",
      "resetConfiguration",
      "clearLegacySecrets",
      "clearPiCredentials",
      "clearMcpOAuth",
    ]),
  );
});
