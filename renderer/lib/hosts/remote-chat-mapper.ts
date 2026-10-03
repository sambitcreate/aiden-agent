import type { Attachment, Chat, ChatMessage } from "../types";
import { parseGenerationTimeline } from "../../shared/generation-timeline";
import {
  parseProviderFailureV1,
  PROVIDER_FAILURE_VERSION,
  type ProviderFailureV1,
} from "../../shared/provider-failure";

/**
 * Pure mapping from a paired host's transcript projections (contract revision
 * 19) into the local `Chat` and `ChatMessage` shapes the transcript renders.
 * Anything the local components would resolve through a local API, such as
 * attachment bytes or HTML artifact media, is left out rather than faked.
 */

/** One `GET /chats/{chatId}/messages` page, mapped. Messages are oldest first. */
export interface RemoteMessagesWindow {
  chatId: string;
  revision: string;
  messages: ChatMessage[];
  hasOlder: boolean;
}

/** The paged transcript of one open remote chat. */
export interface RemoteTranscript {
  chatId: string;
  /** Revision of the newest window read. */
  revision: string | null;
  messages: ChatMessage[];
  hasOlder: boolean;
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function text(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function millis(value: unknown): number | undefined {
  if (typeof value !== "string") return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function mapAttachment(value: unknown): Attachment | null {
  const input = record(value);
  if (!input) return null;
  const id = text(input.id);
  const name = text(input.name);
  const mimeType = text(input.mimeType);
  const kind = input.kind;
  const size = input.size;
  if (!id || name === undefined || !mimeType || (kind !== "image" && kind !== "text")) return null;
  if (typeof size !== "number" || !Number.isSafeInteger(size) || size < 0) return null;
  // Metadata only: the bytes stay on the host and the chip renders without them.
  return { id, name, mimeType, kind, size };
}

/** A failed outcome becomes the local failure notice; anything else is left to the timeline. */
function mapOutcome(value: unknown): ProviderFailureV1 | undefined {
  const outcome = record(value);
  if (outcome?.status !== "failed") return undefined;
  // The host projects a stored ProviderFailureV1 field for field; validate it
  // against the same closed schema the local store uses.
  return parseProviderFailureV1({
    version: PROVIDER_FAILURE_VERSION,
    category: outcome.category,
    attempts: outcome.attempts,
    retryExhausted: outcome.retryExhausted,
  });
}

/** Maps one projected message; returns null for a row the transcript cannot show. */
export function mapRemoteMessage(value: unknown): ChatMessage | null {
  const input = record(value);
  if (!input) return null;
  const id = text(input.id);
  const role = input.role;
  const content = text(input.text);
  const createdAt = millis(input.createdAt);
  if (!id || (role !== "user" && role !== "assistant") || content === undefined || createdAt === undefined)
    return null;
  const message: ChatMessage = { id, role, content, createdAt };
  const reasoning = text(input.reasoning);
  if (role === "assistant" && reasoning) message.reasoning = reasoning;
  if (Array.isArray(input.attachments)) {
    const attachments = input.attachments
      .map(mapAttachment)
      .filter((entry): entry is Attachment => entry !== null);
    if (attachments.length > 0) message.attachments = attachments;
  }
  const failure = mapOutcome(input.outcome);
  if (failure) message.providerFailure = failure;
  if (role === "assistant") {
    const timeline = parseGenerationTimeline(input.timeline, content.length, reasoning?.length ?? 0);
    if (timeline) message.timeline = timeline;
  }
  return message;
}

/** Validates and maps a messages window; throws when the page itself is malformed. */
export function mapRemoteMessagesWindow(value: unknown): RemoteMessagesWindow {
  const input = record(value);
  const chatId = text(input?.chatId);
  const revision = text(input?.revision);
  if (!input || !chatId || !revision || !Array.isArray(input.messages) || typeof input.hasOlder !== "boolean")
    throw new Error("The host returned an unreadable transcript page.");
  return {
    chatId,
    revision,
    messages: input.messages
      .map(mapRemoteMessage)
      .filter((message): message is ChatMessage => message !== null),
    hasOlder: input.hasOlder,
  };
}

/**
 * Maps a remote chat projection, or a feed summary row, to the local chat
 * shape. The transcript is never taken from the projection: pages arrive
 * through the messages window, so `messages` starts empty.
 */
export function mapRemoteChat(value: unknown): Chat | null {
  const input = record(value);
  const id = text(input?.id);
  if (!input || !id) return null;
  const createdAt = millis(input.createdAt) ?? 0;
  const chat: Chat = {
    id,
    title: text(input.title)?.trim() || "Remote chat",
    createdAt,
    updatedAt: millis(input.updatedAt) ?? createdAt,
    messages: [],
  };
  const workspaceId = text(input.workspaceId);
  if (workspaceId) chat.workspaceId = workspaceId;
  const botId = text(input.botId);
  if (botId) chat.botId = botId;
  return chat;
}

export function emptyRemoteTranscript(chatId: string): RemoteTranscript {
  return { chatId, revision: null, messages: [], hasOlder: false };
}

/**
 * Applies a fresh newest window. Older pages already loaded are kept when the
 * new window still overlaps them; otherwise the window replaces the transcript.
 */
export function mergeNewestWindow(current: RemoteTranscript, window: RemoteMessagesWindow): RemoteTranscript {
  const first = window.messages[0];
  if (!first) {
    // An empty newest window means the chat has no visible messages at all.
    return { chatId: window.chatId, revision: window.revision, messages: [], hasOlder: false };
  }
  const overlap = current.messages.findIndex((message) => message.id === first.id);
  if (overlap < 0) {
    return { chatId: window.chatId, revision: window.revision, messages: window.messages, hasOlder: window.hasOlder };
  }
  return {
    chatId: window.chatId,
    revision: window.revision,
    messages: [...current.messages.slice(0, overlap), ...window.messages],
    hasOlder: current.hasOlder,
  };
}

/** Prepends an older page read with `before = current.messages[0].id`. */
export function mergeOlderWindow(current: RemoteTranscript, window: RemoteMessagesWindow): RemoteTranscript {
  const known = new Set(current.messages.map((message) => message.id));
  const older = window.messages.filter((message) => !known.has(message.id));
  return {
    ...current,
    messages: [...older, ...current.messages],
    hasOlder: window.hasOlder,
  };
}
