import assert from "node:assert/strict";
import test from "node:test";
import {
  migrateGoogleProviderPreferences,
  SELECTED_PROVIDER_KEY,
} from "./google-provider-migration.js";

function memoryStorage(initial: Record<string, string>) {
  const values = new Map(Object.entries(initial));
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
    value: (key: string) => values.get(key),
    keys: () => [...values.keys()].sort(),
  };
}

test("migrates the selected Google identity idempotently", () => {
  const storage = memoryStorage({ [SELECTED_PROVIDER_KEY]: "gemini" });

  assert.equal(migrateGoogleProviderPreferences(storage), true);
  assert.equal(storage.value(SELECTED_PROVIDER_KEY), "google");
  assert.equal(migrateGoogleProviderPreferences(storage), false);
});

test("an absent or current selection is left alone", () => {
  const empty = memoryStorage({});
  assert.equal(migrateGoogleProviderPreferences(empty), false);
  assert.deepEqual(empty.keys(), []);

  const current = memoryStorage({ [SELECTED_PROVIDER_KEY]: "openai" });
  assert.equal(migrateGoogleProviderPreferences(current), false);
  assert.equal(current.value(SELECTED_PROVIDER_KEY), "openai");
});

test("storage denial does not block startup", () => {
  const denied = {
    getItem: () => {
      throw new Error("denied");
    },
    setItem: () => {
      throw new Error("denied");
    },
  };
  assert.equal(migrateGoogleProviderPreferences(denied), false);
});

test("migrates legacy Moonshot selections into Pi's moonshotai provider", () => {
  const storage = memoryStorage({ [SELECTED_PROVIDER_KEY]: "moonshot" });

  assert.equal(migrateGoogleProviderPreferences(storage), true);
  assert.equal(storage.value(SELECTED_PROVIDER_KEY), "moonshotai");
});

test("moves an edited legacy-provider selection into its reserved custom identity", () => {
  const storage = memoryStorage({ [SELECTED_PROVIDER_KEY]: "openai" });

  assert.equal(migrateGoogleProviderPreferences(storage, { openai: "custom:openai-legacy" }), true);
  assert.equal(storage.value(SELECTED_PROVIDER_KEY), "custom:openai-legacy");
});

test("keeps the local selection through onboarding ID aliases", () => {
  const releasedId = "custom:onboarding-lmstudio";
  const canonicalId = "custom:lmstudio";
  const storage = memoryStorage({ [SELECTED_PROVIDER_KEY]: releasedId });

  assert.equal(migrateGoogleProviderPreferences(storage, { [releasedId]: canonicalId }), true);
  assert.equal(storage.value(SELECTED_PROVIDER_KEY), canonicalId);
  assert.equal(migrateGoogleProviderPreferences(storage, { [releasedId]: canonicalId }), false);
});

test("Azure selections migrate while custom aliases retain ownership", () => {
  for (const aliases of [{}, { "azure-openai-responses": "custom:azure" }] as Array<
    Record<string, string>
  >) {
    const storage = memoryStorage({ [SELECTED_PROVIDER_KEY]: "azure-openai-responses" });
    const target = aliases["azure-openai-responses"] ?? "azure";
    assert.equal(migrateGoogleProviderPreferences(storage, aliases), true);
    assert.equal(storage.value(SELECTED_PROVIDER_KEY), target);
    assert.equal(migrateGoogleProviderPreferences(storage, aliases), false);
  }
});
