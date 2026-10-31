import * as React from "react";
import { useQueries } from "@tanstack/react-query";
import type { BotTranscriptEntry } from "../../shared/bot-live";
import { MAX_INLINE_IMAGE_BYTES } from "../../shared/attachment-contract";
import type { PeerAttachmentContent } from "../../shared/peer-operation";
import { peerHostsApi } from "../ipc";
import { bytesToBase64 } from "../live-pcm-capture";
import type { Attachment, ChatMessage } from "../types";
import type { HostChatAdapter, HostChatError, HostChatResult } from "./host-chat-adapter";

export type { PeerAttachmentContent };

/**
 * Pictures in another Mac's chats. The host's transcripts carry each image's
 * name, type and size only; this Mac reads the bytes of the images in the
 * loaded messages, a few at a time, and draws them like its own. An image
 * stays the file chip it was until its bytes arrive, and for good when the
 * host no longer has it.
 */

/** The bytes main hands back for `attachmentContent` and `botSessionImage`. */
export function peerAttachmentContent(value: unknown): PeerAttachmentContent {
  const record = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  const { mimeType, bytes } = record;
  if ((mimeType !== "image/png" && mimeType !== "image/jpeg") || !(bytes instanceof Uint8Array))
    throw new Error("The other Mac sent an image this Mac cannot read.");
  return { mimeType, bytes };
}

interface ExpectedImage {
  mimeType: string;
  size: number;
}

/** Whether a host lists this image so that its bytes can be read: PNG or JPEG within the inline limit. */
export function remoteImageReadable(image: ExpectedImage): boolean {
  return (
    (image.mimeType === "image/png" || image.mimeType === "image/jpeg") &&
    Number.isSafeInteger(image.size) &&
    image.size > 0 &&
    image.size <= MAX_INLINE_IMAGE_BYTES
  );
}

/**
 * The base64 to draw, or null when the bytes are not the image the transcript
 * listed. The host already checks them; this keeps a changed or swapped entry
 * from drawing as something else.
 */
export function acceptRemoteImage(expected: ExpectedImage, content: PeerAttachmentContent): string | null {
  if (content.mimeType !== expected.mimeType || content.bytes.byteLength !== expected.size) return null;
  return bytesToBase64(content.bytes);
}

function needsBytes(attachment: Attachment): boolean {
  return attachment.kind === "image" && !attachment.data && remoteImageReadable(attachment);
}

/**
 * The transcript with every image that has been read filled in. Messages
 * without a newly read image keep their identity, so settled rows stay memoized.
 */
export function withRemoteImageData(
  messages: ChatMessage[],
  loaded: ReadonlyMap<string, string>,
  filled: WeakMap<ChatMessage, { key: string; message: ChatMessage }> = new WeakMap(),
): ChatMessage[] {
  if (loaded.size === 0) return messages;
  let changed = false;
  const next = messages.map((message) => {
    const ids = (message.attachments ?? [])
      .filter((attachment) => needsBytes(attachment) && loaded.has(attachment.id))
      .map((attachment) => attachment.id);
    if (ids.length === 0) return message;
    changed = true;
    // The same message with the same images read keeps its filled copy, so its row stays memoized.
    const key = ids.join("\u0000");
    const known = filled.get(message);
    if (known?.key === key) return known.message;
    const copy = {
      ...message,
      attachments: message.attachments!.map((attachment) => {
        const data = needsBytes(attachment) ? loaded.get(attachment.id) : undefined;
        return data ? { ...attachment, data } : attachment;
      }),
    };
    filled.set(message, { key, message: copy });
    return copy;
  });
  return changed ? next : messages;
}

type RemoteImageRead = (id: string) => Promise<HostChatResult<PeerAttachmentContent>>;

/** The host no longer has the image, or sent something other than what it listed. Reading again won't help. */
class RemoteImageGone extends Error {}

function imageGone(error: HostChatError): boolean {
  if (error.retryable === true) return false;
  if ([error.code, error.remoteCode].some((code) => code === "not_found" || code === "unsupported" || code === "capability_denied"))
    return true;
  return error.status !== undefined && error.status >= 400 && error.status < 500 && error.status !== 408 && error.status !== 429;
}

/**
 * Reads at a time per host. A host takes only a few requests from this Mac at
 * once and refuses the rest, so a chat full of pictures must not crowd out
 * sends, approvals and older messages.
 */
export const REMOTE_IMAGE_READS_PER_HOST = 3;
const hostReads = new Map<string, { active: number; waiting: (() => void)[] }>();

async function limited<T>(hostId: string, read: () => Promise<T>): Promise<T> {
  const slot = hostReads.get(hostId) ?? { active: 0, waiting: [] };
  hostReads.set(hostId, slot);
  if (slot.active >= REMOTE_IMAGE_READS_PER_HOST) await new Promise<void>((resolve) => slot.waiting.push(resolve));
  slot.active += 1;
  try {
    return await read();
  } finally {
    slot.active -= 1;
    const next = slot.waiting.shift();
    if (next) next();
    else if (slot.active === 0) hostReads.delete(hostId);
  }
}

