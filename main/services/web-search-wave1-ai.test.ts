import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  GEMINI_API_ENDPOINT,
  GEMINI_ORIGIN,
  MAX_GEMINI_RESPONSE_BYTES,
  buildGeminiRequest,
  geminiHttpError,
  geminiTransportError,
  parseGeminiResponse,
} from "./web-search-gemini-core.js";
import {
  MAX_PARALLEL_MCP_RESPONSE_BYTES,
  PARALLEL_MCP_ENDPOINT,
  PARALLEL_MCP_ORIGIN,
  buildParallelMcpRequest,
  parallelMcpHttpError,
  parallelMcpTransportError,
  parseParallelMcpResponse,
} from "./web-search-parallel-mcp-core.js";
import {
  MAX_PERPLEXITY_RESPONSE_BYTES,
  PERPLEXITY_ENDPOINT,
  PERPLEXITY_MODEL,
  PERPLEXITY_ORIGIN,
  buildPerplexityRequest,
  perplexityHttpError,
  perplexityTransportError,
  parsePerplexityResponse,
} from "./web-search-perplexity-core.js";
import {
  createGeminiWebSearchAdapter,
  createParallelMcpWebSearchAdapter,
  createPerplexityWebSearchAdapter,
} from "./web-search-provider-registry.js";
import { WebSearchError } from "./web-search-core.js";
import type { WebSearchAdapterRequest, WebSearchFetch } from "./web-search-provider-registry.js";

const PRIVATE_KEY = "wave1-ai-private-key-1f4a9c";
const PRIVATE_BODY = "WAVE1_AI_PRIVATE_UPSTREAM_BODY_1f4a9c";

async function fixture(
  provider: "parallel-mcp" | "perplexity" | "gemini",
  name: string,
): Promise<string> {
  return readFile(new URL(`./fixtures/${provider}/${name}`, import.meta.url), "utf8");
}

function request(
  credentialMode: "anonymous" | "api-key",
  credential: string | undefined = credentialMode === "api-key" ? PRIVATE_KEY : undefined,
  signal = new AbortController().signal,
): WebSearchAdapterRequest {
  return {
    query: "current provider documentation",
    numResults: 2,
    credentialMode,
    credential,
    signal,
  };
}

function assertSecureRequest(init: RequestInit | undefined, keyExpected: boolean): void {
  assert.equal(init?.redirect, "error");
  assert.equal(init?.credentials, "omit");
  assert.equal(init?.cache, "no-store");
  assert.equal(init?.referrerPolicy, "no-referrer");
  assert.equal(JSON.stringify(init).includes(PRIVATE_BODY), false);
  assert.equal(JSON.stringify(init).includes(PRIVATE_KEY), keyExpected);
}

test("Parallel MCP builder uses the fixed hosted endpoint and optional bearer auth", () => {
  const anonymous = buildParallelMcpRequest("  current Parallel docs  ", 2, {
    mode: "anonymous",
  });
  assert.equal(anonymous.url, PARALLEL_MCP_ENDPOINT);
  assert.equal(new URL(anonymous.url).origin, PARALLEL_MCP_ORIGIN);
  assertSecureRequest(anonymous.init, false);
  assert.deepEqual(anonymous.init.headers, {
    Accept: "application/json, text/event-stream",
    "Content-Type": "application/json",
  });
  assert.deepEqual(JSON.parse(anonymous.init.body), {
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: {
      name: "web_search",
      arguments: {
        objective: "current Parallel docs",
        search_queries: ["current Parallel docs"],
      },
    },
  });

  const keyed = buildParallelMcpRequest("current Parallel docs", 2, {
    mode: "api-key",
    apiKey: `  ${PRIVATE_KEY}  `,
  });
  assert.equal(keyed.init.headers.Authorization, `Bearer ${PRIVATE_KEY}`);
  assert.equal(keyed.url.includes(PRIVATE_KEY), false);
  assert.equal(keyed.init.body.includes(PRIVATE_KEY), false);
});

