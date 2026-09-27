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

function poolSecrets() {
  const bound = new Map<string, { key: string; binding: string }>();
  let nextId = 0;
  let clock = 100;
  const port: WebSearchEncryptedSecretPort = {
    async getProviderKey(providerId, binding) {
      const entry = bound.get(providerId);
      return entry?.binding === binding ? entry.key : null;
    },
    async getOrBindLegacyProviderKey() {
      return null;
    },
    async setProviderKey(providerId, key, binding, isCurrent = () => true) {
      if (!isCurrent()) throw new Error("stale mutation");
      bound.set(providerId, { key, binding });
    },
    async deleteKey(providerId, isCurrent = () => true) {
      if (!isCurrent()) throw new Error("stale mutation");
      bound.delete(providerId);
    },
  };
  const access = createWebSearchCredentialAccess(port, {
    createEntryId: () => `entry${(nextId += 1)}`,
    now: () => (clock += 1),
  });
  return { bound, access };
}

test("a key saved before pools existed becomes the first pool entry", async () => {
  const h = poolSecrets();
  const tavily = h.access.reference("tavily");
  await h.access.set(tavily, "tvly-legacy");

  const listed = await h.access.listPool(tavily);
  assert.deepEqual(
    listed.entries.map((entry) => entry.id),
    ["primary"],
  );
  assert.deepEqual(await h.access.readPool(tavily), {
    strategy: "ordered",
    keys: [{ id: "primary", key: "tvly-legacy" }],
  });
  assert.equal(await h.access.read(tavily), "tvly-legacy");
});

test("pool keys can be added, reordered, re-strategized, and removed without exposing keys", async () => {
  const h = poolSecrets();
  const tavily = h.access.reference("tavily");

  await h.access.addPoolKey(tavily, "tvly-one");
  await h.access.addPoolKey(tavily, "tvly-two", "Team");
  const added = await h.access.addPoolKey(tavily, "tvly-three");
  assert.deepEqual(
    added.entries.map((entry) => [entry.id, entry.label]),
    [
      ["primary", "Key 1"],
      ["entry1", "Team"],
      ["entry2", "Key 3"],
    ],
  );
  assert.doesNotMatch(JSON.stringify(added), /tvly-/u);
  // The first pooled key lives in the pre-pool slot for single-key readers.
  assert.equal(await h.access.read(tavily), "tvly-one");

  await assert.rejects(h.access.addPoolKey(tavily, " tvly-two "), /already in the pool/u);

  await h.access.reorderPool(tavily, ["entry2", "primary", "entry1"]);
  assert.deepEqual(
    (await h.access.readPool(tavily)).keys.map((entry) => entry.key),
    ["tvly-three", "tvly-one", "tvly-two"],
  );
  assert.equal(await h.access.read(tavily), "tvly-three");
  await assert.rejects(h.access.reorderPool(tavily, ["entry2", "primary"]), /no longer matches/u);

  const strategy = await h.access.setPoolStrategy(tavily, "round-robin");
  assert.equal(strategy.strategy, "round-robin");
  await assert.rejects(h.access.setPoolStrategy(tavily, "random"));

  const removed = await h.access.removePoolKey(tavily, "entry2");
  assert.deepEqual(
    removed.entries.map((entry) => entry.id),
    ["primary", "entry1"],
  );
  assert.equal(await h.access.read(tavily), "tvly-one");
  assert.ok(![...h.bound.values()].some((entry) => entry.key === "tvly-three"));
  await assert.rejects(h.access.removePoolKey(tavily, "entry2"), /no longer in the pool/u);

  // Removing the provider credential clears every pooled slot and the index.
  await h.access.remove(tavily);
  assert.equal(await h.access.has(tavily), false);
  assert.deepEqual(await h.access.readPool(tavily), { strategy: "ordered", keys: [] });
  assert.equal(h.bound.size, 0);
});

test("the pool refuses a ninth key and non-pool providers keep single-key behavior", async () => {
  const h = poolSecrets();
  const tavily = h.access.reference("tavily");
  for (let index = 0; index < 8; index += 1) await h.access.addPoolKey(tavily, `tvly-${index}`);
  await assert.rejects(h.access.addPoolKey(tavily, "tvly-9"), /at most 8 keys/u);

  const brave = h.access.reference("brave");
  await assert.rejects(h.access.listPool(brave), /does not support multiple API keys/u);
  await h.access.set(brave, "brave-key");
  assert.deepEqual(await h.access.readPool(brave), {
    strategy: "ordered",
    keys: [{ id: "primary", key: "brave-key" }],
  });
});

test("concurrent pool edits are serialized so neither is lost", async () => {
  const h = poolSecrets();
  const tavily = h.access.reference("tavily");
  await Promise.all([
    h.access.addPoolKey(tavily, "tvly-a"),
    h.access.addPoolKey(tavily, "tvly-b"),
    h.access.addPoolKey(tavily, "tvly-c"),
  ]);
  assert.deepEqual((await h.access.readPool(tavily)).keys.map((entry) => entry.key).sort(), [
    "tvly-a",
    "tvly-b",
    "tvly-c",
  ]);
});

test("a corrupt pool index falls back to the saved primary key", async () => {
  const h = poolSecrets();
  const tavily = h.access.reference("tavily");
  await h.access.addPoolKey(tavily, "tvly-a");
  await h.access.addPoolKey(tavily, "tvly-b");
  const indexSlot = [...h.bound.keys()].find((id) => id.endsWith(":pool-index"))!;
  h.bound.set(indexSlot, { key: "{not json", binding: tavily.binding });
  assert.deepEqual((await h.access.readPool(tavily)).keys, [{ id: "primary", key: "tvly-a" }]);
});
