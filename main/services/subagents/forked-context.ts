import { createHash } from "node:crypto";
import type { AssistantMessage, ImageContent, TextContent } from "@earendil-works/pi-ai";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { MAX_IMAGE_BYTES, MAX_TEXT_CHARS } from "../attachments.js";
import { runtimeSupportsImages } from "../generation-runtime.js";
import type { ResolvedModelRuntime } from "../model-runtime-core.js";
import { sanitizeSubagentText } from "./safe-text.js";

export type SubagentContextMode = "fresh" | "fork";

export const MAX_FORK_CONTEXT_MESSAGES = 512;
export const MAX_FORK_CONTEXT_TEXT_CHARS = 2_000_000;
export const MAX_FORK_CONTEXT_ATTACHMENT_BYTES = 32 * 1024 * 1024;

const MAX_ATTACHMENTS_PER_MESSAGE = 20;
const MAX_ATTACHMENT_ID_CHARS = 256;
const MAX_ATTACHMENT_NAME_CHARS = 512;
const MAX_MIME_TYPE_CHARS = 128;
const MAX_LEGACY_TEXT_CHARS = MAX_TEXT_CHARS + "\n… [truncated]".length;
const MAX_IMAGE_BASE64_CHARS = Math.ceil(MAX_IMAGE_BYTES / 3) * 4;
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u;
const SAFE_PRIVATE_ID = /^[A-Za-z0-9._:-]+$/u;
const FORK_IMAGE_MIME_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "image/bmp",
  "image/heic",
  "image/heif",
]);

interface ForkTextAttachment {
  readonly id: string;
  readonly name: string;
  readonly mimeType: string;
  readonly kind: "text";
  readonly size: number;
  readonly text: string;
}

interface ForkImageAttachment {
  readonly id: string;
  readonly name: string;
  readonly mimeType: string;
  readonly kind: "image";
  readonly size: number;
  readonly data: string;
}

export type ForkContextAttachment = ForkTextAttachment | ForkImageAttachment;

export interface ForkContextMessage {
  readonly role: "user" | "assistant";
  readonly content: string;
  readonly createdAt: number;
  readonly attachments?: readonly ForkContextAttachment[];
}

export interface SubagentContextCapture {
  readonly mode: SubagentContextMode;
  /** Private, content-bound revision. Never include this in renderer projections. */
  readonly revisionHash: string;
  readonly chatId: string;
  readonly messages: readonly ForkContextMessage[];
}

export interface LiveSubagentContextCaptureInput {
  chatId: string;
  parentRunId: string;
  /** Read exactly once from the live parent Agent at the nested tool boundary. */
  messages: unknown;
  descendantContextWindow: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function boundedString(value: unknown, maximum: number, field: string, allowEmpty = false): string {
  if (
    typeof value !== "string" ||
    (!allowEmpty && value.length === 0) ||
    value.length > maximum ||
    value.includes("\0")
  ) {
    throw new Error(`Forked subagent context contains an invalid ${field}.`);
  }
  return value;
}

function parseAttachment(value: unknown): ForkContextAttachment {
  if (!isRecord(value)) {
    throw new Error("Forked subagent context contains an invalid attachment.");
  }
  const id = boundedString(value.id, MAX_ATTACHMENT_ID_CHARS, "attachment id");
  const name = sanitizeSubagentText(
    boundedString(value.name, MAX_ATTACHMENT_NAME_CHARS, "attachment name"),
  );
  const mimeType = boundedString(value.mimeType, MAX_MIME_TYPE_CHARS, "attachment MIME type");
  if (
    !Number.isSafeInteger(value.size) ||
    (value.size as number) < 0 ||
    (value.size as number) > MAX_FORK_CONTEXT_ATTACHMENT_BYTES
  ) {
    throw new Error("Forked subagent context contains an invalid attachment size.");
  }
  const size = value.size as number;
  if (value.kind === "text") {
    if (mimeType !== "text/plain") {
      throw new Error("Forked subagent context contains an unsupported text attachment.");
    }
    const text = sanitizeSubagentText(
      boundedString(value.text, MAX_LEGACY_TEXT_CHARS, "text attachment", true),
    );
    return Object.freeze({ id, name, mimeType, kind: "text", size, text });
  }
  if (
    value.kind !== "image" ||
    !FORK_IMAGE_MIME_TYPES.has(mimeType) ||
    typeof value.data !== "string" ||
    value.data.length === 0 ||
    value.data.length > MAX_IMAGE_BASE64_CHARS ||
    !BASE64.test(value.data)
  ) {
    throw new Error("Forked subagent context contains an unsupported attachment.");
  }
  const decodedBytes = Buffer.byteLength(value.data, "base64");
  if (decodedBytes !== size || decodedBytes > MAX_IMAGE_BYTES) {
    throw new Error("Forked subagent context contains an invalid image attachment size.");
  }
  return Object.freeze({ id, name, mimeType, kind: "image", size, data: value.data });
}

function parseAttachments(value: unknown): readonly ForkContextAttachment[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > MAX_ATTACHMENTS_PER_MESSAGE) {
    throw new Error("Forked subagent context contains invalid message attachments.");
  }
  return Object.freeze(value.map(parseAttachment));
}

