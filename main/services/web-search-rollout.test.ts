import assert from "node:assert/strict";
import test from "node:test";

import { WebSearchError, type WebSearchResultSet } from "./web-search-core.js";
import { WebSearchService } from "./web-search.js";
import {
  freshWebSearchSettings,
  type WebSearchProviderId,
  type WebSearchSettingsV2,
} from "./web-search-provider-registry-core.js";
import {
  assertWebSearchRolloutMutationAllowed,
  pinWebSearchRolloutPolicy,
  resolveWebSearchRolloutPolicy,
  webSearchProviderZooEnabled,
  webSearchRolloutMutationAllowed,
  webSearchSettingsForRollout,
  webSearchVisibleProviderIds,
} from "./web-search-rollout.js";
import type { WebSearchAdapter, WebSearchAdapterFactory } from "./web-search-provider-registry.js";
import type { AppSettings } from "./types.js";

const QUERY = "current Aiden documentation";
const EXA_KEY = "exa-key-for-rollout-test";

function evidence(providerId: WebSearchProviderId = "exa"): WebSearchResultSet {
  return {
    providerId,
    untrusted: true,
    results: [{ title: "Evidence", url: "https://example.test/result", text: "Evidence" }],
  };
}

function adapter(
  providerId: WebSearchProviderId,
  search: WebSearchAdapter["search"],
): WebSearchAdapterFactory {
  return () => ({ providerId, adapterVersion: 1, search });
}

function settings(selection: WebSearchSettingsV2["selection"]): AppSettings {
  return {
    webSearch: {
      ...freshWebSearchSettings(),
      selection,
      providerConfig: { perplexity: {} },
    },
  };
}

test("the provider-zoo rollout is default-on and exact-zero reversible", () => {
  assert.equal(webSearchProviderZooEnabled({}), true);
  assert.equal(webSearchProviderZooEnabled({ AIDEN_WEB_SEARCH_PROVIDER_ZOO_ENABLED: "1" }), true);
  assert.equal(
    webSearchProviderZooEnabled({ AIDEN_WEB_SEARCH_PROVIDER_ZOO_ENABLED: " 0 " }),
    false,
  );
  assert.equal(
    webSearchProviderZooEnabled({ AIDEN_WEB_SEARCH_PROVIDER_ZOO_ENABLED: "false" }),
    true,
  );
  assert.deepEqual(
    webSearchVisibleProviderIds(
      resolveWebSearchRolloutPolicy({ AIDEN_WEB_SEARCH_PROVIDER_ZOO_ENABLED: "0" }),
    ),
    ["exa"],
  );
  assert.equal(
    resolveWebSearchRolloutPolicy({ AIDEN_WEB_SEARCH_PROVIDER_ZOO_ENABLED: "0" }).mode,
    "exa-baseline",
  );
});

test("rollback fences hidden route/config mutations but permits the global switch and Exa key", () => {
  const baseline = resolveWebSearchRolloutPolicy({
    AIDEN_WEB_SEARCH_PROVIDER_ZOO_ENABLED: "0",
  });
  assert.equal(webSearchRolloutMutationAllowed("set-enabled", undefined, baseline), true);
  assert.equal(webSearchRolloutMutationAllowed("set-credential", "exa", baseline), true);
  assert.equal(webSearchRolloutMutationAllowed("set-credential", "perplexity", baseline), false);
  for (const mutation of [
    "set-selection",
    "set-automatic-route",
    "set-provider-config",
    "existing-auth",
  ] as const) {
    assert.equal(webSearchRolloutMutationAllowed(mutation, undefined, baseline), false);
    assert.throws(
      () => assertWebSearchRolloutMutationAllowed(mutation, undefined, baseline),
      /provider-zoo rollback is active/u,
    );
  }
  assert.equal(
    webSearchRolloutMutationAllowed(
      "set-selection",
      undefined,
      resolveWebSearchRolloutPolicy({ AIDEN_WEB_SEARCH_PROVIDER_ZOO_ENABLED: "1" }),
    ),
    true,
  );
});

test("rollback projects a fixed anonymous Exa route without mutating durable provider state", () => {
  const durable = {
    ...freshWebSearchSettings(),
    selection: {
      mode: "automatic" as const,
      route: [
        { providerId: "perplexity" as const, credentialMode: "api-key" as const },
        { providerId: "tavily" as const, credentialMode: "api-key" as const },
      ],
      fallbackOn: ["quota" as const],
    },
    providerConfig: { perplexity: {} },
  };
  const before = structuredClone(durable);
  const projected = webSearchSettingsForRollout(
    durable,
    resolveWebSearchRolloutPolicy({ AIDEN_WEB_SEARCH_PROVIDER_ZOO_ENABLED: "0" }),
  );

  assert.deepEqual(projected.selection, {
    mode: "fixed",
    providerId: "exa",
    credentialMode: "anonymous",
  });
  assert.deepEqual(projected.providerConfig, durable.providerConfig);
  assert.deepEqual(durable, before);
  assert.notEqual(projected, durable);
});

