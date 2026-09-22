import assert from "node:assert/strict";
import test from "node:test";
import {
  CREATE_IMAGES_POWER_FEATURES_KEY,
  readCreateImagesPowerFeatures,
  writeCreateImagesPowerFeatures,
} from "./power-features-core.js";

test("power features use a bounded device preference with a fail-closed default", () => {
  const values = new Map<string, string>();
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => void values.set(key, value),
  };
  assert.equal(readCreateImagesPowerFeatures(storage), false);
  writeCreateImagesPowerFeatures(storage, true);
  assert.equal(values.get(CREATE_IMAGES_POWER_FEATURES_KEY), "enabled");
  assert.equal(readCreateImagesPowerFeatures(storage), true);
  values.set(CREATE_IMAGES_POWER_FEATURES_KEY, "future");
  assert.equal(readCreateImagesPowerFeatures(storage), false);
});
