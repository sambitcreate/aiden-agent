// Bot-only `suggest_connection` tool. It appends a typed connect card to the Bot's
// chat so the person can choose to connect an app; it never connects anything
// itself. The durable Bot runtime registers it with per-Bot dependencies.

import { Type } from "@earendil-works/pi-ai";
import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import {
  CONNECT_CARD_REASON_MAX_CHARS,
  connectionSuggestionFor,
  type ConnectCardEntry,
} from "../../../renderer/shared/bot-connections.js";
import { declarePiRuntimeReplay } from "../pi-runtime-tool.js";

export const SUGGEST_CONNECTION_TOOL_NAME = "suggest_connection";

type MaybePromise<T> = T | Promise<T>;

export interface SuggestConnectionDeps {
  /** True when the plugin (or the preset that covers it) is already set up. */
  isConnected(pluginId: string): MaybePromise<boolean>;
  /** True after the person chose Not now for this plugin on this Bot. */
  isDismissed(botId: string, pluginId: string): MaybePromise<boolean>;
  appendConnectCard(botId: string, card: ConnectCardEntry): MaybePromise<void>;
  /** Optional: true when this Bot's chat already shows a pending card for the plugin. */
  hasPendingCard?(botId: string, pluginId: string): MaybePromise<boolean>;
}

export type SuggestConnectionStatus =
  | "suggested"
  | "already_connected"
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
        if (await deps.isConnected(id)) {
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
          `Showed a card to connect ${suggestion.name}. Wait for the person to connect it or choose Not now.`,
        );
      },
    },
    "never",
  );
}
