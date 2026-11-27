// Shared contracts and strict runtime parsers for the Floating Chat Starter
// (Quick Chat) window and IPC bridge.

import type { HandoffQueuedMessage } from "./chat-handoff.js";

export type QuickChatWindowMode = "starter" | "starter-popover" | "modal";

export const QUICK_CHAT_DEFAULT_PERSISTENCE_VALUES = [
  "ephemeral",
  "noWorkspace",
  "lastWorkspace",
] as const;

export type QuickChatDefaultPersistence =
  (typeof QUICK_CHAT_DEFAULT_PERSISTENCE_VALUES)[number];

export type QuickChatOpenSource = "hotkey" | "command";

export type QuickChatHandoffCompletePayload =
  | { kind: "draft" }
  | { kind: "chat"; chatId: string };

export type QuickChatExpandRequest =
  | {
      kind: "draft";
      workspaceId: string;
      text: string;
      attachments: unknown[];
      providerId?: string;
      model?: string;
      ephemeral?: boolean;
    }
  | {
      kind: "chat";
      chatId: string;
      draftText?: string;
      draftAttachments?: unknown[];
      queuedMessages?: HandoffQueuedMessage[];
    };

export interface QuickChatExpandResult {
  ok: boolean;
}

const VALID_MODES = new Set<QuickChatWindowMode>(["starter", "starter-popover", "modal"]);
const VALID_DEFAULT_PERSISTENCE = new Set<QuickChatDefaultPersistence>(
  QUICK_CHAT_DEFAULT_PERSISTENCE_VALUES,
);
const MAX_DRAFT_TEXT_CHARS = 200_000;
const MAX_ATTACHMENTS = 32;
const MAX_QUEUED_MESSAGES = 32;

export function parseQuickChatDefaultPersistence(
  value: unknown,
): QuickChatDefaultPersistence | undefined {
  if (
    typeof value === "string" &&
    VALID_DEFAULT_PERSISTENCE.has(value as QuickChatDefaultPersistence)
  ) {
    return value as QuickChatDefaultPersistence;
  }
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseQuickChatWindowMode(value: unknown): QuickChatWindowMode {
  if (typeof value !== "string" || !VALID_MODES.has(value as QuickChatWindowMode)) {
    throw new Error("Invalid quick chat window mode.");
  }
  return value as QuickChatWindowMode;
}

function parseAttachments(value: unknown, fieldName: string): unknown[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > MAX_ATTACHMENTS) {
    throw new Error(`Invalid quick chat ${fieldName}.`);
  }
  return value;
}

function parseQueuedMessages(value: unknown): HandoffQueuedMessage[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > MAX_QUEUED_MESSAGES) {
    throw new Error("Invalid quick chat queuedMessages.");
  }
  const parsed: HandoffQueuedMessage[] = [];
  for (const item of value) {
    if (!isRecord(item) || typeof item.content !== "string") {
      throw new Error("Invalid quick chat queued message item.");
    }
    if (item.content.length > MAX_DRAFT_TEXT_CHARS) {
      throw new Error("Queued message exceeds maximum length.");
    }
    const attachments = item.attachments !== undefined
      ? parseAttachments(item.attachments, "queued message attachments")
      : undefined;
    parsed.push({
      content: item.content,
      ...(attachments && attachments.length > 0 ? { attachments } : {}),
    });
  }
  return parsed;
}

export function parseQuickChatExpandRequest(value: unknown): QuickChatExpandRequest {
  if (!isRecord(value)) {
    throw new Error("Quick chat expand request must be an object.");
  }
  if (value.kind === "draft") {
    const workspaceId = typeof value.workspaceId === "string" ? value.workspaceId.trim() : "";
    if (!workspaceId || workspaceId.length > 256 || workspaceId.includes("\0")) {
      throw new Error("Invalid quick chat draft workspaceId.");
    }
    const text = typeof value.text === "string" ? value.text : "";
    if (text.length > MAX_DRAFT_TEXT_CHARS) {
      throw new Error("Quick chat draft text exceeds maximum length.");
    }
    const attachments = parseAttachments(value.attachments, "attachments");
    const providerId =
      typeof value.providerId === "string" && value.providerId.trim().length > 0 && value.providerId.length <= 128
        ? value.providerId.trim()
        : undefined;
    const model =
      typeof value.model === "string" && value.model.trim().length > 0 && value.model.length <= 256
        ? value.model.trim()
        : undefined;
    if (value.ephemeral !== undefined && typeof value.ephemeral !== "boolean") {
      throw new Error("Invalid quick chat draft ephemeral flag.");
    }
    const ephemeral = value.ephemeral === true ? true : undefined;
    return {
      kind: "draft",
      workspaceId,
      text,
      attachments,
      ...(providerId ? { providerId } : {}),
      ...(model ? { model } : {}),
      ...(ephemeral ? { ephemeral } : {}),
    };
  }
  if (value.kind === "chat") {
    const chatId = typeof value.chatId === "string" ? value.chatId.trim() : "";
    if (!chatId || chatId.length > 256 || chatId.includes("\0")) {
      throw new Error("Invalid quick chat chatId.");
    }
    const draftText =
      typeof value.draftText === "string"
        ? value.draftText.length <= MAX_DRAFT_TEXT_CHARS
          ? value.draftText
          : (() => {
              throw new Error("Quick chat draftText exceeds maximum length.");
            })()
        : undefined;
    const draftAttachments =
      value.draftAttachments !== undefined
        ? parseAttachments(value.draftAttachments, "draftAttachments")
        : undefined;
    const queuedMessages = parseQueuedMessages(value.queuedMessages);
    return {
      kind: "chat",
      chatId,
      ...(draftText !== undefined ? { draftText } : {}),
      ...(draftAttachments && draftAttachments.length > 0 ? { draftAttachments } : {}),
      ...(queuedMessages && queuedMessages.length > 0 ? { queuedMessages } : {}),
    };
  }
  throw new Error("Quick chat expand request kind must be 'draft' or 'chat'.");
}
