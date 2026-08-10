import type { Api, ImageContent, Message, Model, TextContent } from "@earendil-works/pi-ai";
import { SkillInvocationError } from "../../renderer/shared/slash-commands.js";
import type { ChatMessage, ChatStartParams } from "./types.js";

const ZERO_USAGE = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function userMessage(
  content: string,
  attachments: ChatStartParams["messages"][number]["attachments"],
  supportsImages: boolean,
  timestamp: number,
  contentFirst = false,
  includeTextAttachments = true,
): Message {
  if (!attachments?.length) return { role: "user", content, timestamp };
  const parts: (TextContent | ImageContent)[] = [];
  const textFiles = includeTextAttachments
    ? attachments.filter((attachment) => attachment.kind === "text" && attachment.text)
    : [];
  const textPrefix = textFiles
    .map((attachment) => `Attached file: ${attachment.name}\n\`\`\`\n${attachment.text}\n\`\`\``)
    .join("\n\n");
  const combinedText = (contentFirst ? [content, textPrefix] : [textPrefix, content])
    .filter(Boolean)
    .join("\n\n");
  if (combinedText) parts.push({ type: "text", text: combinedText });
  if (supportsImages) {
    for (const attachment of attachments) {
      if (attachment.kind === "image" && attachment.data) {
        parts.push({ type: "image", data: attachment.data, mimeType: attachment.mimeType });
      }
    }
  }
  return { role: "user", content: parts.length ? parts : content, timestamp };
}

/** Build the ordinary bounded text payload before Pi wraps an explicit skill invocation. */
export function chatUserTextWithAttachments(
  content: string,
  attachments: ChatStartParams["messages"][number]["attachments"],
  maxBytes = Number.MAX_SAFE_INTEGER,
): string {
  const textFiles: string[] = [];
  let totalBytes = Buffer.byteLength(content, "utf8");
  for (const attachment of attachments ?? []) {
    if (attachment.kind === "text" && typeof attachment.text === "string") {
      const textFile = `Attached file: ${attachment.name}\n\`\`\`\n${attachment.text}\n\`\`\``;
      totalBytes += Buffer.byteLength(textFile, "utf8");
      if (textFiles.length > 0 || content) totalBytes += 2;
      if (totalBytes > maxBytes) {
        throw new SkillInvocationError(
          "instructions_too_large",
          "The selected skill and message exceed Aiden’s invocation limit.",
        );
      }
      textFiles.push(textFile);
    }
  }
  if (totalBytes > maxBytes) {
    throw new SkillInvocationError(
      "instructions_too_large",
      "The selected skill and message exceed Aiden’s invocation limit.",
    );
  }
  const textPrefix = textFiles.join("\n\n");
  return [textPrefix, content].filter(Boolean).join("\n\n");
}

/** Rehydrate Aiden chat history using the generation's exact Pi image gate. */
export function toPiMessages(
  params: ChatStartParams,
  model: Model<Api>,
  supportsImages: boolean,
): Message[] {
  const now = Date.now();
  return params.messages.map((message): Message => {
    if (message.role === "assistant") {
      return {
        role: "assistant",
        content: [{ type: "text", text: message.content }],
        api: model.api,
        provider: model.provider,
        model: model.id,
        usage: ZERO_USAGE,
        stopReason: "stop",
        timestamp: now,
      };
    }

    return userMessage(message.content, message.attachments, supportsImages, now);
  });
}

/**
 * Rehydrate one main-process-owned chat message for Pi's private session
 * journal. Unlike the renderer start payload, this keeps the persisted
 * timestamp and stable chat-message identity is recorded separately by the
 * journal synchronizer.
 */
export function chatMessageToPiMessage(
  message: ChatMessage,
  model: Model<Api>,
  supportsImages: boolean,
  currentTurnContent?: string,
): Message {
  if (message.role === "user" && currentTurnContent !== undefined) {
    return userMessage(
      currentTurnContent,
      message.attachments,
      supportsImages,
      message.createdAt,
      true,
      false,
    );
  }
  const params: ChatStartParams = {
    chatId: "journal-rehydration",
    providerId: model.provider,
    model: model.id,
    messages: [
      {
        role: message.role,
        content: message.content,
        attachments: message.attachments,
      },
    ],
  };
  const converted = toPiMessages(params, model, supportsImages)[0];
  return { ...converted, timestamp: message.createdAt };
}
