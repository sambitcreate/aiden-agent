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

test("rejects unsafe scores and invalid citation metadata", () => {
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
  const badCitation = responsePayload() as ReturnType<typeof responsePayload>;
  badCitation.meta.citation = "Unknown source";
  assert.throws(() => buildOpenRouterBenchmarkCache(badCitation), /citation/u);
});

function benchmarkRow(permaslug: string, displayName: string, coding: number) {
  return {
    source: "artificial-analysis",
    model_permaslug: permaslug,
    display_name: displayName,
    coding_index: coding,
  };
}

function runtimeWith(fetched: OpenRouterBenchmarkCache, initial: OpenRouterBenchmarkCache | null) {
  let key: string | null = initial ? "pad-key" : null;
  let stored = initial;
  return new OpenRouterBenchmarkRuntime({
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
        stored = parseOpenRouterBenchmarkCache(JSON.parse(JSON.stringify(next)));
      },
      clear: async () => {
        stored = null;
      },
    },
    fetchCatalog: async () => fetched,
  });
}

test("drops rows that share a permaslug, keeps the rest, and reports how many were skipped", async () => {
  const cache = buildOpenRouterBenchmarkCache(
    responsePayload([
      benchmarkRow("anthropic/claude-sonnet-4.5", "Claude Sonnet 4.5 (Reasoning)", 61),
      benchmarkRow("openai/gpt-5.4", "GPT-5.4", 81.4),
      benchmarkRow("Anthropic/Claude-Sonnet-4.5", "Claude Sonnet 4.5 (Non-reasoning)", 49),
    ]),
  );
  assert.deepEqual(
    cache.models.map((model) => model.modelPermaslug),
    ["openai/gpt-5.4"],
  );
  assert.equal(cache.source.skippedAmbiguous, 2);
  assert.equal(openRouterBenchmarkForModel(cache, "anthropic", "claude-sonnet-4.5"), undefined);
  assert.equal(openRouterBenchmarkForModel(cache, "openai", "gpt-5.4")?.coding, 81.4);
  assert.deepEqual(parseOpenRouterBenchmarkCache(JSON.parse(JSON.stringify(cache))), cache);

  const runtime = runtimeWith(cache, null);
  const connected = await runtime.connect("pad-key");
  assert.equal(connected.cachedModelCount, 1);
  assert.equal(connected.skippedAmbiguousCount, 2);
  assert.equal((await runtime.status()).skippedAmbiguousCount, 2);
  assert.equal((await runtime.disconnect()).skippedAmbiguousCount, 0);
});

test("a response whose rows are all ambiguous is still rejected", () => {
  assert.throws(
    () =>
      buildOpenRouterBenchmarkCache(
        responsePayload([
          benchmarkRow("openai/gpt", "GPT", 1),
          benchmarkRow("OPENAI/GPT", "GPT duplicate", 2),
        ]),
      ),
    /between 1 and 500/u,
  );
});

function rows(count: number) {
  return Array.from({ length: count }, (_, index) =>
    benchmarkRow(`vendor/model-${index}`, `Model ${index}`, index % 100),
  );
}

test("accepts every row up to the 500-row cap and rejects a 501-row response", () => {
  for (const count of [101, 500]) {
    const cache = buildOpenRouterBenchmarkCache(responsePayload(rows(count)));
    assert.equal(cache.models.length, count);
    assert.equal(parseOpenRouterBenchmarkCache(JSON.parse(JSON.stringify(cache))).models.length, count);
  }
  assert.throws(
    () => buildOpenRouterBenchmarkCache(responsePayload(rows(501))),
    /between 1 and 500/u,
  );
});

test("a stored cache with duplicate permaslugs is rejected instead of pruned", () => {
  const cache = buildOpenRouterBenchmarkCache(
    responsePayload([
      benchmarkRow("openai/gpt-5.4", "GPT-5.4", 81.4),
      benchmarkRow("anthropic/claude-sonnet-4.5", "Claude Sonnet 4.5", 61),
    ]),
  );
  const tampered = JSON.parse(JSON.stringify(cache)) as { models: Array<Record<string, unknown>> };
  tampered.models[1].modelPermaslug = "OpenAI/GPT-5.4";
  assert.throws(() => parseOpenRouterBenchmarkCache(tampered), /duplicate/u);
});

