import assert from "node:assert/strict";
import { test } from "node:test";

import {
  InMemoryCredentialStore,
  type Api,
  type Credential,
  type CredentialStore,
  type Model,
  type ModelsStoreEntry,
  type ProviderModelsStore,
} from "@earendil-works/pi-ai";
import { builtinModels, builtinProviders } from "@earendil-works/pi-ai/providers/all";

import {
  projectPiCatalogRefreshErrors,
  refreshPiCatalogs,
  staleCatalogProviderIds,
} from "./pi-catalog-refresh.js";
import {
  AIDEN_PI_CATALOG_USER_AGENT,
  parsePiRemoteCatalog,
  PI_REMOTE_CATALOG_REFRESH_INTERVAL_MS,
  withPiRemoteCatalog,
} from "./pi-remote-catalog.js";
import { normalizePiModelsDocument } from "./pi-models-store.js";
import { concentrateProvider } from "./concentrate-provider.js";
import {
  additionalAidenPiApis,
  withAidenPiCompatibility,
  withProviderStreamOverrides,
} from "./pi-provider-compatibility.js";
import { piModelMetadataFor } from "./pi-model-metadata.js";

function opencodeGoProvider() {
  const provider = builtinProviders().find((entry) => entry.id === "opencode-go");
  assert.ok(provider, "pinned Pi must expose OpenCode Go");
  return provider;
}

function oxAlphaModel(): Model<Api> {
  const template = opencodeGoProvider().getModels()[0];
  assert.ok(template);
  return {
    ...template,
    id: "ox-alpha-free",
    name: "Ox Alpha Free (Unlimited)",
    provider: "opencode-go",
    reasoning: true,
    input: ["text", "image"],
    thinkingLevelMap: {
      off: null,
      minimal: null,
      low: "low",
      medium: null,
      high: "high",
      xhigh: null,
      max: "max",
    },
    contextWindow: 1_000_000,
    maxTokens: 131_072,
  };
}

function memoryProviderStore(initial?: ModelsStoreEntry): ProviderModelsStore & {
  snapshot(): ModelsStoreEntry | undefined;
} {
  let entry = initial === undefined ? undefined : structuredClone(initial);
  return {
    read: async () => (entry === undefined ? undefined : structuredClone(entry)),
    write: async (next) => {
      entry = structuredClone(next);
    },
    delete: async () => {
      entry = undefined;
    },
    snapshot: () => (entry === undefined ? undefined : structuredClone(entry)),
  };
}

test("remote catalog parser accepts Pi's keyed response and pins provider identity", () => {
  const model = oxAlphaModel();
  const parsed = parsePiRemoteCatalog("opencode-go", {
    [model.id]: { ...model, provider: "attacker-controlled" },
  });
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0]?.id, "ox-alpha-free");
  assert.equal(parsed[0]?.provider, "opencode-go");
  assert.throws(() => parsePiRemoteCatalog("opencode-go", { models: "wrong" }));
});

test("Ox Alpha publishes its native low, high, and max thinking contract", () => {
  assert.deepEqual(piModelMetadataFor("opencode-go", oxAlphaModel()), {
    source: "provider",
    name: "Ox Alpha Free (Unlimited)",
    type: "llm",
    vision: true,
    reasoning: true,
    thinkingLevels: ["low", "high", "max"],
    thinkingCanDisable: false,
    contextLength: 1_000_000,
  });
});

test("provider stream overrides dispatch a newly cataloged API without altering other APIs", () => {
  const original = opencodeGoProvider();
  const marker = {};
  let selected = "";
  const provider = withProviderStreamOverrides(original, {
    "openai-responses": {
      stream: (() => { selected = "responses"; return marker; }) as never,
      streamSimple: (() => { selected = "responses-simple"; return marker; }) as never,
    },
  });
  const responses = { ...oxAlphaModel(), api: "openai-responses" as const };
  assert.equal(provider.stream(responses, {} as never, {}), marker);
  assert.equal(selected, "responses");
  assert.equal(provider.streamSimple(responses, {} as never, {}), marker);
  assert.equal(selected, "responses-simple");
});

