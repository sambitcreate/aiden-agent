import type { Attachment } from "../services/types.js";
import type { SkillInvocationV1 } from "../../renderer/shared/slash-commands.js";
import { parseSkillInvocationV1 } from "../../renderer/shared/slash-commands.js";
import { isSafeSubagentIdentifier } from "../../renderer/shared/subagent-runs.js";
import {
  MAX_CHAT_ID_BYTES,
  MAX_CHAT_ID_CHARS,
  MAX_MODEL_ID_BYTES,
  MAX_MODEL_ID_CHARS,
  MAX_PROVIDER_ID_BYTES,
  MAX_PROVIDER_ID_CHARS,
} from "../../renderer/shared/chat-message-contract.js";
import {
  attachmentRepresentationBytes,
  parseAttachments,
} from "../services/attachment-contract.js";
import { parseChatMessageContent } from "../services/chat-message-contract.js";

const MESSAGE_KEYS = new Set(["attachments", "content", "model", "role"]);
const META_KEYS = new Set([
  "autoTitle",
  "model",
  "providerId",
  "skillInvocation",
  "turnId",
]);
const FIXED_APPEND_REPRESENTATION_BYTES = 256;

export interface ParsedChatAppend {
  chatId: string;
  role: "user";
  content: string;
  messageModel?: string;
  attachments?: Attachment[];
  providerId?: string;
  metaModel?: string;
  autoTitle: boolean;
  turnId: string;
  skillReference?: SkillInvocationV1;
  retainedBytes: number;
}

function recordWithExactKeys(
  value: unknown,
  allowed: ReadonlySet<string>,
  label: string,
): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`Invalid ${label} envelope.`);
  }
  const record = value as Record<string, unknown>;
  let count = 0;
  for (const key in record) {
    if (!Object.prototype.hasOwnProperty.call(record, key)) continue;
    count += 1;
    if (count > allowed.size || !allowed.has(key)) {
      throw new Error(`Invalid ${label} fields.`);
    }
  }
  return record;
}

function boundedString(
  value: unknown,
  label: string,
  maxChars: number,
  maxBytes: number,
  optional = false,
): { value: string | undefined; bytes: number } {
  if (value === undefined && optional) return { value: undefined, bytes: 0 };
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > maxChars
  ) {
    throw new Error(`Invalid ${label}.`);
  }
  const bytes = Buffer.byteLength(value, "utf8");
  if (bytes > maxBytes) throw new Error(`Invalid ${label}.`);
  return { value, bytes };
}

export function parseChatAppend(
  id: unknown,
  message: unknown,
  meta: unknown,
): ParsedChatAppend {
  const parsedChatId = boundedString(
    id,
    "chat id",
    MAX_CHAT_ID_CHARS,
    MAX_CHAT_ID_BYTES,
  );
  const chatId = parsedChatId.value!;
  const messageRecord = recordWithExactKeys(
    message,
    MESSAGE_KEYS,
    "chat message",
  );
  const metaRecord = recordWithExactKeys(
    meta,
    META_KEYS,
    "chat message metadata",
  );

  if (messageRecord.role !== "user") {
    throw new Error("Renderer chat appends accept only user messages.");
  }
  const { content, bytes: contentBytes } = parseChatMessageContent(
    messageRecord.content,
  );
  const parsedMessageModel = boundedString(
    messageRecord.model,
    "message model",
    MAX_MODEL_ID_CHARS,
    MAX_MODEL_ID_BYTES,
    true,
  );
  const attachments = parseAttachments(messageRecord.attachments);

  const parsedProviderId = boundedString(
    metaRecord.providerId,
    "provider id",
    MAX_PROVIDER_ID_CHARS,
    MAX_PROVIDER_ID_BYTES,
    true,
  );
  const parsedMetaModel = boundedString(
    metaRecord.model,
    "metadata model",
    MAX_MODEL_ID_CHARS,
    MAX_MODEL_ID_BYTES,
    true,
  );
  if (
    metaRecord.autoTitle !== undefined &&
    typeof metaRecord.autoTitle !== "boolean"
  ) {
    throw new Error("Invalid auto-title flag.");
  }
  const parsedTurnId = boundedString(
    metaRecord.turnId,
    "chat message turn identifier",
    MAX_CHAT_ID_CHARS,
    MAX_CHAT_ID_BYTES,
  );
  const turnId = parsedTurnId.value!;
  if (!isSafeSubagentIdentifier(turnId)) {
    throw new Error("Invalid chat message turn identifier.");
  }
  const skillReference =
    metaRecord.skillInvocation === undefined
      ? undefined
      : parseSkillInvocationV1(metaRecord.skillInvocation);

  let retainedBytes = FIXED_APPEND_REPRESENTATION_BYTES;
  retainedBytes += parsedChatId.bytes + contentBytes + parsedMessageModel.bytes;
  retainedBytes +=
    parsedProviderId.bytes + parsedMetaModel.bytes + parsedTurnId.bytes;
  retainedBytes += attachmentRepresentationBytes(attachments);
  if (skillReference) {
    retainedBytes += Buffer.byteLength(skillReference.invocationId, "utf8");
    retainedBytes += Buffer.byteLength(skillReference.displayName, "utf8");
    retainedBytes += Buffer.byteLength(skillReference.source, "utf8") + 64;
  }
  if (!Number.isSafeInteger(retainedBytes))
    throw new Error("Invalid chat message payload.");

  return {
    chatId,
    role: "user",
    content,
    messageModel: parsedMessageModel.value,
    attachments,
    providerId: parsedProviderId.value,
    metaModel: parsedMetaModel.value,
    autoTitle: metaRecord.autoTitle === true,
    turnId,
    skillReference,
    retainedBytes,
  };
}
