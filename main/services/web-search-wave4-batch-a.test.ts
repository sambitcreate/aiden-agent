import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  SERPDIVE_WEB_SEARCH_ENDPOINT,
  SERPDIVE_WEB_SEARCH_MODEL,
  SERPDIVE_WEB_SEARCH_ORIGIN,
  SERPDIVE_WEB_SEARCH_QUERY_MAX_CHARS,
  buildSerpDiveWebSearchRequest,
  createSerpDiveWebSearchAdapter,
  parseSerpDiveWebSearchResponse,
  serpDiveWebSearchAdapterFactory,
} from "./web-search-serpdive-adapter.js";
import {
  WEB_SEARCH_API_KEY_MAX_CHARS,
  WEB_SEARCH_JSON_RESPONSE_MAX_BYTES,
  mapWebSearchJsonHttpError,
} from "./web-search-json-adapter.js";
import { WebSearchError } from "./web-search-core.js";
import type { WebSearchAdapterRequest, WebSearchFetch } from "./web-search-provider-registry.js";
import { WEB_SEARCH_WAVE4_BATCH_A_ADAPTER_FACTORIES } from "./web-search-wave4-batch-a.js";

const PRIVATE_KEY = "wave4-batch-a-private-key-5f6a7b";
const PRIVATE_BODY = "WAVE4_BATCH_A_PRIVATE_UPSTREAM_BODY_5f6a7b";

async function fixture(name: string): Promise<string> {
  return readFile(new URL(`./fixtures/serpdive-search/${name}`, import.meta.url), "utf8");
}

