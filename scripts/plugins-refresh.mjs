/* global AbortSignal, console, fetch, process */
// Dev-time only: `npm run plugins:refresh`. Fetches the public Codex plugin
// directory (github.com/openai/plugins) without credentials and prints what
// differs from renderer/shared/plugin-catalog.ts. It never edits the catalog:
// connectable presets and their sign-in details stay a reviewed, local
// decision. Never call this from the app, startup, builds or tests.

import { writeFile } from "node:fs/promises";
import {
  PLUGIN_CATALOG,
  PLUGIN_CATALOG_SOURCE_URL,
  PLUGIN_CATALOG_VERIFIED_ON,
} from "../renderer/shared/plugin-catalog.ts";
import { diffPluginCatalog, formatPluginCatalogReport, mapUpstreamPlugin } from "./plugins-refresh-core.mjs";

const REPO = "openai/plugins";
const REF = process.env.PLUGINS_REFRESH_REF || "main";
const RAW = `https://raw.githubusercontent.com/${REPO}/${REF}`;
const MAX_BYTES = 2_000_000;
const TIMEOUT_MS = 20_000;
const CONCURRENCY = 8;

async function fetchJson(url, { optional = false } = {}) {
  const response = await fetch(url, {
    headers: { accept: "application/json, text/plain" },
    redirect: "error",
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (optional && response.status === 404) return undefined;
  if (!response.ok) throw new Error(`${url} returned HTTP ${response.status}.`);
  const body = await response.text();
  if (body.length > MAX_BYTES) throw new Error(`${url} is larger than expected.`);
  return JSON.parse(body);
}

async function mapLimit(items, limit, run) {
  const results = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await run(items[index]);
    }
  }));
  return results;
}

async function fetchUpstream() {
  const marketplace = await fetchJson(`${RAW}/.agents/plugins/marketplace.json`);
  if (!Array.isArray(marketplace?.plugins)) throw new Error("Upstream marketplace.json has no plugins list.");
  return mapLimit(marketplace.plugins, CONCURRENCY, async (entry) => {
    const local = entry?.source?.source === "local" && typeof entry.source.path === "string";
    if (!local) return mapUpstreamPlugin({ entry });
    const dir = `${RAW}/${entry.source.path.replace(/^\.\//u, "")}`;
    const [manifest, mcp, app] = await Promise.all([
      fetchJson(`${dir}/.codex-plugin/plugin.json`, { optional: true }),
      fetchJson(`${dir}/.mcp.json`, { optional: true }),
      fetchJson(`${dir}/.app.json`, { optional: true }),
    ]);
    return mapUpstreamPlugin({ entry, manifest, mcp, app });
  });
}

async function main() {
  const jsonOut = process.argv.find((arg) => arg.startsWith("--json="))?.slice("--json=".length);
  const upstream = await fetchUpstream();
  const diff = diffPluginCatalog(PLUGIN_CATALOG, upstream);
  console.log(formatPluginCatalogReport(diff, {
    verifiedOn: PLUGIN_CATALOG_VERIFIED_ON,
    sourceUrl: `${PLUGIN_CATALOG_SOURCE_URL} (${REF})`,
  }));
  if (jsonOut) await writeFile(jsonOut, `${JSON.stringify({ ref: REF, upstream, diff }, null, 2)}\n`);
}

main().catch((error) => {
  console.error(`plugins:refresh failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
