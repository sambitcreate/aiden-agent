import assert from "node:assert/strict";
import test from "node:test";

import {
  WEB_SEARCH_ADAPTER_FACTORIES,
  readBoundedWebSearchResponse,
  webSearchAdapterAvailable,
  webSearchAdapterFactory,
} from "./web-search-provider-registry.js";
import {
  WEB_SEARCH_PROVIDER_REGISTRY,
  freshWebSearchSettings,
  getWebSearchProviderDefinition,
  type WebSearchProviderId,
} from "./web-search-provider-registry-core.js";
import type { WebSearchFetch } from "./web-search-provider-registry.js";

import { readBoundedWebSearchJsonResponse } from "./web-search-json-adapter.js";
import { WebSearchService } from "./web-search.js";
import { WebSearchError } from "./web-search-core.js";

const WAVE1_PROVIDER_IDS = [
  "openai",
  "brave",
  "parallel-mcp",
  "tavily",
  "perplexity",
  "gemini",
] as const satisfies readonly WebSearchProviderId[];

const SHIPPED_PROVIDER_IDS = new Set<WebSearchProviderId>([...WAVE1_PROVIDER_IDS, "exa"]);
const WAVE2_PROVIDER_IDS = [
  "parallel",
  "tinyfish",
  "search1api",
  "jina",
  "kagi",
  "ollama",
  "serper",
] as const satisfies readonly WebSearchProviderId[];

for (const providerId of WAVE2_PROVIDER_IDS) SHIPPED_PROVIDER_IDS.add(providerId);

const WAVE4_PROVIDER_IDS = [
  "serpdive",
  "valyu",
  "xcrawl",
] as const satisfies readonly WebSearchProviderId[];

for (const providerId of WAVE4_PROVIDER_IDS) SHIPPED_PROVIDER_IDS.add(providerId);

test("release state is exactly the reviewed adapter-backed providers", () => {
  const shipped = new Set(
    WEB_SEARCH_PROVIDER_REGISTRY.filter((definition) => definition.releaseState === "shipped").map(
      (definition) => definition.id,
    ),
  );
  assert.deepEqual(shipped, SHIPPED_PROVIDER_IDS);
  for (const providerId of WAVE1_PROVIDER_IDS) {
    const definition = getWebSearchProviderDefinition(providerId);
    assert.ok(definition);
    assert.equal(definition.releaseState, "shipped");
    assert.equal(definition.adapterVersion, 1);
    assert.equal(definition.fixedOrigins.length, 1);
  }
  assert.equal(getWebSearchProviderDefinition("exa")?.releaseState, "shipped");
  for (const providerId of WAVE2_PROVIDER_IDS) {
    const definition = getWebSearchProviderDefinition(providerId);
    assert.ok(definition);
    assert.equal(definition.releaseState, "shipped");
    assert.equal(definition.adapterVersion, 1);
    assert.equal(definition.explicitOnly, true);
    assert.equal(definition.automaticByDefault, false);
  }
  for (const providerId of WAVE4_PROVIDER_IDS) {
    const definition = getWebSearchProviderDefinition(providerId);
    assert.ok(definition);
    assert.equal(definition.releaseState, "shipped");
    assert.equal(definition.adapterVersion, 1);
    assert.equal(definition.explicitOnly, true);
    assert.equal(definition.automaticByDefault, false);
  }
  assert.equal(getWebSearchProviderDefinition("serpbase")?.releaseState, "blocked");
});

test("the main registry exposes only shipped adapter factories and keeps experimental routes closed", () => {
  assert.deepEqual(new Set(Object.keys(WEB_SEARCH_ADAPTER_FACTORIES)), SHIPPED_PROVIDER_IDS);
  for (const providerId of SHIPPED_PROVIDER_IDS) {
    const factory = webSearchAdapterFactory(providerId);
    assert.equal(typeof factory, "function");
    assert.equal(webSearchAdapterAvailable(providerId), true);
    const adapter = factory?.({
      fetch: (async () => {
        throw new Error("central registry construction must not issue I/O");
      }) as WebSearchFetch,
    });
    assert.ok(adapter);
    assert.equal(adapter.providerId, providerId);
    assert.equal(adapter.adapterVersion, 1);
  }
  for (const providerId of [
    "anysearch",
    "brightdata",
    "duckduckgo",
    "firecrawl",
    "searxng",
    "serpbase",
  ]) {
    assert.equal(webSearchAdapterFactory(providerId), undefined);
    assert.equal(webSearchAdapterAvailable(providerId), false);
  }
  assert.equal(webSearchAdapterFactory(null), undefined);
  assert.equal(webSearchAdapterFactory({}), undefined);
});