test("OpenCode Go overlay publishes ox-alpha without sending provider credentials", async () => {
  const store = memoryProviderStore();
  const requests: Array<{ url: string; headers: Headers }> = [];
  const provider = withPiRemoteCatalog(opencodeGoProvider(), {
    fetchImpl: async (input, init) => {
      requests.push({ url: String(input), headers: new Headers(init?.headers) });
      return new Response(JSON.stringify({ "ox-alpha-free": oxAlphaModel() }), {
        status: 200,
        headers: {
          etag: '"catalog-v1"',
          "last-modified": "Thu, 20 Aug 2026 16:00:00 GMT",
        },
      });
    },
    now: () => Date.parse("2026-08-20T16:01:00Z"),
  });

  await provider.refreshModels?.({
    credential: { type: "api_key", key: "must-not-leak" },
    store,
    allowNetwork: true,
    force: true,
    signal: new AbortController().signal,
  });

  assert.equal(requests.length, 1);
  assert.equal(requests[0]?.url, "https://pi.dev/api/models/providers/opencode-go");
  assert.equal(requests[0]?.headers.get("authorization"), null);
  assert.equal(requests[0]?.headers.get("x-api-key"), null);
  assert.equal(requests[0]?.headers.get("cookie"), null);
  assert.equal(requests[0]?.headers.get("user-agent"), AIDEN_PI_CATALOG_USER_AGENT);
  assert.ok(provider.getModels().some((model) => model.id === "ox-alpha-free"));
  assert.ok(store.snapshot()?.models.some((model) => model.id === "ox-alpha-free"));
});

test("cached overlays hydrate offline and honor freshness unless force refreshed", async () => {
  const checkedAt = Date.parse("2026-08-20T16:01:00Z");
  const store = memoryProviderStore({
    models: [oxAlphaModel()],
    checkedAt,
    lastModified: Date.parse("2026-08-20T16:00:00Z"),
  } as ModelsStoreEntry);
  let fetches = 0;
  const provider = withPiRemoteCatalog(opencodeGoProvider(), {
    fetchImpl: async () => {
      fetches += 1;
      return new Response(null, { status: 304 });
    },
    now: () => checkedAt + PI_REMOTE_CATALOG_REFRESH_INTERVAL_MS - 1,
  });

  await provider.refreshModels?.({ store, allowNetwork: false });
  assert.ok(provider.getModels().some((model) => model.id === "ox-alpha-free"));

  await provider.refreshModels?.({ store, allowNetwork: true });
  assert.equal(fetches, 0);

  await provider.refreshModels?.({ store, allowNetwork: true, force: true });
  assert.equal(fetches, 1);
  assert.ok(provider.getModels().some((model) => model.id === "ox-alpha-free"));
});

test("fresh empty and negative catalog results do not refetch on every launch", async () => {
  const checkedAt = Date.parse("2026-08-22T16:00:00Z");
  for (const firstResponse of [
    () => Response.json({}, { headers: { "last-modified": "Sat, 22 Aug 2026 15:59:00 GMT" } }),
    () => new Response(null, { status: 404 }),
    () => new Response(null, { status: 501 }),
  ]) {
    const store = memoryProviderStore();
    let fetches = 0;
    const provider = withPiRemoteCatalog(opencodeGoProvider(), {
      fetchImpl: async () => {
        fetches += 1;
        return firstResponse();
      },
      now: () => checkedAt,
    });
    await provider.refreshModels!({ store, allowNetwork: true });
    await provider.refreshModels!({ store, allowNetwork: true });
    assert.equal(fetches, 1);
    assert.deepEqual(store.snapshot()?.models, []);
  }
});

