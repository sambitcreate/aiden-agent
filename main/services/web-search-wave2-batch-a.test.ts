import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  JINA_WEB_SEARCH_ORIGIN,
  buildJinaWebSearchRequest,
  createJinaWebSearchAdapter,
  jinaWebSearchAdapterFactory,
  parseJinaWebSearchResponse,
} from "./web-search-jina-adapter.js";
import {
  PARALLEL_WEB_SEARCH_ENDPOINT,
  PARALLEL_WEB_SEARCH_ORIGIN,
  buildParallelWebSearchRequest,
  createParallelWebSearchAdapter,
  parallelWebSearchAdapterFactory,
  parseParallelWebSearchResponse,
} from "./web-search-parallel-adapter.js";
import {
  SEARCH1API_WEB_SEARCH_ENDPOINT,
  SEARCH1API_WEB_SEARCH_ORIGIN,
  buildSearch1APIWebSearchRequest,
  createSearch1APIWebSearchAdapter,
  parseSearch1APIWebSearchResponse,
  search1APIWebSearchAdapterFactory,
} from "./web-search-search1api-adapter.js";
import {
  TINYFISH_WEB_SEARCH_ENDPOINT,
  TINYFISH_WEB_SEARCH_ORIGIN,
  buildTinyFishWebSearchRequest,
  createTinyFishWebSearchAdapter,
  parseTinyFishWebSearchResponse,
  tinyFishWebSearchAdapterFactory,
} from "./web-search-tinyfish-adapter.js";
import {
  WEB_SEARCH_API_KEY_MAX_CHARS,
  WEB_SEARCH_JSON_RESPONSE_MAX_BYTES,
  mapWebSearchJsonHttpError,
} from "./web-search-json-adapter.js";
import { WebSearchError } from "./web-search-core.js";
import type {
  WebSearchAdapterRequest,
  WebSearchAdapterFactory,
  WebSearchFetch,
} from "./web-search-provider-registry.js";
import { WEB_SEARCH_WAVE2_BATCH_A_ADAPTER_FACTORIES } from "./web-search-wave2-batch-a.js";

const PRIVATE_KEY = "wave2-batch-a-private-key-4e3d9c";
const PRIVATE_BODY = "WAVE2_BATCH_A_PRIVATE_UPSTREAM_BODY_4e3d9c";

type BatchProviderId = "parallel" | "tinyfish" | "search1api" | "jina";

async function fixture(
  provider: "parallel-search" | "tinyfish-search" | "search1api-search" | "jina-search",
  name: string,
): Promise<string> {
  return readFile(new URL(`./fixtures/${provider}/${name}`, import.meta.url), "utf8");
}

function adapterRequest(
  providerId: BatchProviderId,
  signal = new AbortController().signal,
): WebSearchAdapterRequest {
  return {
    query: `current ${providerId} documentation`,
    numResults: 2,
    credentialMode: "api-key",
    credential: PRIVATE_KEY,
    signal,
  };
}

function assertSecureRequest(init: RequestInit | undefined): void {
  assert.equal(init?.redirect, "error");
  assert.equal(init?.credentials, "omit");
  assert.equal(init?.cache, "no-store");
  assert.equal(init?.referrerPolicy, "no-referrer");
  assert.equal(JSON.stringify(init).includes(PRIVATE_BODY), false);
  assert.equal(JSON.stringify(init).includes(PRIVATE_KEY), true);
}

function assertNoSecretInError(error: unknown): asserts error is WebSearchError {
  assert.ok(error instanceof WebSearchError);
  assert.equal(error.message.includes(PRIVATE_BODY), false);
  assert.equal(error.message.includes(PRIVATE_KEY), false);
}

