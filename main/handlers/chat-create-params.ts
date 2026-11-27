import {
  MAX_MODEL_ID_BYTES,
  MAX_MODEL_ID_CHARS,
  MAX_PROVIDER_ID_BYTES,
  MAX_PROVIDER_ID_CHARS,
  MAX_WORKSPACE_ID_BYTES,
  MAX_WORKSPACE_ID_CHARS,
} from "../../renderer/shared/chat-message-contract.js";
import { parseUtf8BoundedString, requireAllowedKeys } from "../shared/guards.js";

const CHAT_CREATE_KEYS = new Set([
  "model",
  "providerId",
  "title",
  "workspaceId",
]);
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

function projectedCreate(record: Record<string, unknown>): ParsedChatCreate {
  return {
    title: parseUtf8BoundedString(
      record.title,
      "chat title",
      MAX_CREATE_TITLE_CHARS,
      MAX_CREATE_TITLE_BYTES,
      true,
    ).value,
    workspaceId: parseUtf8BoundedString(
      record.workspaceId,
      "workspace id",
      MAX_WORKSPACE_ID_CHARS,
      MAX_WORKSPACE_ID_BYTES,
      true,
    ).value,
    providerId: parseUtf8BoundedString(
      record.providerId,
      "provider id",
      MAX_PROVIDER_ID_CHARS,
      MAX_PROVIDER_ID_BYTES,
      true,
    ).value,
    model: parseUtf8BoundedString(
      record.model,
      "model id",
      MAX_MODEL_ID_CHARS,
      MAX_MODEL_ID_BYTES,
      true,
    ).value,
  };
}

export function parseChatCreate(value: unknown): ParsedPublicChatCreate {
  const projected = projectedCreate(
    requireAllowedKeys(value, CHAT_CREATE_KEYS, "Invalid chat creation fields."),
  );
  if (!projected.workspaceId) throw new Error("Invalid workspace id.");
  return { ...projected, workspaceId: projected.workspaceId };
}
