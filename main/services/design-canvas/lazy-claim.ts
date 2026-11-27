// A design turn's write claims the page it landed on in that same write
// (`withLazyClaim`). At a full `chatPages` the write cannot tell which
// claimed chats are gone without waiting, so it skips the claim, and this
// runs after it: it asks which of them are live and, when that makes room,
// claims in a write of its own. Below the cap it reads and writes nothing.

import { lazyClaimNeedsRoom, withLazyClaim } from "../../../renderer/shared/design-canvas/chat-pages.js";
import type { DesignCanvas } from "../../../renderer/shared/design-canvas/schema.js";
import type { DesignCanvasUpdated, DesignChatCanvases } from "./store.js";

const NO_ROOM = Symbol("no room");

export async function claimWithRoom(input: {
  chatId: string;
  workspaceId: string;
  /** The page the write landed on; undefined when it landed on none. */
  pageId: string | undefined;
  /** The document the write saved. */
  saved: DesignCanvas;
  store: Pick<DesignChatCanvases, "update">;
  isLive?(chatIds: string[], workspaceId: string): Promise<Set<string>>;
  broadcast(update: DesignCanvasUpdated): void;
  /** Asked on the canvas's chain right before the claim is written: false (the chat left the workspace) writes nothing. */
  stillOwned?(): Promise<boolean>;
}): Promise<void> {
  const pageId = input.pageId;
  if (!input.isLive || pageId === undefined || !lazyClaimNeedsRoom(input.saved, input.chatId)) return;
  const checked = new Set(Object.keys(input.saved.chatPages));
  const live = await input.isLive([...checked], input.workspaceId);
  // A claim made after this check is a live chat's.
  const isLive = (chatId: string) => !checked.has(chatId) || live.has(chatId);
  try {
    const { doc } = await input.store.update(
      input.chatId,
      (current) => {
        const next = withLazyClaim(current, input.chatId, pageId, isLive);
        if (next === current) throw NO_ROOM;
        return next;
      },
      {
        workspaceId: input.workspaceId,
        ...(input.stillOwned
          ? {
              beforeWrite: async () => {
                if (!(await input.stillOwned!())) throw NO_ROOM;
              },
            }
          : {}),
      },
    );
    input.broadcast({ workspaceId: input.workspaceId, chatId: input.chatId, revision: doc.revision });
  } catch {
    // The write it follows has landed; the chat's next write tries again.
  }
}
