import type { Api, ImageContent, Message, Model, TextContent } from "@earendil-works/pi-ai";
import type { ChatStartParams } from "./types.js";

const ZERO_USAGE = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

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

    const attachments = message.attachments ?? [];
    if (attachments.length === 0) {
      return { role: "user", content: message.content, timestamp: now };
    }

    const parts: (TextContent | ImageContent)[] = [];
    const textFiles = attachments.filter((attachment) => attachment.kind === "text" && attachment.text);
    const textPrefix = textFiles
      .map((attachment) => `Attached file: ${attachment.name}\n\`\`\`\n${attachment.text}\n\`\`\``)
      .join("\n\n");
    const combinedText = [textPrefix, message.content].filter(Boolean).join("\n\n");
    if (combinedText) parts.push({ type: "text", text: combinedText });
    if (supportsImages) {
      for (const attachment of attachments) {
        if (attachment.kind === "image" && attachment.data) {
          parts.push({ type: "image", data: attachment.data, mimeType: attachment.mimeType });
        }
      }
    }
    return { role: "user", content: parts.length ? parts : message.content, timestamp: now };
  });
}