test("shipped adapter origins are fixed HTTPS origins with no query, fragment, or credentials", () => {
  for (const providerId of SHIPPED_PROVIDER_IDS) {
    const definition = getWebSearchProviderDefinition(providerId);
    assert.ok(definition);
    for (const origin of definition.fixedOrigins) {
      const parsed = new URL(origin);
      assert.equal(parsed.protocol, "https:");
      assert.equal(parsed.origin, origin);
      assert.equal(parsed.username, "");
      assert.equal(parsed.password, "");
      assert.equal(parsed.search, "");
      assert.equal(parsed.hash, "");
    }
  }
});

// Cleanup is best effort: an underlying source may never acknowledge cancel.
// Keep a watchdog so the regression fails deterministically instead of hanging CI.
async function settlesPromptly<T>(operation: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error("Web search waited for body cleanup")), 250);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

for (const [label, read] of [
  ["MCP", readBoundedWebSearchResponse],
  ["JSON", readBoundedWebSearchJsonResponse],
] as const) {
  for (const failure of ["declared-size", "streamed-size", "invalid-chunk", "abort"] as const) {
    test(`${label} body ${failure} settles and unlocks while source cancellation is pending`, async () => {
      const controller = new AbortController();
      let finishCleanup!: () => void;
      const cleanup = new Promise<void>((resolve) => {
        finishCleanup = resolve;
      });
      let cancelCalls = 0;
      const stream = new ReadableStream<Uint8Array>({
        start(source) {
          if (failure === "streamed-size") source.enqueue(new Uint8Array(5));
          if (failure === "invalid-chunk") source.enqueue("invalid" as unknown as Uint8Array);
        },
        cancel() {
          cancelCalls += 1;
          return cleanup;
        },
      });
      const response = new Response(stream, {
        headers: failure === "declared-size" ? { "content-length": "5" } : {},
      });
      const operation = read(response, controller.signal, 4, "brave");
      if (failure === "abort") controller.abort();
      try {
        await assert.rejects(settlesPromptly(operation), (error: unknown) => {
          if (failure === "abort")
            return error instanceof DOMException && error.name === "AbortError";
          return (
            error instanceof WebSearchError &&
            error.kind === "invalid-response" &&
            error.providerId === "brave"
          );
        });
        assert.equal(cancelCalls, 1);
        assert.equal(stream.locked, false);
      } finally {
        finishCleanup();
        await operation.catch(() => undefined);
      }
    });
  }

  test(`${label} preserves the bounded error when source cancellation rejects`, async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(source) {
        source.enqueue(new Uint8Array(5));
      },
      cancel() {
        return Promise.reject(new Error("private provider cleanup detail"));
      },
    });
    await assert.rejects(
      read(new Response(stream), new AbortController().signal, 4, "brave"),
      (error: unknown) =>
        error instanceof WebSearchError &&
        error.kind === "invalid-response" &&
        !error.message.includes("private"),
    );
    assert.equal(stream.locked, false);
  });

  test(`${label} accepts exact-byte-limit chunks without cancelling a completed body`, async () => {
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      start(source) {
        source.enqueue(new Uint8Array([1, 2]));
        source.enqueue(new Uint8Array([3, 4]));
        source.close();
      },
      cancel() {
        cancelled = true;
      },
    });
    assert.deepEqual(
      await read(new Response(stream), new AbortController().signal, 4, "brave"),
      new Uint8Array([1, 2, 3, 4]),
    );
    assert.equal(cancelled, false);
    assert.equal(stream.locked, false);
  });
}

