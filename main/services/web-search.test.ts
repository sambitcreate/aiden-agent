import assert from "node:assert/strict";
import test from "node:test";

import { WebSearchService } from "./web-search.js";
import {
  freshWebSearchSettings,
  type WebSearchProviderId,
  type WebSearchSettingsV2,
} from "./web-search-provider-registry-core.js";
import { WebSearchError, webSearchError, type WebSearchResultSet } from "./web-search-core.js";
import type { WebSearchAdapter, WebSearchAdapterFactory } from "./web-search-provider-registry.js";
import {
  OPENAI_WEB_SEARCH_RESPONSES_ENDPOINT,
  type WebSearchExistingAuthRendererStatus,
} from "./web-search-auth-reuse-core.js";
import type { WebSearchResolvedExistingAuth } from "./web-search-auth-reuse.js";
import type { AppSettings } from "./types.js";

const PRIVATE_KEY = "exa-key-private-7dbfe9";
const QUERY = "current Exa documentation";

function rpcBody(results: readonly Record<string, string>[]): string {
  return JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    result: {
      content: [
        {
          type: "text",
          text: JSON.stringify({ results }),
        },
      ],
    },
  });
}

function response(body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: { "content-type": "application/json" },
  });
}

function evidence(providerId: "exa" | "parallel-mcp" = "exa"): WebSearchResultSet {
  return {
    providerId,
    untrusted: true,
    results: [{ title: "Result", url: "https://example.test/result", text: "Evidence" }],
  };
}

function adapter(
  providerId: "exa" | "parallel-mcp",
  search: WebSearchAdapter["search"],
): WebSearchAdapterFactory {
  return () => ({ providerId, adapterVersion: 1, search });
}

function anyAdapter(
  providerId: WebSearchProviderId,
  search: WebSearchAdapter["search"],
): WebSearchAdapterFactory {
  return () => ({ providerId, adapterVersion: 1, search });
}

function baseSettings(selection: WebSearchSettingsV2["selection"]): AppSettings {
  return { webSearch: { ...freshWebSearchSettings(), selection } };
}

test("fresh foreground construction persists the anonymous Exa route and sends no key", async () => {
  let persisted: AppSettings["webSearch"];
  let requestUrl = "";
  let requestInit: RequestInit | undefined;
  const service = new WebSearchService({
    getMigrationEvidence: async () => ({ seeded: false }),
    getSettings: async () => ({}),
    persistSettings: async (patch) => {
      persisted = patch.webSearch;
    },
    fetch: async (input, init) => {
      requestUrl = String(input);
      requestInit = init;
      return response(rpcBody([{ title: "Exa docs", url: "https://exa.ai/docs", text: "Docs" }]));
    },
  });

  const tool = await service.toolForGeneration();
  assert.ok(tool);
  assert.equal(tool.name, "web_search");
  assert.equal(tool.description.includes("untrusted"), true);
  const result = await tool.execute(
    "call-1",
    { query: `  ${QUERY}  ` },
    new AbortController().signal,
  );
  const firstContent = result.content[0];
  assert.ok(firstContent && firstContent.type === "text");
  assert.deepEqual(JSON.parse(firstContent.text), {
    providerId: "exa",
    results: [{ title: "Exa docs", url: "https://exa.ai/docs", text: "Docs" }],
    untrusted: true,
  });
  assert.equal(requestUrl, "https://mcp.exa.ai/mcp?tools=web_search_exa");
  assert.equal((requestInit?.headers as Record<string, string>)?.["x-api-key"], undefined);
  assert.equal(JSON.stringify(requestInit).includes(PRIVATE_KEY), false);
  assert.deepEqual(persisted, freshWebSearchSettings());
  const availability = await service.availability();
  assert.equal(availability.enabled, true);
  assert.equal(availability.ready, true);
  assert.equal(JSON.stringify(availability).includes(PRIVATE_KEY), false);
});

