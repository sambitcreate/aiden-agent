import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  BRAVE_WEB_SEARCH_ORIGIN,
  BRAVE_WEB_SEARCH_QUERY_MAX_CHARS,
  buildBraveWebSearchRequest,
  createBraveWebSearchAdapter,
  parseBraveWebSearchResponse,
} from "./web-search-brave-adapter.js";
import {
  OPENAI_WEB_SEARCH_ENDPOINT,
  OPENAI_WEB_SEARCH_MODEL,
  OPENAI_WEB_SEARCH_ORIGIN,
  buildOpenAIWebSearchRequest,
  createOpenAIWebSearchAdapter,
  parseOpenAIWebSearchResponse,
} from "./web-search-openai-adapter.js";
import {
  TAVILY_WEB_SEARCH_ENDPOINT,
  TAVILY_WEB_SEARCH_ORIGIN,
  buildTavilyWebSearchRequest,
  createTavilyWebSearchAdapter,
  parseTavilyWebSearchResponse,
} from "./web-search-tavily-adapter.js";
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
import type { WebSearchResolvedExistingAuth } from "./web-search-auth-reuse.js";

const PRIVATE_KEY = "wave1-provider-key-4e3d9c";
const PRIVATE_BODY = "WAVE1_PRIVATE_UPSTREAM_BODY_4e3d9c";

async function fixture(
  provider: "openai-responses" | "brave-search" | "tavily-search",
  name: string,
): Promise<string> {
  return readFile(new URL(`./fixtures/${provider}/${name}`, import.meta.url), "utf8");
}

