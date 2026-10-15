import {
  MAX_FORK_SUMMARY_INSTRUCTIONS_CHARS,
  type ChatForkPosition,
} from "../../renderer/shared/chat-copy-contract.js";

const MAX_CHAT_ID_CHARS = 160;
const MAX_CHAT_ID_BYTES = 640;
const MAX_DRAFT_TEXT_CHARS = 65_536;
const COPY_KEYS = new Set(["chatId", "throughMessageId", "messageId", "position", "summary"]);
const FORK_SUMMARY_KEYS = new Set(["instructions"]);
const CHAT_ONLY_KEYS = new Set(["chatId"]);
const CONTEXT_PRESSURE_KEYS = new Set([
  "chatId",
  "draftText",
  "providerId",
  "modelId",
  "attachments",
]);
const CONTEXT_PRESSURE_ATTACHMENT_KEYS = new Set([
  "id",
  "name",
  "kind",
  "mimeType",
  "textLength",
]);
const MAX_CONTEXT_PRESSURE_ATTACHMENTS = 20;
const MAX_ATTACHMENT_NAME_CHARS = 512;
const MAX_ATTACHMENT_TEXT_CHARS = 16 * 1024 * 1024;

function exactRecord(
  value: unknown,
  allowed: ReadonlySet<string>,
  label: string,
): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Invalid ${label}.`);
  }
  const record = value as Record<string, unknown>;
  let count = 0;
  for (const key in record) {
    if (!Object.prototype.hasOwnProperty.call(record, key)) continue;
    count += 1;
    if (count > allowed.size || !allowed.has(key)) {
      throw new Error(`Invalid ${label}.`);
    }
  }
  return record;
}

function boundedId(value: unknown, label: string): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > MAX_CHAT_ID_CHARS ||
    Buffer.byteLength(value, "utf8") > MAX_CHAT_ID_BYTES
  ) {
    throw new Error(`Invalid ${label}.`);
  }
  return value;
}

export interface ParsedChatCopyRequest {
  chatId: string;
  /** Absent for a whole-chat clone. */
  forkAt?: { messageId: string; position: ChatForkPosition };
  /** Summarize what the source did after the fork point. Forks only. */
  summary?: { instructions?: string };
}

function parseForkSummaryRequest(value: unknown): { instructions?: string } {
  const record = exactRecord(value, FORK_SUMMARY_KEYS, "fork summary request");
  if (record.instructions === undefined) return {};
  if (typeof record.instructions !== "string") throw new Error("Invalid summary focus.");
  const instructions = record.instructions.trim();
  if (instructions.length > MAX_FORK_SUMMARY_INSTRUCTIONS_CHARS) {
    throw new Error("The summary focus is too long.");
  }
  return instructions ? { instructions } : {};
}

/**
 * `{ chatId }` clones; `{ chatId, messageId, position }` forks. The older
 * `{ chatId, throughMessageId }` shape remains a fork after that reply. A
 * fork may add `summary: { instructions? }`.
 */
export function parseChatCopyRequest(value: unknown): ParsedChatCopyRequest {
  const record = exactRecord(value, COPY_KEYS, "chat copy request");
  const chatId = boundedId(record.chatId, "chat id");
  const summary =
    record.summary === undefined ? undefined : { summary: parseForkSummaryRequest(record.summary) };
  if (record.throughMessageId !== undefined) {
    if (record.messageId !== undefined || record.position !== undefined) {
      throw new Error("Invalid chat copy request.");
    }
    return {
      chatId,
      forkAt: { messageId: boundedId(record.throughMessageId, "turn id"), position: "after" },
      ...summary,
    };
  }
  if (record.messageId === undefined && record.position === undefined) {
    if (summary) throw new Error("Only a fork can carry a summary.");
    return { chatId };
  }
  if (record.position !== "after" && record.position !== "before") {
    throw new Error("Invalid fork position.");
  }
  return {
    chatId,
    forkAt: { messageId: boundedId(record.messageId, "message id"), position: record.position },
    ...summary,
  };
}

export function parseChatOnlyRequest(value: unknown): { chatId: string } {
  const record = exactRecord(value, CHAT_ONLY_KEYS, "chat request");
  return { chatId: boundedId(record.chatId, "chat id") };
}

export interface ParsedContextPressureAttachment {
  id: string;
  name: string;
  kind: "image" | "text";
  mimeType: string;
  /** UTF-16 length of the text attachment payload; token estimates need only its size. */
  textLength?: number;
}

export interface ParsedChatContextPressureRequest {
  chatId: string;
  /** Optional draft text folded into the next-request projection. */
  draftText?: string;
  /** The composer selection so a not-yet-persisted model switch still prices correctly. */
  providerId?: string;
  modelId?: string;
  attachments?: ParsedContextPressureAttachment[];
}

function parseContextPressureAttachment(value: unknown): ParsedContextPressureAttachment {
  const record = exactRecord(value, CONTEXT_PRESSURE_ATTACHMENT_KEYS, "context pressure attachment");
  if (record.kind !== "image" && record.kind !== "text") {
    throw new Error("Invalid attachment kind.");
  }
  if (
    typeof record.name !== "string" ||
    record.name.length > MAX_ATTACHMENT_NAME_CHARS ||
    typeof record.mimeType !== "string" ||
    record.mimeType.length > 128
  ) {
    throw new Error("Invalid attachment descriptor.");
  }
  if (
    record.textLength !== undefined &&
    (!Number.isInteger(record.textLength) ||
      (record.textLength as number) < 0 ||
      (record.textLength as number) > MAX_ATTACHMENT_TEXT_CHARS)
  ) {
    throw new Error("Invalid attachment text length.");
  }
  const attachment: ParsedContextPressureAttachment = {
    id: boundedId(record.id, "attachment id"),
    name: record.name,
    kind: record.kind,
    mimeType: record.mimeType,
  };
  if (record.textLength !== undefined) attachment.textLength = record.textLength as number;
  return attachment;
}

export function parseChatContextPressureRequest(value: unknown): ParsedChatContextPressureRequest {
  const record = exactRecord(value, CONTEXT_PRESSURE_KEYS, "context pressure request");
  if (
    record.draftText !== undefined &&
    (typeof record.draftText !== "string" || record.draftText.length > MAX_DRAFT_TEXT_CHARS)
  ) {
    throw new Error("Invalid draft text.");
  }
  if (
    (record.providerId !== undefined && typeof record.providerId !== "string") ||
    (record.modelId !== undefined && typeof record.modelId !== "string") ||
    (typeof record.providerId === "string" && record.providerId.length > 256) ||
    (typeof record.modelId === "string" && record.modelId.length > 512)
  ) {
    throw new Error("Invalid model selection.");
  }
  if (
    record.attachments !== undefined &&
    (!Array.isArray(record.attachments) ||
      record.attachments.length > MAX_CONTEXT_PRESSURE_ATTACHMENTS)
  ) {
    throw new Error("Invalid attachments.");
  }
  const parsed: ParsedChatContextPressureRequest = {
    chatId: boundedId(record.chatId, "chat id"),
    draftText: record.draftText as string | undefined,
  };
  // An empty id means "no live selection yet": omit it so the chat's saved
  // provider/model price the request instead.
  if (record.providerId) parsed.providerId = record.providerId as string;
  if (record.modelId) parsed.modelId = record.modelId as string;
  if (record.attachments !== undefined) {
    parsed.attachments = (record.attachments as unknown[]).map(parseContextPressureAttachment);
    // The projection materializes each text length, so bound the draft as a
    // whole the way the composer's aggregate attachment budget does.
    const totalText = parsed.attachments.reduce(
      (sum, attachment) => sum + (attachment.textLength ?? 0),
      0,
    );
    if (totalText > MAX_ATTACHMENT_TEXT_CHARS) throw new Error("Invalid attachments.");
  }
  return parsed;
}

// Keep workspace-bound identifiers on the same explicit budget as the rest
// of the renderer chat envelope. Exported for contract tests.
export const CHAT_SESSION_ID_LIMITS = Object.freeze({
  chatCharacters: MAX_CHAT_ID_CHARS,
  chatBytes: MAX_CHAT_ID_BYTES,
});
