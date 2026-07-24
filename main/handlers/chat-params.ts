// Pure parsing helpers for the chat generation IPC handlers, extracted so they
// can be unit-tested without importing Electron. See handlers/chat.ts.

import type { Attachment, ChatRole, ChatStartParams } from "../services/types.js";
import { MAX_IMAGE_BYTES, MAX_TEXT_CHARS } from "../services/attachments.js";
import { isGoogleThinkingLevel } from "../../renderer/shared/google-thinking.js";

const ROLES: ChatRole[] = ["user", "assistant", "system"];
const MAX_ATTACHMENTS_PER_MESSAGE = 20;
const MAX_ATTACHMENT_ID_CHARS = 256;
const MAX_ATTACHMENT_NAME_CHARS = 512;
const MAX_MIME_TYPE_CHARS = 128;
// Older attachment reads appended this suffix after slicing at MAX_TEXT_CHARS.
const MAX_LEGACY_TEXT_CHARS = MAX_TEXT_CHARS + "\n… [truncated]".length;
const MAX_IMAGE_BASE64_CHARS = Math.ceil(MAX_IMAGE_BYTES / 3) * 4;
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u;

function boundedString(
  value: unknown,
  field: string,
  maxChars: number,
  allowEmpty = false,
): string {
  if (typeof value !== "string" || (!allowEmpty && value.length === 0) || value.length > maxChars) {
    throw new Error(`Invalid attachment ${field}.`);
  }
  return value;
}

function parseAttachment(value: unknown, index: number): Attachment {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Invalid attachment at index ${index}.`);
  }
  const attachment = value as Record<string, unknown>;
  const id = boundedString(attachment.id, "id", MAX_ATTACHMENT_ID_CHARS);
  const name = boundedString(attachment.name, "name", MAX_ATTACHMENT_NAME_CHARS);
  const mimeType = boundedString(attachment.mimeType, "mimeType", MAX_MIME_TYPE_CHARS);
  if (!Number.isSafeInteger(attachment.size) || (attachment.size as number) < 0) {
    throw new Error("Invalid attachment size.");
  }
  const size = attachment.size as number;

  if (attachment.kind === "text") {
    const text = boundedString(attachment.text, "text", MAX_LEGACY_TEXT_CHARS, true);
    return { id, name, mimeType, kind: "text", size, text };
  }
  if (attachment.kind === "image") {
    if (
      !mimeType.startsWith("image/") ||
      typeof attachment.data !== "string" ||
      attachment.data.length === 0 ||
      attachment.data.length > MAX_IMAGE_BASE64_CHARS ||
      !BASE64.test(attachment.data)
    ) {
      throw new Error("Invalid image attachment data.");
    }
    const decodedBytes = Buffer.byteLength(attachment.data, "base64");
    if (decodedBytes > MAX_IMAGE_BYTES || decodedBytes !== size) {
      throw new Error("Invalid image attachment size.");
    }
    return { id, name, mimeType, kind: "image", size, data: attachment.data };
  }
  throw new Error("Invalid attachment kind.");
}

function parseAttachments(value: unknown): Attachment[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > MAX_ATTACHMENTS_PER_MESSAGE) {
    throw new Error("Invalid message attachments.");
  }
  return value.map(parseAttachment);
}

export function parseParams(value: unknown): ChatStartParams {
  if (typeof value !== "object" || value === null) throw new Error("Invalid generation params.");
  const p = value as Record<string, unknown>;
  if (typeof p.providerId !== "string" || !p.providerId) throw new Error("Missing providerId.");
  if (typeof p.model !== "string" || !p.model) throw new Error("Missing model.");
  if (!Array.isArray(p.messages)) throw new Error("Missing messages.");
  if (p.thinkingLevel !== undefined && !isGoogleThinkingLevel(p.thinkingLevel)) {
    throw new Error("Invalid thinking level.");
  }
  const messages = p.messages.map((raw) => {
    const m = (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, unknown>;
    return {
      role: ROLES.includes(m.role as ChatRole) ? (m.role as ChatRole) : "user",
      content: typeof m.content === "string" ? m.content : "",
      attachments: parseAttachments(m.attachments),
    };
  });
  const thinkingLevel = isGoogleThinkingLevel(p.thinkingLevel) ? p.thinkingLevel : undefined;

  return {
    chatId: typeof p.chatId === "string" ? p.chatId : "",
    workspaceId: typeof p.workspaceId === "string" ? p.workspaceId : undefined,
    providerId: p.providerId,
    model: p.model,
    ...(thinkingLevel === undefined ? {} : { thinkingLevel }),
    messages,
  };
}