test("Wave 2 batch builders use reviewed fixed origins and header-only credentials", () => {
  const parallel = buildParallelWebSearchRequest("  current Parallel docs  ", 2, {
    mode: "api-key",
    apiKey: `  ${PRIVATE_KEY}  `,
  });
  assert.equal(parallel.url, PARALLEL_WEB_SEARCH_ENDPOINT);
  assert.equal(new URL(parallel.url).origin, PARALLEL_WEB_SEARCH_ORIGIN);
  assert.equal(parallel.init.method, "POST");
  assertSecureRequest(parallel.init);
  assert.deepEqual(parallel.init.headers, {
    Accept: "application/json",
    "Content-Type": "application/json",
    "x-api-key": PRIVATE_KEY,
  });
  assert.deepEqual(JSON.parse(parallel.init.body ?? ""), {
    objective: "current Parallel docs",
    search_queries: ["current Parallel docs"],
    advanced_settings: { max_results: 2 },
  });
  assert.equal(parallel.init.body?.includes(PRIVATE_KEY), false);
  assert.equal(parallel.url.includes(PRIVATE_KEY), false);

  const tinyfish = buildTinyFishWebSearchRequest("  current TinyFish docs  ", 2, PRIVATE_KEY);
  const tinyfishUrl = new URL(tinyfish.url);
  assert.equal(TINYFISH_WEB_SEARCH_ENDPOINT, TINYFISH_WEB_SEARCH_ORIGIN);
  assert.equal(tinyfishUrl.origin, TINYFISH_WEB_SEARCH_ORIGIN);
  assert.equal(tinyfishUrl.pathname, "/");
  assert.equal(tinyfishUrl.searchParams.get("query"), "current TinyFish docs");
  assert.equal(tinyfish.init.method, "GET");
  assertSecureRequest(tinyfish.init);
  assert.deepEqual(tinyfish.init.headers, {
    Accept: "application/json",
    "X-API-Key": PRIVATE_KEY,
  });
  assert.equal(tinyfish.url.includes(PRIVATE_KEY), false);

  const search1api = buildSearch1APIWebSearchRequest("  current Search1API docs  ", 2, {
    mode: "api-key",
    apiKey: PRIVATE_KEY,
  });
  assert.equal(search1api.url, SEARCH1API_WEB_SEARCH_ENDPOINT);
  assert.equal(new URL(search1api.url).origin, SEARCH1API_WEB_SEARCH_ORIGIN);
  assert.equal(search1api.init.method, "POST");
  assertSecureRequest(search1api.init);
  assert.deepEqual(search1api.init.headers, {
    Accept: "application/json",
    Authorization: `Bearer ${PRIVATE_KEY}`,
    "Content-Type": "application/json",
  });
  assert.deepEqual(JSON.parse(search1api.init.body ?? ""), {
    query: "current Search1API docs",
    max_results: 2,
    crawl_results: 0,
  });
  assert.equal(search1api.init.body?.includes(PRIVATE_KEY), false);
  assert.equal(search1api.url.includes(PRIVATE_KEY), false);

  const jina = buildJinaWebSearchRequest("  current Jina docs  ", 2, PRIVATE_KEY);
  const jinaUrl = new URL(jina.url);
  assert.equal(jinaUrl.origin, JINA_WEB_SEARCH_ORIGIN);
  assert.equal(decodeURIComponent(jinaUrl.pathname.slice(1)), "current Jina docs");
  assert.equal(jinaUrl.searchParams.get("count"), "2");
  assert.equal(jina.init.method, "GET");
  assertSecureRequest(jina.init);
  assert.deepEqual(jina.init.headers, {
    Accept: "application/json",
    Authorization: `Bearer ${PRIVATE_KEY}`,
    "X-Respond-With": "no-content",
    "X-Retain-Images": "none",
  });
  assert.equal(jina.url.includes(PRIVATE_KEY), false);
});

