// Connection suggestions for Bots: which catalog plugin to offer, how to name it,
// and where its setup starts. Shared by the create-flow chips, transcript connect
// cards, the Bot-only `suggest_connection` tool, and Remote clients.

import { isConnectablePlugin, PLUGIN_CATALOG, type PluginCatalogEntry } from "./plugin-catalog.js";

/** Where the existing preset setup flow (`mcp-preset-setup.tsx`) starts for a suggestion. */
export type BotConnectionSetupEntry =
  /** The plugin is itself a connectable preset. */
  | { kind: "mcp-preset"; presetId: string }
  /** Aiden cannot sign in to this app directly; Composio's preset covers it. */
  | { kind: "composio"; presetId: "composio"; appName: string };

export interface BotConnectionSuggestion {
  pluginId: string;
  /** Full display name, used in "Connect {name}". */
  name: string;
  /** Short chip label. */
  chipLabel: string;
  /** Catalog id understood by `McpPresetIcon` (and native icon maps). */
  iconId: string;
  setupEntry: BotConnectionSetupEntry;
}

export type ConnectCardStatus = "pending" | "connected" | "dismissed";

/** Typed Bot transcript entry appended by `suggest_connection`. */
export interface ConnectCardEntry {
  type: "connect_card";
  pluginId: string;
  reason: string;
  status: ConnectCardStatus;
}

export const CONNECT_CARD_REASON_MAX_CHARS = 280;

/** Apps that Composio connects when Aiden cannot complete their own sign-in. */
const COMPOSIO_COVERED_PLUGIN_IDS: ReadonlySet<string> = new Set([
  "gmail",
  "google-calendar",
  "outlook-email",
  "outlook-calendar",
  "slack",
  "teams",
]);

const CHIP_LABELS: Readonly<Record<string, string>> = {
  composio: "500+ apps",
  "google-calendar": "Calendar",
  "outlook-email": "Outlook",
  "outlook-calendar": "Outlook Calendar",
};

const CATALOG_BY_ID: ReadonlyMap<string, PluginCatalogEntry> = new Map(
  PLUGIN_CATALOG.map((plugin) => [plugin.id, plugin]),
);

export function connectionSuggestionFor(pluginId: string): BotConnectionSuggestion | null {
  const plugin = CATALOG_BY_ID.get(pluginId);
  if (!plugin) return null;
  let setupEntry: BotConnectionSetupEntry;
  if (isConnectablePlugin(plugin)) {
    setupEntry = { kind: "mcp-preset", presetId: plugin.id };
  } else if (COMPOSIO_COVERED_PLUGIN_IDS.has(plugin.id)) {
    setupEntry = { kind: "composio", presetId: "composio", appName: plugin.name };
  } else {
    return null;
  }
  return {
    pluginId: plugin.id,
    name: plugin.name,
    chipLabel: CHIP_LABELS[plugin.id] ?? plugin.name,
    iconId: plugin.id,
    setupEntry,
  };
}

/** Whole-word keywords, in priority order per plugin list. */
const KEYWORD_PLUGINS: ReadonlyArray<readonly [keywords: readonly string[], pluginIds: readonly string[]]> = [
  [["email", "emails", "e-mail", "inbox", "inboxes", "mail", "gmail"], ["gmail", "outlook-email"]],
  [["outlook"], ["outlook-email"]],
  [
    ["calendar", "calendars", "meeting", "meetings", "schedule", "appointment", "appointments"],
    ["google-calendar"],
  ],
  [["notes", "note", "docs", "doc", "wiki", "notion"], ["notion"]],
  [["slack"], ["slack"]],
  [["apps", "everything", "integrations", "composio"], ["composio"]],
];

const DEFAULT_PLUGIN_IDS = ["gmail", "google-calendar", "notion", "composio"] as const;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

const KEYWORD_PATTERNS = KEYWORD_PLUGINS.map(([keywords, pluginIds]) => ({
  pattern: new RegExp(
    `(?<![\\p{L}\\p{N}])(?:${keywords.map(escapeRegExp).join("|")})(?![\\p{L}\\p{N}])`,
    "iu",
  ),
  pluginIds,
}));

/**
 * Rank chips from the "What should it help with?" answer and a preset's suggestions:
 * keyword matches first (by where they appear), then preset ids, then defaults.
 * Composio is always offered, in the last slot if the list is full.
 */
export function rankConnections(
  text: string,
  presetIds: readonly string[] = [],
  limit = 6,
): BotConnectionSuggestion[] {
  const matches = KEYWORD_PATTERNS.flatMap(({ pattern, pluginIds }) => {
    const index = text.search(pattern);
    return index < 0 ? [] : pluginIds.map((pluginId, order) => ({ pluginId, index, order }));
  }).sort((a, b) => a.index - b.index || a.order - b.order);

  const ordered: BotConnectionSuggestion[] = [];
  const seen = new Set<string>();
  for (const pluginId of [...matches.map((match) => match.pluginId), ...presetIds, ...DEFAULT_PLUGIN_IDS]) {
    if (seen.has(pluginId)) continue;
    seen.add(pluginId);
    const suggestion = connectionSuggestionFor(pluginId);
    if (suggestion) ordered.push(suggestion);
  }

  const size = Math.max(1, Math.floor(limit));
  const ranked = ordered.slice(0, size);
  if (!ranked.some((suggestion) => suggestion.pluginId === "composio")) {
    const composio = ordered.find((suggestion) => suggestion.pluginId === "composio");
    if (composio) ranked.splice(Math.min(ranked.length, size - 1), 1, composio);
  }
  return ranked;
}