test("rollback retains keyed Exa only when the durable route explicitly selected it", () => {
  const projected = webSearchSettingsForRollout(
    {
      ...freshWebSearchSettings(),
      selection: {
        mode: "automatic",
        route: [
          { providerId: "exa", credentialMode: "api-key" },
          { providerId: "perplexity", credentialMode: "api-key" },
        ],
        fallbackOn: ["quota"],
      },
    },
    resolveWebSearchRolloutPolicy({ AIDEN_WEB_SEARCH_PROVIDER_ZOO_ENABLED: "0" }),
  );
  assert.deepEqual(projected.selection, {
    mode: "fixed",
    providerId: "exa",
    credentialMode: "api-key",
  });
});

test("rollback never wakes a dormant Exa key or invokes a paid route", async () => {
  const credentialReads: string[] = [];
  let exaCalls = 0;
  let paidCalls = 0;
  const service = new WebSearchService({
    getSettings: async () =>
      settings({
        mode: "fixed",
        providerId: "perplexity",
        credentialMode: "api-key",
      }),
    getCredential: async (providerId) => {
      credentialReads.push(providerId);
      return providerId === "exa" ? EXA_KEY : "perplexity-key";
    },
    rollout: resolveWebSearchRolloutPolicy({ AIDEN_WEB_SEARCH_PROVIDER_ZOO_ENABLED: "0" }),
    adapterFactories: {
      exa: adapter("exa", async (request) => {
        exaCalls += 1;
        assert.equal(request.credentialMode, "anonymous");
        assert.equal(request.credential, undefined);
        return evidence();
      }),
      perplexity: adapter("perplexity", async () => {
        paidCalls += 1;
        throw new WebSearchError("transient", "perplexity");
      }),
    },
  });

  const result = await service.search({ query: QUERY });
  assert.equal(result.providerId, "exa");
  assert.equal(exaCalls, 1);
  assert.equal(paidCalls, 0);
  assert.deepEqual(credentialReads, []);
});

test("rollback sends an explicitly keyed Exa route through Exa and preserves that mode", async () => {
  let requestCredential: string | undefined;
  const service = new WebSearchService({
    getSettings: async () => ({
      webSearch: {
        ...freshWebSearchSettings(),
        selection: {
          mode: "fixed",
          providerId: "exa",
          credentialMode: "api-key",
        },
      },
    }),
    getCredential: async (providerId) => (providerId === "exa" ? EXA_KEY : undefined),
    rollout: resolveWebSearchRolloutPolicy({ AIDEN_WEB_SEARCH_PROVIDER_ZOO_ENABLED: "0" }),
    adapterFactories: {
      exa: adapter("exa", async (request) => {
        requestCredential = request.credential;
        return evidence();
      }),
    },
  });

  const snapshot = await service.snapshot();
  assert.deepEqual(snapshot.route, {
    mode: "fixed",
    route: [{ providerId: "exa", credentialMode: "api-key" }],
    fallbackOn: [],
  });
  assert.equal((await service.search({ query: QUERY })).providerId, "exa");
  assert.equal(requestCredential, EXA_KEY);
});

test("rollback fails closed when Exa has no usable adapter", async () => {
  const service = new WebSearchService({
    getSettings: async () => settings({ mode: "fixed", providerId: "tavily" }),
    rollout: resolveWebSearchRolloutPolicy({ AIDEN_WEB_SEARCH_PROVIDER_ZOO_ENABLED: "0" }),
    adapterFactories: {},
  });

  assert.equal(await service.toolForGeneration(), undefined);
  const availability = await service.availability();
  assert.equal(availability.ready, false);
  assert.deepEqual(availability.route, [
    { providerId: "exa", ready: false, configurationStatus: "invalid" },
  ]);
  await assert.rejects(
    service.search({ query: QUERY }),
    (error: unknown) =>
      error instanceof WebSearchError && error.kind === "unavailable" && error.providerId === "exa",
  );
});

test("a resolved startup policy remains unchanged when the caller environment later changes", () => {
  const environment: Record<string, string | undefined> = {
    AIDEN_WEB_SEARCH_PROVIDER_ZOO_ENABLED: "0",
  };
  const policy = resolveWebSearchRolloutPolicy(environment);
  environment.AIDEN_WEB_SEARCH_PROVIDER_ZOO_ENABLED = "1";
  assert.equal(policy.providerZooEnabled, false);
  assert.equal(policy.mode, "exa-baseline");
});

test("service rollout policy is pinned before a generation can observe it", async () => {
  const mutablePolicy = {
    providerZooEnabled: false,
    mode: "exa-baseline" as const,
  };
  const service = new WebSearchService({
    getSettings: async () => settings({ mode: "fixed", providerId: "tavily" }),
    rollout: mutablePolicy,
    adapterFactories: {
      exa: adapter("exa", async () => evidence()),
      tavily: adapter("tavily", async () => {
        throw new Error("the paid route must stay unreachable");
      }),
    },
  });
  mutablePolicy.providerZooEnabled = true;
  assert.equal((await service.snapshot()).route.route[0]?.providerId, "exa");
  assert.equal(pinWebSearchRolloutPolicy(mutablePolicy).providerZooEnabled, true);
});