test("Perplexity builder uses Sonar chat completions with bearer auth in the header", () => {
  const built = buildPerplexityRequest("  current Perplexity docs  ", 2, `  ${PRIVATE_KEY}  `);
  assert.equal(built.url, PERPLEXITY_ENDPOINT);
  assert.equal(new URL(built.url).origin, PERPLEXITY_ORIGIN);
  assertSecureRequest(built.init, true);
  assert.deepEqual(built.init.headers, {
    Accept: "application/json",
    Authorization: `Bearer ${PRIVATE_KEY}`,
    "Content-Type": "application/json",
  });
  assert.deepEqual(JSON.parse(built.init.body), {
    model: PERPLEXITY_MODEL,
    messages: [{ role: "user", content: "current Perplexity docs" }],
    max_tokens: 1024,
    return_related_questions: false,
  });
  assert.equal(built.init.body.includes(PRIVATE_KEY), false);
  assert.equal(built.url.includes(PRIVATE_KEY), false);
});

test("Gemini builder uses generateContent Google Search grounding and x-goog-api-key", () => {
  const built = buildGeminiRequest("  current Gemini docs  ", 2, `  ${PRIVATE_KEY}  `);
  assert.equal(built.url, GEMINI_API_ENDPOINT);
  assert.equal(new URL(built.url).origin, GEMINI_ORIGIN);
  assert.equal(new URL(built.url).pathname, "/v1beta/models/gemini-3.6-flash:generateContent");
  assertSecureRequest(built.init, true);
  assert.deepEqual(built.init.headers, {
    Accept: "application/json",
    "Content-Type": "application/json",
    "x-goog-api-key": PRIVATE_KEY,
  });
  assert.deepEqual(JSON.parse(built.init.body), {
    contents: [{ role: "user", parts: [{ text: "current Gemini docs" }] }],
    tools: [{ google_search: {} }],
  });
  assert.equal(built.init.body.includes(PRIVATE_KEY), false);
  assert.equal(built.url.includes(PRIVATE_KEY), false);
});

test("the provider fixtures normalize only bounded, safe source evidence", async () => {
  const parallel = parseParallelMcpResponse(
    {
      status: 200,
      contentType: "application/json; charset=utf-8",
      body: await fixture("parallel-mcp", "json-success.json"),
    },
    2,
  );
  assert.deepEqual(parallel, {
    ok: true,
    value: {
      providerId: "parallel-mcp",
      trust: "untrusted-web-evidence",
      results: [
        {
          title: "Parallel MCP programmatic use",
          url: "https://docs.parallel.ai/integrations/mcp/programmatic-use",
          text: "Parallel Search MCP exposes web search over JSON-RPC.",
        },
        {
          title: "Source 2",
          url: "https://example.test/parallel-second",
          text: "A second untrusted Parallel source.",
        },
      ],
    },
  });

  const sse = parseParallelMcpResponse(
    {
      status: 200,
      contentType: "text/event-stream",
      body: await fixture("parallel-mcp", "sse-success.sse"),
    },
    1,
  );
  assert.deepEqual(sse, {
    ok: true,
    value: {
      providerId: "parallel-mcp",
      trust: "untrusted-web-evidence",
      results: [
        {
          title: "SSE source",
          url: "https://example.test/parallel-sse",
          text: "SSE evidence",
        },
      ],
    },
  });

  const perplexity = parsePerplexityResponse(
    {
      status: 200,
      contentType: "application/json",
      body: await fixture("perplexity", "json-success.json"),
    },
    2,
  );
  assert.deepEqual(perplexity, {
    ok: true,
    value: {
      providerId: "perplexity",
      trust: "untrusted-web-evidence",
      results: [
        {
          title: "Perplexity Sonar API",
          url: "https://docs.perplexity.ai/api-reference/sonar-post",
          text: "The Sonar API returns web-grounded answers and citations.",
        },
        {
          title: "Second Perplexity source",
          url: "https://example.test/perplexity-second",
          text: "A second untrusted Perplexity source.",
        },
      ],
    },
  });

  const citationsOnly = parsePerplexityResponse(
    {
      status: 200,
      body: await fixture("perplexity", "citations-only.json"),
    },
    2,
  );
  assert.equal(citationsOnly.ok, true);
  if (citationsOnly.ok) {
    assert.deepEqual(
      citationsOnly.value.results.map(({ url }) => url),
      [
        "https://example.test/perplexity-citation-one",
        "https://example.test/perplexity-citation-two",
      ],
    );
  }

  const gemini = parseGeminiResponse(
    {
      status: 200,
      contentType: "application/json; charset=utf-8",
      body: await fixture("gemini", "json-success.json"),
    },
    2,
  );
  assert.deepEqual(gemini, {
    ok: true,
    value: {
      providerId: "gemini",
      trust: "untrusted-web-evidence",
      results: [
        {
          title: "Grounding with Google Search",
          url: "https://ai.google.dev/gemini-api/docs/google-search",
          text: "Google Search grounding supports this source.",
        },
        {
          title: "Second Gemini source",
          url: "https://example.test/gemini-second",
          text: "The second source has separate evidence.",
        },
      ],
    },
  });
});