test("a stored cache with an invalid skipped-row count is rejected", () => {
  const cache = buildOpenRouterBenchmarkCache(responsePayload());
  for (const skippedAmbiguous of [-1, 1.5, "2", null]) {
    const stored = JSON.parse(JSON.stringify(cache)) as { source: Record<string, unknown> };
    stored.source.skippedAmbiguous = skippedAmbiguous;
    assert.throws(() => parseOpenRouterBenchmarkCache(stored), /skipped-row count/u);
  }
});

test("model_count counts unique models, so a duplicate group plus an unrelated row is accepted", () => {
  const payload = responsePayload([
    benchmarkRow("openai/gpt", "GPT", 1),
    benchmarkRow("OPENAI/GPT", "GPT duplicate", 2),
    benchmarkRow("openai/gpt-5.4", "GPT-5.4", 81.4),
  ]);
  // OpenRouter documents model_count as the number of unique models in the response.
  payload.meta.model_count = 2;
  const cache = buildOpenRouterBenchmarkCache(payload);
  assert.deepEqual(
    cache.models.map((model) => model.modelPermaslug),
    ["openai/gpt-5.4"],
  );
  assert.equal(cache.source.skippedAmbiguous, 2);
  assert.equal(openRouterBenchmarkForModel(cache, "openai", "gpt"), undefined);
  assert.equal(openRouterBenchmarkForModel(cache, "openai", "gpt-5.4")?.coding, 81.4);

  payload.meta.model_count = 1;
  assert.throws(() => buildOpenRouterBenchmarkCache(payload), /model count/u);
});

test("a cache stored before skipped rows were recorded reports none skipped", async () => {
  const current = buildOpenRouterBenchmarkCache(responsePayload());
  const legacy = JSON.parse(JSON.stringify(current)) as {
    source: Record<string, unknown>;
  };
  delete legacy.source.skippedAmbiguous;
  const parsed = parseOpenRouterBenchmarkCache(legacy);
  assert.equal(parsed.source.skippedAmbiguous, 0);
  const status = await runtimeWith(parsed, parsed).status();
  assert.equal(status.ready, true);
  assert.equal(status.skippedAmbiguousCount, 0);
});

test("reasoning variants keep separate identities when matching models.dev rows", () => {
  const cache = buildOpenRouterBenchmarkCache(
    responsePayload([
      benchmarkRow("anthropic/claude-4.5-sonnet-reasoning", "Claude Sonnet 4.5 (Reasoning)", 61),
      benchmarkRow("anthropic/claude-4.5-sonnet", "Claude Sonnet 4.5 (Non-reasoning)", 49),
      benchmarkRow("x-ai/grok-4", "Grok 4", 55),
      benchmarkRow("x-ai/grok-4-thinking-variant", "Grok 4 Thinking", 66),
    ]),
  );
  const coding = (identity: {
    author?: string;
    modelId: string;
    name: string;
    reasoning?: boolean;
  }) => openRouterBenchmarkForModelsDevIdentity(cache, identity)?.coding;

  // No base row: the models.dev reasoning flag picks the variant.
  const sonnet = { author: "anthropic", modelId: "claude-sonnet-4-5", name: "Claude Sonnet 4.5" };
  assert.equal(coding({ ...sonnet, reasoning: true }), 61);
  assert.equal(coding({ ...sonnet, reasoning: false }), 49);
  assert.equal(coding(sonnet), undefined);
  // An explicit variant in the name or ID wins over the flag.
  assert.equal(coding({ ...sonnet, name: "Claude Sonnet 4.5 (Thinking)", reasoning: false }), 61);
  assert.equal(coding({ ...sonnet, modelId: "claude-sonnet-4-5-thinking", reasoning: false }), 61);
  assert.equal(
    coding({ ...sonnet, modelId: "claude-sonnet-4-5-no-thinking", reasoning: true }),
    49,
  );
  assert.equal(coding({ ...sonnet, name: "Claude Sonnet 4.5 Non-Reasoning" }), 49);
  // A base row exists, so an unmarked model takes it whatever its flag says.
  const grok = { author: "x-ai", modelId: "grok-4-0709", name: "Grok 4" };
  assert.equal(coding({ ...grok, reasoning: true }), 55);
  assert.equal(coding({ ...grok, modelId: "grok-4-thinking" }), 66);
  // There is no non-reasoning Grok row, and conflicting markers never guess.
  assert.equal(coding({ ...grok, name: "Grok 4 (Non-reasoning)" }), undefined);
  assert.equal(
    coding({ ...sonnet, name: "Claude Sonnet 4.5 (Reasoning)", modelId: "x-no-thinking" }),
    undefined,
  );
});