test("legacy keyed Exa migration uses a fixed API-key snapshot without putting the key in the request body", async () => {
  let requestInit: RequestInit | undefined;
  const service = new WebSearchService({
    getMigrationEvidence: async () => ({ seeded: true }),
    getSettings: async () => ({ exaEnabled: true }),
    getCredential: async () => PRIVATE_KEY,
    persistSettings: async () => undefined,
    fetch: async (_input, init) => {
      requestInit = init;
      return response(
        rpcBody([{ title: "Keyed", url: "https://example.test/keyed", text: "Keyed" }]),
      );
    },
  });

  const snapshot = await service.snapshot();
  assert.deepEqual(snapshot.route, {
    mode: "fixed",
    route: [{ providerId: "exa", credentialMode: "api-key" }],
    fallbackOn: [],
  });
  const result = await service.search({ query: QUERY });
  assert.equal(result.providerId, "exa");
  assert.equal((requestInit?.headers as Record<string, string>)?.["x-api-key"], PRIVATE_KEY);
  assert.equal(requestInit?.body?.toString().includes(PRIVATE_KEY), false);
  assert.equal(JSON.stringify(snapshot).includes(PRIVATE_KEY), false);
});

test("keyed Wave 1 routes read only the routed provider credential and publish results", async () => {
  const calls: string[] = [];
  const requestInits: RequestInit[] = [];
  const service = new WebSearchService({
    getSettings: async () => ({
      webSearch: {
        ...freshWebSearchSettings(),
        selection: { mode: "fixed", providerId: "perplexity", credentialMode: "api-key" },
      },
    }),
    getCredential: async (providerId) => {
      calls.push(providerId);
      return providerId === "perplexity" ? PRIVATE_KEY : undefined;
    },
    fetch: async (input, init) => {
      assert.equal(String(input), "https://api.perplexity.ai/chat/completions");
      requestInits.push(init ?? {});
      return response(
        JSON.stringify({
          citations: [
            {
              title: "Perplexity source",
              url: "https://example.test/perplexity-source",
              snippet: "Perplexity evidence",
            },
          ],
        }),
      );
    },
  });

  const availability = await service.availability();
  assert.equal(availability.ready, true);
  assert.deepEqual(availability.route, [
    { providerId: "perplexity", ready: true, configurationStatus: "configured" },
  ]);
  const result = await service.search({ query: "current Perplexity documentation" });
  assert.equal(result.providerId, "perplexity");
  assert.equal(result.results[0]?.url, "https://example.test/perplexity-source");
  assert.deepEqual(calls, ["perplexity", "perplexity"]);
  const headers = requestInits[0]?.headers as Record<string, string>;
  assert.equal(headers.Authorization, `Bearer ${PRIVATE_KEY}`);
  assert.equal(JSON.stringify(requestInits[0]).includes(PRIVATE_KEY), true);
  assert.equal(requestInits[0]?.body?.toString().includes(PRIVATE_KEY), false);
});

test("a keyed Wave 1 route without its provider credential is closed before fetch", async () => {
  const calls: string[] = [];
  let fetchCalls = 0;
  const service = new WebSearchService({
    getSettings: async () => ({
      webSearch: {
        ...freshWebSearchSettings(),
        selection: { mode: "fixed", providerId: "gemini", credentialMode: "api-key" },
      },
    }),
    getCredential: async (providerId) => {
      calls.push(providerId);
      return undefined;
    },
    fetch: async () => {
      fetchCalls += 1;
      return response("{}");
    },
  });

  const availability = await service.availability();
  assert.equal(availability.ready, false);
  assert.deepEqual(availability.route, [
    { providerId: "gemini", ready: false, configurationStatus: "needs-setup" },
  ]);
  await assert.rejects(
    service.search({ query: "current Gemini documentation" }),
    (error: unknown) =>
      error instanceof WebSearchError && error.kind === "config" && error.providerId === "gemini",
  );
  assert.deepEqual(calls, ["gemini", "gemini"]);
  assert.equal(fetchCalls, 0);
});