test("malformed and unsafe provider bodies fail closed without leakage", async () => {
  const malformed = [
    parseParallelMcpResponse({
      status: 200,
      contentType: "application/json",
      body: await fixture("parallel-mcp", "malformed.json"),
    }),
    parsePerplexityResponse({
      status: 200,
      contentType: "application/json",
      body: await fixture("perplexity", "malformed.json"),
    }),
    parseGeminiResponse({
      status: 200,
      contentType: "application/json",
      body: await fixture("gemini", "malformed.json"),
    }),
  ];
  for (const outcome of malformed) {
    assert.equal(outcome.ok, false);
    assert.equal(JSON.stringify(outcome).includes(PRIVATE_BODY), false);
    assert.equal(JSON.stringify(outcome).includes(PRIVATE_KEY), false);
    if (!outcome.ok) assert.equal(outcome.error.category, "invalid_response");
  }

  const unsafe = parsePerplexityResponse({
    status: 200,
    body: JSON.stringify({ citations: [PRIVATE_BODY, "file:///tmp/private", "https://safe.test"] }),
  });
  assert.equal(unsafe.ok, true);
  if (unsafe.ok) {
    assert.deepEqual(
      unsafe.value.results.map(({ url }) => url),
      ["https://safe.test"],
    );
    assert.equal(JSON.stringify(unsafe).includes(PRIVATE_BODY), false);
  }
});

test("HTTP and transport categories are closed and provider-attributed", async () => {
  const cases = JSON.parse(await fixture("parallel-mcp", "http-errors.json")) as Array<{
    status: number;
    category: string;
    fallbackEligible: boolean;
  }>;
  for (const expected of cases) {
    const parallel = parallelMcpHttpError(expected.status);
    const perplexity = perplexityHttpError(expected.status);
    const gemini = geminiHttpError(expected.status);
    for (const error of [parallel, perplexity, gemini]) {
      assert.equal(error.category, expected.category);
      assert.equal(error.fallbackEligible, expected.fallbackEligible);
      assert.equal(error.message.includes(PRIVATE_BODY), false);
      assert.equal(error.message.includes(PRIVATE_KEY), false);
    }

    for (const parser of [parseParallelMcpResponse, parsePerplexityResponse, parseGeminiResponse]) {
      const parsed = parser({ status: expected.status, body: `${PRIVATE_BODY}:${PRIVATE_KEY}` });
      assert.equal(parsed.ok, false);
      assert.equal(JSON.stringify(parsed).includes(PRIVATE_BODY), false);
      assert.equal(JSON.stringify(parsed).includes(PRIVATE_KEY), false);
    }
  }
  assert.equal(parallelMcpTransportError("redirect").category, "policy");
  assert.equal(perplexityTransportError("network").category, "network");
  assert.equal(geminiTransportError("cancelled").category, "cancelled");
});

test("factories enforce the shared fetch policy, auth placement, and attribution", async () => {
  const run = async (
    providerId: "parallel-mcp" | "perplexity" | "gemini",
    body: string,
    factory: (options?: { fetch?: WebSearchFetch }) => {
      providerId: string;
      search(request: WebSearchAdapterRequest): Promise<unknown>;
    },
    credentialMode: "anonymous" | "api-key",
    expectedUrl: string,
  ) => {
    const calls: Array<{ input: string; init: RequestInit | undefined }> = [];
    const fetch: WebSearchFetch = async (input, init) => {
      calls.push({ input: String(input), init });
      return new Response(body, {
        status: 200,
        headers: {
          "content-type": providerId === "parallel-mcp" ? "application/json" : "application/json",
        },
      });
    };
    const adapter = factory({ fetch });
    const result = await adapter.search(request(credentialMode));
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.input, expectedUrl);
    assertSecureRequest(calls[0]?.init, credentialMode === "api-key");
    assert.equal(calls[0]?.init?.signal instanceof AbortSignal, true);
    assert.equal((result as { providerId: string }).providerId, providerId);
    assert.equal((result as { untrusted: boolean }).untrusted, true);
  };

  await run(
    "parallel-mcp",
    await fixture("parallel-mcp", "json-success.json"),
    createParallelMcpWebSearchAdapter,
    "anonymous",
    PARALLEL_MCP_ENDPOINT,
  );
  await run(
    "perplexity",
    await fixture("perplexity", "json-success.json"),
    createPerplexityWebSearchAdapter,
    "api-key",
    PERPLEXITY_ENDPOINT,
  );
  await run(
    "gemini",
    await fixture("gemini", "json-success.json"),
    createGeminiWebSearchAdapter,
    "api-key",
    GEMINI_API_ENDPOINT,
  );
});

