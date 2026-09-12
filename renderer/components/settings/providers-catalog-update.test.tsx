import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("./providers-settings.tsx", import.meta.url), "utf8");

test("Providers exposes a labeled combined catalog update with honest partial outcomes", () => {
  assert.match(source, /Update model catalogs/u);
  assert.match(source, /providersApi\.updateCatalogs\(\)/u);
  assert.match(source, /inventoryErrors/u);
  assert.match(source, /model details kept cached data/u);
  assert.doesNotMatch(source, /aria-label="Refresh built-in provider models"/u);
});

test("catalog details disclose authority and foreground network privacy", () => {
  assert.match(source, /aria-expanded=\{catalogDetailsOpen\}/u);
  assert.match(source, /models\.dev/u);
  assert.match(source, /sends no[\s\S]*prompts/u);
  assert.match(source, /This foreground update contacts/u);
  assert.match(source, /affects display details only/u);
  assert.match(source, /never which[\s\S]*models can run/u);
});
