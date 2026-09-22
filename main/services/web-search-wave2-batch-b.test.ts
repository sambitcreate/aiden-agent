import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  KAGI_WEB_SEARCH_ENDPOINT,
  KAGI_WEB_SEARCH_ORIGIN,
  buildKagiWebSearchRequest,
  createKagiWebSearchAdapter,
  parseKagiWebSearchResponse,
} from "./web-search-kagi-adapter.js";
import {
  OLLAMA_CLOUD_WEB_SEARCH_ENDPOINT,
  OLLAMA_CLOUD_WEB_SEARCH_ORIGIN,
  buildOllamaCloudWebSearchRequest,
  createOllamaCloudWebSearchAdapter,
  parseOllamaCloudWebSearchResponse,
} from "./web-search-ollama-adapter.js";
import {
  SERPER_WEB_SEARCH_ENDPOINT,
  SERPER_WEB_SEARCH_ORIGIN,
  buildSerperWebSearchRequest,
  createSerperWebSearchAdapter,
  parseSerperWebSearchResponse,
} from "./web-search-serper-adapter.js";
import {
  WEB_SEARCH_JSON_RESPONSE_MAX_BYTES,
  mapWebSearchJsonHttpError,
} from "./web-search-json-adapter.js";
import { WebSearchError } from "./web-search-core.js";
import { WEB_SEARCH_WAVE2_BATCH_B_ADAPTER_FACTORIES } from "./web-search-wave2-batch-b.js";
import type {
  WebSearchAdapterFactory,
  WebSearchAdapterRequest,
  WebSearchFetch,
} from "./web-search-provider-registry.js";

const PRIVATE_KEY = "wave2-batch-b-provider-key-7c18e2";
const PRIVATE_BODY = "WAVE2_BATCH_B_PRIVATE_UPSTREAM_BODY_7c18e2";

async function fixture(
  provider: "kagi-search" | "ollama-cloud-search" | "serper-search",
  name: string,
): Promise<string> {
  return readFile(new URL(`./fixtures/${provider}/${name}`, import.meta.url), "utf8");
}

