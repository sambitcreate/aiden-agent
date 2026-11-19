// Connection suggestions for Bots: which connector to offer, how to name it,
// and where its setup starts. Shared by transcript connect cards, the Bot-only
// `suggest_connection` tool, and Remote clients.

import { COMPOSIO_APPS, CONNECTOR_CATALOG, isConnectorAvailable } from "./connector-catalog.js";

/** Where the existing preset setup flow (`mcp-preset-setup.tsx`) starts for a suggestion. */
export type BotConnectionSetupEntry =
  /** The suggestion is itself a connector preset. */
  | { kind: "mcp-preset"; presetId: string }
  /** Aiden cannot sign in to this app directly; Composio's preset covers it. */
  | { kind: "composio"; presetId: "composio"; appName: string };

export interface BotConnectionSuggestion {
  pluginId: string;
  /** Full display name, used in "Connect {name}". */
  name: string;
  /** Catalog id understood by `McpPresetIcon` (and native icon maps). */
  iconId: string;
  setupEntry: BotConnectionSetupEntry;
}

/**
 * `needs_access` is derived for the desktop only, never stored or sent to
 * phones: the app is connected in Aiden, but this Bot's Custom access leaves
 * it out, so the card's Connect adds it to this Bot.
 */
export type ConnectCardStatus = "pending" | "connected" | "dismissed" | "needs_access";

/** Typed Bot transcript entry appended by `suggest_connection`. */
export interface ConnectCardEntry {
  type: "connect_card";
  pluginId: string;
  reason: string;
  status: ConnectCardStatus;
}

export const CONNECT_CARD_REASON_MAX_CHARS = 280;

type SuggestionTarget = { name: string; setupEntry: BotConnectionSetupEntry };

/**
 * Connectors that can be set up now, plus the apps Composio covers, by id.
 * A connector served by a Mac app (iMCP) is set up in Settings only: Bots run
 * on Linux too, and phones have no card for it.
 */
const SUGGESTIONS_BY_ID: ReadonlyMap<string, SuggestionTarget> = new Map<string, SuggestionTarget>([
  ...CONNECTOR_CATALOG.filter((entry) => isConnectorAvailable(entry) && !entry.macApp).map((entry): [string, SuggestionTarget] => [
    entry.id,
    { name: entry.name, setupEntry: { kind: "mcp-preset", presetId: entry.id } },
  ]),
  ...COMPOSIO_APPS.map((app): [string, SuggestionTarget] => [
    app.id,
    { name: app.name, setupEntry: { kind: "composio", presetId: "composio", appName: app.name } },
  ]),
]);

export function connectionSuggestionFor(pluginId: string): BotConnectionSuggestion | null {
  const match = SUGGESTIONS_BY_ID.get(pluginId);
  if (!match) return null;
  return {
    pluginId,
    name: match.name,
    iconId: pluginId,
    setupEntry: match.setupEntry,
  };
}
