import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { PLUGIN_CATALOG } from "../../shared/plugin-catalog.js";
import {
  McpPresetIcon,
  PLUGIN_ICON_CATALOG_IDS,
  PLUGIN_ICON_SLUGS,
  pluginIconInitial,
} from "./mcp-preset-icons.js";

const catalogIds = new Set(PLUGIN_CATALOG.map((plugin) => plugin.id));
const renderIcon = (presetId: string, name: string) =>
  renderToStaticMarkup(createElement(McpPresetIcon, { presetId, name, className: "size-4" }));

test("plugins without a brand mark render a hidden, centered name initial", () => {
  const html = renderIcon("game-studio", "Game Studio");
  assert.doesNotMatch(html, /<svg/u);
  assert.match(html, /^<span aria-hidden="true" class="[^"]*\bjustify-center\b[^"]*">G<\/span>$/u);
  assert.equal(pluginIconInitial("Dropbox"), "D");
  assert.equal(pluginIconInitial("monday.com"), "M");
  assert.equal(pluginIconInitial("  granola"), "G");
  assert.equal(pluginIconInitial("!!"), "?");
});

test("every mapped catalog plugin renders a decorative brand mark", () => {
  for (const pluginId of PLUGIN_ICON_CATALOG_IDS) {
    assert.ok(catalogIds.has(pluginId), `icon mapping for unknown plugin ${pluginId}`);
    const html = renderIcon(pluginId, pluginId);
    assert.match(html, /^<svg[^>]*aria-hidden="true"/u, `${pluginId} renders an svg mark`);
    assert.match(html, /<path[^>]* d="[Mm][^"]+"/u, `${pluginId} has a drawn path`);
    assert.match(html, /class="size-4"/u);
  }
});

test("OpenAI-built plugins borrow the OpenAI mark rather than a misleading substitute", () => {
  assert.equal(PLUGIN_ICON_SLUGS["test-android-apps"], "openai");
  assert.equal(PLUGIN_ICON_SLUGS["build-ios-apps"], "openai");
  assert.equal(
    renderIcon("build-ios-apps", "Build iOS Apps"),
    renderIcon("test-android-apps", "Test Android Apps"),
  );
  assert.notEqual(renderIcon("dropbox", "Dropbox"), renderIcon("build-ios-apps", "Build iOS Apps"));
});
