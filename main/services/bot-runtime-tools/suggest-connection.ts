// Bot-only `suggest_connection` tool. It appends a typed connect card to the Bot's
// chat so the person can choose to connect an app; it never connects anything
// itself. The durable Bot runtime registers it with per-Bot dependencies.

import { Type } from "@earendil-works/pi-ai";
import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import {
  CONNECT_CARD_REASON_MAX_CHARS,
  connectionSuggestionFor,
  type ConnectCardEntry,
  type ConnectCardStatus,
} from "../../../renderer/shared/bot-connections.js";
import { declarePiRuntimeReplay } from "../pi-runtime-tool.js";
import {
  assertMcpPresetServer,
  getMcpPreset,
  presetServerId,
  type McpPreset,
} from "../mcp-presets.js";
import type { McpServer } from "../types.js";
import { mcpServerOffersTools } from "../../../renderer/shared/mcp-exposure.js";

export const SUGGEST_CONNECTION_TOOL_NAME = "suggest_connection";

type MaybePromise<T> = T | Promise<T>;

export interface BotConnectionReadinessDeps {
  listServers(): Promise<readonly McpServer[]>;
  /** The preset's API key is saved for this exact server configuration. */
  hasPresetKey(server: McpServer): Promise<boolean>;
  /** OAuth tokens are saved for this server's current authorization binding. */
  hasOAuthTokens(server: McpServer, preset: McpPreset): Promise<boolean>;
}

/**
 * Whether a suggested plugin is usable now: its own preset is saved, valid,
 * switched on, and signed in. This is the renderer's connect-card rule, so the
 * Bot, the desktop card, and Remote agree. Apps reached through Composio are
 * never reported connected: Aiden cannot see which apps Composio has linked.
 */
export async function isBotConnectionReady(
  pluginId: string,
  deps: BotConnectionReadinessDeps,
): Promise<boolean> {
  const suggestion = connectionSuggestionFor(pluginId);
  if (suggestion?.setupEntry.kind !== "mcp-preset") return false;
  const presetId = suggestion.setupEntry.presetId;
  const preset = getMcpPreset(presetId);
  if (!preset) return false;
  const serverId = presetServerId(presetId);
  const server = (await deps.listServers()).find(
    (entry) => entry.id === serverId && entry.presetId === presetId,
  );
  // Switched off for the model: the Bot cannot use it, so it is not "connected" for the Bot.
  if (!server?.enabled || !mcpServerOffersTools(server)) return false;
  try {
    assertMcpPresetServer(server);
  } catch {
    return false;
  }
  if (preset.auth.kind === "none") return true;
  return preset.auth.kind === "apiKey"
    ? deps.hasPresetKey(server)
    : deps.hasOAuthTokens(server, preset);
}

/**
 * The Aiden connection (MCP server id) a suggestion stands for, which is what a
 * Custom-access Bot's selection names. Composio apps have none of their own.
 */
export function connectionSourceIdFor(pluginId: string): string | undefined {
  const suggestion = connectionSuggestionFor(pluginId);
  return suggestion?.setupEntry.kind === "mcp-preset" ? presetServerId(suggestion.setupEntry.presetId) : undefined;
}

export interface ConnectCardStatusDeps {
  isConnected(pluginId: string): MaybePromise<boolean>;
  /** True when this Bot's own (Custom) access leaves the connection out. */
  botLacksConnection(botId: string, sourceId: string): MaybePromise<boolean>;
  isDismissed(botId: string, pluginId: string): MaybePromise<boolean>;
}

/**
 * What a pending connect card shows now: connected and usable by this Bot,
 * connected in Aiden but not part of this Bot's access ("Add to this Bot"),
 * answered with Not now, or still waiting. Shared with Remote, which shows
 * `needs_access` as pending.
 */
export async function resolveConnectCardStatus(
  botId: string,
  card: ConnectCardEntry,
  deps: ConnectCardStatusDeps,
): Promise<ConnectCardStatus> {
  if (await deps.isConnected(card.pluginId)) {
    const sourceId = connectionSourceIdFor(card.pluginId);
    if (sourceId === undefined || !(await deps.botLacksConnection(botId, sourceId))) return "connected";
    // Not now on "Add to this Bot" settles the card without granting anything.
    return (await deps.isDismissed(botId, card.pluginId)) ? "dismissed" : "needs_access";
  }
  if (await deps.isDismissed(botId, card.pluginId)) return "dismissed";
  return card.status;
}

