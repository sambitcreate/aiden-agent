// What runs when a chat turns design mode on, by the Design toggle or
// Aiden's card: the chat claims its page of the workspace canvas, its
// earlier pages land there, the canvas is asked to show it, and a page made
// for the chat takes its newest title. The run is tracked in
// `PendingEntries`, so the chat's turn writes wait for its claim.

import type { DesignTitleFollow } from "./title-follow.js";
import type { DesignCanvasUpdated, DesignChatCanvases } from "./store.js";
import { designTurnPages, type DesignCanvasViews } from "./views.js";
import {
  EARLIER_PAGES_LIMIT,
  pagesWrittenInChat,
  placeWrittenPagesOnCanvas,
  type PendingEntries,
  type RecentWrittenPages,
} from "./written-pages.js";

/** The chat as entry reads it: its id, title and saved messages. */
type EnteringChat = { id: string; title: string; messages: Parameters<typeof pagesWrittenInChat>[0] };

export function createDesignEntry(deps: {
  store: Pick<DesignChatCanvases, "get" | "update" | "workspaceIdOf">;
  views: Pick<DesignCanvasViews, "get" | "viewports" | "showPage" | "pageIdsOf">;
  recent: Pick<RecentWrittenPages, "merged">;
  pending: Pick<PendingEntries, "track">;
  titleFollow: Pick<DesignTitleFollow, "follow">;
  isLive(chatIds: string[], workspaceId: string): Promise<Set<string>>;
  /** Checked on the canvas's chain before the write: false once design mode is off or the chat is gone. */
  designModeOn(chatId: string): Promise<boolean>;
  broadcast(update: DesignCanvasUpdated): void;
  /** Asks the canvas to show the chat's page and fit these frames. */
  focus(request: { chatId: string; pageId: string; frameIds: string[]; focusId?: number }): void;
  newId(): string;
}): (chat: EnteringChat, workspaceRoot: string) => Promise<void> {
  return (chat, workspaceRoot) =>
    deps.pending.track(
      chat.id,
      (async () => {
        const { frameIds, pageId, focusId } = await placeWrittenPagesOnCanvas({
          chatId: chat.id,
          workspaceRoot,
          // A reply still running has not saved its activity yet; its pages come from this run's record.
          paths: deps.recent.merged(chat.id, pagesWrittenInChat(chat.messages)),
          limit: EARLIER_PAGES_LIMIT,
          shouldSave: () => deps.designModeOn(chat.id),
          store: deps.store,
          pages: designTurnPages({ views: deps.views, chatId: chat.id }),
          broadcast: deps.broadcast,
          newId: deps.newId,
          entry: {
            pageName: chat.title,
            otherViews: (workspaceId) => deps.views.pageIdsOf(workspaceId, chat.id),
            isLive: deps.isLive,
          },
        });
        // The canvas shows that page and fits the pages once it loads, so the person sees them whole.
        if (pageId && (frameIds.length > 0 || focusId !== undefined)) {
          deps.focus({ chatId: chat.id, pageId, frameIds, ...(focusId !== undefined ? { focusId } : {}) });
        }
        // The title may have changed while entry ran; a page made for the chat follows it.
        await deps.titleFollow.follow(chat.id);
      })(),
    );
}
