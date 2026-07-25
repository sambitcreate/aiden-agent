import assert from "node:assert/strict";
import test from "node:test";
import {
  migrateGoogleProviderPreferences,
  SELECTED_PROVIDER_KEY,
} from "./google-provider-migration.js";
import { MODEL_PAD_LAYOUT_KEY } from "./model-pad-layout.js";
import { PINNED_MODELS_KEY } from "./model-picker-data.js";

function memoryStorage(initial: Record<string, string>) {
  const values = new Map(Object.entries(initial));
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
    value: (key: string) => values.get(key),
  };
}

test("migrates selected, pinned, and Model Pad Google identities idempotently", () => {
  const storage = memoryStorage({
    [SELECTED_PROVIDER_KEY]: "gemini",
    [PINNED_MODELS_KEY]: JSON.stringify([
      "gemini::gemini-2.5-pro",
      "openai::gpt-4.1",
      "google::gemini-2.5-pro",
    ]),
    [MODEL_PAD_LAYOUT_KEY]: JSON.stringify({
      schemaVersion: 1,
      placements: {
        "gemini::gemini-2.5-pro": { x: 0.2, y: 0.8, source: "user" },
        "google::gemini-2.5-pro": { x: 0.7, y: 0.6, source: "user" },
        "openai::gpt-4.1": { x: 0.4, y: 0.5, source: "user" },
      },
    }),
  });

  assert.equal(migrateGoogleProviderPreferences(storage), true);
  assert.equal(storage.value(SELECTED_PROVIDER_KEY), "google");
  assert.deepEqual(JSON.parse(storage.value(PINNED_MODELS_KEY) ?? "[]"), [
    "google::gemini-2.5-pro",
    "openai::gpt-4.1",
  ]);
  assert.deepEqual(JSON.parse(storage.value(MODEL_PAD_LAYOUT_KEY) ?? "{}").placements, {
    "google::gemini-2.5-pro": { x: 0.7, y: 0.6, source: "user" },
    "openai::gpt-4.1": { x: 0.4, y: 0.5, source: "user" },
  });
  assert.equal(migrateGoogleProviderPreferences(storage), false);
});

test("malformed preferences do not block startup", () => {
  const storage = memoryStorage({
    [PINNED_MODELS_KEY]: "{",
    [MODEL_PAD_LAYOUT_KEY]: "[]",
  });
  assert.equal(migrateGoogleProviderPreferences(storage), false);
  assert.equal(storage.value(PINNED_MODELS_KEY), "{");
  assert.equal(storage.value(MODEL_PAD_LAYOUT_KEY), "[]");
});

test("migrates legacy Moonshot selections into Pi's moonshotai provider", () => {
  const storage = memoryStorage({
    [SELECTED_PROVIDER_KEY]: "moonshot",
    [PINNED_MODELS_KEY]: JSON.stringify([
      "moonshot::moonshot-v1-128k",
      "moonshotai::moonshot-v1-128k",
    ]),
    [MODEL_PAD_LAYOUT_KEY]: JSON.stringify({
      schemaVersion: 1,
      placements: {
        "moonshot::moonshot-v1-128k": { x: 0.2, y: 0.8, source: "user" },
      },
    }),
  });

  assert.equal(migrateGoogleProviderPreferences(storage), true);
  assert.equal(storage.value(SELECTED_PROVIDER_KEY), "moonshotai");
  assert.deepEqual(JSON.parse(storage.value(PINNED_MODELS_KEY) ?? "[]"), [
    "moonshotai::moonshot-v1-128k",
  ]);
  assert.deepEqual(JSON.parse(storage.value(MODEL_PAD_LAYOUT_KEY) ?? "{}").placements, {
    "moonshotai::moonshot-v1-128k": { x: 0.2, y: 0.8, source: "user" },
  });
});

test("moves edited legacy-provider preferences into their reserved custom identity", () => {
  const storage = memoryStorage({
    [SELECTED_PROVIDER_KEY]: "openai",
    [PINNED_MODELS_KEY]: JSON.stringify(["openai::work-model"]),
    [MODEL_PAD_LAYOUT_KEY]: JSON.stringify({
      schemaVersion: 1,
      placements: { "openai::work-model": { x: 0.4, y: 0.5, source: "user" } },
    }),
  });

  assert.equal(migrateGoogleProviderPreferences(storage, { openai: "custom:openai-legacy" }), true);
  assert.equal(storage.value(SELECTED_PROVIDER_KEY), "custom:openai-legacy");
  assert.deepEqual(JSON.parse(storage.value(PINNED_MODELS_KEY) ?? "[]"), [
    "custom:openai-legacy::work-model",
  ]);
  assert.deepEqual(JSON.parse(storage.value(MODEL_PAD_LAYOUT_KEY) ?? "{}").placements, {
    "custom:openai-legacy::work-model": { x: 0.4, y: 0.5, source: "user" },
  });
});