test("AI adapters enforce response byte bounds before parsing and do not echo secrets", async () => {
  const adapters = [
    createParallelMcpWebSearchAdapter({
      fetch: async () =>
        new Response("{}", {
          status: 200,
          headers: {
            "content-type": "application/json",
            "content-length": String(MAX_PARALLEL_MCP_RESPONSE_BYTES + 1),
          },
        }),
    }),
    createPerplexityWebSearchAdapter({
      fetch: async () =>
        new Response("{}", {
          status: 200,
          headers: {
            "content-type": "application/json",
            "content-length": String(MAX_PERPLEXITY_RESPONSE_BYTES + 1),
          },
        }),
    }),
    createGeminiWebSearchAdapter({
      fetch: async () =>
        new Response("{}", {
          status: 200,
          headers: {
            "content-type": "application/json",
            "content-length": String(MAX_GEMINI_RESPONSE_BYTES + 1),
          },
        }),
    }),
  ];
  for (const [index, adapter] of adapters.entries()) {
    const providerId = ["parallel-mcp", "perplexity", "gemini"][index];
    await assert.rejects(
      adapter.search(request(index === 0 ? "anonymous" : "api-key")),
      (error: unknown) =>
        error instanceof WebSearchError &&
        error.kind === "invalid-response" &&
        error.providerId === providerId &&
        !error.message.includes(PRIVATE_KEY) &&
        !error.message.includes(PRIVATE_BODY),
    );
  }

  const streamed = createGeminiWebSearchAdapter({
    fetch: async () => {
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array(MAX_GEMINI_RESPONSE_BYTES));
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
    streamed.search(request("api-key")),
    (error: unknown) => error instanceof WebSearchError && error.kind === "invalid-response",
  );
});

test("AI adapter credentials and redirects fail closed", async () => {
  for (const build of [
    () => buildParallelMcpRequest("query", 1, { mode: "api-key", apiKey: `${PRIVATE_KEY}\n` }),
    () => buildPerplexityRequest("query", 1, `${PRIVATE_KEY}\r`),
    () => buildGeminiRequest("query", 1, ""),
  ]) {
    assert.throws(build, (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal(error.message.includes(PRIVATE_KEY), false);
      assert.equal(error.message.includes(PRIVATE_BODY), false);
      return true;
    });
  }

  for (const [providerId, adapter] of [
    ["parallel-mcp", createParallelMcpWebSearchAdapter({ fetch: async () => new Response("{}") })],
    ["perplexity", createPerplexityWebSearchAdapter({ fetch: async () => new Response("{}") })],
    ["gemini", createGeminiWebSearchAdapter({ fetch: async () => new Response("{}") })],
  ] as const) {
    await assert.rejects(
      adapter.search(request("api-key", `${PRIVATE_KEY}\n`)),
      (error: unknown) =>
        error instanceof WebSearchError &&
        error.kind === "auth" &&
        error.providerId === providerId &&
        !error.message.includes(PRIVATE_KEY),
    );
  }

  const redirectAdapters = [
    createParallelMcpWebSearchAdapter({
      fetch: async () => {
        throw new TypeError("redirect mode is error and a redirect was received");
      },
    }),
    createPerplexityWebSearchAdapter({
      fetch: async () => {
        throw new TypeError("maximum redirect count reached");
      },
    }),
    createGeminiWebSearchAdapter({
      fetch: async () => {
        throw new TypeError("redirect mode is error");
      },
    }),
  ];
  for (const [index, adapter] of redirectAdapters.entries()) {
    const providerId = ["parallel-mcp", "perplexity", "gemini"][index];
    await assert.rejects(
      adapter.search(request(index === 0 ? "anonymous" : "api-key")),
      (error: unknown) =>
        error instanceof WebSearchError &&
        error.kind === "config" &&
        error.providerId === providerId,
    );
  }
});