function revisionHash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function ownData(value: object, key: PropertyKey, field: string): unknown {
  let descriptor: PropertyDescriptor | undefined;
  try {
    descriptor = Object.getOwnPropertyDescriptor(value, key);
  } catch {
    throw new Error(`Live fork context could not safely read ${field}.`);
  }
  if (!descriptor || !("value" in descriptor)) {
    throw new Error(`Live fork context contains an accessor or missing ${field}.`);
  }
  return descriptor.value;
}

function ownArrayValues(value: unknown, field: string, maximum: number): unknown[] {
  if (!Array.isArray(value) || value.length > maximum) {
    throw new Error(`Live fork context contains an invalid ${field}.`);
  }
  const length = ownData(value, "length", `${field} length`);
  if (length !== value.length) {
    throw new Error(`Live fork context changed while capturing ${field}.`);
  }
  const result: unknown[] = [];
  for (let index = 0; index < value.length; index += 1) {
    result.push(ownData(value, String(index), `${field} item`));
  }
  if (ownData(value, "length", `${field} length`) !== length) {
    throw new Error(`Live fork context changed while capturing ${field}.`);
  }
  return result;
}

function plainRecord(value: unknown, field: string): object {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`Live fork context contains an invalid ${field}.`);
  }
  let prototype: object | null;
  try {
    prototype = Object.getPrototypeOf(value);
  } catch {
    throw new Error(`Live fork context could not safely read ${field}.`);
  }
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error(`Live fork context contains an unsafe ${field}.`);
  }
  return value;
}

function redactPrivateForkText(value: string): string {
  return sanitizeSubagentText(value)
    .replace(/-----BEGIN [^-\n]+ PRIVATE KEY-----[\s\S]*?-----END [^-\n]+ PRIVATE KEY-----/giu, "[credential redacted]")
    .replace(/\b(?:authorization\s*:\s*bearer|api[_ -]?key|access[_ -]?token|password|secret)\s*[:=]\s*[^\s,;]+/giu, "[credential redacted]")
    .replace(/\bsk-[A-Za-z0-9_-]{16,}\b/gu, "[credential redacted]")
    .replace(/\/(?:Users|home)\/[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._@+,:=-]+)+/gu, "[private path redacted]");
}

function liveTimestamp(message: object): number {
  const timestamp = ownData(message, "timestamp", "message timestamp");
  if (typeof timestamp !== "number" || !Number.isFinite(timestamp) || timestamp < 0) {
    throw new Error("Live fork context contains an invalid message timestamp.");
  }
  return timestamp;
}

function liveTextPart(part: object): string | undefined {
  if (ownData(part, "type", "content type") !== "text") return undefined;
  const text = ownData(part, "text", "text content");
  if (typeof text !== "string" || text.length > MAX_FORK_CONTEXT_TEXT_CHARS) {
    throw new Error("Live fork context contains invalid text content.");
  }
  // textSignature and every other provider/private field are deliberately unread.
  return redactPrivateForkText(text);
}

function liveImagePart(
  part: object,
  messageIndex: number,
  partIndex: number,
): ForkImageAttachment | undefined {
  if (ownData(part, "type", "content type") !== "image") return undefined;
  const mimeType = ownData(part, "mimeType", "image MIME type");
  const data = ownData(part, "data", "image data");
  if (
    typeof mimeType !== "string" ||
    !FORK_IMAGE_MIME_TYPES.has(mimeType) ||
    typeof data !== "string" ||
    data.length === 0 ||
    data.length > MAX_IMAGE_BASE64_CHARS ||
    !BASE64.test(data)
  ) {
    throw new Error("Live fork context contains an unsupported image attachment.");
  }
  const size = Buffer.byteLength(data, "base64");
  if (size > MAX_IMAGE_BYTES) {
    throw new Error("Live fork context contains an oversized image attachment.");
  }
  const extension = mimeType === "image/jpeg" ? "jpg" : mimeType.slice("image/".length);
  return Object.freeze({
    id: `live-${messageIndex}-${partIndex}`,
    name: `conversation-image-${messageIndex + 1}.${extension}`,
    mimeType,
    kind: "image",
    size,
    data,
  });
}

