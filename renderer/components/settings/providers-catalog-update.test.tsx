import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("./providers-settings.tsx", import.meta.url), "utf8");

test("Providers keeps release model metadata offline during ordinary app use", () => {
  assert.doesNotMatch(source, /Update model catalogs/u);
  assert.doesNotMatch(source, /providersApi\.updateCatalogs\(\)/u);
  assert.doesNotMatch(source, /models\.dev/u);
  assert.match(source, /bundled release snapshot/u);
  assert.match(source, /stay offline during ordinary app use/u);
});
