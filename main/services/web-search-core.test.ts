import assert from "node:assert/strict";
import test from "node:test";

import {
  WEB_SEARCH_NORMALIZED_RESULT_MAX_BYTES,
  WEB_SEARCH_QUERY_MAX_BYTES,
  WEB_SEARCH_QUERY_MAX_CHARS,
  WEB_SEARCH_RESULTS_MAX,
  canFallbackWebSearchError,
  normalizeWebSearchError,
  normalizeWebSearchRequest,
  normalizeWebSearchResultSet,
  snapshotWebSearchRoute,
  webSearchError,
  webSearchErrorSnapshot,
  webSearchSettingsHasSecretMetadata,
  type WebSearchSettingsV2,
} from "./web-search-core.js";
import { freshWebSearchSettings } from "./web-search-provider-registry-core.js";

test("model-facing request is trimmed, defaulted, bounded, and cannot select recipients", () => {
  assert.deepEqual(normalizeWebSearchRequest({ query: "  current events  " }), {
    query: "current events",
    numResults: 5,
  });
  assert.deepEqual(normalizeWebSearchRequest({ query: "query", numResults: 10 }), {
    query: "query",
    numResults: 10,
  });
  assert.throws(() => normalizeWebSearchRequest({ query: " \t " }), /invalid/u);
  assert.throws(
    () => normalizeWebSearchRequest({ query: "a".repeat(WEB_SEARCH_QUERY_MAX_CHARS + 1) }),
    /invalid/u,
  );
  const tooManyBytes = "€".repeat(Math.floor(WEB_SEARCH_QUERY_MAX_BYTES / 3) + 1);
  assert.throws(() => normalizeWebSearchRequest({ query: tooManyBytes }), /invalid/u);
  assert.throws(() => normalizeWebSearchRequest({ query: "query", numResults: 0 }), /invalid/u);
  assert.throws(() => normalizeWebSearchRequest({ query: "query", numResults: 11 }), /invalid/u);
  assert.throws(() => normalizeWebSearchRequest({ query: "query", provider: "brave" }), /invalid/u);
  assert.throws(() => normalizeWebSearchRequest({ query: "query\nsecret" }), /invalid/u);
});

test("result normalization attributes exactly one provider and bounds untrusted evidence", () => {
  const secret = "not-a-provider-secret";
  const result = normalizeWebSearchResultSet("exa", {
    results: Array.from({ length: WEB_SEARCH_RESULTS_MAX + 3 }, (_value, index) => ({
      title: `${secret} ${index}`,
      url: `https://example.test/${index}?q=${index}`,
      text: "😀".repeat(10_000),
    })),
  });
  assert.equal(result.providerId, "exa");
  assert.equal(result.untrusted, true);
  assert.equal(result.results.length, WEB_SEARCH_RESULTS_MAX);
  assert.ok(JSON.stringify(result).length > 0);
  for (const entry of result.results) {
    assert.ok(new TextEncoder().encode(entry.text).byteLength <= 4_096);
    assert.equal(entry.url.startsWith("https://"), true);
  }
  assert.throws(
    () => normalizeWebSearchResultSet("unknown", { results: [] }),
    (error: unknown) => error instanceof Error && /invalid response/u.test(error.message),
  );
  assert.throws(
    () => normalizeWebSearchResultSet("exa", { items: [] }),
    (error: unknown) => error instanceof Error && /invalid response/u.test(error.message),
  );
  assert.ok(JSON.stringify(result).length <= WEB_SEARCH_NORMALIZED_RESULT_MAX_BYTES);
  assert.deepEqual(
    normalizeWebSearchResultSet("exa", { results: [{ url: "https://user:password@example.test" }] })
      .results[0],
    {
      title: "",
      url: "",
      text: "",
    },
  );
});

test("error normalization exposes only stable categories and safe provider attribution", () => {
  const secret = "UPSTREAM_BODY_SECRET";
  const cases: Array<[number, string]> = [
    [401, "auth"],
    [408, "timeout"],
    [429, "quota"],
    [500, "transient"],
    [400, "invalid-request"],
  ];
  for (const [status, kind] of cases) {
    const error = normalizeWebSearchError(new Error(`${secret} body detail`), "exa");
    assert.equal(error.kind, "unavailable");
    const mapped = normalizeWebSearchError("exa", { status, body: secret });
    assert.equal(mapped.kind, kind);
    assert.equal(mapped.providerId, "exa");
    assert.doesNotMatch(mapped.message, new RegExp(secret, "u"));
    assert.doesNotMatch(JSON.stringify(mapped.snapshot()), new RegExp(secret, "u"));
  }
  const explicit = webSearchError("unsupported", "brave");
  assert.equal(explicit.retryable, true);
  assert.deepEqual(webSearchErrorSnapshot(new Error(secret), "brave"), {
    kind: "unavailable",
    providerId: "brave",
    retryable: false,
  });
  assert.deepEqual(webSearchErrorSnapshot("not-an-error", "exa"), {
    kind: "unavailable",
    providerId: "exa",
    retryable: false,
  });
});

test("automatic fallback uses only the user-selected categories and fixed never falls back", () => {
  const transient = webSearchError("transient", "exa");
  assert.equal(canFallbackWebSearchError(transient, ["transient"]), true);
  assert.equal(canFallbackWebSearchError(transient, ["quota"]), false);
  assert.equal(canFallbackWebSearchError(webSearchError("auth", "exa"), ["quota"]), false);
  assert.equal(canFallbackWebSearchError("timeout", ["timeout"]), true);
  assert.equal(canFallbackWebSearchError("route-exhausted", ["timeout"]), false);

  const fixedSettings: WebSearchSettingsV2 = {
    ...freshWebSearchSettings(),
    selection: { mode: "fixed", providerId: "exa", credentialMode: "anonymous" },
  };
  assert.deepEqual(snapshotWebSearchRoute(fixedSettings), {
    mode: "fixed",
    route: [{ providerId: "exa", credentialMode: "anonymous" }],
    fallbackOn: [],
  });
  const automaticSnapshot = snapshotWebSearchRoute(freshWebSearchSettings());
  assert.equal(automaticSnapshot.mode, "automatic");
  assert.deepEqual(automaticSnapshot.route, [{ providerId: "exa", credentialMode: "anonymous" }]);
  const freshRoute = freshWebSearchSettings().selection;
  assert.equal(freshRoute.mode, "automatic");
  assert.notEqual(automaticSnapshot.route, freshRoute.route);
});

test("portable Web Search settings have no secret metadata while malformed secret fields are detectable", () => {
  assert.equal(webSearchSettingsHasSecretMetadata(freshWebSearchSettings()), false);
  assert.equal(
    webSearchSettingsHasSecretMetadata({
      ...freshWebSearchSettings(),
      providerConfig: { exa: { apiKey: "secret" } },
    }),
    true,
  );
  assert.equal(
    webSearchSettingsHasSecretMetadata({
      ...freshWebSearchSettings(),
      selection: {
        mode: "automatic",
        route: [{ providerId: "exa", credentialMode: "api-key" }],
        fallbackOn: ["quota"],
      },
    }),
    false,
  );
});
