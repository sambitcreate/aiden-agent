import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { PLUGIN_CATALOG } from "../../shared/plugin-catalog.js";
import {
  PLUGIN_ICON_CATALOG_IDS,
  PLUGIN_ICON_SLUGS,
  pluginIconInitial,
} from "./mcp-preset-icons.js";

const source = readFileSync(new URL("./mcp-preset-icons.tsx", import.meta.url), "utf8");
const catalogIds = new Set(PLUGIN_CATALOG.map((plugin) => plugin.id));

test("plugin fallback initials center in the icon well", () => {
  assert.match(source, /flex items-center justify-center leading-none text-center/u);
  assert.equal(pluginIconInitial("Dropbox"), "D");
  assert.equal(pluginIconInitial("monday.com"), "M");
  assert.equal(pluginIconInitial("  granola"), "G");
});

test("catalog brand marks use Simple Icons paths without misleading substitutes", () => {
  assert.ok(PLUGIN_ICON_CATALOG_IDS.includes("dropbox"));
  assert.equal(PLUGIN_ICON_SLUGS.dropbox, "dropbox");
  assert.match(source, /"dropbox": "M6 1\.807/u);
  assert.equal(PLUGIN_ICON_SLUGS["test-android-apps"], "openai");
  assert.equal(PLUGIN_ICON_SLUGS["build-ios-apps"], "openai");
  assert.equal(PLUGIN_ICON_SLUGS["game-studio"], undefined);
  for (const pluginId of Object.keys(PLUGIN_ICON_SLUGS)) {
    assert.ok(catalogIds.has(pluginId), `icon mapping for unknown plugin ${pluginId}`);
  }
});
