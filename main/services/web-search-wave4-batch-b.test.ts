import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  ANYSEARCH_WEB_SEARCH_ENDPOINT,
  ANYSEARCH_WEB_SEARCH_ORIGIN,
  anySearchWebSearchAdapterFactory,
  buildAnySearchWebSearchRequest,
  createAnySearchWebSearchAdapter,
  parseAnySearchWebSearchResponse,
} from "./web-search-anysearch-adapter.js";
import {
  XCRAWL_WEB_SEARCH_ENDPOINT,
  XCRAWL_WEB_SEARCH_ORIGIN,
  buildXCrawlWebSearchRequest,
  createXCrawlWebSearchAdapter,
  parseXCrawlWebSearchResponse,
  xcrawlWebSearchAdapterFactory,
} from "./web-search-xcrawl-adapter.js";
import {
  VALYU_WEB_SEARCH_ENDPOINT,
  VALYU_WEB_SEARCH_ORIGIN,
  buildValyuWebSearchRequest,
  createValyuWebSearchAdapter,
  parseValyuWebSearchResponse,
  valyuWebSearchAdapterFactory,
} from "./web-search-valyu-adapter.js";
import {
  WEB_SEARCH_API_KEY_MAX_CHARS,
  WEB_SEARCH_JSON_RESPONSE_MAX_BYTES,
  mapWebSearchJsonHttpError,
} from "./web-search-json-adapter.js";
import { WebSearchError } from "./web-search-core.js";
import type {
  WebSearchAdapterFactory,
  WebSearchAdapterRequest,
  WebSearchFetch,
} from "./web-search-provider-registry.js";
import {
  WEB_SEARCH_WAVE4_BATCH_B_ADAPTER_FACTORIES,
  WEB_SEARCH_WAVE4_BATCH_B_HELD_ADAPTER_FACTORIES,
} from "./web-search-wave4-batch-b.js";

const PRIVATE_KEY = "wave4-batch-b-private-key-4e3d9c";
const PRIVATE_BODY = "WAVE4_BATCH_B_PRIVATE_UPSTREAM_BODY_4e3d9c";

type BatchProviderId = "anysearch" | "xcrawl" | "valyu";
type FixtureProvider = "anysearch-search" | "xcrawl-search" | "valyu-search";