function useRemoteImageReads(
  hostId: string,
  scope: readonly string[],
  wanted: readonly (ExpectedImage & { id: string })[],
  read: RemoteImageRead,
  enabled: boolean,
): { loaded: ReadonlyMap<string, string>; gone: ReadonlySet<string> } {
  const results = useQueries({
    queries: wanted.map((image) => ({
      queryKey: [...scope, "image", image.id, image.mimeType, image.size],
      queryFn: () =>
        limited(hostId, async () => {
          let result: HostChatResult<PeerAttachmentContent>;
          try {
            result = await read(image.id);
          } catch (error) {
            // Bytes main could not hand over as an image are not worth reading again.
            throw new RemoteImageGone(error instanceof Error ? error.message : "The other Mac sent an unreadable image.");
          }
          if (!result.ok) throw imageGone(result.error) ? new RemoteImageGone(result.error.message) : new Error(result.error.message);
          const data = acceptRemoteImage(image, result.value);
          if (data === null) throw new RemoteImageGone("The other Mac sent a different image.");
          return data;
        }),
      enabled,
      // A busy or unreachable host is asked again; one that no longer has the image is not.
      retry: (failures: number, error: Error) => !(error instanceof RemoteImageGone) && failures < 2,
      // The bytes behind an id never change; the client's cache time decides how long they stay.
      staleTime: Infinity,
    })),
  });
  const outcomeKey = results
    .map((result) => (result.data ? "1" : result.error instanceof RemoteImageGone ? "0" : "-"))
    .join("");
  return React.useMemo(() => {
    const loaded = new Map<string, string>();
    const gone = new Set<string>();
    results.forEach((result, index) => {
      const id = wanted[index]!.id;
      if (result.data) loaded.set(id, result.data);
      else if (result.error instanceof RemoteImageGone) gone.add(id);
    });
    return { loaded, gone };
    // `results` is a new array on every render; the key says when an outcome changed.
  }, [outcomeKey, wanted]);
}

/** `wanted`, kept the same array while the same images are wanted. */
function useStableWanted(images: (ExpectedImage & { id: string })[]): (ExpectedImage & { id: string })[] {
  const key = images.map((image) => `${image.id}\u0000${image.mimeType}\u0000${image.size}`).join("\u0001");
  // The key names every field a read depends on.
  return React.useMemo(() => images, [key]);
}

/** Reads the images in a paired host's chat transcript and returns it with them drawn. */
export function useRemoteChatImages(
  adapter: Pick<HostChatAdapter, "hostId" | "attachmentContent"> | null | undefined,
  chatId: string,
  messages: ChatMessage[],
  enabled: boolean,
): ChatMessage[] {
  const wanted = useStableWanted(
    messages.flatMap((message) =>
      (message.attachments ?? []).filter(needsBytes).map((attachment) => ({
        id: attachment.id,
        mimeType: attachment.mimeType,
        size: attachment.size,
      })),
    ),
  );
  const read = React.useCallback<RemoteImageRead>(
    (id) =>
      adapter?.attachmentContent
        ? adapter.attachmentContent(chatId, id)
        : Promise.resolve({ ok: false, error: { code: "unsupported", message: "This Mac cannot read that image." } }),
    [adapter, chatId],
  );
  const hostId = adapter?.hostId ?? "";
  const { loaded } = useRemoteImageReads(
    hostId,
    ["host", hostId, "chat", chatId],
    wanted,
    read,
    enabled && Boolean(adapter?.attachmentContent),
  );
  const filled = React.useRef(new WeakMap<ChatMessage, { key: string; message: ChatMessage }>()).current;
  return React.useMemo(() => withRemoteImageData(messages, loaded, filled), [messages, loaded, filled]);
}

/**
 * A Bot's transcript with its shared images drawn: an image shows as its file
 * chip while its bytes are read, and one the host no longer has, or that this
 * Mac cannot draw, becomes the line the host sends devices that do not draw
 * images.
 */
export function withRemoteBotImages(
  entries: BotTranscriptEntry[],
  loaded: ReadonlyMap<string, string>,
  gone: ReadonlySet<string>,
): BotTranscriptEntry[] {
  if (!entries.some((entry) => entry.type === "shared_image" && !entry.data)) return entries;
  return entries.map((entry): BotTranscriptEntry => {
    if (entry.type !== "shared_image" || entry.data) return entry;
    const data = loaded.get(entry.id);
    if (data) return { ...entry, data };
    if (gone.has(entry.id) || !remoteImageReadable(entry))
      return {
        id: entry.id,
        type: "assistant",
        text: `I shared an image: ${entry.name}. Open this chat on its Mac to see it.`,
        toolCalls: [],
        stopReason: "stop",
      };
    return entry;
  });
}

/** Reads the images a Bot on a paired host shared and returns its transcript with them drawn. */
export function useRemoteBotImages(
  hostId: string,
  botId: string,
  entries: BotTranscriptEntry[] | undefined,
  enabled: boolean,
): BotTranscriptEntry[] | undefined {
  const wanted = useStableWanted(
    (entries ?? []).flatMap((entry) =>
      entry.type === "shared_image" && !entry.data && remoteImageReadable(entry)
        ? [{ id: entry.id, mimeType: entry.mimeType, size: entry.size }]
        : [],
    ),
  );
  const read = React.useCallback<RemoteImageRead>(
    async (entryId) => {
      const result = await peerHostsApi.call(hostId, { operation: "botSessionImage", resourceId: botId, itemId: entryId });
      return result.ok ? { ok: true, value: peerAttachmentContent(result.value) } : result;
    },
    [hostId, botId],
  );
  const { loaded, gone } = useRemoteImageReads(hostId, ["host", hostId, "bot", botId], wanted, read, enabled);
  return React.useMemo(
    () => (entries ? withRemoteBotImages(entries, loaded, gone) : entries),
    [entries, loaded, gone],
  );
}