function adapterRequest(
  _providerId: "openai" | "brave" | "tavily",
  signal = new AbortController().signal,
): WebSearchAdapterRequest {
  return {
    query: "current provider documentation",
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

test("OpenAI builder follows the reviewed Responses web-search JSON contract", () => {
  const request = buildOpenAIWebSearchRequest("  current OpenAI docs  ", 2, {
    mode: "api-key",
    apiKey: `  ${PRIVATE_KEY}  `,
  });
  assert.equal(request.url, OPENAI_WEB_SEARCH_ENDPOINT);
  assert.equal(new URL(request.url).origin, OPENAI_WEB_SEARCH_ORIGIN);
  assert.equal(request.init.method, "POST");
  assertSecureRequest(request.init);
  assert.deepEqual(request.init.headers, {
    Accept: "application/json",
    Authorization: `Bearer ${PRIVATE_KEY}`,
    "Content-Type": "application/json",
  });
  assert.deepEqual(JSON.parse(request.init.body ?? ""), {
    model: OPENAI_WEB_SEARCH_MODEL,
    tools: [{ type: "web_search" }],
    input: "current OpenAI docs",
    include: ["web_search_call.action.sources"],
    store: false,
  });
  assert.equal(request.init.body?.includes(PRIVATE_KEY), false);
  assert.equal(request.url.includes(PRIVATE_KEY), false);
});

test("OpenAI existing-auth requests honor the exact bound model and secure fixed contract", async () => {
  let requestUrl = "";
  let requestInit: RequestInit | undefined;
  const adapter = createOpenAIWebSearchAdapter({
    fetch: async (input, init) => {
      requestUrl = String(input);
      requestInit = init;
      return new Response(
        JSON.stringify({
          output: [
            { type: "web_search_call", status: "completed" },
            {
              type: "message",
              content: [
                {
                  type: "output_text",
                  text: "Source",
                  annotations: [{ type: "url_citation", url: "https://example.test/source" }],
                },
              ],
            },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    },
  });
  const existingAuth: WebSearchResolvedExistingAuth = {
    targetProviderId: "openai",
    sourceProviderId: "openai",
    modelId: "gpt-5.4-bound",
    modelApi: "openai-responses",
    endpoint: OPENAI_WEB_SEARCH_ENDPOINT,
    credential: PRIVATE_KEY,
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${PRIVATE_KEY}`,
      "Content-Type": "application/json",
    },
  };
  const result = await adapter.search({
    ...adapterRequest("openai"),
    credentialMode: "existing-provider-auth",
    credential: undefined,
    existingAuth,
  });
  assert.equal(result.providerId, "openai");
  assert.equal(requestUrl, OPENAI_WEB_SEARCH_ENDPOINT);
  assertSecureRequest(requestInit);
  assert.deepEqual(requestInit?.headers, existingAuth.headers);
  assert.equal(JSON.parse(requestInit?.body?.toString() ?? "{}").model, "gpt-5.4-bound");
});

test("OpenAI adapter rejects anonymous and mismatched credential modes before fetch", async () => {
  let fetchCalls = 0;
  const adapter = createOpenAIWebSearchAdapter({
    fetch: async () => {
      fetchCalls += 1;
      return new Response("{}", { status: 200 });
    },
  });
  await assert.rejects(
    adapter.search({
      ...adapterRequest("openai"),
      credentialMode: "anonymous",
    }),
    (error: unknown) => error instanceof WebSearchError && error.kind === "config",
  );
  await assert.rejects(
    adapter.search({
      ...adapterRequest("openai"),
      credentialMode: "api-key",
      existingAuth: {
        targetProviderId: "openai",
        sourceProviderId: "openai",
        modelId: "gpt-5.4-bound",
        modelApi: "openai-responses",
        endpoint: OPENAI_WEB_SEARCH_ENDPOINT,
        credential: PRIVATE_KEY,
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${PRIVATE_KEY}`,
          "Content-Type": "application/json",
        },
      },
    }),
    (error: unknown) => error instanceof WebSearchError && error.kind === "config",
  );
  assert.equal(fetchCalls, 0);
});

test("Brave builder keeps query data in its reviewed URL and key in its auth header", () => {
  const request = buildBraveWebSearchRequest("  current Brave docs  ", 2, PRIVATE_KEY);
  assert.equal(new URL(request.url).origin, BRAVE_WEB_SEARCH_ORIGIN);
  assert.equal(new URL(request.url).pathname, "/res/v1/web/search");
  assert.equal(new URL(request.url).searchParams.get("q"), "current Brave docs");
  assert.equal(new URL(request.url).searchParams.get("count"), "2");
  assert.equal(request.init.method, "GET");
  assertSecureRequest(request.init);
  assert.deepEqual(request.init.headers, {
    Accept: "application/json",
    "X-Subscription-Token": PRIVATE_KEY,
  });
  assert.equal(request.url.includes(PRIVATE_KEY), false);
  assert.throws(
    () =>
      buildBraveWebSearchRequest("x".repeat(BRAVE_WEB_SEARCH_QUERY_MAX_CHARS + 1), 2, PRIVATE_KEY),
    (error: unknown) => error instanceof WebSearchError && error.kind === "invalid-request",
  );
});

test("Tavily builder uses only the documented JSON fields and bearer auth", () => {
  const request = buildTavilyWebSearchRequest("  current Tavily docs  ", 2, {
    mode: "api-key",
    apiKey: PRIVATE_KEY,
  });
  assert.equal(request.url, TAVILY_WEB_SEARCH_ENDPOINT);
  assert.equal(new URL(request.url).origin, TAVILY_WEB_SEARCH_ORIGIN);
  assert.equal(request.init.method, "POST");
  assertSecureRequest(request.init);
  assert.deepEqual(request.init.headers, {
    Accept: "application/json",
    Authorization: `Bearer ${PRIVATE_KEY}`,
    "Content-Type": "application/json",
  });
  assert.deepEqual(JSON.parse(request.init.body ?? ""), {
    query: "current Tavily docs",
    search_depth: "basic",
    max_results: 2,
  });
  assert.equal(request.init.body?.includes(PRIVATE_KEY), false);
  assert.equal(request.url.includes(PRIVATE_KEY), false);
});

test("provider parsers normalize deterministic fixtures into bounded untrusted evidence", async () => {
  const openai = parseOpenAIWebSearchResponse(
    JSON.parse(await fixture("openai-responses", "json-success.json")),
    2,
  );
  assert.deepEqual(openai, {
    results: [
      {
        title: "OpenAI web search documentation",
        url: "https://platform.openai.com/docs/guides/tools-web-search",
        text: "OpenAI web search returns current evidence from the public web.",
      },
      {
        title: "Second source",
        url: "https://example.test/openai-second",
        text: "OpenAI web search returns current evidence from the public web.",
      },
    ],
  });

  const brave = parseBraveWebSearchResponse(
    JSON.parse(await fixture("brave-search", "json-success.json")),
    2,
  );
  assert.deepEqual(brave, {
    results: [
      {
        title: "Brave Search API",
        url: "https://api.search.brave.com/app/documentation/web-search",
        text: "The Brave Search API returns web results with titles, URLs, and descriptions.",
      },
      {
        title: "Second Brave source",
        url: "https://example.test/brave-second",
        text: "A second untrusted search result.",
      },
    ],
  });

  const tavily = parseTavilyWebSearchResponse(
    JSON.parse(await fixture("tavily-search", "json-success.json")),
    2,
  );
  assert.deepEqual(tavily, {
    results: [
      {
        title: "Tavily Search API",
        url: "https://docs.tavily.com/documentation/api-reference/endpoint/search",
        text: "Tavily Search returns source results with title, URL, and content.",
      },
      {
        title: "Second Tavily source",
        url: "https://example.test/tavily-second",
        text: "A second untrusted search result.",
      },
    ],
  });
});

test("malformed JSON envelopes fail closed without returning provider data", async () => {
  const malformed = [
    parseOpenAIWebSearchResponse(
      JSON.parse(await fixture("openai-responses", "malformed.json")),
      2,
    ),
    parseBraveWebSearchResponse(JSON.parse(await fixture("brave-search", "malformed.json")), 2),
    parseTavilyWebSearchResponse(JSON.parse(await fixture("tavily-search", "malformed.json")), 2),
  ];
  assert.deepEqual(malformed, [undefined, undefined, undefined]);
  assert.equal(parseBraveWebSearchResponse({ web: null }, 2)?.results.length, 0);
});

test("factories enforce fixed origin, shared fetch policy, and result attribution", async () => {
  const run = async (
    providerId: "openai" | "brave" | "tavily",
    body: string,
    factory: WebSearchAdapterFactory,
  ) => {
    const calls: Array<{ input: string; init: RequestInit | undefined }> = [];
    const fetch: WebSearchFetch = async (input, init) => {
      calls.push({ input: String(input), init });
      return new Response(body, {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };
    const adapter = factory({ fetch });
    const result = await adapter.search(adapterRequest(providerId));
    assert.equal(calls.length, 1);
    assertSecureRequest(calls[0]?.init);
    assert.equal(calls[0]?.init?.signal instanceof AbortSignal, true);
    const parsed = result as { providerId: string; untrusted: boolean };
    assert.equal(parsed.providerId, providerId);
    assert.equal(parsed.untrusted, true);
    return calls[0];
  };

  const openaiCall = await run(
    "openai",
    await fixture("openai-responses", "json-success.json"),
    createOpenAIWebSearchAdapter,
  );
  assert.equal(openaiCall.input, OPENAI_WEB_SEARCH_ENDPOINT);

  const braveCall = await run(
    "brave",
    await fixture("brave-search", "json-success.json"),
    createBraveWebSearchAdapter,
  );
  assert.equal(new URL(braveCall.input).origin, BRAVE_WEB_SEARCH_ORIGIN);

  const tavilyCall = await run(
    "tavily",
    await fixture("tavily-search", "json-success.json"),
    createTavilyWebSearchAdapter,
  );
  assert.equal(tavilyCall.input, TAVILY_WEB_SEARCH_ENDPOINT);
});

test("HTTP categories, redirect policy, and malformed bodies stay closed and secret-free", async () => {
  const providers = ["openai", "brave", "tavily"] as const;
  for (const providerId of providers) {
    for (const [status, kind] of [
      [400, "invalid-request"],
      [401, "auth"],
      [403, "auth"],
      [408, "timeout"],
      [429, "quota"],
      [500, "transient"],
    ] as const) {
      const error = mapWebSearchJsonHttpError(providerId, status);
      assert.equal(error.kind, kind);
      assert.equal(error.providerId, providerId);
      assert.doesNotMatch(error.message, new RegExp(PRIVATE_BODY, "u"));
      assert.doesNotMatch(error.message, new RegExp(PRIVATE_KEY, "u"));
    }
    const redirect = mapWebSearchJsonHttpError(providerId, 302);
    assert.equal(redirect.kind, "config");
    assert.equal(redirect.providerId, providerId);
  }
  assert.equal(mapWebSearchJsonHttpError("tavily", 432, [432, 433]).kind, "quota");
  assert.equal(mapWebSearchJsonHttpError("tavily", 433, [432, 433]).kind, "quota");

  const adapter = createTavilyWebSearchAdapter({
    fetch: async () => new Response(PRIVATE_BODY, { status: 401 }),
  });
  await assert.rejects(
    adapter.search(adapterRequest("tavily")),
    (error: unknown) =>
      error instanceof WebSearchError &&
      error.kind === "auth" &&
      error.providerId === "tavily" &&
      !error.message.includes(PRIVATE_BODY) &&
      !error.message.includes(PRIVATE_KEY),
  );

  const redirectAdapter = createBraveWebSearchAdapter({
    fetch: async () => {
      throw new TypeError("redirect mode is error and a redirect was received");
    },
  });
  await assert.rejects(
    redirectAdapter.search(adapterRequest("brave")),
    (error: unknown) => error instanceof WebSearchError && error.kind === "config",
  );

  const malformedAdapter = createOpenAIWebSearchAdapter({
    fetch: async () => new Response("not-json", { status: 200 }),
  });
  await assert.rejects(
    malformedAdapter.search(adapterRequest("openai")),
    (error: unknown) => error instanceof WebSearchError && error.kind === "invalid-response",
  );
});

test("declared and streamed byte bounds are enforced before JSON parsing", async () => {
  const declaredOversize = createTavilyWebSearchAdapter({
    fetch: async () =>
      new Response("{}", {
        status: 200,
        headers: {
          "content-type": "application/json",
          "content-length": String(WEB_SEARCH_JSON_RESPONSE_MAX_BYTES + 1),
        },
      }),
  });
  await assert.rejects(
    declaredOversize.search(adapterRequest("tavily")),
    (error: unknown) => error instanceof WebSearchError && error.kind === "invalid-response",
  );

  const streamedOversize = createBraveWebSearchAdapter({
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
  await assert.rejects(
    streamedOversize.search(adapterRequest("brave")),
    (error: unknown) => error instanceof WebSearchError && error.kind === "invalid-response",
  );
});

test("API keys and malformed credentials fail closed without echoing input", () => {
  for (const build of [
    () => buildOpenAIWebSearchRequest("query", 1, `${PRIVATE_KEY}\n`),
    () => buildBraveWebSearchRequest("query", 1, `${PRIVATE_KEY}\r`),
    () => buildTavilyWebSearchRequest("query", 1, ""),
    () => buildOpenAIWebSearchRequest("query", 1, "x".repeat(WEB_SEARCH_API_KEY_MAX_CHARS + 1)),
  ]) {
    assert.throws(build, (error: unknown) => {
      assert.ok(error instanceof WebSearchError);
      assert.equal(error.kind, "auth");
      assert.equal(error.message.includes(PRIVATE_KEY), false);
      return true;
    });
  }
});

test("caller cancellation is propagated to fetch and does not become a network error", async () => {
  const controller = new AbortController();
  let signalSeen: AbortSignal | undefined;
  const adapter = createOpenAIWebSearchAdapter({
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
  const pending = adapter.search(adapterRequest("openai", controller.signal));
  controller.abort();
  await assert.rejects(
    pending,
    (error: unknown) => error instanceof WebSearchError && error.kind === "cancelled",
  );
  assert.equal(signalSeen, controller.signal);

  const timeoutController = new AbortController();
  const timeoutAdapter = createTavilyWebSearchAdapter({
    fetch: async () => {
      timeoutController.abort();
      throw new DOMException("aborted", "AbortError");
    },
  });
  await assert.rejects(
    timeoutAdapter.search({
      ...adapterRequest("tavily", timeoutController.signal),
      timedOut: () => true,
    }),
    (error: unknown) => error instanceof WebSearchError && error.kind === "timeout",
  );
});