test("Parallel MCP supports anonymous and keyed routes without cross-reading credentials", async () => {
  const parallelBody = JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    result: {
      structuredContent: {
        results: [
          {
            title: "Parallel source",
            url: "https://example.test/parallel",
            excerpts: ["Evidence"],
          },
        ],
      },
    },
  });
  const run = async (
    credentialMode: "anonymous" | "api-key",
  ): Promise<{ calls: string[]; init: RequestInit | undefined; result: WebSearchResultSet }> => {
    const calls: string[] = [];
    let requestInit: RequestInit | undefined;
    const service = new WebSearchService({
      getSettings: async () => ({
        webSearch: {
          ...freshWebSearchSettings(),
          selection: { mode: "fixed", providerId: "parallel-mcp", credentialMode },
        },
      }),
      getCredential: async (providerId) => {
        calls.push(providerId);
        return providerId === "parallel-mcp" ? PRIVATE_KEY : undefined;
      },
      fetch: async (_input, init) => {
        requestInit = init;
        return response(parallelBody);
      },
    });
    const result = await service.search({ query: "current Parallel documentation" });
    return { calls, init: requestInit, result };
  };

  const anonymous = await run("anonymous");
  assert.deepEqual(anonymous.calls, []);
  assert.equal(anonymous.result.providerId, "parallel-mcp");
  assert.equal((anonymous.init?.headers as Record<string, string>)?.Authorization, undefined);

  const keyed = await run("api-key");
  assert.deepEqual(keyed.calls, ["parallel-mcp"]);
  assert.equal(keyed.result.providerId, "parallel-mcp");
  assert.equal(
    (keyed.init?.headers as Record<string, string>)?.Authorization,
    `Bearer ${PRIVATE_KEY}`,
  );
  assert.equal(keyed.init?.body?.toString().includes(PRIVATE_KEY), false);
});

test("enabled routes without a ready adapter do not publish an unusable tool", async () => {
  const service = new WebSearchService({
    getSettings: async () => ({
      webSearch: {
        ...freshWebSearchSettings(),
        selection: { mode: "fixed", providerId: "exa", credentialMode: "api-key" },
      },
    }),
    getCredential: async () => undefined,
  });

  assert.equal(await service.toolForGeneration(), undefined);
  const availability = await service.availability();
  assert.equal(availability.enabled, true);
  assert.equal(availability.ready, false);
  assert.deepEqual(availability.route, [
    { providerId: "exa", ready: false, configurationStatus: "needs-setup" },
  ]);
});

test("automatic routing charges each sent attempt, preserves order, and falls back only on selected errors", async () => {
  const calls: string[] = [];
  const revalidated: string[] = [];
  const service = new WebSearchService({
    getSettings: async () =>
      baseSettings({
        mode: "automatic",
        route: [
          { providerId: "exa", credentialMode: "anonymous" },
          { providerId: "parallel-mcp", credentialMode: "anonymous" },
        ],
        fallbackOn: ["quota"],
      }),
    adapterFactories: {
      exa: adapter("exa", async () => {
        throw webSearchError("quota", "exa");
      }),
      "parallel-mcp": adapter("parallel-mcp", async () => evidence("parallel-mcp")),
    },
  });

  const result = await service.search(
    { query: QUERY },
    {
      beforeProviderAttempt: (providerId) => {
        calls.push(providerId);
      },
      revalidateAfterAttempt: (providerId) => {
        revalidated.push(providerId);
        return true;
      },
    },
  );
  assert.equal(result.providerId, "parallel-mcp");
  assert.deepEqual(calls, ["exa", "parallel-mcp"]);
  assert.deepEqual(revalidated, ["parallel-mcp"]);
});

test("fixed routing never falls back and a failed post-I/O revalidation never publishes evidence", async () => {
  let fixedCalls = 0;
  const fixed = new WebSearchService({
    getSettings: async () =>
      baseSettings({ mode: "fixed", providerId: "exa", credentialMode: "anonymous" }),
    adapterFactories: {
      exa: adapter("exa", async () => {
        fixedCalls += 1;
        throw webSearchError("quota", "exa");
      }),
      "parallel-mcp": adapter("parallel-mcp", async () => evidence("parallel-mcp")),
    },
  });
  await assert.rejects(
    fixed.search({ query: QUERY }, { signal: new AbortController().signal }),
    (error: unknown) => error instanceof WebSearchError && error.kind === "quota",
  );
  assert.equal(fixedCalls, 1);

  const fenced = new WebSearchService({
    getSettings: async () => ({ webSearch: freshWebSearchSettings() }),
    adapterFactories: { exa: adapter("exa", async () => evidence()) },
  });
  await assert.rejects(
    fenced.search({ query: QUERY }, { revalidateAfterAttempt: () => false }),
    (error: unknown) => error instanceof WebSearchError && error.kind === "unavailable",
  );
});

