import assert from "node:assert/strict";
import test from "node:test";

import {
  WEB_SEARCH_ADAPTER_FACTORIES,
  webSearchAdapterAvailable,
  webSearchAdapterFactory,
} from "./web-search-provider-registry.js";
import {
  WEB_SEARCH_PROVIDER_REGISTRY,
  getWebSearchProviderDefinition,
  type WebSearchProviderId,
} from "./web-search-provider-registry-core.js";
import type { WebSearchFetch } from "./web-search-provider-registry.js";

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
  for (const providerId of ["serpbase", "xcrawl", "searxng", "firecrawl"]) {
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
