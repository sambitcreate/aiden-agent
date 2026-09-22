import assert from "node:assert/strict";
import test from "node:test";
import {
  CREATE_IMAGES_AUTOSAVE_KEY,
  readCreateImagesAutosaveEnabled,
  writeCreateImagesAutosaveEnabled,
} from "./autosave-preferences-core.js";

test("Create Images autosave is device-local, defaults on, and can be disabled", () => {
  const values = new Map<string, string>();
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
  };

  assert.equal(readCreateImagesAutosaveEnabled(storage), true);
  writeCreateImagesAutosaveEnabled(storage, false);
  assert.equal(values.get(CREATE_IMAGES_AUTOSAVE_KEY), "disabled");
  assert.equal(readCreateImagesAutosaveEnabled(storage), false);
  writeCreateImagesAutosaveEnabled(storage, true);
  assert.equal(readCreateImagesAutosaveEnabled(storage), true);
});

test("unknown or unavailable Create Images autosave state fails safe to enabled", () => {
  assert.equal(
    readCreateImagesAutosaveEnabled({ getItem: () => "unexpected" }),
    true,
  );
  assert.equal(
    readCreateImagesAutosaveEnabled({
      getItem: () => {
        throw new Error("unavailable");
      },
    }),
    true,
  );
});
