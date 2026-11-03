// Stored chat images reach the window as links, without their bytes. Reusing
// one in a new message (the composer of a fork) needs the bytes again, in the
// exact shape a renderer append sends.

import type { Attachment } from "./types";

export type StoredImageLoader = (chatId: string, attachmentId: string) => Promise<{ data: string }>;

/**
 * The attachments with every image's bytes filled in, ready for the composer.
 * An image whose bytes can no longer be read is left out.
 */
export async function attachmentsWithBytes(
  chatId: string,
  attachments: readonly Attachment[],
  load: StoredImageLoader,
): Promise<Attachment[]> {
  const ready = await Promise.all(
    attachments.map(async (attachment): Promise<Attachment | undefined> => {
      if (attachment.kind !== "image") return attachment;
      const { id, name, mimeType, kind, size } = attachment;
      if (attachment.data) return { id, name, mimeType, kind, size, data: attachment.data };
      try {
        const { data } = await load(chatId, id);
        return { id, name, mimeType, kind, size, data };
      } catch {
        return undefined;
      }
    }),
  );
  return ready.filter((attachment): attachment is Attachment => attachment !== undefined);
}
