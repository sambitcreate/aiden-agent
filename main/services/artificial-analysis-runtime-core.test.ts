import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { gzipSync } from "node:zlib";
import {
  ARTIFICIAL_ANALYSIS_FREE_ENDPOINT,
  ArtificialAnalysisFetchError,
  ArtificialAnalysisRuntime,
  artificialAnalysisPercentiles,
  buildArtificialAnalysisUserCache,
  fetchArtificialAnalysisUserCache,
  normalizeArtificialAnalysisApiKey,
  type ArtificialAnalysisCacheStore,
  type ArtificialAnalysisCredentialStore,
  type ArtificialAnalysisStoredCredential,
} from "./artificial-analysis-runtime-core.js";
import type { ArtificialAnalysisUserCache } from "./artificial-analysis-catalog-core.js";

function rawModel(
  id: string,
  intelligence: number | null,
  responseTime: number | null,
  creator = "Example",
) {
  return {
    id,
    slug: id,
    name: id,
    release_date: "2026-07-01",
    model_creator: { id: `creator-${creator}`, name: creator },
    evaluations: {
      artificial_analysis_intelligence_index: intelligence,
      artificial_analysis_coding_index: intelligence === null ? null : intelligence - 1,
      artificial_analysis_agentic_index: intelligence === null ? null : intelligence - 2,
    },
    performance: {
      median_output_tokens_per_second: responseTime === null ? null : 100,
      median_time_to_first_token_seconds: responseTime === null ? null : 0.5,
      median_end_to_end_response_time_seconds: responseTime,
    },
  };
}

function page(
  pageNumber: number,
  totalPages: number,
  data: unknown[],
  tier: "free" | "pro" | "commercial" = "free",
) {
  return {
    tier,
    intelligence_index_version: 4.1,
    pagination: {
      page: pageNumber,
      page_size: 200,
      total_pages: totalPages,
      has_more: pageNumber < totalPages,
    },
    data,
  };
}

function catalog(
  id = "model-a",
  generation = `generation-${id.replace(/[^a-z0-9-]/giu, "-")}`,
): ArtificialAnalysisUserCache {
  return buildArtificialAnalysisUserCache(
    [page(1, 1, [rawModel(id, 50, 5)])],
    "2026-07-22T18:00:00.000Z",
    generation,
  );
}

test("normalizes the Free endpoint into stable capability and response-time percentiles", () => {
  const result = buildArtificialAnalysisUserCache(
    [
      page(1, 2, [rawModel("fast", 20, 2), rawModel("tied-a", 70, 8)]),
      page(2, 2, [rawModel("tied-b", 70, 8), rawModel("slow", 90, 12)]),
    ],
    "2026-07-22T18:00:00.000Z",
  );

  assert.equal(result.source.tier, "free");
  assert.equal(result.source.intelligence_index_version, 4.1);
  assert.equal(result.models.length, 4);
  const fast = result.models.find((model) => model.id === "fast")!;
  const tiedA = result.models.find((model) => model.id === "tied-a")!;
  const tiedB = result.models.find((model) => model.id === "tied-b")!;
  const slow = result.models.find((model) => model.id === "slow")!;
  assert.equal(fast.ranking?.capability_percentile, 0);
  assert.equal(fast.ranking?.response_time_percentile, 0);
  assert.equal(tiedA.ranking?.capability_percentile, 0.5);
  assert.equal(tiedB.ranking?.capability_percentile, 0.5);
  assert.equal(slow.ranking?.capability_percentile, 1);
  assert.equal(slow.ranking?.response_time_percentile, 1);
});

test("percentiles ignore missing values and place a single measured value in the middle", () => {
  const cache = catalog();
  const models = [
    ...cache.models,
    { ...cache.models[0], id: "missing", intelligence_index: undefined },
  ];
  const result = artificialAnalysisPercentiles(models, (model) => model.intelligence_index);
  assert.equal(result.get("model-a"), 0.5);
  assert.equal(result.has("missing"), false);
});

test("normalizes contract-valid models with a null creator without rejecting the catalog", () => {
  const model = rawModel("creator-unknown", 40, 4);
  const result = buildArtificialAnalysisUserCache(
    [page(1, 1, [{ ...model, model_creator: null }])],
    "2026-07-22T18:00:00.000Z",
    "generation-null-creator",
  );
  assert.equal(result.models[0].creator, "Unknown");
  assert.ok(result.models[0].ranking);
});

