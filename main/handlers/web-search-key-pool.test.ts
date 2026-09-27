import assert from "node:assert/strict";
import test from "node:test";

import {
  WEB_SEARCH_KEY_POOL_CHANNELS,
  registerWebSearchKeyPoolHandlers,
} from "./web-search-key-pool.js";
import {
  createWebSearchCredentialAccess,
  type WebSearchEncryptedSecretPort,
} from "../services/web-search-credential-core.js";
import { WebSearchKeyPoolTracker } from "../services/web-search-key-pool-core.js";
import type { WebSearchKeyPoolRendererState } from "../../renderer/shared/web-search-key-pool.js";

interface FakeEvent {
  readonly sender: "settings" | "foreign";
}

function harness(options: { mutationsAllowed?: boolean } = {}) {
  const bound = new Map<string, { key: string; binding: string }>();
  const port: WebSearchEncryptedSecretPort = {
    async getProviderKey(id, binding) {
      const entry = bound.get(id);
      return entry?.binding === binding ? entry.key : null;
    },
    async getOrBindLegacyProviderKey() {
      return null;
    },
    async setProviderKey(id, key, binding, isCurrent = () => true) {
      if (!isCurrent()) throw new Error("stale mutation");
      bound.set(id, { key, binding });
    },
    async deleteKey(id, isCurrent = () => true) {
      if (!isCurrent()) throw new Error("stale mutation");
      bound.delete(id);
    },
    async deleteKeyFamily(id, isCurrent = () => true) {
      if (!isCurrent()) throw new Error("stale mutation");
      for (const key of bound.keys()) {
        if (key === id || key.startsWith(`${id}:`)) bound.delete(key);
      }
    },
  };
  let nextId = 0;
  const credentials = createWebSearchCredentialAccess(port, {
    createEntryId: () => `team${(nextId += 1)}`,
  });
  const tracker = new WebSearchKeyPoolTracker({ now: () => 5_000 });
  const handlers = new Map<string, (event: FakeEvent, ...args: unknown[]) => unknown>();
  let destroyed = false;
  registerWebSearchKeyPoolHandlers<FakeEvent>({
    handle: (channel, handler) => {
      assert.equal(handlers.has(channel), false, `duplicate handler for ${channel}`);
      handlers.set(channel, handler);
    },
    credentials,
    tracker,
    providerConfig: async () => undefined,
    owner: (event) => {
      if (event.sender !== "settings") throw new Error("Untrusted sender.");
      return { isDestroyed: () => destroyed };
    },
    assertMutationAllowed: () => {
      if (options.mutationsAllowed === false) throw new Error("Credential changes are paused.");
    },
  });
  const invoke = async (channel: string, ...args: unknown[]) => {
    const handler = handlers.get(channel);
    assert.ok(handler, `no handler for ${channel}`);
    return (await handler({ sender: "settings" }, ...args)) as WebSearchKeyPoolRendererState;
  };
  return {
    bound,
    tracker,
    handlers,
    invoke,
    foreign: (channel: string, ...args: unknown[]) =>
      handlers.get(channel)!({ sender: "foreign" }, ...args),
    destroy: () => {
      destroyed = true;
    },
  };
}

test("every key-pool channel is registered once", () => {
  const h = harness();
  assert.deepEqual([...h.handlers.keys()].sort(), [...WEB_SEARCH_KEY_POOL_CHANNELS].sort());
});

test("renderer round trip adds, reorders, and removes keys and only ever returns redacted state", async () => {
  const h = harness();
  assert.deepEqual((await h.invoke("webSearch:keyPool:get", "tavily")).entries, []);

  await h.invoke("webSearch:keyPool:add", "tavily", "tvly-secret-one", "Personal");
  const added = await h.invoke("webSearch:keyPool:add", "tavily", "tvly-secret-two");
  assert.deepEqual(
    added.entries.map((entry) => [entry.id, entry.label]),
    [
      ["primary", "Personal"],
      ["team1", "Key 2"],
    ],
  );
  assert.equal(added.maxEntries, 8);

  const reordered = await h.invoke("webSearch:keyPool:reorder", "tavily", ["team1", "primary"]);
  assert.deepEqual(
    reordered.entries.map((entry) => entry.id),
    ["team1", "primary"],
  );
  const strategy = await h.invoke("webSearch:keyPool:setStrategy", "tavily", "round-robin");
  assert.equal(strategy.strategy, "round-robin");

  const removed = await h.invoke("webSearch:keyPool:remove", "tavily", "team1");
  assert.deepEqual(
    removed.entries.map((entry) => entry.id),
    ["primary"],
  );

  for (const state of [added, reordered, strategy, removed]) {
    assert.doesNotMatch(JSON.stringify(state), /tvly-secret/u);
  }
});

test("cooldowns are visible to the renderer and can be cleared manually", async () => {
  const h = harness();
  await h.invoke("webSearch:keyPool:add", "tavily", "tvly-a");
  await h.invoke("webSearch:keyPool:add", "tavily", "tvly-b");
  h.tracker.recordFailure("tavily", "team1", "quota");

  const cooling = await h.invoke("webSearch:keyPool:get", "tavily");
  assert.deepEqual(
    cooling.entries.map((entry) => entry.cooldown?.reason ?? null),
    [null, "quota"],
  );
  assert.ok(cooling.entries[1]!.cooldown!.until > cooling.observedAt);

  const reset = await h.invoke("webSearch:keyPool:resetCooldown", "tavily", "team1");
  assert.equal(reset.entries[1]!.cooldown, null);

  // Removing a cooling key forgets its cooldown so a reused ID starts clean.
  h.tracker.recordFailure("tavily", "team1", "auth");
  await h.invoke("webSearch:keyPool:remove", "tavily", "team1");
  assert.equal(h.tracker.cooldown("tavily", "team1"), undefined);
});

test("foreign senders, unsupported providers, rollout fences, and closed documents are refused", async () => {
  const h = harness();
  await assert.rejects(
    Promise.resolve().then(() => h.foreign("webSearch:keyPool:get", "tavily")),
    /Untrusted sender/u,
  );
  await assert.rejects(h.invoke("webSearch:keyPool:get", "brave"), /does not support/u);
  await assert.rejects(
    h.invoke("webSearch:keyPool:resetCooldown", "tavily", "../escape"),
    /Invalid Web Search key entry/u,
  );

  const fenced = harness({ mutationsAllowed: false });
  await assert.rejects(
    fenced.invoke("webSearch:keyPool:add", "tavily", "tvly-a"),
    /Credential changes are paused/u,
  );
  assert.equal(fenced.bound.size, 0);
  // Reads stay available while mutations are fenced.
  assert.deepEqual((await fenced.invoke("webSearch:keyPool:get", "tavily")).entries, []);

  h.destroy();
  await assert.rejects(
    h.invoke("webSearch:keyPool:add", "tavily", "tvly-late"),
    /no longer active/u,
  );
  assert.equal(h.bound.size, 0);
});
