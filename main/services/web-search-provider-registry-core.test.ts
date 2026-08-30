import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_WEB_SEARCH_FALLBACK_ON,
  WEB_SEARCH_PROVIDER_IDS,
  WEB_SEARCH_PROVIDER_REGISTRY,
  assertWebSearchProviderRegistry,
  classifyWebSearchProfile,
  freshWebSearchSettings,
  getWebSearchProviderDefinition,
  isWebSearchProviderId,
  migrateWebSearchSettings,
  migrateWebSearchSettingsWithReport,
  normalizeWebSearchRoute,
  normalizeWebSearchSettings,
  projectWebSearchProviderForRenderer,
  webSearchProviderRegistryForRenderer,
  webSearchRouteEntryReady,
  type WebSearchSettingsV2,
} from "./web-search-provider-registry-core.js";

test("registry is the exact 28-provider Pi inventory and validates reviewed HTTPS origins", () => {
  assert.equal(WEB_SEARCH_PROVIDER_IDS.length, 28);
  assert.equal(new Set(WEB_SEARCH_PROVIDER_IDS).size, 28);
  assert.deepEqual(
    new Set(WEB_SEARCH_PROVIDER_REGISTRY.map((definition) => definition.id)),
    new Set(WEB_SEARCH_PROVIDER_IDS),
  );
  assert.doesNotThrow(assertWebSearchProviderRegistry);
  for (const definition of WEB_SEARCH_PROVIDER_REGISTRY) {
    assert.ok(definition.label.length > 0);
    assert.ok(definition.description.length > 0);
    assert.ok(definition.adapterVersion >= 1);
    assert.ok(definition.privacyUrl.startsWith("https://"));
    assert.ok(definition.termsUrl.startsWith("https://"));
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
  assert.equal(getWebSearchProviderDefinition("exa")?.automaticByDefault, true);
  assert.equal(getWebSearchProviderDefinition("serpbase")?.releaseState, "blocked");
  assert.equal(isWebSearchProviderId("all"), false);
  assert.equal(isWebSearchProviderId("exa"), true);
});

test("renderer projection is redacted and contains only categorical status", () => {
  const definition = getWebSearchProviderDefinition("exa");
  assert.ok(definition);
  const projected = projectWebSearchProviderForRenderer(definition, {
    configurationStatus: "configured",
    ready: true,
  });
  assert.equal(projected.id, "exa");
  assert.equal(projected.ready, true);
  assert.equal(projected.configurationStatus, "configured");
  assert.equal("fixedOrigins" in projected, false);
  assert.equal("apiKey" in projected, false);
  assert.equal("keyPrefix" in projected, false);
  assert.equal("keySuffix" in projected, false);
  assert.equal("rawError" in projected, false);
  assert.equal("adapter" in projected, false);
  assert.deepEqual(
    webSearchProviderRegistryForRenderer().map((entry) => entry.id),
    [...WEB_SEARCH_PROVIDER_IDS],
  );
  assert.equal(webSearchProviderRegistryForRenderer()[0]?.configurationStatus, "needs-setup");
});

test("renderer projection keeps API-key and existing-auth readiness distinct", () => {
  const definition = getWebSearchProviderDefinition("openai");
  assert.ok(definition);
  const keyOnly = projectWebSearchProviderForRenderer(definition, {
    configurationStatus: "configured",
    ready: true,
    hasCredential: true,
    hasExistingProviderAuth: false,
  });
  const existingOnly = projectWebSearchProviderForRenderer(definition, {
    configurationStatus: "configured",
    ready: true,
    hasCredential: false,
    hasExistingProviderAuth: true,
  });
  const both = projectWebSearchProviderForRenderer(definition, {
    configurationStatus: "configured",
    ready: true,
    hasCredential: true,
    hasExistingProviderAuth: true,
  });
  assert.deepEqual(keyOnly.configuredCredentialModes, ["api-key"]);
  assert.deepEqual(existingOnly.configuredCredentialModes, ["existing-provider-auth"]);
  assert.deepEqual(both.configuredCredentialModes, ["api-key", "existing-provider-auth"]);
  for (const projection of [keyOnly, existingOnly, both]) {
    assert.equal("credential" in projection, false);
    assert.equal("apiKey" in projection, false);
  }
});

test("fresh settings are enabled with only anonymous Exa and an explicit fallback policy", () => {
  const settings = freshWebSearchSettings();
  assert.deepEqual(settings, {
    version: 2,
    enabled: true,
    selection: {
      mode: "automatic",
      route: [{ providerId: "exa", credentialMode: "anonymous" }],
      fallbackOn: [...DEFAULT_WEB_SEARCH_FALLBACK_ON],
    },
    providerConfig: {},
  });
  assert.deepEqual(normalizeWebSearchSettings(settings), settings);
});

test("settings normalization rejects unknown, blocked, duplicate, and secret-shaped config", () => {
  const base = freshWebSearchSettings();
  assert.throws(
    () => normalizeWebSearchSettings({ ...base, providerConfig: { unknown: {} } }),
    /Unknown Web Search provider/u,
  );
  assert.throws(
    () =>
      normalizeWebSearchSettings({
        ...base,
        selection: {
          ...base.selection,
          route: [{ providerId: "serpbase", credentialMode: "api-key" }],
        },
      }),
    /not available/u,
  );
  assert.throws(
    () =>
      normalizeWebSearchSettings({
        ...base,
        selection: {
          ...base.selection,
          route: [
            { providerId: "exa", credentialMode: "anonymous" },
            { providerId: "exa", credentialMode: "anonymous" },
          ],
        },
      }),
    /duplicate provider exa/u,
  );
  assert.throws(
    () =>
      normalizeWebSearchSettings({
        ...base,
        providerConfig: { exa: { apiKey: "secret" } },
      }),
    /unsupported field/u,
  );
  assert.throws(
    () =>
      normalizeWebSearchSettings({
        ...base,
        providerConfig: { searxng: { endpoint: "https://user:password@example.test" } },
      }),
    /credentials/u,
  );
  assert.throws(
    () =>
      normalizeWebSearchSettings({
        ...base,
        providerConfig: { searxng: { endpoint: "https://example.test/search?q=secret" } },
      }),
    /query/u,
  );
  assert.throws(
    () => normalizeWebSearchRoute([{ providerId: "all", credentialMode: "anonymous" }]),
    /unknown provider/u,
  );
});

test("endpoint and zone config is bounded, normalized, and never accepts arbitrary fields", () => {
  const settings = normalizeWebSearchSettings({
    ...freshWebSearchSettings(),
    providerConfig: {
      searxng: { endpoint: " https://search.example.test/ " },
      firecrawl: { endpoint: "http://127.0.0.1:3002/api/" },
      brightdata: { zone: " serp-zone " },
    },
  });
  assert.equal(settings.providerConfig.searxng?.endpoint, "https://search.example.test/");
  assert.equal(settings.providerConfig.firecrawl?.endpoint, "http://127.0.0.1:3002/api");
  assert.equal(settings.providerConfig.brightdata?.zone, "serp-zone");
  assert.throws(
    () =>
      normalizeWebSearchSettings({
        ...freshWebSearchSettings(),
        providerConfig: { brightdata: { zone: "x\n" } },
      }),
    /invalid/u,
  );
  assert.throws(
    () =>
      normalizeWebSearchSettings({
        ...freshWebSearchSettings(),
        providerConfig: { exa: { endpoint: "https://example.test" } },
      }),
    /unsupported field/u,
  );
});

test("route readiness depends on the matching provider mode and main-owned status only", () => {
  assert.equal(
    webSearchRouteEntryReady({ providerId: "exa", credentialMode: "anonymous" }, undefined),
    true,
  );
  assert.equal(
    webSearchRouteEntryReady({ providerId: "exa", credentialMode: "api-key" }, undefined, {
      hasCredential: false,
    }),
    false,
  );
  assert.equal(
    webSearchRouteEntryReady({ providerId: "exa", credentialMode: "api-key" }, undefined, {
      hasCredential: true,
    }),
    true,
  );
  assert.equal(
    webSearchRouteEntryReady(
      { providerId: "searxng", credentialMode: "endpoint" },
      { endpoint: "https://search.example.test" },
    ),
    true,
  );
  assert.equal(
    webSearchRouteEntryReady({ providerId: "searxng", credentialMode: "endpoint" }, undefined),
    false,
  );
});

function migrationSettings(
  input: Parameters<typeof migrateWebSearchSettings>[0],
): WebSearchSettingsV2 {
  return migrateWebSearchSettings(input);
}

test("migration preserves explicit legacy false and never selects dormant keys", () => {
  const cases: Array<{ input: Parameters<typeof migrateWebSearchSettings>[0]; expected: unknown }> =
    [
      {
        input: { exaEnabled: false, hasExaKey: false, freshProfile: true },
        expected: { enabled: false, mode: "automatic", credentialMode: "anonymous" },
      },
      {
        input: { exaEnabled: false, hasExaKey: true, profileKind: "upgrade" },
        expected: { enabled: false, mode: "automatic", credentialMode: "anonymous" },
      },
      {
        input: { exaEnabled: true, hasExaKey: true, profileKind: "upgrade" },
        expected: { enabled: true, mode: "fixed", credentialMode: "api-key" },
      },
      {
        input: { exaEnabled: true, hasExaKey: false, profileKind: "upgrade" },
        expected: { enabled: true, mode: "automatic", credentialMode: "anonymous" },
      },
      {
        input: { profileKind: "fresh", hasExaKey: true },
        expected: { enabled: true, mode: "automatic", credentialMode: "anonymous" },
      },
      {
        input: { profileKind: "upgrade", hasExaKey: true },
        expected: { enabled: false, mode: "automatic", credentialMode: "anonymous" },
      },
    ];
  for (const { input, expected } of cases) {
    const settings = migrationSettings(input);
    assert.equal(settings.enabled, (expected as { enabled: boolean }).enabled);
    assert.equal(settings.selection.mode, (expected as { mode: string }).mode);
    if (settings.selection.mode === "fixed") {
      assert.equal(
        settings.selection.credentialMode,
        (expected as { credentialMode: string }).credentialMode,
      );
    } else {
      assert.equal(
        settings.selection.route[0]?.credentialMode,
        (expected as { credentialMode: string }).credentialMode,
      );
    }
  }
  const report = migrateWebSearchSettingsWithReport({
    exaEnabled: false,
    hasExaKey: true,
    profileKind: "fresh",
  });
  assert.equal(report.dormantLegacyCredential, true);
  assert.equal(report.settings.enabled, false);
  assert.equal(JSON.stringify(report).includes("keyPrefix"), false);
});

test("migration uses durable install/onboarding evidence and treats absent evidence conservatively", () => {
  assert.equal(classifyWebSearchProfile({ seeded: false }), "fresh");
  assert.equal(classifyWebSearchProfile({ install: { seeded: false } }), "fresh");
  assert.equal(classifyWebSearchProfile({ profileInitialized: false }), "fresh");
  assert.equal(
    classifyWebSearchProfile({
      onboarding: { version: 2, outcome: "incomplete", lastSatisfiedStep: "none" },
      hasPersistedProfile: false,
      settingsFileExists: false,
    }),
    "fresh",
  );
  assert.equal(
    classifyWebSearchProfile({
      onboarding: { version: 2, outcome: "incomplete", lastSatisfiedStep: "none" },
      seeded: true,
    }),
    "upgrade",
  );
  assert.equal(
    classifyWebSearchProfile({
      onboarding: { version: 2, outcome: "completed", lastSatisfiedStep: "tour" },
      seeded: true,
    }),
    "upgrade",
  );
  assert.equal(classifyWebSearchProfile({}), "upgrade");
  assert.equal(classifyWebSearchProfile(undefined), "upgrade");
  assert.equal(migrateWebSearchSettings({}).enabled, false);
});
