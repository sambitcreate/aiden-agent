import { MAX_CHAT_MESSAGE_CONTENT_BYTES } from "../../renderer/shared/chat-message-contract.js";

export function parseChatMessageContent(value: unknown): { content: string; bytes: number } {
  if (typeof value !== "string") throw new Error("Invalid message text.");
  const content = value;
  // UTF-8 never uses fewer bytes than JavaScript UTF-16 code units. This
  // rejects arbitrarily large forged IPC strings before Buffer.byteLength's
  // linear scan, while the exact byte check below handles multibyte text.
  if (content.length > MAX_CHAT_MESSAGE_CONTENT_BYTES) {
    throw new Error("Message text exceeds the 1 MB limit.");
  }
  const bytes = Buffer.byteLength(content, "utf8");
  if (bytes > MAX_CHAT_MESSAGE_CONTENT_BYTES) {
    throw new Error("Message text exceeds the 1 MB limit.");
  }
  return { content, bytes };
}