function adapterRequest(
  signal = new AbortController().signal,
  _providerId: "kagi" | "ollama" | "serper" = "kagi",
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

test("Kagi builder uses the reviewed hosted JSON contract and header-only credential", () => {
  const request = buildKagiWebSearchRequest("  current Kagi docs  ", 2, {
    mode: "api-key",
    apiKey: `  ${PRIVATE_KEY}  `,
  });
  assert.equal(request.url, KAGI_WEB_SEARCH_ENDPOINT);
  assert.equal(new URL(request.url).origin, KAGI_WEB_SEARCH_ORIGIN);
  assert.equal(request.init.method, "POST");
  assertSecureRequest(request.init);
  assert.deepEqual(request.init.headers, {
    Accept: "application/json",
    Authorization: `Bearer ${PRIVATE_KEY}`,
    "Content-Type": "application/json",
  });
  assert.deepEqual(JSON.parse(request.init.body ?? ""), {
    query: "current Kagi docs",
    limit: 2,
  });
  assert.equal(request.url.includes(PRIVATE_KEY), false);
  assert.equal(request.init.body?.includes(PRIVATE_KEY), false);
});

test("Ollama Cloud builder uses max_results and bearer auth on the fixed endpoint", () => {
  const request = buildOllamaCloudWebSearchRequest("  current Ollama docs  ", 2, PRIVATE_KEY);
  assert.equal(request.url, OLLAMA_CLOUD_WEB_SEARCH_ENDPOINT);
  assert.equal(new URL(request.url).origin, OLLAMA_CLOUD_WEB_SEARCH_ORIGIN);
  assert.equal(request.init.method, "POST");
  assertSecureRequest(request.init);
  assert.deepEqual(request.init.headers, {
    Accept: "application/json",
    Authorization: `Bearer ${PRIVATE_KEY}`,
    "Content-Type": "application/json",
  });
  assert.deepEqual(JSON.parse(request.init.body ?? ""), {
    query: "current Ollama docs",
    max_results: 2,
  });
  assert.equal(request.url.includes(PRIVATE_KEY), false);
  assert.equal(request.init.body?.includes(PRIVATE_KEY), false);
});

test("Serper builder keeps the API key in X-API-KEY and sends only q and num", () => {
  const request = buildSerperWebSearchRequest("  current Serper docs  ", 2, {
    mode: "api-key",
    apiKey: PRIVATE_KEY,
  });
  assert.equal(request.url, SERPER_WEB_SEARCH_ENDPOINT);
  assert.equal(new URL(request.url).origin, SERPER_WEB_SEARCH_ORIGIN);
  assert.equal(request.init.method, "POST");
  assertSecureRequest(request.init);
  assert.deepEqual(request.init.headers, {
    Accept: "application/json",
    "Content-Type": "application/json",
    "X-API-KEY": PRIVATE_KEY,
  });
  assert.deepEqual(JSON.parse(request.init.body ?? ""), {
    q: "current Serper docs",
    num: 2,
  });
  assert.equal(request.url.includes(PRIVATE_KEY), false);
  assert.equal(request.init.body?.includes(PRIVATE_KEY), false);
});

test("provider parsers normalize deterministic fixtures into capped source evidence", async () => {
  const kagi = parseKagiWebSearchResponse(
    JSON.parse(await fixture("kagi-search", "json-success.json")),
    2,
  );
  assert.deepEqual(kagi, {
    results: [
      {
        title: "Kagi Search API",
        url: "https://help.kagi.com/kagi/api/search.html",
        text: "The Search API provides programmable access to Kagi search results.",
      },
      {
        title: "Second Kagi source",
        url: "https://example.test/kagi-second",
        text: "A second untrusted Kagi result.",
      },
    ],
  });

  const ollama = parseOllamaCloudWebSearchResponse(
    JSON.parse(await fixture("ollama-cloud-search", "json-success.json")),
    2,
  );
  assert.deepEqual(ollama, {
    results: [
      {
        title: "Ollama Web Search",
        url: "https://docs.ollama.com/capabilities/web-search",
        text: "Ollama Cloud web search returns bounded source snippets.",
      },
      {
        title: "Second Ollama source",
        url: "https://example.test/ollama-second",
        text: "A second untrusted Ollama Cloud result.",
      },
    ],
  });

  const serper = parseSerperWebSearchResponse(
    JSON.parse(await fixture("serper-search", "json-success.json")),
    2,
  );
  assert.deepEqual(serper, {
    results: [
      {
        title: "Serper API",
        url: "https://serper.dev/",
        text: "Serper provides a hosted Google Search API.",
      },
      {
        title: "Second Serper source",
        url: "https://example.test/serper-second",
        text: "A second untrusted Serper result.",
      },
    ],
  });
});

test("malformed envelopes fail closed without returning provider data", async () => {
  const malformed = [
    parseKagiWebSearchResponse(JSON.parse(await fixture("kagi-search", "malformed.json")), 2),
    parseOllamaCloudWebSearchResponse(
      JSON.parse(await fixture("ollama-cloud-search", "malformed.json")),
      2,
    ),
    parseSerperWebSearchResponse(JSON.parse(await fixture("serper-search", "malformed.json")), 2),
  ];
  assert.deepEqual(malformed, [undefined, undefined, undefined]);

  assert.deepEqual(
    parseKagiWebSearchResponse(
      { data: { search: [{ title: "bad", url: "javascript:alert(1)", snippet: PRIVATE_BODY }] } },
      2,
    ),
    { results: [] },
  );
});

test("factories enforce the shared fetch policy, fixed origins, and provider attribution", async () => {
  const cases: readonly ["kagi" | "ollama" | "serper", string, WebSearchAdapterFactory, string][] =
    [
      [
        "kagi",
        await fixture("kagi-search", "json-success.json"),
        createKagiWebSearchAdapter,
        KAGI_WEB_SEARCH_ENDPOINT,
      ],
      [
        "ollama",
        await fixture("ollama-cloud-search", "json-success.json"),
        createOllamaCloudWebSearchAdapter,
        OLLAMA_CLOUD_WEB_SEARCH_ENDPOINT,
      ],
      [
        "serper",
        await fixture("serper-search", "json-success.json"),
        createSerperWebSearchAdapter,
        SERPER_WEB_SEARCH_ENDPOINT,
      ],
    ];

  for (const [providerId, body, factory, expectedEndpoint] of cases) {
    const calls: Array<{ input: string; init: RequestInit | undefined }> = [];
    const fetch: WebSearchFetch = async (input, init) => {
      calls.push({ input: String(input), init });
      return new Response(body, {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };
    const adapter = factory({ fetch });
    const result = await adapter.search(adapterRequest(undefined, providerId));
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.input, expectedEndpoint);
    assertSecureRequest(calls[0]?.init);
    assert.equal(calls[0]?.init?.signal instanceof AbortSignal, true);
    assert.deepEqual(result, {
      providerId,
      results: [
        {
          title:
            providerId === "kagi"
              ? "Kagi Search API"
              : providerId === "ollama"
                ? "Ollama Web Search"
                : "Serper API",
          url:
            providerId === "kagi"
              ? "https://help.kagi.com/kagi/api/search.html"
              : providerId === "ollama"
                ? "https://docs.ollama.com/capabilities/web-search"
                : "https://serper.dev/",
          text:
            providerId === "kagi"
              ? "The Search API provides programmable access to Kagi search results."
              : providerId === "ollama"
                ? "Ollama Cloud web search returns bounded source snippets."
                : "Serper provides a hosted Google Search API.",
        },
        {
          title:
            providerId === "kagi"
              ? "Second Kagi source"
              : providerId === "ollama"
                ? "Second Ollama source"
                : "Second Serper source",
          url:
            providerId === "kagi"
              ? "https://example.test/kagi-second"
              : providerId === "ollama"
                ? "https://example.test/ollama-second"
                : "https://example.test/serper-second",
          text:
            providerId === "kagi"
              ? "A second untrusted Kagi result."
              : providerId === "ollama"
                ? "A second untrusted Ollama Cloud result."
                : "A second untrusted Serper result.",
        },
      ],
      untrusted: true,
    });
  }
});

test("HTTP categories, redirect policy, and malformed bodies stay closed and secret-free", async () => {
  const providers = ["kagi", "ollama", "serper"] as const;
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

  const adapter = createOllamaCloudWebSearchAdapter({
    fetch: async () => new Response(PRIVATE_BODY, { status: 401 }),
  });
  await assert.rejects(
    adapter.search(adapterRequest(undefined, "ollama")),
    (error: unknown) =>
      error instanceof WebSearchError &&
      error.kind === "auth" &&
      error.providerId === "ollama" &&
      !error.message.includes(PRIVATE_BODY) &&
      !error.message.includes(PRIVATE_KEY),
  );

  const redirectAdapter = createKagiWebSearchAdapter({
    fetch: async () => {
      throw new TypeError("redirect mode is error and a redirect was received");
    },
  });
  await assert.rejects(
    redirectAdapter.search(adapterRequest(undefined, "kagi")),
    (error: unknown) => error instanceof WebSearchError && error.kind === "config",
  );

  const malformedAdapter = createSerperWebSearchAdapter({
    fetch: async () => new Response("not-json", { status: 200 }),
  });
  await assert.rejects(
    malformedAdapter.search(adapterRequest(undefined, "serper")),
    (error: unknown) => error instanceof WebSearchError && error.kind === "invalid-response",
  );
});

test("declared and streamed response byte bounds apply to each batch adapter", async () => {
  for (const factory of [
    createKagiWebSearchAdapter,
    createOllamaCloudWebSearchAdapter,
    createSerperWebSearchAdapter,
  ] as const) {
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
    await assert.rejects(
      declaredOversize.search(adapterRequest()),
      (error: unknown) => error instanceof WebSearchError && error.kind === "invalid-response",
    );

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
    await assert.rejects(
      streamedOversize.search(adapterRequest()),
      (error: unknown) => error instanceof WebSearchError && error.kind === "invalid-response",
    );
  }
});

test("API keys and malformed credentials fail closed without echoing input", () => {
  for (const build of [
    () => buildKagiWebSearchRequest("query", 1, `${PRIVATE_KEY}\n`),
    () => buildOllamaCloudWebSearchRequest("query", 1, `${PRIVATE_KEY}\r`),
    () => buildSerperWebSearchRequest("query", 1, ""),
  ]) {
    assert.throws(build, (error: unknown) => {
      assert.ok(error instanceof WebSearchError);
      assert.equal(error.kind, "auth");
      assert.equal(error.message.includes(PRIVATE_KEY), false);
      return true;
    });
  }
});

test("API-key adapters reject anonymous or mismatched credential modes before fetch", async () => {
  const factories: readonly [WebSearchAdapterFactory, "kagi" | "ollama" | "serper"][] = [
    [createKagiWebSearchAdapter, "kagi"],
    [createOllamaCloudWebSearchAdapter, "ollama"],
    [createSerperWebSearchAdapter, "serper"],
  ];
  for (const [factory, providerId] of factories) {
    let fetchCalled = false;
    const adapter = factory({
      fetch: async () => {
        fetchCalled = true;
        return new Response("{}", { status: 200 });
      },
    });
    await assert.rejects(
      adapter.search({
        ...adapterRequest(undefined, providerId),
        credentialMode: "anonymous",
      }),
      (error: unknown) =>
        error instanceof WebSearchError && error.kind === "auth" && error.providerId === providerId,
    );
    assert.equal(fetchCalled, false);
  }
});

test("caller cancellation reaches every adapter and maps to a closed cancellation error", async () => {
  const cases: readonly [WebSearchAdapterFactory, "kagi" | "ollama" | "serper"][] = [
    [createKagiWebSearchAdapter, "kagi"],
    [createOllamaCloudWebSearchAdapter, "ollama"],
    [createSerperWebSearchAdapter, "serper"],
  ];
  for (const [factory, providerId] of cases) {
    const controller = new AbortController();
    let signalSeen: AbortSignal | undefined;
    const adapter = factory({
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
    const pending = adapter.search(adapterRequest(controller.signal, providerId));
    controller.abort();
    await assert.rejects(
      pending,
      (error: unknown) =>
        error instanceof WebSearchError &&
        error.kind === "cancelled" &&
        error.providerId === providerId,
    );
    assert.equal(signalSeen, controller.signal);
  }
});

test("batch factory map exposes exactly Kagi, Ollama Cloud, and Serper", () => {
  assert.deepEqual(Object.keys(WEB_SEARCH_WAVE2_BATCH_B_ADAPTER_FACTORIES).sort(), [
    "kagi",
    "ollama",
    "serper",
  ]);
  for (const providerId of ["kagi", "ollama", "serper"] as const) {
    assert.equal(typeof WEB_SEARCH_WAVE2_BATCH_B_ADAPTER_FACTORIES[providerId], "function");
  }
});
