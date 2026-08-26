import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  buildOpenRouterBenchmarkCache,
  openRouterBenchmarkForModel,
  openRouterBenchmarkForModelsDevIdentity,
  parseOpenRouterBenchmarkCache,
  type OpenRouterBenchmarkCache,
} from "./openrouter-benchmark-catalog-core.js";
import {
  fetchOpenRouterBenchmarkCache,
  ModelInsightsError,
  normalizeOpenRouterBenchmarkApiKey,
  OpenRouterBenchmarkRuntime,
} from "./openrouter-benchmark-runtime-core.js";

function responsePayload(
  models: unknown[] = [
    {
      source: "artificial-analysis",
      model_permaslug: "openai/gpt-5.4",
      display_name: "GPT-5.4",
      intelligence_index: 72.1,
      coding_index: 81.4,
      agentic_index: 69.3,
    },
  ],
) {
  return {
    data: models,
    meta: {
      as_of: "2026-06-03T12:00:00.000Z",
      version: "v1",
      source: "artificial-analysis",
      source_url: "https://artificialanalysis.ai",
      citation:
        "Source: Artificial Analysis (artificialanalysis.ai) via OpenRouter (openrouter.ai/rankings).",
      model_count: models.length,
      task_type: null,
    },
  };
}

test("normalizes source-aware OpenRouter benchmarks and matches exact permaslugs only", () => {
  const cache = buildOpenRouterBenchmarkCache(responsePayload(), "2026-06-04T00:00:00.000Z");
  assert.deepEqual(parseOpenRouterBenchmarkCache(cache), cache);
  assert.deepEqual(openRouterBenchmarkForModel(cache, "openai", "gpt-5.4"), {
    source: "openrouter",
    datasetSource: "artificial-analysis",
    sourceLabel: "Artificial Analysis via OpenRouter",
    sourceUrl: "https://artificialanalysis.ai",
    citation:
      "Source: Artificial Analysis (artificialanalysis.ai) via OpenRouter (openrouter.ai/rankings).",
    asOf: "2026-06-03T12:00:00.000Z",
    license: "CC BY 4.0",
    intelligence: 72.1,
    coding: 81.4,
    agentic: 69.3,
  });
  assert.equal(openRouterBenchmarkForModel(cache, "openai", "org/gpt-5.4"), undefined);
  assert.equal(openRouterBenchmarkForModel(cache, "custom-openai", "gpt-5.4"), undefined);
  assert.ok(openRouterBenchmarkForModel(cache, "openrouter", "openai/gpt-5.4"));
  assert.equal(openRouterBenchmarkForModel(cache, "openrouter", "openai/gpt-5.4:free"), undefined);
});

test("rejects unsafe scores, duplicate identities, and invalid citation metadata", () => {
  assert.throws(
    () =>
      buildOpenRouterBenchmarkCache(
        responsePayload([
          {
            source: "artificial-analysis",
            model_permaslug: "openai/gpt",
            display_name: "GPT",
            coding_index: 101,
          },
        ]),
      ),
    /between 0 and 100/u,
  );
  const duplicate = responsePayload([
    {
      source: "artificial-analysis",
      model_permaslug: "openai/gpt",
      display_name: "GPT",
      coding_index: 1,
    },
    {
      source: "artificial-analysis",
      model_permaslug: "OPENAI/GPT",
      display_name: "GPT duplicate",
      coding_index: 2,
    },
  ]);
  assert.throws(() => buildOpenRouterBenchmarkCache(duplicate), /duplicate/u);
  const badCitation = responsePayload() as ReturnType<typeof responsePayload>;
  badCitation.meta.citation = "Unknown source";
  assert.throws(() => buildOpenRouterBenchmarkCache(badCitation), /citation/u);
});

test("fetch sends the dedicated key only to the fixed endpoint and maps auth failures", async () => {
  let observedAuthorization = "";
  const cache = await fetchOpenRouterBenchmarkCache("or-secret", {
    now: () => new Date("2026-06-04T00:00:00.000Z"),
    fetch: async (input, init) => {
      assert.equal(
        String(input),
        "https://openrouter.ai/api/v1/benchmarks?source=artificial-analysis&max_results=100",
      );
      observedAuthorization = new Headers(init?.headers).get("authorization") ?? "";
      assert.equal(init?.redirect, "error");
      return Response.json(responsePayload());
    },
  });
  assert.equal(observedAuthorization, "Bearer or-secret");
  assert.equal(cache.models.length, 1);

  await assert.rejects(
    () =>
      fetchOpenRouterBenchmarkCache("bad", {
        fetch: async () => new Response("", { status: 401 }),
      }),
    (error: unknown) => error instanceof ModelInsightsError && error.code === "invalid_key",
  );
});

test("normalizes Model Pad keys without requiring an inference-provider key shape", () => {
  assert.equal(normalizeOpenRouterBenchmarkApiKey("  sk-or-v1-example  "), "sk-or-v1-example");
  assert.throws(() => normalizeOpenRouterBenchmarkApiKey(""), /Paste an OpenRouter API key/u);
  assert.throws(() => normalizeOpenRouterBenchmarkApiKey("key\nvalue"), /unsupported characters/u);
  assert.throws(() => normalizeOpenRouterBenchmarkApiKey("x".repeat(4_097)), /too long/u);
});

