import type { Attachment, Chat } from "./types.js";
import type { SkillProvenanceV1 } from "../../renderer/shared/slash-commands.js";
import { safeStoredAttachments } from "./attachment-contract.js";
import { parseChatHtmlArtifacts } from "../../renderer/shared/chat-artifacts.js";
import { parseSkillProvenanceV1 } from "../../renderer/shared/slash-commands.js";
import {
  parseProviderFailureV1,
  type ProviderFailureV1,
} from "../../renderer/shared/provider-failure.js";
import {
  MAX_CHAT_ID_BYTES,
  MAX_CHAT_ID_CHARS,
  MAX_MODEL_ID_BYTES,
  MAX_MODEL_ID_CHARS,
  MAX_PROVIDER_ID_BYTES,
  MAX_PROVIDER_ID_CHARS,
  MAX_WORKSPACE_ID_BYTES,
  MAX_WORKSPACE_ID_CHARS,
} from "../../renderer/shared/chat-message-contract.js";

export const MAX_VISIBLE_MESSAGE_CONTENT_CHARS = 64 * 1024 * 1024;
export const MAX_VISIBLE_CHAT_TITLE_CHARS = 1_024;
export const MAX_VISIBLE_CHAT_TITLE_BYTES = 4_096;

export interface VisibleChatMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  createdAt: number;
  model?: string;
  attachments?: Attachment[];
  htmlArtifacts?: import("../../renderer/shared/chat-artifacts.js").ChatHtmlArtifactV1[];
  skill?: SkillProvenanceV1;
  providerFailure?: ProviderFailureV1;
}

/** Strip private provider protocol before a Chat crosses into the renderer. */
export function chatForRenderer(chat: Chat | null): Chat | null {
  if (!chat) return null;
  return {
    ...chat,
    messages: chat.messages.map((message) => {
      const { pi: _privatePiProtocol, ...visible } = message;
      return {
        ...visible,
        providerFailure:
          message.role === "assistant"
            ? parseProviderFailureV1(message.providerFailure)
            : undefined,
      };
    }),
  };
}

function boundedString(
  value: unknown,
  label: string,
  maxChars: number,
  maxBytes: number,
  optional = false,
): string | undefined {
  if (value === undefined && optional) return undefined;
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > maxChars ||
    Buffer.byteLength(value, "utf8") > maxBytes
  ) {
    throw new Error(`This chat contains an invalid ${label}.`);
  }
  return value;
}

export function projectVisibleChatMetadata(input: {
  title: unknown;
  workspaceId?: unknown;
  botId?: unknown;
  providerId?: unknown;
  model?: unknown;
}): {
  title: string;
  workspaceId?: string;
  botId?: string;
  providerId?: string;
  model?: string;
} {
  return {
    title: boundedString(
      input.title,
      "title",
      MAX_VISIBLE_CHAT_TITLE_CHARS,
      MAX_VISIBLE_CHAT_TITLE_BYTES,
    )!,
    workspaceId: boundedString(
      input.workspaceId,
      "workspace identifier",
      MAX_WORKSPACE_ID_CHARS,
      MAX_WORKSPACE_ID_BYTES,
      true,
    ),
    botId: boundedString(
      input.botId,
      "bot identifier",
      MAX_CHAT_ID_CHARS,
      MAX_CHAT_ID_BYTES,
      true,
    ),
    providerId: boundedString(
      input.providerId,
      "provider identifier",
      MAX_PROVIDER_ID_CHARS,
      MAX_PROVIDER_ID_BYTES,
      true,
    ),
    model: boundedString(
      input.model,
      "model identifier",
      MAX_MODEL_ID_CHARS,
      MAX_MODEL_ID_BYTES,
      true,
    ),
  };
}

export function projectVisibleChatMessage(value: unknown): VisibleChatMessage | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("This chat contains an invalid visible message.");
  }
  const message = value as Record<string, unknown>;
  if (message.role !== "user" && message.role !== "assistant") return undefined;
  const id = boundedString(
    message.id,
    "message identifier",
    MAX_CHAT_ID_CHARS,
    MAX_CHAT_ID_BYTES,
  )!;
  if (
    typeof message.content !== "string" ||
    message.content.length > MAX_VISIBLE_MESSAGE_CONTENT_CHARS
  ) {
    throw new Error("This chat contains invalid or oversized visible message text.");
  }
  if (!Number.isSafeInteger(message.createdAt) || (message.createdAt as number) < 0) {
    throw new Error("This chat contains an invalid visible message timestamp.");
  }
  const model = boundedString(
    message.model,
    "message model identifier",
    MAX_MODEL_ID_CHARS,
    MAX_MODEL_ID_BYTES,
    true,
  );
  return {
    id,
    role: message.role,
    content: message.content,
    createdAt: message.createdAt as number,
    model,
    attachments: safeStoredAttachments(message.attachments),
    htmlArtifacts:
      message.role === "assistant"
        ? parseChatHtmlArtifacts(message.htmlArtifacts)
        : undefined,
    skill:
      message.role === "user"
        ? parseSkillProvenanceV1(message.skill)
        : undefined,
    providerFailure:
      message.role === "assistant"
        ? parseProviderFailureV1(message.providerFailure)
        : undefined,
  };
}
