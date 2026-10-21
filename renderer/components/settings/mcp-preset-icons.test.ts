import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { COMPOSIO_APPS, CONNECTOR_CATALOG } from "../../shared/connector-catalog.js";
import {
  McpPresetIcon,
  PLUGIN_ICON_CATALOG_IDS,
  pluginIconInitial,
} from "./mcp-preset-icons.js";

const knownIds = new Set([...CONNECTOR_CATALOG.map((entry) => entry.id), ...COMPOSIO_APPS.map((app) => app.id)]);
const renderIcon = (presetId: string, name: string) =>
  renderToStaticMarkup(createElement(McpPresetIcon, { presetId, name, className: "size-4" }));

test("connectors without a brand mark render a hidden, centered name initial", () => {
  const html = renderIcon("granola", "Granola");
  assert.doesNotMatch(html, /<svg/u);
  assert.match(html, /^<span aria-hidden="true" class="[^"]*\bjustify-center\b[^"]*">G<\/span>$/u);
  assert.equal(pluginIconInitial("Dropbox"), "D");
  assert.equal(pluginIconInitial("monday.com"), "M");
  assert.equal(pluginIconInitial("  granola"), "G");
  assert.equal(pluginIconInitial("!!"), "?");
});

test("every mapped connector or Composio app renders a decorative brand mark", () => {
  for (const id of PLUGIN_ICON_CATALOG_IDS) {
    assert.ok(knownIds.has(id), `icon mapping for unknown connector ${id}`);
    const html = renderIcon(id, id);
    assert.match(html, /^<svg[^>]*aria-hidden="true"/u, `${id} renders an svg mark`);
    assert.match(html, /<path[^>]* d="[Mm][^"]+"/u, `${id} has a drawn path`);
    assert.match(html, /class="size-4"/u);
  }
});

test("Figma Desktop shares Figma's mark", () => {
  assert.equal(renderIcon("figma-desktop", "Figma Desktop"), renderIcon("figma", "Figma"));
});