/**
 * Snapshot the exact live depth-1 transcript at the nested tool boundary.
 * This reads only own data descriptors and positively projects user text/images
 * and assistant prose. Tool protocol, reasoning, signatures and unknown fields
 * are never inspected or copied.
 */
export function captureLiveSubagentContext(
  input: LiveSubagentContextCaptureInput,
): SubagentContextCapture {
  const chatId = assertPrivateIdentity(input.chatId, "chat id");
  const parentRunId = assertPrivateIdentity(input.parentRunId, "parent run id");
  if (
    !Number.isFinite(input.descendantContextWindow) ||
    input.descendantContextWindow < 1_024
  ) {
    throw new Error("Live fork context has no usable descendant model window.");
  }
  const source = ownArrayValues(
    input.messages,
    "message transcript",
    MAX_FORK_CONTEXT_MESSAGES,
  );
  const projected: ForkContextMessage[] = [];
  let attachmentBytes = 0;
  for (let messageIndex = 0; messageIndex < source.length; messageIndex += 1) {
    const message = plainRecord(source[messageIndex], "message");
    const role = ownData(message, "role", "message role");
    if (role !== "user" && role !== "assistant") continue;
    const rawContent = ownData(message, "content", "message content");
    let content = "";
    const attachments: ForkImageAttachment[] = [];
    if (typeof rawContent === "string") {
      if (role !== "user" || rawContent.length > MAX_FORK_CONTEXT_TEXT_CHARS) {
        throw new Error("Live fork context contains invalid message content.");
      }
      content = redactPrivateForkText(rawContent);
    } else {
      const parts = ownArrayValues(rawContent, "message content", MAX_ATTACHMENTS_PER_MESSAGE * 4);
      const text: string[] = [];
      for (let partIndex = 0; partIndex < parts.length; partIndex += 1) {
        const part = plainRecord(parts[partIndex], "content part");
        const projectedText = liveTextPart(part);
        if (projectedText !== undefined) {
          text.push(projectedText);
          continue;
        }
        if (role === "user") {
          const image = liveImagePart(part, messageIndex, partIndex);
          if (image) attachments.push(image);
        }
        // Thinking, tool calls, and every unsupported part are stripped.
      }
      content = text.join("\n\n");
    }
    if (content.length === 0 && attachments.length === 0) continue;
    attachmentBytes += attachments.reduce((total, attachment) => total + attachment.size, 0);
    if (attachmentBytes > MAX_FORK_CONTEXT_ATTACHMENT_BYTES) {
      throw new Error("Live fork context exceeds the attachment limit.");
    }
    projected.push(
      Object.freeze({
        role,
        content,
        createdAt: liveTimestamp(message),
        ...(attachments.length === 0 ? {} : { attachments: Object.freeze(attachments) }),
      }),
    );
  }

  // Reserve at least half of the descendant window for its system prompt,
  // tools, delegated task and answer. The normal child transform applies its
  // exact schema-aware budget again before provider dispatch.
  const textBudget = Math.min(
    MAX_FORK_CONTEXT_TEXT_CHARS,
    Math.max(1_024, Math.floor(input.descendantContextWindow * 2)),
  );
  const retained: ForkContextMessage[] = [];
  let retainedChars = 0;
  for (let index = projected.length - 1; index >= 0; index -= 1) {
    const message = projected[index]!;
    const chars = message.content.length;
    if (chars > textBudget && retained.length === 0) {
      throw new Error("Live fork context cannot fit the descendant model window.");
    }
    if (retainedChars + chars > textBudget) break;
    retained.unshift(message);
    retainedChars += chars;
  }
  const frozenMessages = Object.freeze(retained);
  const hash = revisionHash({
    mode: "fork",
    chatId,
    parentRunId,
    descendantContextWindow: Math.floor(input.descendantContextWindow),
    messages: frozenMessages,
  });
  return Object.freeze({ mode: "fork", revisionHash: hash, chatId, messages: frozenMessages });
}

function assertPrivateIdentity(value: unknown, field: string): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 160 ||
    value.normalize("NFKC") !== value ||
    !SAFE_PRIVATE_ID.test(value)
  ) {
    throw new Error(`Forked subagent context contains an invalid ${field}.`);
  }
  return value;
}

/**
 * Project one persisted chat revision into immutable, user-visible context.
 * This is intentionally a positive projection: private reasoning, timelines,
 * approvals, tool payloads, subagent references, and unknown fields are never copied.
 */