export interface SuggestConnectionDeps {
  /** True when the plugin (or the preset that covers it) is already set up. */
  isConnected(pluginId: string): MaybePromise<boolean>;
  /**
   * Optional: true when the app is set up in Aiden but this Bot's access
   * leaves it out. The card then offers "Add to this Bot" instead.
   */
  botLacksConnection?(botId: string, pluginId: string): MaybePromise<boolean>;
  /**
   * Optional: true when the Bot's own access includes the app but this chat's
   * narrower access leaves it out. No card can change that, so none is shown.
   */
  chatLacksConnection?(botId: string, pluginId: string): MaybePromise<boolean>;
  /** True after the person chose Not now for this plugin on this Bot. */
  isDismissed(botId: string, pluginId: string): MaybePromise<boolean>;
  appendConnectCard(botId: string, card: ConnectCardEntry): MaybePromise<void>;
  /** Optional: true when this Bot's chat already shows a pending card for the plugin. */
  hasPendingCard?(botId: string, pluginId: string): MaybePromise<boolean>;
}

export type SuggestConnectionStatus =
  | "suggested"
  | "already_connected"
  | "chat_restricted"
  | "dismissed"
  | "pending"
  | "unknown_plugin";

export interface SuggestConnectionDetails {
  status: SuggestConnectionStatus;
  pluginId: string;
}

function result(
  status: SuggestConnectionStatus,
  pluginId: string,
  text: string,
): AgentToolResult<SuggestConnectionDetails> {
  return { content: [{ type: "text", text }], details: { status, pluginId } };
}

function oneLine(value: string): string {
  const flat = value.replace(/\s+/gu, " ").trim();
  const chars = Array.from(flat);
  return chars.length <= CONNECT_CARD_REASON_MAX_CHARS
    ? flat
    : `${chars.slice(0, CONNECT_CARD_REASON_MAX_CHARS - 1).join("").trimEnd()}…`;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw signal.reason ?? new Error("The suggestion was cancelled.");
}

export function createSuggestConnectionTool(
  botId: string,
  deps: SuggestConnectionDeps,
): AgentTool {
  return declarePiRuntimeReplay(
    {
      name: SUGGEST_CONNECTION_TOOL_NAME,
      label: "Suggest Connection",
      description:
        "Show the person a card offering to connect an app (for example Gmail, Google Calendar, Notion, or Composio for 500+ apps) when that would clearly help with what they asked. The card has a Connect button and a Not now button; you do not connect anything yourself. Give one short, plain reason written to the person. Do not suggest an app that is already connected or that they turned down.",
      parameters: Type.Object({
        pluginId: Type.String({
          description: "Catalog id, for example gmail, google-calendar, notion, outlook-email, or composio.",
        }),
        reason: Type.String({
          description: "One short sentence to the person explaining why connecting helps.",
        }),
      }),
      execute: async (
        _toolCallId,
        rawParams,
        signal,
      ): Promise<AgentToolResult<SuggestConnectionDetails>> => {
        const { pluginId, reason } = rawParams as { pluginId?: unknown; reason?: unknown };
        if (typeof pluginId !== "string" || pluginId.trim().length === 0) {
          throw new Error("A pluginId is required.");
        }
        if (typeof reason !== "string" || reason.trim().length === 0) {
          throw new Error("A reason is required.");
        }
        throwIfAborted(signal);
        const suggestion = connectionSuggestionFor(pluginId.trim());
        if (!suggestion) {
          return result(
            "unknown_plugin",
            pluginId,
            `"${pluginId}" isn't an app Aiden can connect. Don't suggest it.`,
          );
        }
        const id = suggestion.pluginId;
        const connected = await deps.isConnected(id);
        const needsAccess = connected && (await deps.botLacksConnection?.(botId, id)) === true;
        if (connected && !needsAccess && (await deps.chatLacksConnection?.(botId, id)) === true) {
          return result(
            "chat_restricted",
            id,
            `${suggestion.name} is connected and in your Bot access, but this chat's own access was narrowed and leaves it out, so you can't use it here. Tell the person; a card can't change this chat's access.`,
          );
        }
        if (connected && !needsAccess) {
          return result(
            "already_connected",
            id,
            `${suggestion.name} is already connected. Use it instead of suggesting it.`,
          );
        }
        if (await deps.isDismissed(botId, id)) {
          return result(
            "dismissed",
            id,
            `The person chose Not now for ${suggestion.name}. Don't suggest it again.`,
          );
        }
        if (deps.hasPendingCard && (await deps.hasPendingCard(botId, id))) {
          return result(
            "pending",
            id,
            `A card to connect ${suggestion.name} is already waiting in the chat.`,
          );
        }
        throwIfAborted(signal);
        await deps.appendConnectCard(botId, {
          type: "connect_card",
          pluginId: id,
          reason: oneLine(reason),
          status: "pending",
        });
        return result(
          "suggested",
          id,
          needsAccess
            ? `${suggestion.name} is connected in Aiden, but your access doesn't include it. Showed a card so the person can add it to you. Wait for them to add it or choose Not now.`
            : `Showed a card to connect ${suggestion.name}. Wait for the person to connect it or choose Not now.`,
        );
      },
    },
    "never",
  );
}