for (const providerId of ["brave", "perplexity", "jina"] as const) {
  test(`${providerId} HTTP quota errors do not wait for discarded body cleanup`, async () => {
    let finishCleanup!: () => void;
    const cleanup = new Promise<void>((resolve) => {
      finishCleanup = resolve;
    });
    let cancelCalls = 0;
    const factory = webSearchAdapterFactory(providerId)!;
    const adapter = factory({
      fetch: async () =>
        new Response(
          new ReadableStream({
            cancel() {
              cancelCalls += 1;
              return cleanup;
            },
          }),
          { status: 429 },
        ),
    });
    const operation = adapter.search({
      query: "test",
      numResults: 1,
      credentialMode: "api-key",
      credential: "test-key",
      signal: new AbortController().signal,
    });
    try {
      await assert.rejects(
        settlesPromptly(operation),
        (error: unknown) =>
          error instanceof WebSearchError &&
          error.kind === "quota" &&
          error.providerId === providerId,
      );
      assert.equal(cancelCalls, 1);
    } finally {
      finishCleanup();
      await operation.catch(() => undefined);
    }
  });
}

for (const providerId of ["exa", "brave"] as const) {
  for (const failure of ["timeout", "cancelled"] as const) {
    test(`${providerId} service reports ${failure} while body cleanup is pending`, async () => {
      const controller = new AbortController();
      let finishCleanup!: () => void;
      const cleanup = new Promise<void>((resolve) => {
        finishCleanup = resolve;
      });
      let started!: () => void;
      const fetched = new Promise<void>((resolve) => {
        started = resolve;
      });
      let cancelCalls = 0;
      const service = new WebSearchService({
        getSettings: async () => ({
          webSearch: {
            ...freshWebSearchSettings(),
            selection: { mode: "fixed", providerId, credentialMode: "api-key" },
          },
        }),
        getCredential: async () => "test-key",
        timeoutMs: failure === "timeout" ? 20 : 10_000,
        fetch: async () => {
          started();
          return new Response(
            new ReadableStream({
              cancel() {
                cancelCalls += 1;
                return cleanup;
              },
            }),
          );
        },
      });
      const operation = service.search({ query: "test" }, controller.signal);
      await fetched;
      if (failure === "cancelled") controller.abort();
      try {
        await assert.rejects(
          settlesPromptly(operation),
          (error: unknown) =>
            error instanceof WebSearchError &&
            error.kind === failure &&
            error.providerId === providerId,
        );
        assert.equal(cancelCalls, 1);
      } finally {
        finishCleanup();
        await operation.catch(() => undefined);
      }
    });
  }
}

test("a stalled discarded body does not block the explicitly configured fallback", async () => {
  let finishCleanup!: () => void;
  const cleanup = new Promise<void>((resolve) => {
    finishCleanup = resolve;
  });
  const calls: string[] = [];
  const service = new WebSearchService({
    getSettings: async () => ({
      webSearch: {
        ...freshWebSearchSettings(),
        selection: {
          mode: "automatic",
          route: [
            { providerId: "exa", credentialMode: "anonymous" },
            { providerId: "brave", credentialMode: "api-key" },
          ],
          fallbackOn: ["invalid-response"],
        },
      },
    }),
    getCredential: async () => "test-key",
    fetch: async (url) => {
      calls.push(String(url));
      if (calls.length === 1)
        return new Response(
          new ReadableStream({
            cancel() {
              return cleanup;
            },
          }),
          { headers: { "content-length": "262145" } },
        );
      return new Response(
        JSON.stringify({
          web: {
            results: [{ title: "Result", url: "https://example.test/", description: "Evidence" }],
          },
        }),
        { headers: { "content-type": "application/json" } },
      );
    },
  });
  const operation = service.search({ query: "test" });
  try {
    const result = await settlesPromptly(operation);
    assert.equal(result.providerId, "brave");
    assert.equal(result.results[0]?.url, "https://example.test/");
    assert.equal(calls.length, 2);
    assert.equal(new URL(calls[0]!).hostname, "mcp.exa.ai");
    assert.equal(new URL(calls[1]!).hostname, "api.search.brave.com");
  } finally {
    finishCleanup();
    await operation.catch(() => undefined);
  }
});