test("accepts pagination beyond twenty pages within the OpenAPI and safety limits", () => {
  const pages = Array.from({ length: 21 }, (_, index) =>
    page(index + 1, 21, [rawModel(`model-${index + 1}`, index + 1, index + 1)]),
  );
  const result = buildArtificialAnalysisUserCache(
    pages,
    "2026-07-22T18:00:00.000Z",
    "generation-twenty-one-pages",
  );
  assert.equal(result.models.length, 21);
});

test("rejects inconsistent pages, duplicates, and responses without usable rankings", () => {
  assert.throws(
    () =>
      buildArtificialAnalysisUserCache(
        [
          page(1, 2, [rawModel("one", 1, 1)]),
          {
            ...page(2, 2, [rawModel("two", 2, 2)]),
            pagination: {
              ...page(2, 2, []).pagination,
              page_size: 100,
            },
          },
        ],
        "2026-07-22T18:00:00.000Z",
      ),
    /inconsistent pagination/u,
  );
  assert.throws(
    () =>
      buildArtificialAnalysisUserCache(
        [page(1, 2, [rawModel("one", 1, 1)])],
        "2026-07-22T18:00:00.000Z",
      ),
    /incomplete model data/u,
  );
  assert.throws(
    () =>
      buildArtificialAnalysisUserCache(
        [page(1, 1, [rawModel("same", 1, 1), rawModel("same", 2, 2)])],
        "2026-07-22T18:00:00.000Z",
      ),
    /duplicate model identifiers/u,
  );
  assert.throws(
    () =>
      buildArtificialAnalysisUserCache(
        [page(1, 1, [rawModel("unmeasured", null, null)])],
        "2026-07-22T18:00:00.000Z",
      ),
    /no usable benchmark rankings/u,
  );
});

test("fetches every page only from the fixed Free endpoint without placing the key in the URL", async () => {
  const secret = "aa-secret-value";
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  const fetched = await fetchArtificialAnalysisUserCache(secret, {
    now: () => new Date("2026-07-22T18:00:00.000Z"),
    fetch: async (input, init) => {
      const url = String(input);
      requests.push({ url, init });
      const pageNumber = Number(new URL(url).searchParams.get("page"));
      return new Response(
        JSON.stringify(
          page(pageNumber, 2, [rawModel(pageNumber === 1 ? "one" : "two", pageNumber, pageNumber)]),
        ),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    },
  });

  assert.equal(fetched.models.length, 2);
  assert.deepEqual(
    requests.map((request) => request.url),
    [`${ARTIFICIAL_ANALYSIS_FREE_ENDPOINT}?page=1`, `${ARTIFICIAL_ANALYSIS_FREE_ENDPOINT}?page=2`],
  );
  for (const request of requests) {
    assert.doesNotMatch(request.url, new RegExp(secret));
    assert.deepEqual(request.init?.headers, { accept: "application/json", "x-api-key": secret });
    assert.equal(request.init?.redirect, "error");
  }
});

test("maps authentication and malformed responses to actionable errors without echoing the key", async () => {
  const secret = "do-not-echo-this-key";
  await assert.rejects(
    fetchArtificialAnalysisUserCache(secret, {
      fetch: async () => new Response("not authorized", { status: 401 }),
    }),
    (error: unknown) => {
      assert.ok(error instanceof ArtificialAnalysisFetchError);
      assert.equal(error.code, "invalid_key");
      assert.doesNotMatch(error.message, new RegExp(secret));
      return true;
    },
  );
  await assert.rejects(
    fetchArtificialAnalysisUserCache(secret, {
      fetch: async () => new Response("not json", { status: 200 }),
    }),
    (error: unknown) => {
      assert.ok(error instanceof ArtificialAnalysisFetchError);
      assert.equal(error.code, "invalid_response");
      return true;
    },
  );
});

test("bounds streamed pages even when the server omits Content-Length", async () => {
  const oversized = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode("x".repeat(24)));
      controller.enqueue(new TextEncoder().encode("y".repeat(24)));
      controller.close();
    },
  });
  await assert.rejects(
    fetchArtificialAnalysisUserCache("secret", {
      fetch: async () => new Response(oversized, { status: 200 }),
      limits: { maxPageBytes: 32, maxTotalBytes: 64 },
    }),
    (error: unknown) => {
      assert.ok(error instanceof ArtificialAnalysisFetchError);
      assert.equal(error.code, "invalid_response");
      assert.match(error.message, /too large/u);
      return true;
    },
  );
});

