import { createHash } from "node:crypto";
import type { AidenUiNodeV1, ChatUiVisualV1 } from "../../renderer/shared/aiden-ui/types.js";
import { MAX_ATTACHMENT_INLINE_BYTES } from "../../renderer/shared/attachment-contract.js";
import { VISUAL_SNAPSHOT_ID_PREFIX, withoutVisualSnapshots } from "../../renderer/shared/visual-snapshots.js";
import type { Attachment } from "./types.js";

/**
 * The Electron-free half of visual snapshots: a serial queue with a per-visual
 * timeout and per-chat cancellation, plus the reserved attachment shape. The
 * capture itself (a hidden window) is injected, so this is unit-testable.
 */

export type SnapshotVisual =
  | { kind: "html"; visualId: string; title: string; layout?: "wide" }
  | {
      kind: "ui";
      visualId: string;
      title: string;
      layout?: "wide";
      visual: ChatUiVisualV1;
      /** The message images this visual shows (see `visualSnapshotImages`). */
      attachments?: readonly Attachment[];
    };

const SNAPSHOT_IMAGE_MIME_TYPE = /^image\/(png|jpeg|gif|webp)$/u;

/**
 * The attachment ids a visual's `<Image>` nodes name literally. Returns `null`
 * when any `<Image>` takes its id from an expression (concatenation, data, or an
 * `<Each>` local): only the desktop's own evaluation can resolve those.
 */
function literalImageReferences(tree: AidenUiNodeV1): Set<string> | null {
  const ids = new Set<string>();
  const pending: AidenUiNodeV1[] = [tree];
  while (pending.length > 0) {
    const node = pending.pop()!;
    if (node.t === "Image") {
      const value = node.p?.attachment;
      if (value !== undefined) {
        if (!("op" in value) || value.op !== "lit" || typeof value.v !== "string") return null;
        ids.add(value.v);
      }
    }
    for (const child of node.c ?? []) pending.push(child);
  }
  return ids;
}

/**
 * The message images a native visual can show, in message order: image
 * attachments within the message's inline attachment limit that the visual can
 * reference. A visual whose `<Image>` ids are all literals gets exactly those
 * images; a visual with any computed id gets every eligible image, so the
 * capture resolves the same ids the desktop does. Snapshot pictures and
 * non-raster or data-less attachments are never included.
 */
export function visualSnapshotImages(visual: ChatUiVisualV1, attachments: readonly Attachment[] | undefined): Attachment[] {
  const referenced = literalImageReferences(visual.tree);
  const images: Attachment[] = [];
  let bytes = 0;
  for (const attachment of withoutVisualSnapshots(attachments ?? [])) {
    if (attachment.kind !== "image" || !attachment.data || !SNAPSHOT_IMAGE_MIME_TYPE.test(attachment.mimeType)) continue;
    if (referenced && !referenced.has(attachment.id)) continue;
    if (bytes + attachment.size > MAX_ATTACHMENT_INLINE_BYTES) continue;
    bytes += attachment.size;
    images.push(attachment);
  }
  return images;
}

export interface VisualSnapshotJob {
  chatId: string;
  messageId: string;
  visuals: SnapshotVisual[];
}

export interface CapturedImage {
  bytes: Buffer;
  mimeType: "image/png" | "image/jpeg";
}

export interface CapturedSnapshot extends CapturedImage {
  visualId: string;
  title: string;
}

export const VISUAL_SNAPSHOT_TIMEOUT_MS = 6000;

export function visualSnapshotAttachmentId(chatId: string, messageId: string, visualId: string): string {
  const digest = createHash("sha256").update(chatId).update("\0").update(messageId).update("\0").update(visualId).digest("hex");
  return `${VISUAL_SNAPSHOT_ID_PREFIX}${digest}`;
}

export function snapshotAttachment(chatId: string, messageId: string, snapshot: CapturedSnapshot): Attachment {
  const safe = Array.from(snapshot.title)
    .filter((character) => character.charCodeAt(0) >= 32 && !'\\/:*?"<>|'.includes(character))
    .join("");
  const base = safe.replace(/\s+/gu, " ").trim().slice(0, 100) || "Visual";
  return {
    id: visualSnapshotAttachmentId(chatId, messageId, snapshot.visualId),
    name: `${base}.${snapshot.mimeType === "image/png" ? "png" : "jpg"}`,
    mimeType: snapshot.mimeType,
    kind: "image",
    size: snapshot.bytes.length,
    data: snapshot.bytes.toString("base64"),
  };
}

export interface VisualSnapshotQueueOptions {
  capture: (visual: SnapshotVisual, signal: AbortSignal, job: VisualSnapshotJob) => Promise<CapturedImage | null>;
  store: (chatId: string, messageId: string, snapshots: CapturedSnapshot[]) => Promise<unknown>;
  timeoutMs?: number;
  onError?: (error: unknown) => void;
}

export function createVisualSnapshotQueue(options: VisualSnapshotQueueOptions) {
  const timeoutMs = options.timeoutMs ?? VISUAL_SNAPSHOT_TIMEOUT_MS;
  const pending: VisualSnapshotJob[] = [];
  const cancelledChats = new Set<string>();
  let running: Promise<void> | null = null;
  let disposed = false;
  let current: { job: VisualSnapshotJob; abort: AbortController } | null = null;

  const captureOne = async (job: VisualSnapshotJob, visual: SnapshotVisual): Promise<CapturedImage | null> => {
    const abort = new AbortController();
    current = { job, abort };
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        options.capture(visual, abort.signal, job),
        new Promise<null>((resolve) => {
          timer = setTimeout(() => {
            abort.abort();
            resolve(null);
          }, timeoutMs);
        }),
      ]);
    } catch (error) {
      if (!abort.signal.aborted) options.onError?.(error);
      return null;
    } finally {
      if (timer) clearTimeout(timer);
      current = null;
    }
  };

  const drain = async () => {
    while (pending.length && !disposed) {
      const job = pending.shift()!;
      if (cancelledChats.has(job.chatId)) continue;
      const captured: CapturedSnapshot[] = [];
      for (const visual of job.visuals) {
        if (disposed || cancelledChats.has(job.chatId)) break;
        const image = await captureOne(job, visual);
        if (image) captured.push({ ...image, visualId: visual.visualId, title: visual.title });
      }
      if (disposed || cancelledChats.has(job.chatId) || captured.length === 0) continue;
      try {
        await options.store(job.chatId, job.messageId, captured);
      } catch (error) {
        options.onError?.(error);
      }
    }
  };

  const kick = () => {
    if (running) return;
    running = drain().finally(() => {
      running = null;
      // A chat cancelled while idle has nothing left to protect.
      if (pending.length === 0) cancelledChats.clear();
      else kick();
    });
  };

  return {
    enqueue(job: VisualSnapshotJob): void {
      if (disposed || job.visuals.length === 0) return;
      cancelledChats.delete(job.chatId);
      pending.push(job);
      kick();
    },
    /** The chat was deleted: drop its work and abandon its in-flight capture. */
    cancelChat(chatId: string): void {
      cancelledChats.add(chatId);
      for (let index = pending.length - 1; index >= 0; index -= 1) {
        if (pending[index]!.chatId === chatId) pending.splice(index, 1);
      }
      if (current?.job.chatId === chatId) current.abort.abort();
    },
    dispose(): void {
      disposed = true;
      pending.length = 0;
      current?.abort.abort();
    },
    /** Resolves when the queue has nothing left to do (tests and shutdown). */
    async idle(): Promise<void> {
      while (running) await running;
    },
  };
}