test("models.dev identities normalize publication stamps and reordered vendor IDs", () => {
  const cache = buildOpenRouterBenchmarkCache(
    responsePayload([
      {
        source: "artificial-analysis",
        model_permaslug: "openai/gpt-5.6-sol-20260709",
        display_name: "GPT-5.6 Sol (max)",
        coding_index: 77.4,
      },
      {
        source: "artificial-analysis",
        model_permaslug: "anthropic/claude-4.8-opus-20260528",
        display_name: "Claude Opus 4.8 (Adaptive Reasoning, Max Effort)",
        coding_index: 74.3,
      },
    ]),
  );

  assert.equal(
    openRouterBenchmarkForModelsDevIdentity(cache, {
      author: "openai",
      modelId: "gpt-5.6-sol",
      name: "GPT-5.6 Sol",
    })?.coding,
    77.4,
  );
  assert.equal(
    openRouterBenchmarkForModelsDevIdentity(cache, {
      author: "anthropic",
      modelId: "claude-opus-4-8",
      name: "Claude Opus 4.8",
    })?.coding,
    74.3,
  );
});

test("models.dev normalization rejects ambiguous aliases instead of guessing", () => {
  const cache = buildOpenRouterBenchmarkCache(
    responsePayload([
      {
        source: "artificial-analysis",
        model_permaslug: "deepseek/deepseek-v4-pro-20260423",
        display_name: "DeepSeek V4 Pro (Reasoning, Max Effort)",
        coding_index: 59.4,
      },
      {
        source: "artificial-analysis",
        model_permaslug: "deepseek/deepseek-v4-pro-20260813",
        display_name: "DeepSeek V4 Pro 0813 (Reasoning, Max Effort)",
        coding_index: 68.8,
      },
    ]),
  );

  assert.equal(
    openRouterBenchmarkForModelsDevIdentity(cache, {
      author: "deepseek",
      modelId: "deepseek-v4-pro",
      name: "Unknown catalog name",
    }),
    undefined,
  );
  assert.equal(
    openRouterBenchmarkForModelsDevIdentity(cache, {
      author: "deepseek",
      modelId: "deepseek-v4-pro",
      name: "DeepSeek V4 Pro",
    })?.coding,
    59.4,
  );
});

test("production runtime never reads the OpenRouter inference-provider credential", () => {
  const source = readFileSync(
    new URL("./openrouter-benchmark-runtime.ts", import.meta.url),
    "utf8",
  );
  assert.match(source, /aiden-internal:model-pad-openrouter-benchmarks-v1/u);
  assert.doesNotMatch(source, /piCredentialStore\.read\(["']openrouter["']\)/u);
  assert.doesNotMatch(source, /setProviderKey|providersApi|discover/u);
});

test("runtime keeps the last good cache when refresh fails or the credential changes", async () => {
  let key: string | null = "first";
  let stored: OpenRouterBenchmarkCache | null = buildOpenRouterBenchmarkCache(responsePayload());
  const previous = stored;
  let fail = true;
  const runtime = new OpenRouterBenchmarkRuntime({
    credentials: {
      read: async () => key,
      write: async (next) => {
        key = next;
      },
      deleteKey: async () => {
        key = null;
      },
    },
    cache: {
      read: async () => stored,
      write: async (cache) => {
        stored = cache;
      },
      clear: async () => {
        stored = null;
      },
    },
    fetchCatalog: async () => {
      if (fail) throw new ModelInsightsError("network_error", "offline");
      key = "second";
      return buildOpenRouterBenchmarkCache(responsePayload(), "2026-06-05T00:00:00.000Z");
    },
  });
  await assert.rejects(() => runtime.refresh(), /offline/u);
  assert.equal(stored, previous);
  fail = false;
  await assert.rejects(() => runtime.refresh(), /key changed/u);
  assert.equal(stored, previous);
});

test("connect owns a separate credential lifecycle and publishes cache only after validation", async () => {
  let key: string | null = null;
  let stored: OpenRouterBenchmarkCache | null = null;
  const observedKeys: string[] = [];
  const runtime = new OpenRouterBenchmarkRuntime({
    credentials: {
      read: async () => key,
      write: async (next) => {
        key = next;
      },
      deleteKey: async () => {
        key = null;
      },
    },
    cache: {
      read: async () => stored,
      write: async (next) => {
        stored = next;
      },
      clear: async () => {
        stored = null;
      },
    },
    fetchCatalog: async (candidate) => {
      observedKeys.push(candidate);
      if (candidate === "bad") throw new ModelInsightsError("invalid_key", "rejected");
      return buildOpenRouterBenchmarkCache(responsePayload(), "2026-06-06T00:00:00.000Z");
    },
  });

  await assert.rejects(() => runtime.connect("bad"), /rejected/u);
  assert.equal(key, null);
  assert.equal(stored, null);

  const connected = await runtime.connect("  pad-only-key  ");
  assert.deepEqual(observedKeys, ["bad", "pad-only-key"]);
  assert.equal(key, "pad-only-key");
  assert.equal(connected.hasKey, true);
  assert.equal(connected.ready, true);

  const disconnected = await runtime.disconnect();
  assert.equal(key, null);
  assert.equal(stored, null);
  assert.deepEqual(disconnected, {
    hasKey: false,
    ready: false,
    cachedModelCount: 0,
    fetchedAt: undefined,
    asOf: undefined,
    citation: undefined,
    license: undefined,
  });
});

test("connect restores the previous dedicated key when cache publication fails", async () => {
  let key: string | null = "previous-pad-key";
  const previousCache = buildOpenRouterBenchmarkCache(responsePayload());
  const runtime = new OpenRouterBenchmarkRuntime({
    credentials: {
      read: async () => key,
      write: async (next) => {
        key = next;
      },
      deleteKey: async () => {
        key = null;
      },
    },
    cache: {
      read: async () => previousCache,
      write: async () => {
        throw new Error("disk full");
      },
      clear: async () => undefined,
    },
    fetchCatalog: async () => buildOpenRouterBenchmarkCache(responsePayload()),
  });

  await assert.rejects(() => runtime.connect("replacement-pad-key"), /disk full/u);
  assert.equal(key, "previous-pad-key");
});