test("variant matching still fails closed when several rows share an identity", () => {
  const cache = buildOpenRouterBenchmarkCache(
    responsePayload([
      benchmarkRow("anthropic/claude-a", "Claude Sonnet 4.5 (Reasoning)", 61),
      benchmarkRow("anthropic/claude-b", "Claude Sonnet 4.5 (Thinking)", 62),
      benchmarkRow("anthropic/claude-c", "Claude Haiku 4.5", 40),
      benchmarkRow("anthropic/claude-d", "Claude Haiku 4.5 (max)", 41),
      benchmarkRow("anthropic/claude-e", "Claude Haiku 4.5 (Reasoning)", 42),
    ]),
  );
  const coding = (name: string, reasoning?: boolean) =>
    openRouterBenchmarkForModelsDevIdentity(cache, {
      author: "anthropic",
      modelId: "unmatched",
      name,
      ...(reasoning === undefined ? {} : { reasoning }),
    })?.coding;
  assert.equal(coding("Claude Sonnet 4.5", true), undefined);
  assert.equal(coding("Claude Sonnet 4.5 (Reasoning)"), undefined);
  // Two base rows are ambiguous; the flag does not fall through to the variant row.
  assert.equal(coding("Claude Haiku 4.5", true), undefined);
  assert.equal(coding("Claude Haiku 4.5 (Reasoning)"), 42);
});

test("accepts a capped benchmark response when model_count reports a larger total", () => {
  const capped = responsePayload();
  capped.meta.model_count = 250;
  capped.meta.source_url = "https://artificialanalysis.ai/benchmarks";
  capped.meta.citation = "ARTIFICIAL ANALYSIS data delivered through OPENROUTER.";

  assert.equal(buildOpenRouterBenchmarkCache(capped).models.length, 1);

  const undercounted = responsePayload([
    responsePayload().data[0],
    {
      source: "artificial-analysis",
      model_permaslug: "anthropic/claude-sonnet-4",
      display_name: "Claude Sonnet 4",
      coding_index: 70,
    },
  ]);
  undercounted.meta.model_count = 1;
  assert.throws(() => buildOpenRouterBenchmarkCache(undercounted), /model count/u);

  const fractional = responsePayload();
  fractional.meta.model_count = 1.5;
  assert.throws(() => buildOpenRouterBenchmarkCache(fractional), /model count/u);
});

