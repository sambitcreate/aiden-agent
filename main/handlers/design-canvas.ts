// IPC for the per-chat design canvas. Registered only while
// AIDEN_EXPERIMENTAL_DESIGN_MODE is on, and every handler re-checks the flag
// the way `chats:setDesignMode` does.

import type { DesignCanvasV1 } from "../../renderer/shared/design-canvas/schema.js";
import {
  assertDesignCanvasChatId,
  type DesignCanvasStore,
} from "../services/design-canvas/store.js";
import type { ChatMeta } from "../services/types.js";

/** Broadcast on `designCanvas:updated` after a save or an Aiden edit lands. */
export type DesignCanvasUpdated = { chatId: string; revision: number };

/** The chat fields the canvas handlers decide on. */
export type DesignCanvasChat = Pick<
  ChatMeta,
  "id" | "workspaceId" | "designMode" | "botId" | "owner"
>;

export const DESIGN_CANVAS_UPDATED_CHANNEL = "designCanvas:updated";
const UNAVAILABLE = "Design mode is not available.";

export function registerDesignCanvasHandlers<Event>(deps: {
  enabled: () => boolean;
  handle(channel: string, handler: (event: Event, ...args: unknown[]) => unknown): void;
  store: Pick<DesignCanvasStore, "get" | "save">;
  broadcast(update: DesignCanvasUpdated): void;
  getChat(chatId: string): Promise<DesignCanvasChat | null>;
}): void {
  if (!deps.enabled()) return;

  const requireChat = async (chatId: unknown): Promise<DesignCanvasChat> => {
    if (!deps.enabled()) throw new Error(UNAVAILABLE);
    assertDesignCanvasChatId(chatId);
    const chat = await deps.getChat(chatId);
    if (!chat) throw new Error("This chat is no longer available.");
    return chat;
  };

  deps.handle("designCanvas:get", async (_event, chatId) => {
    const chat = await requireChat(chatId);
    return deps.store.get(chat.id);
  });

  deps.handle("designCanvas:save", async (_event, chatId, doc, baseRevision) => {
    if (
      typeof baseRevision !== "number" ||
      !Number.isSafeInteger(baseRevision) ||
      baseRevision < 0
    ) {
      throw new Error("Invalid canvas revision.");
    }
    const chat = await requireChat(chatId);
    const result = await deps.store.save(chat.id, doc as DesignCanvasV1, baseRevision);
    if (result.ok) deps.broadcast({ chatId: chat.id, revision: result.revision });
    return result;
  });
}
