import { protocol } from "electron";
import { createChatAttachmentRequestHandler } from "./chat-attachment-request-handler.js";
import { chatStore } from "./chat-store.js";
import { CHAT_ATTACHMENT_SCHEME } from "./custom-schemes-core.js";

let installed = false;

/** Install the `aiden-attachment:` handler once, after app ready. */
export function registerChatAttachmentProtocol(): void {
  if (installed) return;
  protocol.handle(CHAT_ATTACHMENT_SCHEME, createChatAttachmentRequestHandler(chatStore));
  installed = true;
}
