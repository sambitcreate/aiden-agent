import { MAX_INLINE_IMAGE_BYTES } from "../../shared/attachment-contract";
import type { Attachment } from "../types";
import type { HostChatAttachmentUpload } from "./host-chat-adapter";

/** The host stages at most this many uploads for one turn. */
export const MAX_REMOTE_ATTACHMENTS_PER_TURN = 10;
const MAX_REMOTE_TEXT_CHARACTERS = 100_000;
const MAX_REMOTE_NAME_CHARACTERS = 255;

/** Text types the host accepts as they are; any other text file is sent as plain text. */
const REMOTE_TEXT_MIME_TYPES = new Set([
  "text/plain",
  "text/markdown",
  "text/csv",
  "application/json",
  "application/xml",
  "application/yaml",
  "application/x-yaml",
  "application/javascript",
  "application/typescript",
]);

export class RemoteAttachmentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RemoteAttachmentError";
  }
}

/** The host refuses slashes and control characters in a display name. */
function remoteName(name: string): string {
  const cleaned = Array.from(name.trim().replace(/[/\\\p{Cc}]/gu, "_"))
    .slice(0, MAX_REMOTE_NAME_CHARACTERS)
    .join("")
    .trim();
  return cleaned || "attachment";
}

/**
 * Converts the files this Mac read for the composer into the uploads a
 * paired host accepts, or explains which one it cannot take. Nothing here
 * touches the host; the caller uploads the result.
 */
export function remoteAttachmentUploads(attachments: readonly Attachment[]): HostChatAttachmentUpload[] {
  if (attachments.length > MAX_REMOTE_ATTACHMENTS_PER_TURN) {
    throw new RemoteAttachmentError(`Another Mac takes up to ${MAX_REMOTE_ATTACHMENTS_PER_TURN} attachments per message.`);
  }
  return attachments.map((attachment): HostChatAttachmentUpload => {
    const name = remoteName(attachment.name);
    if (attachment.kind === "image") {
      const mimeType = attachment.mimeType.toLowerCase();
      if (mimeType !== "image/png" && mimeType !== "image/jpeg") {
        throw new RemoteAttachmentError(`${attachment.name} can't be sent to another Mac. Use a PNG or JPEG image.`);
      }
      if (!attachment.data) throw new RemoteAttachmentError(`${attachment.name} could not be read.`);
      if (attachment.size > MAX_INLINE_IMAGE_BYTES) {
        throw new RemoteAttachmentError(`${attachment.name} is too large to send to another Mac.`);
      }
      return { name, mimeType, kind: "image", data: attachment.data };
    }
    if (attachment.text === undefined) throw new RemoteAttachmentError(`${attachment.name} could not be read.`);
    const mimeType = attachment.mimeType.toLowerCase();
    return {
      name,
      mimeType: REMOTE_TEXT_MIME_TYPES.has(mimeType) ? mimeType : "text/plain",
      kind: "text",
      // The composer already truncates text files; this keeps the host's cap exact.
      text: Array.from(attachment.text).slice(0, MAX_REMOTE_TEXT_CHARACTERS).join(""),
    };
  });
}
