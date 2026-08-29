import assert from "node:assert/strict";
import test from "node:test";

import { WebSearchService } from "./web-search.js";
import {
  freshWebSearchSettings,
  type WebSearchSettingsV2,
} from "./web-search-provider-registry-core.js";
import { WebSearchError, webSearchError, type WebSearchResultSet } from "./web-search-core.js";
import type { WebSearchAdapter, WebSearchAdapterFactory } from "./web-search-provider-registry.js";
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