export function capturePersistedSubagentContext(value: unknown): SubagentContextCapture {
  if (!isRecord(value) || !Array.isArray(value.messages)) {
    throw new Error("Forked subagent context could not read the persisted chat revision.");
  }
  const chatId = assertPrivateIdentity(value.id, "chat id");
  if (
    typeof value.updatedAt !== "number" ||
    !Number.isFinite(value.updatedAt) ||
    value.updatedAt < 0
  ) {
    throw new Error("Forked subagent context contains an invalid chat revision.");
  }
  if (value.messages.length > MAX_FORK_CONTEXT_MESSAGES) {
    throw new Error("Forked subagent context exceeds the persisted message limit.");
  }

  const messages: ForkContextMessage[] = [];
  let textChars = 0;
  let attachmentBytes = 0;
  for (const candidate of value.messages) {
    if (!isRecord(candidate)) {
      throw new Error("Forked subagent context contains an invalid persisted message.");
    }
    // System/control records and every non-chat protocol role are excluded.
    if (candidate.role !== "user" && candidate.role !== "assistant") continue;
    const content = sanitizeSubagentText(
      boundedString(
        candidate.content,
        MAX_FORK_CONTEXT_TEXT_CHARS,
        "message content",
        true,
      ),
    );
    if (
      typeof candidate.createdAt !== "number" ||
      !Number.isFinite(candidate.createdAt) ||
      candidate.createdAt < 0
    ) {
      throw new Error("Forked subagent context contains an invalid message timestamp.");
    }
    const attachments =
      candidate.role === "user" ? parseAttachments(candidate.attachments) : undefined;
    if (content.length === 0 && (attachments === undefined || attachments.length === 0)) continue;
    textChars += content.length;
    for (const attachment of attachments ?? []) {
      textChars += attachment.kind === "text" ? attachment.text.length : 0;
      attachmentBytes += attachment.size;
    }
    if (textChars > MAX_FORK_CONTEXT_TEXT_CHARS) {
      throw new Error("Forked subagent context exceeds the text limit.");
    }
    if (attachmentBytes > MAX_FORK_CONTEXT_ATTACHMENT_BYTES) {
      throw new Error("Forked subagent context exceeds the attachment limit.");
    }
    messages.push(
      Object.freeze({
        role: candidate.role,
        content,
        createdAt: candidate.createdAt,
        ...(attachments === undefined ? {} : { attachments }),
      }),
    );
  }

  const frozenMessages = Object.freeze(messages);
  const hash = revisionHash({ chatId, updatedAt: value.updatedAt, messages: frozenMessages });
  return Object.freeze({ mode: "fork", revisionHash: hash, chatId, messages: frozenMessages });
}

export function createFreshSubagentContext(input: {
  chatId: string;
  generationId: string;
}): SubagentContextCapture {
  const chatId = assertPrivateIdentity(input.chatId, "chat id");
  const generationId = assertPrivateIdentity(input.generationId, "generation id");
  return Object.freeze({
    mode: "fresh",
    revisionHash: revisionHash({ mode: "fresh", chatId, generationId }),
    chatId,
    messages: Object.freeze([]),
  });
}

const ZERO_USAGE: AssistantMessage["usage"] = Object.freeze({
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: Object.freeze({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }),
});

/** Build a new deep-copied Pi transcript for exactly one child. */
export function cloneSubagentContextMessages(
  capture: SubagentContextCapture,
  runtime: ResolvedModelRuntime,
): AgentMessage[] {
  if (capture.mode === "fresh") return [];
  const supportsImages = runtimeSupportsImages(runtime.model);
  return capture.messages.map((message): AgentMessage => {
    if (message.role === "assistant") {
      return {
        role: "assistant",
        content: [{ type: "text", text: message.content }],
        api: runtime.model.api,
        provider: runtime.model.provider,
        model: runtime.model.id,
        usage: { ...ZERO_USAGE, cost: { ...ZERO_USAGE.cost } },
        stopReason: "stop",
        timestamp: message.createdAt,
      };
    }

    const parts: (TextContent | ImageContent)[] = [];
    const textFiles = (message.attachments ?? []).filter(
      (attachment): attachment is ForkTextAttachment => attachment.kind === "text",
    );
    const textPrefix = textFiles
      .map((attachment) => `Attached file: ${attachment.name}\n\`\`\`\n${attachment.text}\n\`\`\``)
      .join("\n\n");
    const combinedText = [textPrefix, message.content].filter(Boolean).join("\n\n");
    if (combinedText) parts.push({ type: "text", text: combinedText });
    if (supportsImages) {
      for (const attachment of message.attachments ?? []) {
        if (attachment.kind === "image") {
          parts.push({ type: "image", data: attachment.data, mimeType: attachment.mimeType });
        }
      }
    }
    return {
      role: "user",
      content: parts.length > 0 ? parts : message.content,
      timestamp: message.createdAt,
    };
  });
}