test("Wave 2 parsers map deterministic fixtures to bounded source evidence", async () => {
  assert.deepEqual(
    parseParallelWebSearchResponse(
      JSON.parse(await fixture("parallel-search", "json-success.json")),
      2,
    ),
    {
      results: [
        {
          title: "Parallel Search API Quickstart",
          url: "https://docs.parallel.ai/search/search-quickstart",
          text: "Parallel Search returns ranked URLs and excerpts for AI agents.\n\nThe Search API accepts an objective and search queries.",
        },
        {
          title: "Second Parallel source",
          url: "https://example.test/parallel-second",
          text: "A second untrusted Parallel result.",
        },
      ],
    },
  );
  assert.deepEqual(
    parseTinyFishWebSearchResponse(
      JSON.parse(await fixture("tinyfish-search", "json-success.json")),
      2,
    ),
    {
      results: [
        {
          title: "TinyFish Search API",
          url: "https://docs.tinyfish.ai/search-api/reference",
          text: "TinyFish Search returns structured ranked web results.",
        },
        {
          title: "Second TinyFish source",
          url: "https://example.test/tinyfish-second",
          text: "A second untrusted TinyFish result.",
        },
      ],
    },
  );
  assert.deepEqual(
    parseSearch1APIWebSearchResponse(
      JSON.parse(await fixture("search1api-search", "json-success.json")),
      2,
    ),
    {
      results: [
        {
          title: "Search1API Search API",
          url: "https://s1.dev/docs/basic/search",
          text: "Search1API returns ranked web results from multiple engines.",
        },
        {
          title: "Second Search1API source",
          url: "https://example.test/search1api-second",
          text: "A second untrusted Search1API result.",
        },
      ],
    },
  );
  assert.deepEqual(
    parseJinaWebSearchResponse(JSON.parse(await fixture("jina-search", "json-success.json")), 2),
    {
      results: [
        {
          title: "Jina Search API",
          url: "https://jina.ai/api-dashboard/",
          text: "Jina Search returns JSON search grounding results.",
        },
        {
          title: "Second Jina source",
          url: "https://example.test/jina-second",
          text: "A second untrusted Jina result.",
        },
      ],
    },
  );

  const malformed = await Promise.all([
    fixture("parallel-search", "malformed.json"),
    fixture("tinyfish-search", "malformed.json"),
    fixture("search1api-search", "malformed.json"),
    fixture("jina-search", "malformed.json"),
  ]);
  assert.deepEqual(
    [
      parseParallelWebSearchResponse(JSON.parse(malformed[0]), 2),
      parseTinyFishWebSearchResponse(JSON.parse(malformed[1]), 2),
      parseSearch1APIWebSearchResponse(JSON.parse(malformed[2]), 2),
      parseJinaWebSearchResponse(JSON.parse(malformed[3]), 2),
    ],
    [undefined, undefined, undefined, undefined],
  );

  for (const parse of [
    parseParallelWebSearchResponse,
    parseTinyFishWebSearchResponse,
    parseSearch1APIWebSearchResponse,
    parseJinaWebSearchResponse,
  ]) {
    const safe = parse(
      {
        results: [
          { title: PRIVATE_BODY, url: `https://user:password@example.test/${PRIVATE_KEY}` },
          { title: "Control character", url: "https://example.test/unsafe\nsource" },
          { title: "Safe", url: "https://example.test/safe" },
        ],
        data: [
          { title: PRIVATE_BODY, url: `https://example.test/${PRIVATE_KEY}\nsource` },
          { title: "Safe", url: "https://example.test/safe" },
        ],
      },
      2,
    );
    assert.equal(JSON.stringify(safe).includes(PRIVATE_BODY), false);
    assert.equal(JSON.stringify(safe).includes(PRIVATE_KEY), false);
  }

  for (const envelope of JSON.parse(await fixture("jina-search", "envelope-errors.json")) as Array<{
    code: number;
    kind: string;
  }>) {
    assert.throws(
      () => parseJinaWebSearchResponse({ code: envelope.code, data: [] }, 2),
      (error: unknown) => {
        assertNoSecretInError(error);
        assert.equal(error.kind, envelope.kind);
        assert.equal(error.providerId, "jina");
        return true;
      },
    );
  }
});