test("conditional refresh sends only the safe ETag validator and keeps a 304 overlay", async () => {
  const store = memoryProviderStore({
    models: [oxAlphaModel()],
    checkedAt: Date.parse("2026-08-20T16:01:00Z"),
    lastModified: Date.parse("2026-08-20T16:00:00Z"),
    etag: '"catalog-v1"',
  } as ModelsStoreEntry);
  let headers = new Headers();
  const provider = withPiRemoteCatalog(opencodeGoProvider(), {
    fetchImpl: async (_input, init) => {
      headers = new Headers(init?.headers);
      return new Response(null, { status: 304 });
    },
  });
  await provider.refreshModels!({ store, allowNetwork: true, force: true });
  assert.equal(headers.get("if-none-match"), '"catalog-v1"');
  assert.equal(headers.get("if-modified-since"), null);
  assert.ok(provider.getModels().some((model) => model.id === "ox-alpha-free"));
});

test("configured provider refresh is isolated and publishes before its caller continues", async () => {
  const credentials: CredentialStore = new InMemoryCredentialStore();
  const stores = new Map<string, ReturnType<typeof memoryProviderStore>>();
  const storeFor = (providerId: string) => {
    let store = stores.get(providerId);
    if (!store) {
      store = memoryProviderStore();
      stores.set(providerId, store);
    }
    return store;
  };
  const models = builtinModels({ credentials });
  const original = models.getProvider("opencode-go");
  assert.ok(original);
  const requested: string[] = [];
  const compatible = withAidenPiCompatibility(original);
  models.setProvider(
    withPiRemoteCatalog(compatible, {
      supportedApis: additionalAidenPiApis(original.id),
      fetchImpl: async (input) => {
        requested.push(String(input));
        return Response.json(
          {
            "ox-alpha-free": oxAlphaModel(),
            "gpt-5.6-luna": {
              ...oxAlphaModel(),
              id: "gpt-5.6-luna",
              name: "GPT-5.6 Luna",
              api: "openai-responses",
            },
          },
          { headers: { "last-modified": "Thu, 20 Aug 2026 16:00:00 GMT" } },
        );
      },
    }),
  );
  await credentials.modify(
    "opencode-go",
    async () => ({ type: "api_key", key: "configured" }) satisfies Credential,
  );
  const result = await refreshPiCatalogs({
    models,
    credentials,
    providerModelsStore: storeFor,
    providerIds: ["opencode-go"],
  });

  assert.equal(result.aborted, false);
  assert.equal(result.errors.size, 0);
  assert.deepEqual(requested, ["https://pi.dev/api/models/providers/opencode-go"]);
  assert.ok(models.getModel("opencode-go", "ox-alpha-free"));
  assert.ok(models.getModel("opencode-go", "gpt-5.6-luna"));
});

test("catalog parser preserves OpenRouter's documented unknown-price sentinel", () => {
  const model = oxAlphaModel();
  const parsed = parsePiRemoteCatalog("openrouter", [{
    ...model,
    provider: "openrouter",
    cost: { input: -1_000_000, output: -1_000_000, cacheRead: 0, cacheWrite: 0 },
  }]);
  assert.equal(parsed[0]?.cost.input, -1_000_000);
  assert.throws(() => parsePiRemoteCatalog("openrouter", [{
    ...model,
    cost: { ...model.cost, input: -1 },
  }]));
});

test("catalog parser rejects duplicate ids, unsafe origins, credential headers, and unsupported APIs", () => {
  const model = oxAlphaModel();
  assert.throws(() => parsePiRemoteCatalog("opencode-go", [model, model]));
  assert.throws(() => parsePiRemoteCatalog("opencode-go", [{ ...model, baseUrl: "http://example.test/v1" }]));
  assert.throws(() => parsePiRemoteCatalog("opencode-go", [{ ...model, headers: { Authorization: "secret" } }]));
  assert.throws(() => parsePiRemoteCatalog("opencode-go", [{ ...model, headers: { "Key": "value" } }]));
  assert.throws(() => parsePiRemoteCatalog("opencode-go", [{
    ...model,
    compat: { nested: { constructor: "poison" } },
  }]));
  assert.throws(() => parsePiRemoteCatalog("opencode-go", [{ ...model, api: "unknown-api" }], {
    allowedApis: new Set(["openai-responses"]),
  }));
  assert.throws(() => parsePiRemoteCatalog("opencode-go", [{ ...model, baseUrl: "https://evil.example/v1" }], {
    allowedOrigins: new Set([new URL(model.baseUrl).origin]),
  }));
});

