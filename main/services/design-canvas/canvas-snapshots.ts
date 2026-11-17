// `canvas_read {snapshot: true}`: main asks the window that owns the reply
// for a picture of its design canvas, and that window answers with a
// downscaled PNG of the canvas region (design mode P3d).

import { randomUUID } from "node:crypto";
import type { ChatGenerationOwner } from "../chat-generation-owner.js";

/** `designCanvas:snapshot`, to the turn's window. */
export type DesignCanvasSnapshotRequest = { requestId: string; chatId: string };

const PNG_PREFIX = "data:image/png;base64,";
/** A 1024 px PNG is well under this; anything larger is refused. */
export const DESIGN_SNAPSHOT_MAX_CHARS = 4 * 1024 * 1024;
export const DESIGN_SNAPSHOT_TIMEOUT_MS = 5_000;

type Snapshot = { data: string; mimeType: "image/png" };
type Pending = { owner: ChatGenerationOwner; finish(snapshot: Snapshot | null): void };

export class DesignCanvasSnapshots {
  private pending = new Map<string, Pending>();

  constructor(private readonly timeoutMs = DESIGN_SNAPSHOT_TIMEOUT_MS) {}

  /** Null when no window on this desktop shows the canvas in time. */
  request(input: { chatId: string; owner?: ChatGenerationOwner; signal?: AbortSignal }): Promise<Snapshot | null> {
    const { owner, signal } = input;
    if (!owner || owner.kind === "remote" || owner.id === 0 || owner.isDestroyed() || signal?.aborted) {
      return Promise.resolve(null);
    }
    if (this.pending.size >= 8) return Promise.resolve(null);
    const requestId = randomUUID();
    return new Promise<Snapshot | null>((resolve) => {
      let unsubscribe = () => {};
      const finish = (snapshot: Snapshot | null) => {
        if (!this.pending.delete(requestId)) return;
        clearTimeout(timeout);
        unsubscribe();
        signal?.removeEventListener("abort", abort);
        resolve(snapshot);
      };
      const abort = () => finish(null);
      const timeout = setTimeout(abort, this.timeoutMs);
      this.pending.set(requestId, { owner, finish });
      unsubscribe = owner.onInvalidated(abort);
      signal?.addEventListener("abort", abort, { once: true });
      try {
        owner.send("designCanvas:snapshot", { requestId, chatId: input.chatId } satisfies DesignCanvasSnapshotRequest);
      } catch {
        abort();
      }
    });
  }

  /** The window's picture, or null when its canvas is not on screen. False when not this window's request. */
  answer(
    requestId: unknown,
    dataUrl: unknown,
    owner: Pick<ChatGenerationOwner, "id" | "documentId" | "isDestroyed">,
  ): boolean {
    if (typeof requestId !== "string") return false;
    const request = this.pending.get(requestId);
    if (
      !request ||
      request.owner.id !== owner.id ||
      request.owner.documentId !== owner.documentId ||
      request.owner.isDestroyed() ||
      owner.isDestroyed()
    ) {
      return false;
    }
    const valid =
      typeof dataUrl === "string" &&
      dataUrl.startsWith(PNG_PREFIX) &&
      dataUrl.length > PNG_PREFIX.length &&
      dataUrl.length <= DESIGN_SNAPSHOT_MAX_CHARS &&
      /^[A-Za-z0-9+/]+=*$/u.test(dataUrl.slice(PNG_PREFIX.length));
    request.finish(valid ? { data: dataUrl.slice(PNG_PREFIX.length), mimeType: "image/png" } : null);
    return true;
  }
}