test("Wave 2 factories share bounds, attribution, and fixed-origin fetch policy", async () => {
  const cases: Array<{
    providerId: BatchProviderId;
    fixtureProvider: "parallel-search" | "tinyfish-search" | "search1api-search" | "jina-search";
    factory: WebSearchAdapterFactory;
    expectedOrigin: string;
  }> = [
    {
      providerId: "parallel",
      fixtureProvider: "parallel-search",
      factory: createParallelWebSearchAdapter,
      expectedOrigin: PARALLEL_WEB_SEARCH_ORIGIN,
    },
    {
      providerId: "tinyfish",
      fixtureProvider: "tinyfish-search",
      factory: createTinyFishWebSearchAdapter,
      expectedOrigin: TINYFISH_WEB_SEARCH_ORIGIN,
    },
    {
      providerId: "search1api",
      fixtureProvider: "search1api-search",
      factory: createSearch1APIWebSearchAdapter,
      expectedOrigin: SEARCH1API_WEB_SEARCH_ORIGIN,
    },
    {
      providerId: "jina",
      fixtureProvider: "jina-search",
      factory: createJinaWebSearchAdapter,
      expectedOrigin: JINA_WEB_SEARCH_ORIGIN,
    },
  ];

  for (const item of cases) {
    const body = await fixture(item.fixtureProvider, "json-success.json");
    const calls: Array<{ input: string; init: RequestInit | undefined }> = [];
    const fetch: WebSearchFetch = async (input, init) => {
      calls.push({ input: String(input), init });
      return new Response(body, {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };
    const adapter = item.factory({ fetch });
    const result = await adapter.search(adapterRequest(item.providerId));
    assert.equal(calls.length, 1);
    assert.equal(new URL(calls[0]?.input ?? "").origin, item.expectedOrigin);
    assertSecureRequest(calls[0]?.init);
    assert.equal(calls[0]?.init?.signal instanceof AbortSignal, true);
    assert.equal(result.providerId, item.providerId);
    assert.equal(result.untrusted, true);
    assert.equal(result.results.length, 2);
  }

  assert.deepEqual(
    new Set(Object.keys(WEB_SEARCH_WAVE2_BATCH_A_ADAPTER_FACTORIES)),
    new Set(["parallel", "tinyfish", "search1api", "jina"]),
  );
  for (const [providerId, factory] of Object.entries(WEB_SEARCH_WAVE2_BATCH_A_ADAPTER_FACTORIES)) {
    const adapter = factory({
      fetch: async () => {
        throw new Error("construction must not issue I/O");
      },
    });
    assert.equal(adapter.providerId, providerId);
    assert.equal(adapter.adapterVersion, 1);
  }
});

test("Wave 2 HTTP, redirect, malformed, envelope, and byte failures stay closed", async () => {
  const providers: Array<{ providerId: BatchProviderId; factory: WebSearchAdapterFactory }> = [
    { providerId: "parallel", factory: parallelWebSearchAdapterFactory },
    { providerId: "tinyfish", factory: tinyFishWebSearchAdapterFactory },
    { providerId: "search1api", factory: search1APIWebSearchAdapterFactory },
    { providerId: "jina", factory: jinaWebSearchAdapterFactory },
  ];
  for (const { providerId, factory } of providers) {
    for (const [status, kind] of [
      [400, "invalid-request"],
      [401, "auth"],
      [403, "auth"],
      [408, "timeout"],
      [429, "quota"],
      [500, "transient"],
    ] as const) {
      const error = mapWebSearchJsonHttpError(providerId, status, [402]);
      assert.equal(error.kind, kind);
      assert.equal(error.providerId, providerId);
      assertNoSecretInError(error);
    }
    const redirect = factory({
      fetch: async () => {
        throw new TypeError("redirect mode is error and a redirect was received");
      },
    });
    await assert.rejects(redirect.search(adapterRequest(providerId)), (error: unknown) => {
      assertNoSecretInError(error);
      assert.equal(error.kind, "config");
      return true;
    });

    const malformed = factory({ fetch: async () => new Response(PRIVATE_BODY, { status: 200 }) });
    await assert.rejects(malformed.search(adapterRequest(providerId)), (error: unknown) => {
      assertNoSecretInError(error);
      assert.equal(error.kind, "invalid-response");
      return true;
    });
  }

  const jinaEnvelope = createJinaWebSearchAdapter({
    fetch: async () =>
      new Response(JSON.stringify({ code: 429, status: 42900, data: [], message: PRIVATE_BODY }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
  });
  await assert.rejects(jinaEnvelope.search(adapterRequest("jina")), (error: unknown) => {
    assertNoSecretInError(error);
    assert.equal(error.kind, "quota");
    return true;
  });

  const oversizedFactories: WebSearchAdapterFactory[] = [
    createParallelWebSearchAdapter,
    createTinyFishWebSearchAdapter,
    createSearch1APIWebSearchAdapter,
    createJinaWebSearchAdapter,
  ];
  for (const factory of oversizedFactories) {
    const declaredOversize = factory({
      fetch: async () =>
        new Response("{}", {
          status: 200,
          headers: {
            "content-type": "application/json",
            "content-length": String(WEB_SEARCH_JSON_RESPONSE_MAX_BYTES + 1),
          },
        }),
    });
    await assert.rejects(declaredOversize.search(adapterRequest("jina")), (error: unknown) => {
      assertNoSecretInError(error);
      assert.equal(error.kind, "invalid-response");
      return true;
    });

    const adapter = factory({
      fetch: async () => {
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new Uint8Array(WEB_SEARCH_JSON_RESPONSE_MAX_BYTES));
            controller.enqueue(new Uint8Array(1));
            controller.close();
          },
        });
        return new Response(stream, {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
    });
    await assert.rejects(adapter.search(adapterRequest("jina")), (error: unknown) => {
      assertNoSecretInError(error);
      assert.equal(error.kind, "invalid-response");
      return true;
    });
  }
});

test("Wave 2 credentials and caller cancellation fail closed", async () => {
  const builders = [
    () => buildParallelWebSearchRequest("query", 1, `${PRIVATE_KEY}\n`),
    () => buildTinyFishWebSearchRequest("query", 1, `${PRIVATE_KEY}\r`),
    () => buildSearch1APIWebSearchRequest("query", 1, ""),
    () => buildJinaWebSearchRequest("query", 1, "x".repeat(WEB_SEARCH_API_KEY_MAX_CHARS + 1)),
  ];
  for (const build of builders) {
    assert.throws(build, (error: unknown) => {
      assertNoSecretInError(error);
      assert.equal(error.kind, "auth");
      return true;
    });
  }

  const mismatchedModes: Array<{
    providerId: BatchProviderId;
    factory: WebSearchAdapterFactory;
  }> = [
    { providerId: "parallel", factory: parallelWebSearchAdapterFactory },
    { providerId: "tinyfish", factory: tinyFishWebSearchAdapterFactory },
    { providerId: "search1api", factory: search1APIWebSearchAdapterFactory },
    { providerId: "jina", factory: jinaWebSearchAdapterFactory },
  ];
  for (const { providerId, factory } of mismatchedModes) {
    let fetchCalled = false;
    const adapter = factory({
      fetch: async () => {
        fetchCalled = true;
        return new Response("{}", { status: 200 });
      },
    });
    await assert.rejects(
      adapter.search({
        ...adapterRequest(providerId),
        credentialMode: "anonymous",
      }),
      (error: unknown) => {
        assertNoSecretInError(error);
        assert.equal(error.kind, "auth");
        return true;
      },
    );
    await assert.rejects(
      adapter.search({
        ...adapterRequest(providerId),
        credentialMode: "existing-provider-auth",
      }),
      (error: unknown) => {
        assertNoSecretInError(error);
        assert.equal(error.kind, "auth");
        return true;
      },
    );
    assert.equal(fetchCalled, false);
  }

  const controller = new AbortController();
  let signalSeen: AbortSignal | undefined;
  const adapter = createTinyFishWebSearchAdapter({
    fetch: async (_input, init) => {
      signalSeen = init?.signal as AbortSignal | undefined;
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener(
          "abort",
          () => reject(new DOMException("aborted", "AbortError")),
          { once: true },
        );
      });
    },
  });
  const pending = adapter.search(adapterRequest("tinyfish", controller.signal));
  controller.abort();
  await assert.rejects(pending, (error: unknown) => {
    assertNoSecretInError(error);
    assert.equal(error.kind, "cancelled");
    return true;
  });
  assert.equal(signalSeen, controller.signal);

  const timeoutController = new AbortController();
  const timeoutAdapter = createJinaWebSearchAdapter({
    fetch: async () => {
      timeoutController.abort();
      throw new DOMException("aborted", "AbortError");
    },
  });
  await assert.rejects(
    timeoutAdapter.search({
      ...adapterRequest("jina", timeoutController.signal),
      timedOut: () => true,
    }),
    (error: unknown) => {
      assertNoSecretInError(error);
      assert.equal(error.kind, "timeout");
      return true;
    },
  );
});