test("last-known-good catalog survives 404, 501, server errors, and malformed payloads", async () => {
  const checkedAt = Date.parse("2026-08-20T16:01:00Z");
  for (const response of [
    () => new Response(null, { status: 404 }),
    () => new Response(null, { status: 501 }),
    () => new Response(null, { status: 500 }),
    () => Response.json({ models: "invalid" }, { status: 200 }),
  ]) {
    const store = memoryProviderStore({
      models: [oxAlphaModel()],
      checkedAt,
      lastModified: Date.parse("2026-08-20T16:00:00Z"),
      etag: '"old"',
    } as ModelsStoreEntry);
    const provider = withPiRemoteCatalog(opencodeGoProvider(), {
      fetchImpl: async () => response(),
      now: () => checkedAt + PI_REMOTE_CATALOG_REFRESH_INTERVAL_MS,
    });
    await provider.refreshModels?.({ store, allowNetwork: false });
    await provider.refreshModels?.({ store, allowNetwork: true, force: true }).catch(() => undefined);
    assert.ok(provider.getModels().some((entry) => entry.id === "ox-alpha-free"));
    assert.ok(store.snapshot()?.models.some((entry) => entry.id === "ox-alpha-free"));
  }
});

test("minimum-version and oversized responses fail closed without replacing the cache", async () => {
  const store = memoryProviderStore({
    models: [oxAlphaModel()],
    checkedAt: 1,
    lastModified: Date.parse("2026-08-20T16:00:00Z"),
  } as ModelsStoreEntry);
  for (const response of [
    () => Response.json({ "ox-alpha-free": oxAlphaModel() }, {
      headers: { "x-pi-model-catalog-minimum-version": "999.0.0" },
    }),
    () => new Response("x".repeat(5 * 1024 * 1024 + 1), {
      headers: { "content-type": "application/json" },
    }),
    () => Response.json({ "ox-alpha-free": oxAlphaModel() }, {
      headers: { "last-modified": "Thu, 01 Jan 2026 00:00:00 GMT" },
    }),
  ]) {
    const provider = withPiRemoteCatalog(opencodeGoProvider(), {
      fetchImpl: async () => response(),
    });
    await assert.rejects(provider.refreshModels!({ store, allowNetwork: true, force: true }));
    assert.ok(store.snapshot()?.models.some((entry) => entry.id === "ox-alpha-free"));
  }
});

test("an older valid catalog cannot roll back a newer cached generation", async () => {
  const cached = oxAlphaModel();
  const store = memoryProviderStore({
    models: [cached],
    checkedAt: Date.parse("2026-08-20T16:01:00Z"),
    lastModified: Date.parse("2026-08-20T16:00:00Z"),
  } as ModelsStoreEntry);
  const provider = withPiRemoteCatalog(opencodeGoProvider(), {
    fetchImpl: async () => Response.json({
      replacement: { ...cached, id: "replacement", name: "Older replacement" },
    }, { headers: { "last-modified": "Wed, 19 Aug 2026 16:00:00 GMT" } }),
  });

  await provider.refreshModels?.({ store, allowNetwork: false });
  await assert.rejects(
    provider.refreshModels!({ store, allowNetwork: true, force: true }),
    /older than the cached generation/u,
  );
  assert.deepEqual(store.snapshot()?.models.map((model) => model.id), [cached.id]);
  assert.deepEqual(provider.getModels().filter((model) => model.id === cached.id).map((model) => model.id), [cached.id]);
});