async function fixture(provider: FixtureProvider, name: string): Promise<string> {
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

function assertSecureTransport(init: RequestInit | undefined): void {
  assert.equal(init?.redirect, "error");
  assert.equal(init?.credentials, "omit");
  assert.equal(init?.cache, "no-store");
  assert.equal(init?.referrerPolicy, "no-referrer");
  assert.equal(JSON.stringify(init).includes(PRIVATE_BODY), false);
}

function assertNoSecretInError(error: unknown): asserts error is WebSearchError {
  assert.ok(error instanceof WebSearchError);
  assert.equal(error.message.includes(PRIVATE_BODY), false);
  assert.equal(error.message.includes(PRIVATE_KEY), false);
}

test("Phase 4 hosted builders use exact fixed endpoints and header-only credentials", () => {
  const anonymous = buildAnySearchWebSearchRequest("  current AnySearch docs  ", 2, {
    mode: "anonymous",
  });
  assert.equal(anonymous.url, ANYSEARCH_WEB_SEARCH_ENDPOINT);
  assert.equal(new URL(anonymous.url).origin, ANYSEARCH_WEB_SEARCH_ORIGIN);
  assert.equal(anonymous.init.method, "POST");
  assertSecureTransport({ ...anonymous.init, signal: new AbortController().signal });
  assert.deepEqual(anonymous.init.headers, {
    Accept: "application/json",
    "Content-Type": "application/json",
  });
  assert.deepEqual(JSON.parse(anonymous.init.body ?? ""), {
    query: "current AnySearch docs",
    max_results: 2,
  });
  assert.equal(JSON.stringify(anonymous.init).includes(PRIVATE_KEY), false);
  assert.equal(anonymous.url.includes(PRIVATE_KEY), false);

  const anysearch = buildAnySearchWebSearchRequest("current AnySearch docs", 2, {
    mode: "api-key",
    apiKey: `  ${PRIVATE_KEY}  `,
  });
  assert.deepEqual(anysearch.init.headers, {
    Accept: "application/json",
    Authorization: `Bearer ${PRIVATE_KEY}`,
    "Content-Type": "application/json",
  });
  assert.deepEqual(JSON.parse(anysearch.init.body ?? ""), {
    query: "current AnySearch docs",
    max_results: 2,
  });
  assert.equal(anysearch.init.body?.includes(PRIVATE_KEY), false);
  assert.equal(anysearch.url.includes(PRIVATE_KEY), false);

  const xcrawl = buildXCrawlWebSearchRequest("  current XCrawl docs  ", 2, PRIVATE_KEY);
  assert.equal(xcrawl.url, XCRAWL_WEB_SEARCH_ENDPOINT);
  assert.equal(new URL(xcrawl.url).origin, XCRAWL_WEB_SEARCH_ORIGIN);
  assert.equal(xcrawl.init.method, "POST");
  assertSecureRequest({ ...xcrawl.init, signal: new AbortController().signal });
  assert.deepEqual(xcrawl.init.headers, {
    Accept: "application/json",
    Authorization: `Bearer ${PRIVATE_KEY}`,
    "Content-Type": "application/json",
  });
  assert.deepEqual(JSON.parse(xcrawl.init.body ?? ""), {
    query: "current XCrawl docs",
    limit: 2,
  });
  assert.equal(xcrawl.init.body?.includes(PRIVATE_KEY), false);
  assert.equal(xcrawl.url.includes(PRIVATE_KEY), false);

  const valyu = buildValyuWebSearchRequest("  current Valyu docs  ", 2, {
    mode: "api-key",
    apiKey: PRIVATE_KEY,
  });
  assert.equal(valyu.url, VALYU_WEB_SEARCH_ENDPOINT);
  assert.equal(new URL(valyu.url).origin, VALYU_WEB_SEARCH_ORIGIN);
  assert.equal(valyu.init.method, "POST");
  assertSecureRequest({ ...valyu.init, signal: new AbortController().signal });
  assert.deepEqual(valyu.init.headers, {
    Accept: "application/json",
    "Content-Type": "application/json",
    "X-API-Key": PRIVATE_KEY,
  });
  assert.deepEqual(JSON.parse(valyu.init.body ?? ""), {
    query: "current Valyu docs",
    max_num_results: 2,
    search_type: "web",
  });
  assert.equal(valyu.init.body?.includes(PRIVATE_KEY), false);
  assert.equal(valyu.url.includes(PRIVATE_KEY), false);
});

test("Phase 4 hosted parsers map deterministic fixtures and discard unsafe sources", async () => {
  assert.deepEqual(
    parseAnySearchWebSearchResponse(
      JSON.parse(await fixture("anysearch-search", "json-success.json")),
      2,
    ),
    {
      results: [
        {
          title: "AnySearch Search API",
          url: "https://docs.anysearch.com/api/search",
          text: "AnySearch returns bounded web-search results.",
        },
        {
          title: "Second AnySearch source",
          url: "https://example.test/anysearch-second",
          text: "A second untrusted AnySearch result.",
        },
      ],
    },
  );
  assert.deepEqual(
    parseXCrawlWebSearchResponse(
      JSON.parse(await fixture("xcrawl-search", "json-success.json")),
      2,
    ),
    {
      results: [
        {
          title: "XCrawl Search API",
          url: "https://docs.xcrawl.com/doc/api-reference/search/",
          text: "XCrawl Search API returns structured web results.",
        },
        {
          title: "https://example.test/xcrawl-second",
          url: "https://example.test/xcrawl-second",
          text: "A second untrusted XCrawl result.",
        },
      ],
    },
  );
  assert.deepEqual(
    parseValyuWebSearchResponse(JSON.parse(await fixture("valyu-search", "json-success.json")), 2),
    {
      results: [
        {
          title: "Valyu Search API",
          url: "https://docs.valyu.ai/api-reference/endpoint/search",
          text: "Valyu Search returns web results with usage metadata.",
        },
        {
          title: "Second Valyu source",
          url: "https://example.test/valyu-second",
          text: "A second untrusted Valyu result.",
        },
      ],
    },
  );

  const malformed = await Promise.all([
    fixture("anysearch-search", "malformed.json"),
    fixture("xcrawl-search", "malformed.json"),
    fixture("valyu-search", "malformed.json"),
  ]);
  assert.deepEqual(
    [
      parseAnySearchWebSearchResponse(JSON.parse(malformed[0]), 2),
      parseXCrawlWebSearchResponse(JSON.parse(malformed[1]), 2),
      parseValyuWebSearchResponse(JSON.parse(malformed[2]), 2),
    ],
    [undefined, undefined, undefined],
  );

  assert.deepEqual(parseAnySearchWebSearchResponse({ code: 1 }, 2), undefined);
  assert.deepEqual(
    parseXCrawlWebSearchResponse({ endpoint: "search", status: "running" }, 2),
    undefined,
  );
  assert.deepEqual(
    parseXCrawlWebSearchResponse(
      {
        endpoint: "search",
        status: "completed",
        data: { status: "error", data: [] },
      },
      2,
    ),
    undefined,
  );
  assert.deepEqual(parseValyuWebSearchResponse({ success: false, results: [] }, 2), undefined);

  const safeCases = [
    {
      parse: parseAnySearchWebSearchResponse,
      payload: {
        code: 0,
        data: {
          metadata: {},
          results: [
            { title: PRIVATE_BODY, url: `https://user:password.example.test/${PRIVATE_KEY}` },
            { title: "Control character", url: "https://example.test/unsafe\nsource" },
            { title: "Safe", url: "https://example.test/safe", snippet: "safe" },
          ],
        },
      },
    },
    {
      parse: parseXCrawlWebSearchResponse,
      payload: {
        endpoint: "search",
        status: "completed",
        data: {
          status: "success",
          data: [
            { title: PRIVATE_BODY, url: `https://user:password.example.test/${PRIVATE_KEY}` },
            { title: "Control character", url: "https://example.test/unsafe\nsource" },
            { title: "Safe", url: "https://example.test/safe", description: "safe" },
          ],
        },
      },
    },
    {
      parse: parseValyuWebSearchResponse,
      payload: {
        success: true,
        results: [
          { title: PRIVATE_BODY, url: `https://user:password.example.test/${PRIVATE_KEY}` },
          { title: "Control character", url: "https://example.test/unsafe\nsource" },
          { title: "Safe", url: "https://example.test/safe", content: "safe" },
        ],
      },
    },
  ] as const;
  for (const { parse, payload } of safeCases) {
    const safe = parse(payload, 2);
    assert.equal((JSON.stringify(safe) ?? "").includes(PRIVATE_BODY), false);
    assert.equal((JSON.stringify(safe) ?? "").includes(PRIVATE_KEY), false);
  }
});

test("Phase 4 hosted factories share bounded transport, attribution, and map membership", async () => {
  const cases: Array<{
    providerId: BatchProviderId;
    fixtureProvider: FixtureProvider;
    factory: WebSearchAdapterFactory;
    expectedOrigin: string;
  }> = [
    {
      providerId: "anysearch",
      fixtureProvider: "anysearch-search",
      factory: createAnySearchWebSearchAdapter,
      expectedOrigin: ANYSEARCH_WEB_SEARCH_ORIGIN,
    },
    {
      providerId: "xcrawl",
      fixtureProvider: "xcrawl-search",
      factory: createXCrawlWebSearchAdapter,
      expectedOrigin: XCRAWL_WEB_SEARCH_ORIGIN,
    },
    {
      providerId: "valyu",
      fixtureProvider: "valyu-search",
      factory: createValyuWebSearchAdapter,
      expectedOrigin: VALYU_WEB_SEARCH_ORIGIN,
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
    assert.equal(
      calls[0]?.input,
      {
        anysearch: ANYSEARCH_WEB_SEARCH_ENDPOINT,
        xcrawl: XCRAWL_WEB_SEARCH_ENDPOINT,
        valyu: VALYU_WEB_SEARCH_ENDPOINT,
      }[item.providerId],
    );
    assertSecureRequest(calls[0]?.init);
    assert.equal(calls[0]?.init?.signal instanceof AbortSignal, true);
    assert.equal(result.providerId, item.providerId);
    assert.equal(result.untrusted, true);
    assert.equal(result.results.length, 2);

    const anonymous = item.providerId === "anysearch";
    if (anonymous) {
      const anonymousCalls: RequestInit[] = [];
      const anonymousAdapter = item.factory({
        fetch: async (_input, init) => {
          if (init) anonymousCalls.push(init);
          return new Response(body, {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        },
      });
      const anonymousResult = await anonymousAdapter.search({
        ...adapterRequest(item.providerId),
        credentialMode: "anonymous",
        credential: undefined,
      });
      assert.equal(anonymousResult.providerId, "anysearch");
      assert.equal(anonymousCalls.length, 1);
      assert.deepEqual(anonymousCalls[0]?.headers, {
        Accept: "application/json",
        "Content-Type": "application/json",
      });
    }
  }

  assert.deepEqual(
    new Set(Object.keys(WEB_SEARCH_WAVE4_BATCH_B_ADAPTER_FACTORIES)),
    new Set(["xcrawl", "valyu"]),
  );
  for (const [providerId, factory] of Object.entries(WEB_SEARCH_WAVE4_BATCH_B_ADAPTER_FACTORIES)) {
    const adapter = factory({
      fetch: async () => {
        throw new Error("construction must not issue I/O");
      },
    });
    assert.equal(adapter.providerId, providerId);
    assert.equal(adapter.adapterVersion, 1);
  }
  assert.deepEqual(Object.keys(WEB_SEARCH_WAVE4_BATCH_B_HELD_ADAPTER_FACTORIES), ["anysearch"]);
});

test("Phase 4 hosted HTTP, redirect, malformed, and byte failures stay closed", async () => {
  const providers: Array<{ providerId: BatchProviderId; factory: WebSearchAdapterFactory }> = [
    { providerId: "anysearch", factory: anySearchWebSearchAdapterFactory },
    { providerId: "xcrawl", factory: xcrawlWebSearchAdapterFactory },
    { providerId: "valyu", factory: valyuWebSearchAdapterFactory },
  ];
  const statusFixtures = await Promise.all(
    providers.map(({ providerId }) =>
      fixture(`${providerId}-search` as FixtureProvider, "http-errors.json"),
    ),
  );
  for (const [index, { providerId, factory }] of providers.entries()) {
    const expectedStatuses = JSON.parse(statusFixtures[index] ?? "[]") as Array<{
      status: number;
      kind: string;
    }>;
    for (const { status, kind } of expectedStatuses) {
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
    await assert.rejects(declaredOversize.search(adapterRequest(providerId)), (error: unknown) => {
      assertNoSecretInError(error);
      assert.equal(error.kind, "invalid-response");
      return true;
    });

    const streamedOversize = factory({
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
    await assert.rejects(streamedOversize.search(adapterRequest(providerId)), (error: unknown) => {
      assertNoSecretInError(error);
      assert.equal(error.kind, "invalid-response");
      return true;
    });
  }
});

test("Phase 4 hosted credentials are exact, and cancellation reaches fetch", async () => {
  const invalidBuilders = [
    () => buildAnySearchWebSearchRequest("query", 1, { mode: "api-key", apiKey: "" }),
    () => buildXCrawlWebSearchRequest("query", 1, `${PRIVATE_KEY}\n`),
    () => buildValyuWebSearchRequest("query", 1, "x".repeat(WEB_SEARCH_API_KEY_MAX_CHARS + 1)),
  ];
  for (const build of invalidBuilders) {
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
    { providerId: "xcrawl", factory: xcrawlWebSearchAdapterFactory },
    { providerId: "valyu", factory: valyuWebSearchAdapterFactory },
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
        credential: undefined,
      }),
      (error: unknown) => {
        assertNoSecretInError(error);
        assert.equal(error.kind, "auth");
        return true;
      },
    );
    await assert.rejects(
      adapter.search({ ...adapterRequest(providerId), credentialMode: "existing-provider-auth" }),
      (error: unknown) => {
        assertNoSecretInError(error);
        assert.equal(error.kind, "auth");
        return true;
      },
    );
    assert.equal(fetchCalled, false);
  }

  const anysearch = createAnySearchWebSearchAdapter({
    fetch: async () => new Response("{}", { status: 200 }),
  });
  await assert.rejects(
    anysearch.search({
      ...adapterRequest("anysearch"),
      credentialMode: "api-key",
      credential: undefined,
    }),
    (error: unknown) => {
      assertNoSecretInError(error);
      assert.equal(error.kind, "auth");
      return true;
    },
  );

  const controller = new AbortController();
  let signalSeen: AbortSignal | undefined;
  const adapter = createValyuWebSearchAdapter({
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
  const pending = adapter.search(adapterRequest("valyu", controller.signal));
  controller.abort();
  await assert.rejects(pending, (error: unknown) => {
    assertNoSecretInError(error);
    assert.equal(error.kind, "cancelled");
    return true;
  });
  assert.equal(signalSeen, controller.signal);

  const timeoutController = new AbortController();
  const timeoutAdapter = createXCrawlWebSearchAdapter({
    fetch: async () => {
      timeoutController.abort();
      throw new DOMException("aborted", "AbortError");
    },
  });
  await assert.rejects(
    timeoutAdapter.search({
      ...adapterRequest("xcrawl", timeoutController.signal),
      timedOut: () => true,
    }),
    (error: unknown) => {
      assertNoSecretInError(error);
      assert.equal(error.kind, "timeout");
      return true;
    },
  );
});
