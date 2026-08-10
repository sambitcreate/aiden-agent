import {
  MAX_MODEL_ID_BYTES,
  MAX_MODEL_ID_CHARS,
  MAX_PROVIDER_ID_BYTES,
  MAX_PROVIDER_ID_CHARS,
  MAX_WORKSPACE_ID_BYTES,
  MAX_WORKSPACE_ID_CHARS,
} from "../../renderer/shared/chat-message-contract.js";

const CHAT_CREATE_KEYS = new Set([
  "model",
  "providerId",
  "title",
  "workspaceId",
]);
const ASSISTANT_CHAT_CREATE_KEYS = new Set(["model", "providerId"]);
const MAX_CREATE_TITLE_CHARS = 120;
const MAX_CREATE_TITLE_BYTES = 480;

export interface ParsedChatCreate {
  title?: string;
  workspaceId?: string;
  providerId?: string;
  model?: string;
}

export interface ParsedPublicChatCreate extends ParsedChatCreate {
  workspaceId: string;
}

function exactRecord(
  value: unknown,
  allowed: ReadonlySet<string>,
  label: string,
): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`Invalid ${label}.`);
  }
  const record = value as Record<string, unknown>;
  let count = 0;
  for (const key in record) {
    if (!Object.prototype.hasOwnProperty.call(record, key)) continue;
    count += 1;
    if (count > allowed.size || !allowed.has(key))
      throw new Error(`Invalid ${label}.`);
  }
  return record;
}

function optionalBoundedString(
  value: unknown,
  label: string,
  maxChars: number,
  maxBytes: number,
): string | undefined {
  if (value === undefined) return undefined;
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > maxChars
  ) {
    throw new Error(`Invalid ${label}.`);
  }
  if (Buffer.byteLength(value, "utf8") > maxBytes)
    throw new Error(`Invalid ${label}.`);
  return value;
}

function projectedCreate(record: Record<string, unknown>): ParsedChatCreate {
  return {
    title: optionalBoundedString(
      record.title,
      "chat title",
      MAX_CREATE_TITLE_CHARS,
      MAX_CREATE_TITLE_BYTES,
    ),
    workspaceId: optionalBoundedString(
      record.workspaceId,
      "workspace id",
      MAX_WORKSPACE_ID_CHARS,
      MAX_WORKSPACE_ID_BYTES,
    ),
    providerId: optionalBoundedString(
      record.providerId,
      "provider id",
      MAX_PROVIDER_ID_CHARS,
      MAX_PROVIDER_ID_BYTES,
    ),
    model: optionalBoundedString(
      record.model,
      "model id",
      MAX_MODEL_ID_CHARS,
      MAX_MODEL_ID_BYTES,
    ),
  };
}

export function parseChatCreate(value: unknown): ParsedPublicChatCreate {
  const projected = projectedCreate(
    exactRecord(value, CHAT_CREATE_KEYS, "chat creation fields"),
  );
  if (!projected.workspaceId) throw new Error("Invalid workspace id.");
  return { ...projected, workspaceId: projected.workspaceId };
}

export function parseAssistantChatCreate(
  value: unknown,
): Pick<ParsedChatCreate, "providerId" | "model"> {
  const projected = projectedCreate(
    exactRecord(
      value,
      ASSISTANT_CHAT_CREATE_KEYS,
      "Assistant chat creation fields",
    ),
  );
  return { providerId: projected.providerId, model: projected.model };
}