function adapterRequest(signal = new AbortController().signal): WebSearchAdapterRequest {
  return {
    query: "current serpdive documentation",
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

test("SERPdive builder uses the reviewed free krill request and header-only credentials", () => {
  const request = buildSerpDiveWebSearchRequest("  current SERPdive docs  ", 2, {
    mode: "api-key",
    apiKey: `  ${PRIVATE_KEY}  `,
  });
  assert.equal(request.url, SERPDIVE_WEB_SEARCH_ENDPOINT);
  assert.equal(new URL(request.url).origin, SERPDIVE_WEB_SEARCH_ORIGIN);
  assert.equal(request.init.method, "POST");
  assertSecureRequest(request.init);
  assert.deepEqual(request.init.headers, {
    Accept: "application/json",
    Authorization: `Bearer ${PRIVATE_KEY}`,
    "Content-Type": "application/json",
  });
  assert.deepEqual(JSON.parse(request.init.body ?? ""), {
    query: "current SERPdive docs",
    model: SERPDIVE_WEB_SEARCH_MODEL,
    max_results: 2,
  });
  assert.equal(request.init.body?.includes(PRIVATE_KEY), false);
  assert.equal(request.url.includes(PRIVATE_KEY), false);

  assert.throws(
    () =>
      buildSerpDiveWebSearchRequest(
        "x".repeat(SERPDIVE_WEB_SEARCH_QUERY_MAX_CHARS + 1),
        1,
        PRIVATE_KEY,
      ),
    (error: unknown) => {
      assertNoSecretInError(error);
      assert.equal(error.kind, "invalid-request");
      return true;
    },
  );
});

test("SERPdive parser maps its deterministic response and error fixtures safely", async () => {
  assert.deepEqual(
    parseSerpDiveWebSearchResponse(JSON.parse(await fixture("json-success.json")), 2),
    {
      results: [
        {
          title: "SERPdive API documentation",
          url: "https://serpdive.com/docs",
          text: "SERPdive returns source content for web search grounding.",
        },
        {
          title: "Second SERPdive source",
          url: "https://example.test/serpdive-second",
          text: "A second untrusted SERPdive result.",
        },
      ],
    },
  );
  assert.equal(
    parseSerpDiveWebSearchResponse(JSON.parse(await fixture("malformed.json")), 2),
    undefined,
  );
  const httpErrors = JSON.parse(await fixture("http-errors.json"));
  assert.throws(
    () => parseSerpDiveWebSearchResponse(httpErrors, 2),
    (error: unknown) => {
      assertNoSecretInError(error);
      assert.equal(error.kind, "quota");
      assert.equal(error.providerId, "serpdive");
      return true;
    },
  );

  const unsafe = parseSerpDiveWebSearchResponse(
    {
      results: [
        { url: `https://user:password@example.test/${PRIVATE_KEY}`, title: PRIVATE_BODY },
        { url: `https://example.test/${PRIVATE_KEY}\nunsafe`, title: PRIVATE_BODY },
        { url: "https://example.test/safe", title: "Safe", content: "safe" },
      ],
    },
    3,
  );
  assert.equal(JSON.stringify(unsafe).includes(PRIVATE_BODY), false);
  assert.equal(JSON.stringify(unsafe).includes(PRIVATE_KEY), false);
});

test("SERPdive factory applies shared transport bounds and attribution", async () => {
  const body = await fixture("json-success.json");
  const calls: Array<{ input: string; init: RequestInit | undefined }> = [];
  const fetch: WebSearchFetch = async (input, init) => {
    calls.push({ input: String(input), init });
    return new Response(body, {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  const adapter = createSerpDiveWebSearchAdapter({ fetch });
  const result = await adapter.search(adapterRequest());
  assert.equal(calls.length, 1);
  assert.equal(new URL(calls[0]?.input ?? "").origin, SERPDIVE_WEB_SEARCH_ORIGIN);
  assertSecureRequest(calls[0]?.init);
  assert.equal(calls[0]?.init?.signal instanceof AbortSignal, true);
  assert.equal(result.providerId, "serpdive");
  assert.equal(result.untrusted, true);
  assert.equal(result.results.length, 2);

  assert.deepEqual(Object.keys(WEB_SEARCH_WAVE4_BATCH_A_ADAPTER_FACTORIES), ["serpdive"]);
  const factory = WEB_SEARCH_WAVE4_BATCH_A_ADAPTER_FACTORIES.serpdive;
  assert.equal(factory, serpDiveWebSearchAdapterFactory);
  assert.equal(factory().providerId, "serpdive");
  assert.equal(factory().adapterVersion, 1);
});

test("SERPdive HTTP, redirect, malformed, and response-size failures stay closed", async () => {
  for (const [status, kind] of [
    [400, "invalid-request"],
    [401, "auth"],
    [403, "auth"],
    [408, "timeout"],
    [429, "quota"],
    [500, "transient"],
  ] as const) {
    const error = mapWebSearchJsonHttpError("serpdive", status);
    assert.equal(error.kind, kind);
    assert.equal(error.providerId, "serpdive");
    assertNoSecretInError(error);
  }

  const redirect = createSerpDiveWebSearchAdapter({
    fetch: async () => {
      throw new TypeError("redirect mode is error and a redirect was received");
    },
  });
  await assert.rejects(redirect.search(adapterRequest()), (error: unknown) => {
    assertNoSecretInError(error);
    assert.equal(error.kind, "config");
    return true;
  });

  const malformed = createSerpDiveWebSearchAdapter({
    fetch: async () => new Response(PRIVATE_BODY, { status: 200 }),
  });
  await assert.rejects(malformed.search(adapterRequest()), (error: unknown) => {
    assertNoSecretInError(error);
    assert.equal(error.kind, "invalid-response");
    return true;
  });

  const declaredOversize = createSerpDiveWebSearchAdapter({
    fetch: async () =>
      new Response("{}", {
        status: 200,
        headers: {
          "content-type": "application/json",
          "content-length": String(WEB_SEARCH_JSON_RESPONSE_MAX_BYTES + 1),
        },
      }),
  });
  await assert.rejects(declaredOversize.search(adapterRequest()), (error: unknown) => {
    assertNoSecretInError(error);
    assert.equal(error.kind, "invalid-response");
    return true;
  });

  const streamedOversize = createSerpDiveWebSearchAdapter({
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
  await assert.rejects(streamedOversize.search(adapterRequest()), (error: unknown) => {
    assertNoSecretInError(error);
    assert.equal(error.kind, "invalid-response");
    return true;
  });
});

test("SERPdive credentials and caller cancellation fail closed", async () => {
  for (const credential of ["", `${PRIVATE_KEY}\n`, "x".repeat(WEB_SEARCH_API_KEY_MAX_CHARS + 1)]) {
    assert.throws(
      () => buildSerpDiveWebSearchRequest("query", 1, credential),
      (error: unknown) => {
        assertNoSecretInError(error);
        assert.equal(error.kind, "auth");
        return true;
      },
    );
  }

  let fetchCalled = false;
  const adapter = createSerpDiveWebSearchAdapter({
    fetch: async () => {
      fetchCalled = true;
      return new Response("{}", { status: 200 });
    },
  });
  await assert.rejects(
    adapter.search({
      ...adapterRequest(),
      credentialMode: "anonymous",
    }),
    (error: unknown) => {
      assertNoSecretInError(error);
      assert.equal(error.kind, "auth");
      return true;
    },
  );
  assert.equal(fetchCalled, false);

  const controller = new AbortController();
  let signalSeen: AbortSignal | undefined;
  const cancelling = createSerpDiveWebSearchAdapter({
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
  const pending = cancelling.search(adapterRequest(controller.signal));
  controller.abort();
  await assert.rejects(pending, (error: unknown) => {
    assertNoSecretInError(error);
    assert.equal(error.kind, "cancelled");
    return true;
  });
  assert.equal(signalSeen, controller.signal);

  const timeoutController = new AbortController();
  const timeoutAdapter = createSerpDiveWebSearchAdapter({
    fetch: async () => {
      timeoutController.abort();
      throw new DOMException("aborted", "AbortError");
    },
  });
  await assert.rejects(
    timeoutAdapter.search({
      ...adapterRequest(timeoutController.signal),
      timedOut: () => true,
    }),
    (error: unknown) => {
      assertNoSecretInError(error);
      assert.equal(error.kind, "timeout");
      return true;
    },
  );
});
