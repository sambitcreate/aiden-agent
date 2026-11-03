import type { TranscriptImage } from "../../renderer/shared/transcript-images.js";
import type { RendererDocumentOwner } from "../services/renderer-document-owner.js";

/** Attended, document-owned image loads. No cache or persistent permission is created. */
export function registerTranscriptImageHandlers<Event>(deps: {
  handle(channel: string, handler: (event: Event, ...args: unknown[]) => unknown): void;
  owner(event: Event): Pick<RendererDocumentOwner, "id" | "documentId" | "isDestroyed" | "onInvalidated">;
  fetch(value: unknown, options: { signal: AbortSignal }): Promise<TranscriptImage>;
}): void {
  const active = new Map<string, number>();
  deps.handle("chat:loadTranscriptImage", async (event, value) => {
    const owner = deps.owner(event);
    if (owner.isDestroyed()) throw new Error("The image's window is no longer active.");
    const key = `${owner.id}:${owner.documentId}`;
    if ((active.get(key) ?? 0) >= 4 || [...active.values()].reduce((total, count) => total + count, 0) >= 8) {
      throw new Error("Wait for the other images to finish loading.");
    }
    active.set(key, (active.get(key) ?? 0) + 1);
    const controller = new AbortController();
    const unsubscribe = owner.onInvalidated(() => controller.abort());
    try {
      controller.signal.throwIfAborted();
      const image = await deps.fetch(value, { signal: controller.signal });
      if (owner.isDestroyed()) throw new Error("The image's window is no longer active.");
      return image;
    } finally {
      unsubscribe();
      const remaining = (active.get(key) ?? 1) - 1;
      if (remaining) active.set(key, remaining);
      else active.delete(key);
    }
  });
}