test("fetch sends the dedicated key only to the fixed endpoint and maps auth failures", async () => {
  let observedAuthorization = "";
  const cache = await fetchOpenRouterBenchmarkCache("or-secret", {
    now: () => new Date("2026-06-04T00:00:00.000Z"),
    fetch: async (input, init) => {
      assert.equal(
        String(input),
        "https://openrouter.ai/api/v1/benchmarks?source=artificial-analysis&max_results=500",
      );
      observedAuthorization = new Headers(init?.headers).get("authorization") ?? "";
      assert.equal(init?.redirect, "error");
      return Response.json(responsePayload());
    },
  });
  assert.equal(observedAuthorization, "Bearer or-secret");
  assert.equal(cache.models.length, 1);

  // A full 500-row response with the API's extra fields fits the default response size limit.
  const full = responsePayload(
    rows(500).map((row, index) => ({
      ...row,
      model_permaslug: `vendor/some-fairly-long-model-name-${index}-instruct-preview-20260101`,
      display_name: `Some Fairly Long Model Name ${index} Instruct Preview (Reasoning, Max Effort)`,
      intelligence_index: 72.123456,
      agentic_index: 69.333333,
      pricing: {
        prompt: "0.00000125",
        completion: "0.00001",
        request: "0",
        image: "0",
        web_search: "0",
        internal_reasoning: "0",
        input_cache_read: "0.000000125",
        input_cache_write: "0.0000015625",
      },
    })),
  );
  const fullCache = await fetchOpenRouterBenchmarkCache("or-secret", {
    fetch: async () => new Response(JSON.stringify(full, null, 2)),
  });
  assert.equal(fullCache.models.length, 500);

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
      reasoning: true,
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
      reasoning: true,
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
    skippedAmbiguousCount: 0,
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

test("catalog reads keep the credential state in memory until a lifecycle action changes it", async () => {
  let key: string | null = "pad-key";
  let stored: OpenRouterBenchmarkCache | null = buildOpenRouterBenchmarkCache(responsePayload());
  let credentialReads = 0;
  let cacheReads = 0;
  const fetched = buildOpenRouterBenchmarkCache(responsePayload(), "2026-06-07T00:00:00.000Z");
  const runtime = new OpenRouterBenchmarkRuntime({
    credentials: {
      read: async () => {
        credentialReads += 1;
        return key;
      },
      write: async (next) => {
        key = next;
      },
      deleteKey: async () => {
        key = null;
      },
    },
    cache: {
      read: async () => {
        cacheReads += 1;
        return stored;
      },
      write: async (next) => {
        stored = next;
      },
      clear: async () => {
        stored = null;
      },
    },
    fetchCatalog: async () => fetched,
  });

  const initial = stored;
  for (let index = 0; index < 5; index += 1) {
    assert.equal(await runtime.catalog(), initial);
  }
  assert.equal(credentialReads, 1);
  assert.equal(cacheReads, 1);

  await runtime.disconnect();
  credentialReads = 0;
  cacheReads = 0;
  for (let index = 0; index < 3; index += 1) {
    assert.equal(await runtime.catalog(), null);
  }
  assert.equal(credentialReads, 1);
  assert.equal(cacheReads, 0);

  await runtime.connect("replacement-key");
  credentialReads = 0;
  for (let index = 0; index < 3; index += 1) {
    assert.equal(await runtime.catalog(), fetched);
  }
  assert.equal(credentialReads, 1);

  await runtime.refresh();
  credentialReads = 0;
  cacheReads = 0;
  assert.equal(await runtime.catalog(), fetched);
  assert.equal(await runtime.catalog(), fetched);
  assert.equal(credentialReads, 1);
  assert.equal(cacheReads, 1);
});

test("invalidate makes catalog re-read a credential deleted outside the runtime", async () => {
  let key: string | null = "pad-key";
  const cache = buildOpenRouterBenchmarkCache(responsePayload());
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
    cache: { read: async () => cache, write: async () => undefined, clear: async () => undefined },
    fetchCatalog: async () => cache,
  });

  assert.equal(await runtime.catalog(), cache);
  // A credential store pass (such as onboarding reset) deletes the key directly.
  key = null;
  assert.equal(await runtime.catalog(), cache, "the remembered catalog is still served");
  await runtime.invalidate();
  assert.equal(await runtime.catalog(), null);
});

test("catalog does not remember a credential read that failed", async () => {
  let failing = true;
  let credentialReads = 0;
  const cache = buildOpenRouterBenchmarkCache(responsePayload());
  const runtime = new OpenRouterBenchmarkRuntime({
    credentials: {
      read: async () => {
        credentialReads += 1;
        if (failing) throw new Error("keychain locked");
        return "pad-key";
      },
      write: async () => undefined,
      deleteKey: async () => undefined,
    },
    cache: { read: async () => cache, write: async () => undefined, clear: async () => undefined },
    fetchCatalog: async () => cache,
  });

  await assert.rejects(() => runtime.catalog(), /keychain locked/u);
  failing = false;
  assert.equal(await runtime.catalog(), cache);
  assert.equal(await runtime.catalog(), cache);
  assert.equal(credentialReads, 2);
});

test("models.dev name fallback scopes ambiguity to the requested author", () => {
  const cache = buildOpenRouterBenchmarkCache(
    responsePayload([
      {
        source: "artificial-analysis",
        model_permaslug: "alpha/shared-20260101",
        display_name: "Shared Model (max)",
        coding_index: 11,
      },
      {
        source: "artificial-analysis",
        model_permaslug: "beta/other-20260101",
        display_name: "Shared Model",
        coding_index: 22,
      },
    ]),
  );
  const coding = (identity: { author?: string; modelId: string; name: string }) =>
    openRouterBenchmarkForModelsDevIdentity(cache, identity)?.coding;
  const shared = { modelId: "unmatched-id", name: "Shared Model" };
  assert.equal(coding({ ...shared, author: "beta" }), 22);
  assert.equal(coding({ ...shared, author: "alpha" }), 11);
  assert.equal(coding(shared), undefined);
  assert.equal(coding({ author: "BETA", modelId: "Beta/OTHER-20260101", name: "x" }), 22);
});