test("bounds decoded bytes when a compressed response expands past the page limit", async (t) => {
  const compressed = gzipSync("x".repeat(4_096));
  const server = createServer((_request, response) => {
    response.writeHead(200, {
      "content-encoding": "gzip",
      "content-length": compressed.byteLength,
      "content-type": "application/json",
    });
    response.end(compressed);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  await assert.rejects(
    fetchArtificialAnalysisUserCache("secret", {
      fetch: async () => fetch(`http://127.0.0.1:${address.port}`),
      limits: { maxPageBytes: 512, maxTotalBytes: 1_024 },
    }),
    (error: unknown) => {
      assert.ok(error instanceof ArtificialAnalysisFetchError);
      assert.equal(error.code, "invalid_response");
      assert.match(error.message, /too large/u);
      return true;
    },
  );
});

test("enforces cumulative response bytes across individually valid pages", async () => {
  const payloads = [
    JSON.stringify(page(1, 2, [rawModel("one", 1, 1)])),
    JSON.stringify(page(2, 2, [rawModel("two", 2, 2)])),
  ];
  const lengths = payloads.map((payload) => Buffer.byteLength(payload));
  let request = 0;
  await assert.rejects(
    fetchArtificialAnalysisUserCache("secret", {
      fetch: async () => new Response(payloads[request++], { status: 200 }),
      limits: {
        maxPageBytes: Math.max(...lengths),
        maxTotalBytes: lengths[0] + lengths[1] - 1,
      },
    }),
    (error: unknown) => {
      assert.ok(error instanceof ArtificialAnalysisFetchError);
      assert.equal(error.code, "invalid_response");
      assert.match(error.message, /more data/u);
      return true;
    },
  );
});

test("caps declared pages and normalized model count", async () => {
  await assert.rejects(
    fetchArtificialAnalysisUserCache("secret", {
      fetch: async () => new Response(JSON.stringify(page(1, 2, [rawModel("one", 1, 1)]))),
      limits: { maxPages: 1 },
    }),
    /invalid metadata/u,
  );
  await assert.rejects(
    fetchArtificialAnalysisUserCache("secret", {
      fetch: async () =>
        new Response(JSON.stringify(page(1, 1, [rawModel("one", 1, 1), rawModel("two", 2, 2)]))),
      limits: { maxModels: 1 },
    }),
    /more models/u,
  );
});

test("applies one deadline to the complete paginated fetch", async () => {
  await assert.rejects(
    fetchArtificialAnalysisUserCache("secret", {
      timeoutMs: 10,
      fetch: async (_input, init) =>
        new Promise<Response>((_resolve, reject) => {
          const signal = init?.signal;
          assert.ok(signal);
          signal.addEventListener("abort", () => reject(signal.reason ?? new Error("aborted")), {
            once: true,
          });
        }),
    }),
    (error: unknown) => {
      assert.ok(error instanceof ArtificialAnalysisFetchError);
      assert.equal(error.code, "network_error");
      assert.match(error.message, /in time/u);
      return true;
    },
  );
});

test("validates key input without returning credential material", () => {
  assert.equal(normalizeArtificialAnalysisApiKey("  valid-key  "), "valid-key");
  assert.throws(() => normalizeArtificialAnalysisApiKey(""), /Paste/u);
  assert.throws(() => normalizeArtificialAnalysisApiKey("key\nheader"), /unsupported/u);
});

function runtimeFixture(
  initialKey: string | null = null,
  initialCache: ArtificialAnalysisUserCache | null = null,
  initialGeneration = initialCache?.source.generation ?? "generation-initial",
) {
  let credential: ArtificialAnalysisStoredCredential | null = initialKey
    ? { key: initialKey, generation: initialGeneration }
    : null;
  let storedCache = initialCache;
  let fetchCount = 0;
  let cacheWriteError: Error | null = null;
  let fetchCatalog = async (requestedKey: string) => {
    fetchCount += 1;
    return catalog(`from-${requestedKey}`);
  };
  const credentials: ArtificialAnalysisCredentialStore = {
    read: async () => credential,
    write: async (next) => {
      credential = next;
    },
    deleteKey: async () => {
      credential = null;
    },
  };
  const cacheStore: ArtificialAnalysisCacheStore = {
    read: async () => storedCache,
    write: async (next) => {
      if (cacheWriteError) throw cacheWriteError;
      storedCache = next;
    },
    delete: async () => {
      storedCache = null;
    },
  };
  const runtime = new ArtificialAnalysisRuntime({
    credentials,
    cache: cacheStore,
    fetchCatalog: (requestedKey) => fetchCatalog(requestedKey),
  });
  return {
    runtime,
    get key() {
      return credential?.key ?? null;
    },
    get generation() {
      return credential?.generation ?? null;
    },
    get cache() {
      return storedCache;
    },
    get fetchCount() {
      return fetchCount;
    },
    setCacheWriteError(error: Error | null) {
      cacheWriteError = error;
    },
    setFetchCatalog(next: typeof fetchCatalog) {
      fetchCatalog = next;
    },
  };
}

test("status and catalog reads are offline and connecting fetches exactly once", async () => {
  const fixture = runtimeFixture();
  assert.deepEqual(await fixture.runtime.status(), {
    state: "not_connected",
    hasKey: false,
    ready: false,
    cachedModelCount: 0,
    rankedModelCount: 0,
    fetchedAt: undefined,
    tier: undefined,
    intelligenceIndexVersion: undefined,
  });
  assert.equal(await fixture.runtime.catalog(), null);
  assert.equal(fixture.fetchCount, 0);

  const connected = await fixture.runtime.connect("new-key");
  assert.equal(connected.state, "ready");
  assert.equal(connected.cachedModelCount, 1);
  assert.equal(fixture.key, "new-key");
  assert.equal(fixture.fetchCount, 1);
  assert.equal((await fixture.runtime.catalog())?.models[0].id, "from-new-key");
  assert.equal(fixture.generation, fixture.cache?.source.generation);
  assert.equal(fixture.fetchCount, 1);
});

test("a partial cross-file replacement fails closed until an explicit refresh repairs it", async () => {
  const stale = catalog("stale-model", "generation-stale-cache");
  const fixture = runtimeFixture("saved-key", stale, "generation-new-key");
  assert.deepEqual(await fixture.runtime.status(), {
    state: "connected",
    hasKey: true,
    ready: false,
    cachedModelCount: 0,
    rankedModelCount: 0,
    fetchedAt: undefined,
    tier: undefined,
    intelligenceIndexVersion: undefined,
  });
  assert.equal(await fixture.runtime.catalog(), null);
  assert.equal(fixture.fetchCount, 0);

  const repaired = await fixture.runtime.refresh();
  assert.equal(repaired.state, "ready");
  assert.equal(fixture.generation, fixture.cache?.source.generation);
  assert.equal(fixture.fetchCount, 1);
});

test("failed replacement preserves the previous key and cache", async () => {
  const oldCache = catalog("old-model");
  const fixture = runtimeFixture("old-key", oldCache);
  fixture.setFetchCatalog(async () => {
    throw new ArtificialAnalysisFetchError("invalid_key", "The replacement key was rejected.");
  });
  await assert.rejects(fixture.runtime.connect("bad-key"), /replacement key was rejected/u);
  assert.equal(fixture.key, "old-key");
  assert.equal(fixture.cache, oldCache);
});

test("cache persistence failure rolls a replacement key back", async () => {
  const oldCache = catalog("old-model");
  const fixture = runtimeFixture("old-key", oldCache);
  fixture.setCacheWriteError(new Error("disk full"));
  await assert.rejects(fixture.runtime.connect("new-key"), /disk full/u);
  assert.equal(fixture.key, "old-key");
  assert.equal(fixture.cache, oldCache);
});

test("refresh is explicit, uses the stored key, and disconnect removes both key and cache", async () => {
  const fixture = runtimeFixture("saved-key", catalog("old-model"));
  assert.equal(fixture.fetchCount, 0);
  const refreshed = await fixture.runtime.refresh();
  assert.equal(refreshed.state, "ready");
  assert.equal(fixture.cache?.models[0].id, "from-saved-key");
  assert.equal(fixture.fetchCount, 1);
  assert.equal(fixture.generation, fixture.cache?.source.generation);
  assert.deepEqual(await fixture.runtime.disconnect(), {
    state: "not_connected",
    hasKey: false,
    ready: false,
    cachedModelCount: 0,
    rankedModelCount: 0,
    fetchedAt: undefined,
    tier: undefined,
    intelligenceIndexVersion: undefined,
  });
  assert.equal(fixture.key, null);
  assert.equal(fixture.cache, null);
});

test("disconnect queued behind an in-flight connect wins and prevents stale state", async () => {
  const fixture = runtimeFixture();
  let release!: () => void;
  const mayFinish = new Promise<void>((resolve) => {
    release = resolve;
  });
  let started!: () => void;
  const didStart = new Promise<void>((resolve) => {
    started = resolve;
  });
  fixture.setFetchCatalog(async () => {
    started();
    await mayFinish;
    return catalog("new-model");
  });
  const connect = fixture.runtime.connect("new-key");
  await didStart;
  const disconnect = fixture.runtime.disconnect();
  release();
  await Promise.all([connect, disconnect]);
  assert.equal(fixture.key, null);
  assert.equal(fixture.cache, null);
  assert.equal((await fixture.runtime.status()).state, "not_connected");
});
