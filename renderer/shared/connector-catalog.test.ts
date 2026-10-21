import assert from "node:assert/strict";
import test from "node:test";
import {
  CONNECTOR_CATALOG,
  filterConnectorCatalog,
  getConnectorCatalogEntry,
  isConnectorAvailable,
} from "./connector-catalog.js";

const ids = (search: string, category: string | "all" = "all") =>
  filterConnectorCatalog(CONNECTOR_CATALOG, search, category).map((result) => result.entry.id);

test("catalog entries are unique, documented, and reachable only over HTTPS or this device's loopback", () => {
  const seen = new Set<string>();
  for (const entry of CONNECTOR_CATALOG) {
    assert.match(entry.id, /^[a-z0-9-]+$/u);
    assert.ok(!seen.has(entry.id), `${entry.id} is unique`);
    seen.add(entry.id);
    assert.ok(entry.name && entry.tagline && entry.category, entry.id);
    assert.ok(entry.vendor.startsWith("By "), entry.id);
    assert.equal(new URL(entry.docsUrl).protocol, "https:", `${entry.id} documentation is HTTPS`);
    const url = new URL(entry.url);
    assert.equal(url.username + url.password, "", `${entry.id} carries no credentials in its URL`);
    if (entry.local) {
      assert.equal(url.protocol, "http:");
      assert.equal(url.hostname, "127.0.0.1", `${entry.id} stays on this device`);
      assert.equal(entry.auth.kind, "none", "a local server never receives a credential");
    } else {
      assert.equal(url.protocol, "https:", `${entry.id} uses HTTPS`);
      assert.notEqual(entry.auth.kind, "none", `${entry.id} is a hosted service that needs a credential`);
    }
    if (entry.auth.kind === "apiKey") assert.equal(new URL(entry.auth.keyHelpUrl).protocol, "https:");
  }
});

test("an unavailable connector explains why and names an alternative that can be set up", () => {
  const unavailable = CONNECTOR_CATALOG.filter((entry) => !isConnectorAvailable(entry));
  assert.deepEqual(unavailable.map((entry) => entry.id), ["figma"]);
  for (const entry of unavailable) {
    assert.ok(entry.availability?.reason);
    const alternative = getConnectorCatalogEntry(entry.availability!.alternativeId!);
    assert.ok(alternative && isConnectorAvailable(alternative), `${entry.id} points at a usable alternative`);
  }
  assert.equal(getConnectorCatalogEntry("figma")?.availability?.alternativeId, "figma-desktop");
});

test("searching for an app Composio reaches finds the Composio card with a hint", () => {
  for (const app of ["Gmail", "google calendar", "Google Drive", "slack", "Teams", "outlook", "Zoom", "shopify"]) {
    const results = filterConnectorCatalog(CONNECTOR_CATALOG, app, "all");
    const composio = results.find((result) => result.entry.id === "composio");
    assert.ok(composio, `${app} finds Composio`);
    assert.ok(composio.matchedAlias, `${app} matched through an alias`);
    assert.match(composio.entry.aliasHint ?? "", /500\+ apps through Composio/u);
  }
});

test("a match on the card itself carries no alias hint, and category filters apply", () => {
  const [composio] = filterConnectorCatalog(CONNECTOR_CATALOG, "composio", "all");
  assert.equal(composio?.entry.id, "composio");
  assert.equal(composio?.matchedAlias, undefined);
  assert.deepEqual(ids("jira"), ["atlassian-rovo"]);
  assert.ok(ids("figma").includes("figma-desktop"));
  assert.deepEqual(ids("gmail", "Developer Tools"), []);
  assert.ok(ids("", "Developer Tools").every((id) => getConnectorCatalogEntry(id)?.category === "Developer Tools"));
  assert.equal(ids("").length, CONNECTOR_CATALOG.length);
  assert.deepEqual(ids("no such connector anywhere"), []);
});