test("the pre-attempt fence can refuse a later automatic destination without issuing its request", async () => {
  let secondRequest = false;
  const service = new WebSearchService({
    getSettings: async () =>
      baseSettings({
        mode: "automatic",
        route: [
          { providerId: "exa", credentialMode: "anonymous" },
          { providerId: "parallel-mcp", credentialMode: "anonymous" },
        ],
        fallbackOn: ["quota"],
      }),
    adapterFactories: {
      exa: adapter("exa", async () => {
        throw webSearchError("quota", "exa");
      }),
      "parallel-mcp": adapter("parallel-mcp", async () => {
        secondRequest = true;
        return evidence("parallel-mcp");
      }),
    },
  });
  await assert.rejects(
    service.search(
      { query: QUERY },
      {
        beforeProviderAttempt: (providerId) => {
          if (providerId === "parallel-mcp") throw webSearchError("unavailable", providerId);
        },
      },
    ),
    (error: unknown) => error instanceof WebSearchError && error.kind === "unavailable",
  );
  assert.equal(secondRequest, false);
});

test("timeout and caller cancellation are closed before a result can escape", async () => {
  let aborted = false;
  const service = new WebSearchService({
    getSettings: async () => ({ webSearch: freshWebSearchSettings() }),
    timeoutMs: 5,
    adapterFactories: {
      exa: adapter(
        "exa",
        ({ signal }) =>
          new Promise((_resolve, reject) => {
            signal.addEventListener(
              "abort",
              () => {
                aborted = true;
                reject(new DOMException("aborted", "AbortError"));
              },
              { once: true },
            );
          }),
      ),
    },
  });
  await assert.rejects(
    service.search({ query: QUERY }),
    (error: unknown) => error instanceof WebSearchError && error.kind === "timeout",
  );
  assert.equal(aborted, true);

  const cancelled = new AbortController();
  cancelled.abort();
  await assert.rejects(
    service.search({ query: QUERY }, cancelled.signal),
    (error: unknown) => error instanceof WebSearchError && error.kind === "cancelled",
  );
});

function openAiExistingStatus(modelId = "gpt-5.6"): WebSearchExistingAuthRendererStatus {
  return {
    targetProviderId: "openai",
    state: "ready",
    configured: true,
    sourceProviderId: "openai",
    modelId,
  };
}

