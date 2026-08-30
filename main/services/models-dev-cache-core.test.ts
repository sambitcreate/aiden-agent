import assert from "node:assert/strict";
import test from "node:test";
import {
  fetchModelsDevCatalog,
  MODELS_DEV_CACHE_SCHEMA_VERSION,
  MODELS_DEV_ENDPOINT,
  ModelsDevCacheRuntime,
  type ModelsDevCacheDocument,
} from "./models-dev-cache-core.js";

const catalog = { openai: { models: { "gpt-test": { name: "GPT Test" } } } };

test("foreground fetch uses only the fixed anonymous models.dev request", async () => {
  let request: { input: string | URL | Request; init?: RequestInit } | null = null;
  const result = await fetchModelsDevCatalog(async (input, init) => {
    request = { input, init };
    return new Response(JSON.stringify(catalog), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }, 1_000);

  assert.deepEqual(result, catalog);
  assert.ok(request);
  const captured = request as { input: string | URL | Request; init?: RequestInit };
  assert.equal(captured.input, MODELS_DEV_ENDPOINT);
  assert.deepEqual(captured.init?.headers, { accept: "application/json" });
  assert.equal(captured.init?.method, "GET");
  assert.equal(captured.init?.redirect, "error");
  assert.equal(captured.init?.credentials, "omit");
  assert.equal(captured.init?.referrerPolicy, "no-referrer");
});

test("cache hydration is same-version only and refresh publishes after durable write", async () => {
  let document: ModelsDevCacheDocument = {
    schemaVersion: MODELS_DEV_CACHE_SCHEMA_VERSION,
    appVersion: "old",
    fetchedAt: "2026-01-01T00:00:00.000Z",
    catalog,
  };
  let writes = 0;
  const newer = { anthropic: { models: { newest: { name: "Newest" } } } };
  const runtime = new ModelsDevCacheRuntime({
    appVersion: () => "current",
    store: {
      read: async () => document,
      write: async (next) => {
        writes += 1;
        document = next;
      },
    },
    fetchCatalog: async () => newer,
    now: () => new Date("2026-08-30T12:00:00.000Z"),
  });

  const fallback = { google: { models: { fallback: { name: "Fallback" } } } };
  assert.equal(await runtime.catalog(fallback), fallback);
  assert.deepEqual(await runtime.status(), { source: "bundled", fetchedAt: null });
  const [first, second] = await Promise.all([runtime.refresh(), runtime.refresh()]);
  assert.equal(writes, 1);
  assert.equal(first.catalog, second.catalog);
  assert.deepEqual(await runtime.catalog(fallback), newer);
  assert.deepEqual(await runtime.status(), {
    source: "device-cache",
    fetchedAt: "2026-08-30T12:00:00.000Z",
  });
});

test("a failed refresh preserves last-known-good cache", async () => {
  const document: ModelsDevCacheDocument = {
    schemaVersion: MODELS_DEV_CACHE_SCHEMA_VERSION,
    appVersion: "current",
    fetchedAt: "2026-08-30T11:00:00.000Z",
    catalog,
  };
  let writes = 0;
  const runtime = new ModelsDevCacheRuntime({
    appVersion: () => "current",
    store: {
      read: async () => document,
      write: async () => {
        writes += 1;
      },
    },
    fetchCatalog: async () => {
      throw new Error("offline");
    },
  });
  await assert.rejects(runtime.refresh(), /offline/u);
  assert.equal(writes, 0);
  assert.equal(await runtime.catalog({}), catalog);
});

test("foreground fetch rejects redirects, malformed data, and unsafe numeric limits", async () => {
  await assert.rejects(
    fetchModelsDevCatalog(async () => new Response("redirect", { status: 302 }), 1_000),
    /HTTP 302/u,
  );
  await assert.rejects(
    fetchModelsDevCatalog(async () => new Response("{"), 1_000),
    /malformed JSON/u,
  );
  await assert.rejects(
    fetchModelsDevCatalog(
      async () =>
        new Response(
          JSON.stringify({
            openai: {
              models: { unsafe: { name: "Unsafe", limit: { context: 99_000_000_000 } } },
            },
          }),
        ),
      1_000,
    ),
    /non-negative number/u,
  );
});

test("foreground fetch enforces its deadline when a fetch implementation ignores abort", async () => {
  await assert.rejects(
    fetchModelsDevCatalog(() => new Promise<Response>(() => undefined), 10),
    /refresh deadline/u,
  );
});