test("a future generation cannot poison the cache and a current catalog recovers it", async () => {
  const now = Date.parse("2026-08-22T18:00:00Z");
  const poisoned = { ...oxAlphaModel(), id: "future-poison", name: "Future poison" };
  const store = memoryProviderStore({
    models: [poisoned],
    checkedAt: now,
    lastModified: Date.parse("9999-12-31T23:59:59Z"),
    etag: '"future"',
  } as ModelsStoreEntry);
  const recovered = { ...oxAlphaModel(), id: "recovered", name: "Recovered" };
  const provider = withPiRemoteCatalog(opencodeGoProvider(), {
    now: () => now,
    fetchImpl: async () => Response.json({ recovered }, {
      headers: { "last-modified": "Sat, 22 Aug 2026 17:59:00 GMT" },
    }),
  });

  await provider.refreshModels!({ store, allowNetwork: false });
  assert.equal(provider.getModels().some((model) => model.id === poisoned.id), false);
  await provider.refreshModels!({ store, allowNetwork: true, force: true });
  assert.deepEqual(store.snapshot()?.models.map((model) => model.id), [recovered.id]);
  assert.ok(provider.getModels().some((model) => model.id === recovered.id));

  const futureResponse = withPiRemoteCatalog(opencodeGoProvider(), {
    now: () => now,
    fetchImpl: async () => Response.json({ poisoned }, {
      headers: { "last-modified": "Fri, 31 Dec 9999 23:59:59 GMT" },
    }),
  });
  await assert.rejects(
    futureResponse.refreshModels!({ store: memoryProviderStore(), allowNetwork: true, force: true }),
    /invalid future generation timestamp/u,
  );
});

test("clock rollback retains the last-known-good catalog and its downgrade fence", async () => {
  const acceptedAt = Date.parse("2026-08-22T18:00:00Z");
  const cached = { ...oxAlphaModel(), id: "newer-cached", name: "Newer cached" };
  const store = memoryProviderStore({
    models: [cached],
    checkedAt: acceptedAt,
    lastModified: Date.parse("2026-08-22T17:59:00Z"),
  } as ModelsStoreEntry);
  const older = { ...oxAlphaModel(), id: "older-remote", name: "Older remote" };
  const provider = withPiRemoteCatalog(opencodeGoProvider(), {
    now: () => Date.parse("2026-08-22T17:00:00Z"),
    fetchImpl: async () => Response.json({ older }, {
      headers: { "last-modified": "Sat, 01 Aug 2026 12:00:00 GMT" },
    }),
  });

  await provider.refreshModels!({ store, allowNetwork: false });
  assert.ok(provider.getModels().some((model) => model.id === cached.id));
  await assert.rejects(
    provider.refreshModels!({ store, allowNetwork: true, force: true }),
    /older than the cached generation/u,
  );
  assert.deepEqual(store.snapshot()?.models.map((model) => model.id), [cached.id]);
});

test("clock-rollback revalidation retains its acceptance boundary across restart", async () => {
  const acceptedAt = Date.parse("2026-08-22T18:00:00Z");
  const rolledBackNow = Date.parse("2026-08-22T17:00:00Z");
  const cached = { ...oxAlphaModel(), id: "rollback-cached", name: "Rollback cached" };
  for (const response of [
    () => new Response(null, { status: 304 }),
    () => new Response(null, { status: 404 }),
    () => new Response(null, { status: 501 }),
  ]) {
    const store = memoryProviderStore({
      models: [cached],
      checkedAt: acceptedAt,
      lastModified: Date.parse("2026-08-22T17:59:00Z"),
      etag: '"accepted"',
    } as ModelsStoreEntry);
    const provider = withPiRemoteCatalog(opencodeGoProvider(), {
      now: () => rolledBackNow,
      fetchImpl: async () => response(),
    });
    await provider.refreshModels!({ store, allowNetwork: true, force: true });
    assert.equal(store.snapshot()?.checkedAt, acceptedAt);

    const restarted = withPiRemoteCatalog(opencodeGoProvider(), { now: () => rolledBackNow });
    await restarted.refreshModels!({ store, allowNetwork: false });
    assert.ok(restarted.getModels().some((model) => model.id === cached.id));
  }
});

test("renderer catalog errors contain only bounded app-owned copy", () => {
  const secret = "sk-upstream-token-canary";
  const projected = projectPiCatalogRefreshErrors(new Map([
    ["radius\n<script>", new Error(`upstream reflected ${secret}`)],
  ]));
  assert.deepEqual(projected, [{
    providerId: "radiusscript",
    message: "Catalog refresh failed. Cached models were kept.",
  }]);
  assert.equal(JSON.stringify(projected).includes(secret), false);
  assert.equal(JSON.stringify(projected).includes("<script>"), false);
});

