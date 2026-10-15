/* global URL */
// Pure mapping and diff logic for `npm run plugins:refresh`. No network or
// file access here: the CLI wrapper fetches the upstream Codex plugin
// directory and this module turns it into a review report.

/** Compatibilities where Aiden's local catalog decides how a hosted MCP is offered. */
const HOSTED_MCP = new Set(["http-mcp", "mcp-auth-unsupported"]);

function record(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value : undefined;
}

function text(value) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function httpsUrl(value) {
  const raw = text(value);
  if (!raw) return undefined;
  try {
    return new URL(raw).protocol === "https:" ? raw : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Map one upstream marketplace entry plus its plugin files into the fields
 * Aiden's catalog cares about. `manifest`, `mcp` and `app` are the parsed
 * `.codex-plugin/plugin.json`, `.mcp.json` and `.app.json` (undefined when
 * absent). The compatibility is upstream's shape only; Aiden may still list a
 * hosted MCP as `mcp-auth-unsupported` locally.
 */
export function mapUpstreamPlugin({ entry, manifest, mcp, app }) {
  const id = text(entry?.name);
  if (!id) throw new Error("Upstream marketplace entry has no name.");
  const source = record(entry.source);
  const ui = record(manifest?.interface) ?? {};
  const author = record(manifest?.author) ?? {};
  const servers = Object.values(record(mcp?.mcpServers) ?? {}).map(record).filter(Boolean);
  const httpServers = servers.filter((server) => server.type === "http" || (!server.command && server.url));
  const url = httpServers.map((server) => httpsUrl(server.url)).find(Boolean);

  let compatibility;
  if (source && source.source !== "local") compatibility = "git-marketplace";
  else if (url) compatibility = "http-mcp";
  else if (servers.some((server) => text(server.command))) compatibility = "local-stdio";
  else if (Object.keys(record(app?.apps) ?? {}).length > 0) compatibility = "chatgpt-app";
  else compatibility = "skills";

  const developer = text(ui.developerName) ?? text(author.name);
  return {
    id,
    // Git-hosted entries carry no manifest; their display name stays local.
    name: text(ui.displayName),
    vendor: developer ? `By ${developer}` : undefined,
    category: text(entry.category) ?? text(ui.category),
    tagline: text(ui.shortDescription),
    docsUrl: httpsUrl(ui.websiteURL) ?? httpsUrl(manifest?.homepage) ?? httpsUrl(source?.url),
    compatibility,
    ...(url ? { url } : {}),
  };
}

/**
 * Compare the local catalog with upstream. Aiden-only entries (`source:
 * "aiden"`) are never reported as removed, and local auth details are never
 * compared: preset sign-in stays a local, reviewed decision.
 */
export function diffPluginCatalog(local, upstream) {
  const upstreamById = new Map(upstream.map((plugin) => [plugin.id, plugin]));
  const localById = new Map(local.map((plugin) => [plugin.id, plugin]));
  const added = upstream.filter((plugin) => !localById.has(plugin.id));
  const removed = local.filter(
    (plugin) => plugin.source !== "aiden" && !upstreamById.has(plugin.id),
  );
  const changed = [];
  for (const plugin of local) {
    const remote = upstreamById.get(plugin.id);
    if (!remote || plugin.source === "aiden") continue;
    const changes = [];
    // Vendor attribution and taglines are Aiden's own copy, so only the
    // display name and category are compared.
    for (const field of ["name", "category"]) {
      if (remote[field] !== undefined && remote[field] !== plugin[field]) {
        changes.push({ field, local: plugin[field], upstream: remote[field] });
      }
    }
    const localHosted = HOSTED_MCP.has(plugin.compatibility);
    if (localHosted !== (remote.compatibility === "http-mcp") ||
      (!localHosted && plugin.compatibility !== remote.compatibility)) {
      changes.push({ field: "compatibility", local: plugin.compatibility, upstream: remote.compatibility });
    }
    if (localHosted && remote.url && plugin.url !== remote.url) {
      changes.push({ field: "url", local: plugin.url, upstream: remote.url });
    }
    if (changes.length) changed.push({ id: plugin.id, changes });
  }
  return { added, removed, changed };
}

/** Human-readable review report. Never suggests overwriting auth details. */
export function formatPluginCatalogReport(diff, { verifiedOn, sourceUrl }) {
  const lines = [`Plugin catalog vs ${sourceUrl} (last verified ${verifiedOn})`, ""];
  if (!diff.added.length && !diff.removed.length && !diff.changed.length) {
    lines.push("No differences. Update PLUGIN_CATALOG_VERIFIED_ON in renderer/shared/plugin-catalog.ts.");
    return lines.join("\n");
  }
  if (diff.added.length) {
    lines.push(`Added upstream (${diff.added.length}):`);
    for (const plugin of diff.added) {
      lines.push(`  + ${plugin.id} · ${plugin.name ?? plugin.id} · ${plugin.compatibility}${plugin.url ? ` · ${plugin.url}` : ""}`);
    }
    lines.push("");
  }
  if (diff.removed.length) {
    lines.push(`Removed upstream (${diff.removed.length}):`);
    for (const plugin of diff.removed) lines.push(`  - ${plugin.id} · ${plugin.name}`);
    lines.push("");
  }
  if (diff.changed.length) {
    lines.push(`Changed (${diff.changed.length}):`);
    for (const { id, changes } of diff.changed) {
      for (const change of changes) {
        lines.push(`  ~ ${id}.${change.field}: ${String(change.local)} → ${String(change.upstream)}`);
      }
    }
    lines.push("");
  }
  lines.push(
    "Review each change by hand in renderer/shared/plugin-catalog.ts. A new or changed hosted MCP URL",
    "needs its sign-in (OAuth dynamic registration or API key) verified before it becomes connectable.",
    "Then update PLUGIN_CATALOG_VERIFIED_ON.",
  );
  return lines.join("\n");
}
