import assert from "node:assert/strict";
import test from "node:test";
import type { Credential } from "@earendil-works/pi-ai";
import {
  deleteLegacyApiKeysForPiProvider,
  migrateLegacyApiKeysToPi,
} from "./provider-registry-legacy-migration-core.js";

/** Durable stores shared across simulated launches; each launch builds fresh dependencies. */
function durableStores(
  legacy: Record<string, string>,
  pi: Record<string, Credential> = {},
  options: { customOwned?: string[] } = {},
) {
  const legacyKeys = new Map(Object.entries(legacy));
  const piCredentials = new Map(Object.entries(pi));
  const signedOut = new Set<string>();
  let failModifyFor: string | undefined;
  const launch = () => ({
    readLegacy: async (id: string) => legacyKeys.get(id) ?? null,
    deleteLegacy: async (id: string) => void legacyKeys.delete(id),
    signedOut: async (id: string) => signedOut.has(id),
    credentials: {
      read: async (id: string) => piCredentials.get(id),
      modify: async (
        id: string,
        fn: (current: Credential | undefined) => Promise<Credential | undefined>,
      ) => {
        if (id === failModifyFor) throw new Error("credential store unavailable");
        const next = await fn(piCredentials.get(id));
        if (next) piCredentials.set(id, next);
        return next;
      },
    },
  });
  /** What the provider logout path does: drop Pi's credential and its pre-Pi record. */
  const logout = async (piId: string) => {
    piCredentials.delete(piId);
    await deleteLegacyApiKeysForPiProvider(piId, {
      // An alias can map the legacy id to a custom endpoint, whose only recovery key it then is.
      ownedByBuiltin: async (id) => !(options.customOwned ?? []).includes(id),
      deleteLegacy: launch().deleteLegacy,
      markSignedOut: async (id) => void signedOut.add(id),
    });
  };
  return {
    legacyKeys,
    piCredentials,
    signedOut,
    launch,
    logout,
    failModify: (id: string) => {
      failModifyFor = id;
    },
  };
}

test("a provider logged out after migration stays logged out on the next launch", async () => {
  const stores = durableStores({ openai: " sk-openai ", moonshot: "sk-moonshot" });

  await migrateLegacyApiKeysToPi(stores.launch());
  assert.deepEqual(stores.piCredentials.get("openai"), { type: "api_key", key: "sk-openai" });
  assert.deepEqual(stores.piCredentials.get("moonshotai"), { type: "api_key", key: "sk-moonshot" });
  assert.deepEqual([...stores.legacyKeys.keys()], [], "migration moves the legacy records");

  await stores.logout("openai");
  await migrateLegacyApiKeysToPi(stores.launch());

  assert.equal(stores.piCredentials.has("openai"), false);
  assert.deepEqual(stores.piCredentials.get("moonshotai"), { type: "api_key", key: "sk-moonshot" });
});

test("logging out removes a renamed provider's pre-Pi record before it is migrated", async () => {
  // A copy left by an earlier build: Pi already holds the key and the legacy record survived.
  const stores = durableStores(
    { moonshot: "sk-moonshot", deepseek: "sk-deepseek" },
    { moonshotai: { type: "api_key", key: "sk-moonshot" } },
  );

  await stores.logout("moonshotai");
  await migrateLegacyApiKeysToPi(stores.launch());

  assert.equal(stores.piCredentials.has("moonshotai"), false);
  assert.equal(stores.legacyKeys.has("moonshot"), false);
  assert.deepEqual(stores.piCredentials.get("deepseek"), { type: "api_key", key: "sk-deepseek" });
});

test("logout keeps a legacy key a custom alias owns, and the next launch still does not import it", async () => {
  // `openai` is aliased to custom:openai-legacy with migration deferred: its legacy record is that endpoint's key.
  const stores = durableStores(
    { openai: "sk-custom-endpoint" },
    { openai: { type: "api_key", key: "sk-builtin" } },
    { customOwned: ["openai"] },
  );

  await stores.logout("openai");
  assert.equal(stores.legacyKeys.get("openai"), "sk-custom-endpoint", "the custom endpoint's key survives");

  await migrateLegacyApiKeysToPi(stores.launch());
  assert.equal(stores.piCredentials.has("openai"), false, "the signed-out built-in stays signed out");
  assert.equal(stores.legacyKeys.get("openai"), "sk-custom-endpoint");
});

test("a current Pi credential wins over the legacy record", async () => {
  const oauth = { type: "oauth", access: "a", refresh: "r", expires: 1 } as unknown as Credential;
  const stores = durableStores({ anthropic: "sk-stale" }, { anthropic: oauth });

  await migrateLegacyApiKeysToPi(stores.launch());

  assert.equal(stores.piCredentials.get("anthropic"), oauth);
});

test("a failed Pi write keeps the legacy record so the key is not lost", async () => {
  const stores = durableStores({ google: "sk-google" });
  stores.failModify("google");

  await assert.rejects(migrateLegacyApiKeysToPi(stores.launch()), /credential store unavailable/);

  assert.equal(stores.legacyKeys.get("google"), "sk-google");
  assert.equal(stores.piCredentials.has("google"), false);
});