function openAiExistingResolution(
  credential: string,
  modelId = "gpt-5.6",
): WebSearchResolvedExistingAuth {
  return {
    targetProviderId: "openai",
    sourceProviderId: "openai",
    modelId,
    modelApi: "openai-responses",
    endpoint: OPENAI_WEB_SEARCH_RESPONSES_ENDPOINT,
    credential,
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${credential}`,
      "Content-Type": "application/json",
    },
  };
}

test("existing-auth readiness is bound to the attempted provider identity", async () => {
  let adapterCalls = 0;
  const service = new WebSearchService({
    getSettings: async () =>
      baseSettings({
        mode: "fixed",
        providerId: "xai",
        credentialMode: "existing-provider-auth",
      }),
    getExistingAuthStatus: async () => openAiExistingStatus(),
    resolveExistingAuth: async () => openAiExistingResolution("bound-openai-key"),
    adapterFactories: {
      xai: anyAdapter("xai", async () => {
        adapterCalls += 1;
        return {
          providerId: "xai",
          untrusted: true,
          results: [],
        };
      }),
    },
  });

  const availability = await service.availability();
  assert.deepEqual(availability.route, [
    { providerId: "xai", ready: false, configurationStatus: "needs-setup" },
  ]);
  await assert.rejects(
    service.search({ query: QUERY }),
    (error: unknown) =>
      error instanceof WebSearchError && error.kind === "config" && error.providerId === "xai",
  );
  assert.equal(adapterCalls, 0);
});

test("failed existing-auth resolution does not consume an attempt or issue a request", async () => {
  let beforeAttemptCalls = 0;
  let adapterCalls = 0;
  const service = new WebSearchService({
    getSettings: async () =>
      baseSettings({
        mode: "fixed",
        providerId: "openai",
        credentialMode: "existing-provider-auth",
      }),
    getExistingAuthStatus: async () => openAiExistingStatus(),
    resolveExistingAuth: async () => {
      throw new Error("binding revoked");
    },
    adapterFactories: {
      openai: anyAdapter("openai", async () => {
        adapterCalls += 1;
        return { providerId: "openai", untrusted: true, results: [] };
      }),
    },
  });

  await assert.rejects(
    service.search(
      { query: QUERY },
      { beforeProviderAttempt: () => void (beforeAttemptCalls += 1) },
    ),
    (error: unknown) =>
      error instanceof WebSearchError && error.kind === "auth" && error.providerId === "openai",
  );
  assert.equal(beforeAttemptCalls, 0);
  assert.equal(adapterCalls, 0);
});

test("same-model key re-consent during deferred I/O fences old evidence before publication", async () => {
  const firstKey = "existing-key-before-reconsent";
  const replacementKey = "existing-key-after-reconsent";
  let currentKey = firstKey;
  let adapterStartedResolve: (() => void) | undefined;
  const adapterStarted = new Promise<void>((resolve) => {
    adapterStartedResolve = resolve;
  });
  let releaseResponse: (() => void) | undefined;
  const responseReady = new Promise<void>((resolve) => {
    releaseResponse = resolve;
  });
  let adapterCalls = 0;
  const service = new WebSearchService({
    getSettings: async () =>
      baseSettings({
        mode: "fixed",
        providerId: "openai",
        credentialMode: "existing-provider-auth",
      }),
    // The redacted projection remains ready with the same model, which is why
    // post-I/O validation must use the exact main-only resolution below.
    getExistingAuthStatus: async () => openAiExistingStatus(),
    resolveExistingAuth: async () => openAiExistingResolution(currentKey),
    adapterFactories: {
      openai: anyAdapter("openai", async () => {
        adapterCalls += 1;
        adapterStartedResolve?.();
        await responseReady;
        return { providerId: "openai", untrusted: true, results: [] };
      }),
    },
  });

  const request = service.search({ query: QUERY });
  await adapterStarted;
  currentKey = replacementKey;
  releaseResponse?.();
  await assert.rejects(
    request,
    (error: unknown) =>
      error instanceof WebSearchError && error.kind === "auth" && error.providerId === "openai",
  );
  assert.equal(adapterCalls, 1);
});

test("revocation during deferred existing-auth I/O fences evidence before publication", async () => {
  let revoked = false;
  let adapterStartedResolve: (() => void) | undefined;
  const adapterStarted = new Promise<void>((resolve) => {
    adapterStartedResolve = resolve;
  });
  let releaseResponse: (() => void) | undefined;
  const responseReady = new Promise<void>((resolve) => {
    releaseResponse = resolve;
  });
  let adapterCalls = 0;
  const service = new WebSearchService({
    getSettings: async () =>
      baseSettings({
        mode: "fixed",
        providerId: "openai",
        credentialMode: "existing-provider-auth",
      }),
    getExistingAuthStatus: async () => openAiExistingStatus(),
    resolveExistingAuth: async () => {
      if (revoked) throw new Error("binding revoked");
      return openAiExistingResolution("existing-key-before-revoke");
    },
    adapterFactories: {
      openai: anyAdapter("openai", async () => {
        adapterCalls += 1;
        adapterStartedResolve?.();
        await responseReady;
        return { providerId: "openai", untrusted: true, results: [] };
      }),
    },
  });

  const request = service.search({ query: QUERY });
  await adapterStarted;
  revoked = true;
  releaseResponse?.();
  await assert.rejects(
    request,
    (error: unknown) =>
      error instanceof WebSearchError && error.kind === "auth" && error.providerId === "openai",
  );
  assert.equal(adapterCalls, 1);
});