test("provider-scoped refresh isolates failures and aborts a hung provider promptly", async () => {
  const credentials: CredentialStore = new InMemoryCredentialStore();
  const models = builtinModels({ credentials });
  const template = opencodeGoProvider();
  const ok = { ...template, id: "ok-provider", refreshModels: async () => undefined };
  const broken = { ...template, id: "broken-provider", refreshModels: async () => { throw new Error("offline"); } };
  const hung = { ...template, id: "hung-provider", refreshModels: async () => new Promise<void>(() => undefined) };
  for (const provider of [ok, broken, hung]) {
    models.setProvider(provider);
    await credentials.modify(provider.id, async () => ({ type: "api_key", key: "configured" }));
  }
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 10);
  const result = await refreshPiCatalogs({
    models,
    credentials,
    providerModelsStore: () => memoryProviderStore(),
    providerIds: ["ok-provider", "broken-provider", "hung-provider"],
    signal: controller.signal,
  });
  assert.equal(result.aborted, true);
  assert.match(result.errors.get("broken-provider")?.message ?? "", /offline/u);
});

test("provider-scoped refresh aborts a non-mutating auth check without invoking OAuth resolution", async () => {
  const template = opencodeGoProvider();
  const controller = new AbortController();
  let mutatingAuthCalls = 0;
  const models = {
    getProvider: () => ({ ...template, refreshModels: async () => undefined }),
    checkAuth: async () => new Promise<never>(() => undefined),
    getAuth: async () => {
      mutatingAuthCalls += 1;
      throw new Error("OAuth resolution must not run during scoped refresh.");
    },
  };
  const credentials = {
    read: async () => ({ type: "api_key", key: "configured" }),
  };
  setTimeout(() => controller.abort(), 10);
  const result = await refreshPiCatalogs({
    models: models as never,
    credentials: credentials as never,
    providerModelsStore: () => memoryProviderStore(),
    providerIds: ["hung-auth"],
    signal: controller.signal,
  });
  assert.equal(result.aborted, true);
  assert.equal(result.errors.get("hung-auth")?.name, "AbortError");
  assert.equal(mutatingAuthCalls, 0);
});

test("stale launch refresh selects only stale pi.dev overlays", async () => {
  const radius = builtinProviders().find((provider) => provider.id === "radius");
  assert.ok(radius);
  const now = Date.parse("2026-08-22T18:00:00Z");
  const stale = withPiRemoteCatalog(opencodeGoProvider(), { now: () => now });
  const fresh = withPiRemoteCatalog({ ...opencodeGoProvider(), id: "fresh-overlay" }, { now: () => now });
  const stores = new Map<string, ReturnType<typeof memoryProviderStore>>([
    [stale.id, memoryProviderStore()],
    [fresh.id, memoryProviderStore({
      models: [],
      checkedAt: now - 1_000,
    })],
  ]);
  const providers = [stale, fresh, radius, concentrateProvider()];
  const ids = await staleCatalogProviderIds(
    providers,
    (providerId) => stores.get(providerId) ?? memoryProviderStore(),
  );
  assert.equal(ids.includes("radius"), false);
  assert.equal(ids.includes("concentrate"), false);
  assert.deepEqual(ids, [stale.id]);
  assert.ok(ids.every((id) => providers.find((provider) => provider.id === id)?.refreshModels));
});

test("persisted Pi catalog normalization strips unsafe entries and validators", () => {
  const model = oxAlphaModel();
  const normalized = normalizePiModelsDocument({
    version: 999,
    entries: {
      "opencode-go": {
        models: [model],
        checkedAt: 123,
        lastModified: 456,
        etag: '"safe"',
      },
      "../unsafe": { models: [model] },
      poisoned: { models: [{ ...model, headers: { Cookie: "secret" } }] },
    },
  });
  assert.equal(normalized.version, 1);
  assert.deepEqual(Object.keys(normalized.entries), ["opencode-go"]);
  assert.equal((normalized.entries["opencode-go"] as { etag?: string }).etag, '"safe"');
});
