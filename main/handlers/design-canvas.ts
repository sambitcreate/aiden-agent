// IPC for the per-chat design canvas. Registered only while
// AIDEN_EXPERIMENTAL_DESIGN_MODE is on, and every handler re-checks the flag
// the way `chats:setDesignMode` does.

import type { DesignCanvasV1 } from "../../renderer/shared/design-canvas/schema.js";
import type { DesignGrantRegistry } from "../services/design-canvas/grants.js";
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

/** `designCanvas:grant` reply: an `aiden-design://<grant>/` host, or no access. */
export type DesignCanvasGrantResult = { grant: string } | { error: "unavailable" };

export const DESIGN_CANVAS_UPDATED_CHANNEL = "designCanvas:updated";
const UNAVAILABLE = "Design mode is not available.";

export function registerDesignCanvasHandlers<Event>(deps: {
  enabled: () => boolean;
  handle(channel: string, handler: (event: Event, ...args: unknown[]) => unknown): void;
  store: Pick<DesignCanvasStore, "get" | "save">;
  broadcast(update: DesignCanvasUpdated): void;
  getChat(chatId: string): Promise<DesignCanvasChat | null>;
  grants: Pick<DesignGrantRegistry, "issue" | "revokeChat">;
  /** The chat's workspace folder, or null when the chat has no folder to frame. */
  workspaceRoot(chat: DesignCanvasChat): Promise<string | null>;
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

  // Only an attended desktop chat in design mode may frame its own workspace
  // folder; Bot and routine chats never get a grant.
  const canFrame = (chat: DesignCanvasChat | null): chat is DesignCanvasChat =>
    chat !== null && chat.designMode === true && !chat.botId && !chat.owner;

  deps.handle("designCanvas:grant", async (_event, chatId): Promise<DesignCanvasGrantResult> => {
    if (!deps.enabled()) throw new Error(UNAVAILABLE);
    assertDesignCanvasChatId(chatId);
    const chat = await deps.getChat(chatId);
    if (!canFrame(chat)) return { error: "unavailable" };
    const root = await deps.workspaceRoot(chat);
    if (!root) return { error: "unavailable" };
    const grant = deps.grants.issue(chat.id, root);
    // Design mode may have turned off, the chat moved, or its workspace was
    // removed or re-pointed while we awaited.
    const current = await deps.getChat(chat.id);
    if (
      !canFrame(current) ||
      current.workspaceId !== chat.workspaceId ||
      (await deps.workspaceRoot(current)) !== root
    ) {
      deps.grants.revokeChat(chat.id);
      return { error: "unavailable" };
    }
    return { grant };
  });
}
