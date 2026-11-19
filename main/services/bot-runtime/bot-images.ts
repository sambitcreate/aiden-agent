// Images in a Bot conversation.
//
// A person's images are stored once, natively, in the Bot's `pi.user`
// entries. That entry is the attachment snapshot: nothing about an image lives
// in a tool closure, so a restarted harness sees exactly what the model saw.
//
// - A model with image input receives the images as they are.
// - A model without image input receives, for that request only, a text
//   reference per image (`Attached image reference: image_…`), the same line
//   the legacy chat path writes. The companion `inspect_image` tool resolves a
//   reference against the conversation's entries at call time.
// - Images the Bot shares (`share_image`) become `aiden.bot-shared-image`
//   entries so every client can render them.

import { createHash } from "node:crypto";
import type { ImageContent, Message, TextContent } from "@earendil-works/pi-ai";
import type { EntryRecord } from "@earendil-works/pi-durable";
import type { Attachment } from "../types.js";
import { visionAttachmentAlias } from "../vision-attachment-reference.js";

export const BOT_SHARED_IMAGE_ENTRY_KIND = "aiden.bot-shared-image";

/** `data` of an `aiden.bot-shared-image` entry. */
export interface BotSharedImage {
  [key: string]: string | number;
  id: string;
  name: string;
  mimeType: string;
  size: number;
  /** Base64 bytes. */
  data: string;
}

/** Stable id of an image's bytes, so its reference survives restarts and resends. */
export function botImageId(data: string): string {
  return `img-${createHash("sha256").update(data, "utf8").digest("hex").slice(0, 24)}`;
}

export function botImageReference(data: string): string {
  return visionAttachmentAlias({ id: botImageId(data) });
}

function referenceLine(image: ImageContent): string {
  return `Attached image reference: ${botImageReference(image.data)}.`;
}

/**
 * The request a model without image input receives: every user image becomes
 * its text reference. Other messages are returned unchanged.
 */
export function withImageReferences(messages: readonly Message[]): Message[] {
  return messages.map((message) => {
    if (message.role !== "user" || typeof message.content === "string") return message;
    if (!message.content.some((part) => part.type === "image")) return message;
    const text = message.content
      .map((part) => (part.type === "image" ? referenceLine(part) : part.text))
      .filter((value) => value.length > 0)
      .join("\n\n");
    const content: TextContent[] = [{ type: "text", text }];
    return { ...message, content };
  });
}

/** Every image the person attached in this conversation, as legacy-shaped attachments. */
export function imageAttachmentsFromEntries(entries: readonly EntryRecord[]): Attachment[] {
  const seen = new Set<string>();
  const attachments: Attachment[] = [];
  for (const entry of entries) {
    for (const message of entry.model ?? []) {
      if (message.role !== "user" || typeof message.content === "string") continue;
      for (const part of message.content) {
        if (part.type !== "image") continue;
        const id = botImageId(part.data);
        if (seen.has(id)) continue;
        seen.add(id);
        attachments.push({
          id,
          name: visionAttachmentAlias({ id }),
          mimeType: part.mimeType,
          kind: "image",
          size: Math.floor((part.data.length * 3) / 4),
          data: part.data,
        });
      }
    }
  }
  return attachments;
}

export function sharedImageEntry(attachment: Attachment): BotSharedImage {
  if (attachment.kind !== "image" || typeof attachment.data !== "string") {
    throw new Error("Only images can be shared in a Bot chat.");
  }
  return {
    id: attachment.id,
    name: attachment.name,
    mimeType: attachment.mimeType,
    size: attachment.size,
    data: attachment.data,
  };
}
