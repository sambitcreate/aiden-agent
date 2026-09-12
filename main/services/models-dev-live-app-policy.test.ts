import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

test("models.dev refresh is confined to the explicit foreground catalog action", () => {
  const providers = readFileSync(new URL("../handlers/providers.ts", import.meta.url), "utf8");
  const catalog = readFileSync(new URL("./models-catalog.ts", import.meta.url), "utf8");
  const startup = readFileSync(new URL("../index.ts", import.meta.url), "utf8");
  const actionStart = providers.indexOf('ipcMain.handle("providers:updateCatalogs"');
  const actionEnd = providers.indexOf('ipcMain.handle(', actionStart + 1);
  const foreground = providers.slice(actionStart, actionEnd);
  assert.ok(actionStart >= 0 && actionEnd > actionStart);
  assert.match(foreground, /providerAuthOwner\(event\)/u);
  assert.match(foreground, /modelsDevCacheRuntime\.refresh\(\)/u);
  assert.doesNotMatch(providers.slice(0, actionStart) + providers.slice(actionEnd), /modelsDevCacheRuntime\.refresh/u);
  assert.match(catalog, /modelsDevCacheRuntime\.catalog\(bundled\)/u);
  assert.doesNotMatch(catalog + startup, /modelsDevCacheRuntime\.refresh|fetchModelsDevCatalog/u);
});
