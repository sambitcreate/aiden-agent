// Canonical latest-response selection and revalidation for read aloud.
//
// The renderer never decides which response is speakable: it renders the
// eligibility main projects here, and every start request is revalidated
// against the live chat state before synthesis is dispatched.

import { createHash } from "node:crypto";
import type { TtsSourceRef } from "../../../renderer/shared/tts.js";

/** Stored message shape needed for eligibility; deliberately minimal. */
export interface TtsStoredMessage {
  id: string;
  role: "user" | "assistant" | string;
  content: string;
  /** Closed terminal provider outcome retained on an assistant message. */
  providerFailure?: unknown;
  timeline?: { status: string };
  pi?: { stopReason?: string };
}

export interface TtsStoredChat {
  messages: readonly TtsStoredMessage[];
}

export interface TtsSourceDeps {
  /** Returns the stored chat, or null/undefined when the chat is gone. */
  getChat(chatId: string): Promise<TtsStoredChat | null | undefined>;
  /** True while a turn is queued or actively generating in the chat. */
  isChatBusy(chatId: string): boolean;
}

export type TtsSourceIneligibilityReason =
  | "ok"
  | "chat_missing"
  | "busy"
  | "no_response"
  | "failed"
  | "empty";

/** Safe projection for the renderer: identity + closed reason, never content. */
export interface TtsLatestSourceProjection {
  source: TtsSourceRef | null;
  reason: TtsSourceIneligibilityReason;
}

/** Revision binds identity, the full visible body, and failure state. */
export function computeTtsSourceRevision(input: {
  chatId: string;
  messageId: string;
  content: string;
  providerFailure: boolean;
  policyVersion: number;
}): string {
  return createHash("sha256")
    .update(
      `${input.chatId}\u{0}${input.messageId}\u{0}${input.providerFailure ? "1" : "0"}\u{0}${input.policyVersion}\u{0}${input.content}`,
    )
    .digest("hex")
    .slice(0, 32);
}

const SOURCE_POLICY_VERSION = 1;

/**
 * Resolve the single eligible latest assistant response of a chat:
 * the last assistant message after the most recent user turn, when the chat
 * is idle, the response persisted, and it has no known provider failure.
 * Never scans backward past a newer failure or empty response.
 */
export async function resolveLatestTtsSource(
  deps: TtsSourceDeps,
  chatId: string,
): Promise<TtsLatestSourceProjection> {
  const chat = await deps.getChat(chatId);
  if (!chat) return { source: null, reason: "chat_missing" };
  if (deps.isChatBusy(chatId)) return { source: null, reason: "busy" };
  const candidate = latestAssistantAfterLastUser(chat.messages);
  if (!candidate) return { source: null, reason: "no_response" };
  if (hasIncompleteEvidence(candidate)) {
    return { source: null, reason: "failed" };
  }
  if (!candidate.content.trim()) return { source: null, reason: "empty" };
  return {
    source: {
      chatId,
      messageId: candidate.id,
      sourceRevision: computeTtsSourceRevision({
        chatId,
        messageId: candidate.id,
        content: candidate.content,
        providerFailure: false,
        policyVersion: SOURCE_POLICY_VERSION,
      }),
    },
    reason: "ok",
  };
}

/**
 * Revalidate a submitted source reference against live chat state and return
 * the canonical visible body. Throws closed errors the service maps onto
 * safe categories; content never crosses in error messages.
 */
export async function revalidateTtsSource(
  deps: TtsSourceDeps,
  source: TtsSourceRef,
): Promise<{ content: string }> {
  const chat = await deps.getChat(source.chatId);
  if (!chat) throw new Error("tts_source_chat_missing");
  if (deps.isChatBusy(source.chatId)) throw new Error("tts_source_busy");
  const message = latestAssistantAfterLastUser(chat.messages);
  if (!message || message.id !== source.messageId) {
    throw new Error("tts_source_changed");
  }
  if (hasIncompleteEvidence(message)) {
    throw new Error("tts_source_failed");
  }
  const expected = computeTtsSourceRevision({
    chatId: source.chatId,
    messageId: source.messageId,
    content: message.content,
    providerFailure: false,
    policyVersion: SOURCE_POLICY_VERSION,
  });
  if (expected !== source.sourceRevision) throw new Error("tts_source_changed");
  return { content: message.content };
}

function hasIncompleteEvidence(message: TtsStoredMessage): boolean {
  return (
    message.providerFailure !== undefined ||
    (message.timeline !== undefined && message.timeline.status !== "completed") ||
    ["error", "aborted", "length"].includes(message.pi?.stopReason ?? "")
  );
}

function latestAssistantAfterLastUser(
  messages: readonly TtsStoredMessage[],
): TtsStoredMessage | null {
  let lastUserIndex = -1;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]!.role === "user") {
      lastUserIndex = index;
      break;
    }
  }
  for (let index = messages.length - 1; index > lastUserIndex; index -= 1) {
    const message = messages[index]!;
    if (message.role === "assistant") return message;
  }
  return null;
}
