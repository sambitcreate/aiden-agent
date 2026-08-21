import assert from "node:assert/strict";
import test from "node:test";
import {
  CREATE_IMAGES_CANVAS_NAVIGATION_KEY,
  createImagesCanvasNavigationProps,
  readCreateImagesCanvasNavigationPreferences,
  writeCreateImagesCanvasNavigationPreferences,
} from "./canvas-navigation-preferences-core.js";

test("canvas navigation preferences are device-local, bounded, and fail closed", () => {
  const values = new Map<string, string>();
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
  };
  assert.equal(readCreateImagesCanvasNavigationPreferences(storage).mode, "classic");
  writeCreateImagesCanvasNavigationPreferences(storage, {
    version: 1,
    mode: "trackpad",
    zoomOnDoubleClick: false,
  });
  const stored = readCreateImagesCanvasNavigationPreferences(storage);
  assert.equal(stored.mode, "trackpad");
  assert.equal(createImagesCanvasNavigationProps(stored).panOnScroll, true);
  values.set(CREATE_IMAGES_CANVAS_NAVIGATION_KEY, JSON.stringify({ version: 2, mode: "hostile" }));
  assert.equal(readCreateImagesCanvasNavigationPreferences(storage).mode, "classic");
});
