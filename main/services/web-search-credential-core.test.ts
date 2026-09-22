import assert from "node:assert/strict";
import test from "node:test";

import {
  MAX_WEB_SEARCH_CREDENTIAL_BYTES,
  MAX_WEB_SEARCH_CREDENTIAL_CHARS,
  createWebSearchCredentialAccess,
  normalizeWebSearchCredential,
  webSearchCredentialReference,
  type WebSearchEncryptedSecretPort,
} from "./web-search-credential-core.js";

function fakeSecrets(initial: { legacy?: Record<string, string> } = {}) {
  const bound = new Map<string, { key: string; binding: string }>();
  const legacy = new Map(Object.entries(initial.legacy ?? {}));
  const calls: Array<{ operation: string; providerId: string }> = [];
  const port: WebSearchEncryptedSecretPort = {
    async getProviderKey(providerId, binding) {
      const entry = bound.get(providerId);
      return entry?.binding === binding ? entry.key : null;
    },
    async getOrBindLegacyProviderKey(providerId, binding) {
      calls.push({ operation: "legacy-read", providerId });
      const existing = bound.get(providerId);
      if (existing) return existing.binding === binding ? existing.key : null;
      const key = legacy.get(providerId);
      if (key === undefined) return null;
      bound.set(providerId, { key, binding });
      return key;
    },
    async setProviderKey(providerId, key, binding, isCurrent = () => true) {
      if (!isCurrent()) throw new Error("stale mutation");
      calls.push({ operation: "set", providerId });
      bound.set(providerId, { key, binding });
    },
    async deleteKey(providerId, isCurrent = () => true) {
      if (!isCurrent()) throw new Error("stale mutation");
      calls.push({ operation: "delete", providerId });
      bound.delete(providerId);
      legacy.delete(providerId);
    },
  };
  return { bound, legacy, calls, access: createWebSearchCredentialAccess(port) };
}

test("credential references use stable provider IDs and reviewed endpoint bindings", () => {
  const exa = webSearchCredentialReference("exa");
  assert.equal(exa.secretId, "web-search:exa:api-key");
  assert.equal(exa.legacySecretId, "exa");
  assert.deepEqual(JSON.parse(exa.binding), {
    version: 1,
    providerId: "exa",
    credentialSlot: "api-key",
    endpoint: "https://api.exa.ai",
  });

  const selfHosted = webSearchCredentialReference("firecrawl", {
    endpoint: "https://search.example.test/api/",
  });
  assert.equal(selfHosted.secretId, "web-search:firecrawl:api-key");
  assert.equal(JSON.parse(selfHosted.binding).endpoint, "https://search.example.test/api");
  assert.throws(() => webSearchCredentialReference("firecrawl"), /requires an explicit endpoint/u);
  assert.throws(
    () =>
      webSearchCredentialReference("firecrawl", {
        endpoint: "https://user:password@search.example.test/api",
      }),
    /invalid/u,
  );
  assert.throws(() => webSearchCredentialReference("serpbase"), /does not accept/u);
});

test("namespaced credentials resolve before the legacy Exa key and remove both slots", async () => {
  const h = fakeSecrets({ legacy: { exa: "legacy-exa-key" } });
  const exa = h.access.reference("exa");

  assert.equal(await h.access.read(exa), "legacy-exa-key");
  assert.equal(await h.access.has(exa), true);
  assert.deepEqual(h.bound.get("exa"), {
    key: "legacy-exa-key",
    binding: exa.binding,
  });

  await h.access.set(exa, "  replacement-key  ");
  assert.deepEqual(h.bound.get(exa.secretId), {
    key: "replacement-key",
    binding: exa.binding,
  });
  // A rollback build can still read the old slot until the user explicitly
  // removes the credential; the v2 namespaced slot always wins first.
  assert.equal(h.legacy.get("exa"), "legacy-exa-key");
  assert.equal(await h.access.read(exa), "replacement-key");

  const brave = h.access.reference("brave");
  await h.access.set(brave, "brave-key");
  assert.equal(h.bound.has(brave.secretId), true);
  assert.equal(h.legacy.has("brave"), false);
  await h.access.remove(exa);
  assert.equal(await h.access.has(exa), false);
  assert.equal(h.bound.has(exa.secretId), false);
  assert.equal(h.bound.has("exa"), false);
  assert.equal(h.legacy.has("exa"), false);
  assert.equal(await h.access.read(brave), "brave-key");
});

test("credentials are bound to the exact provider endpoint and never fall through", async () => {
  const h = fakeSecrets();
  const first = h.access.reference("firecrawl", { endpoint: "https://one.example.test/api" });
  const second = h.access.reference("firecrawl", { endpoint: "https://two.example.test/api" });
  await h.access.set(first, "firecrawl-key");
  assert.equal(await h.access.read(first), "firecrawl-key");
  assert.equal(await h.access.read(second), null);
  assert.equal(await h.access.has(second), false);
});

test("credential writes reject bounded/control-character input without echoing secrets", async () => {
  const h = fakeSecrets();
  const reference = h.access.reference("exa");
  const privateValue = "PRIVATE_WEB_SEARCH_KEY_5f9a";
  assert.equal(normalizeWebSearchCredential("  key  "), "key");
  assert.doesNotThrow(() =>
    normalizeWebSearchCredential("x".repeat(MAX_WEB_SEARCH_CREDENTIAL_CHARS)),
  );
  assert.doesNotThrow(() =>
    normalizeWebSearchCredential("😀".repeat(Math.floor(MAX_WEB_SEARCH_CREDENTIAL_BYTES / 4))),
  );

  for (const invalid of [
    null,
    42,
    "",
    " \t ",
    `${privateValue}\nnext`,
    `${privateValue}\u0085next`,
    "x".repeat(MAX_WEB_SEARCH_CREDENTIAL_CHARS + 1),
    "😀".repeat(Math.floor(MAX_WEB_SEARCH_CREDENTIAL_BYTES / 4) + 1),
  ]) {
    assert.throws(
      () => normalizeWebSearchCredential(invalid),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.equal(error.message.includes(privateValue), false);
        return true;
      },
    );
    await assert.rejects(h.access.set(reference, invalid), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal(error.message.includes(privateValue), false);
      return true;
    });
  }
  assert.equal(h.bound.size, 0);
  assert.equal(
    h.calls.some((call) => call.operation === "set"),
    false,
  );
});

test("credential mutation guards are forwarded before publication", async () => {
  const h = fakeSecrets();
  const reference = h.access.reference("exa");
  await assert.rejects(
    h.access.set(reference, "key", () => false),
    /stale mutation/u,
  );
  await assert.rejects(
    h.access.remove(reference, () => false),
    /stale mutation/u,
  );
  assert.equal(h.bound.size, 0);
  assert.equal(h.calls.length, 0);
});
