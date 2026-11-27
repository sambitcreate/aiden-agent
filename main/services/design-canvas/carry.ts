// A No workspace chat attached to a project workspace brings its canvas
// along when its files come too. Its pages are appended to the project's
// canvas, named after the chat, and file and image frames follow the paths
// their files were copied to (`appendCanvasPages`). The hidden canvas is only
// read: it goes with the hidden workspace, and its own claims and `namedFor`
// marks never come over. The attaching chat claims the first page it brought
// (in the same write); at a full `chatPages` only that claim is skipped.

import { ChatPagesFullError, claimPage, type IsChatLive } from "../../../renderer/shared/design-canvas/chat-pages.js";
import { appendCanvasPages } from "../../../renderer/shared/design-canvas/pages.js";
import { DESIGN_CANVAS_LIMITS } from "../../../renderer/shared/design-canvas/schema.js";
import type { DesignCanvasStore, DesignCanvasUpdated } from "./store.js";
import type { DesignCanvasViews } from "./views.js";

/** `carried`: pages came over; `nothing`: nothing to bring; `too-large`: over a limit, so nothing came over. */
export type DesignCanvasCarryOutcome = "carried" | "nothing" | "too-large";

export interface DesignCanvasCarry {
  carry(input: {
    chatId: string;
    /** Names the pages that come over: "<label> · <page name>". */
    label: string;
    fromWorkspaceId: string;
    toWorkspaceId: string;
    /** Each copied file's path in the hidden folder and in the project. */
    copied: ReadonlyArray<{ from: string; to: string }>;
  }): Promise<DesignCanvasCarryOutcome>;
}

const STOP = Symbol("stop");

export function createDesignCanvasCarry(deps: {
  store: Pick<DesignCanvasStore, "get" | "update">;
  views: Pick<DesignCanvasViews, "showPage">;
  broadcast?(update: DesignCanvasUpdated): void;
  newId(): string;
  /**
   * Which claimed chats are live in the target workspace. Asked only when its
   * `chatPages` is full, so a gone chat's entry makes room for the claim.
   */
  isLive?(chatIds: string[], workspaceId: string): Promise<Set<string>>;
}): DesignCanvasCarry {
  return {
    async carry(input) {
      const source = await deps.store.get(input.fromWorkspaceId);
      if (source.frames.length === 0) return "nothing";
      const pathMap = new Map(input.copied.map((pair) => [pair.from, pair.to]));
      let outcome: DesignCanvasCarryOutcome = "nothing";
      let firstPage: string | undefined;
      let isLive: IsChatLive | undefined;
      if (deps.isLive) {
        const target = await deps.store.get(input.toWorkspaceId);
        const claimed = Object.keys(target.chatPages).filter((chatId) => chatId !== input.chatId);
        if (claimed.length >= DESIGN_CANVAS_LIMITS.chatPages) {
          const checked = new Set(claimed);
          const live = await deps.isLive(claimed, input.toWorkspaceId);
          // A claim made after this check is a live chat's.
          isLive = (chatId) => !checked.has(chatId) || live.has(chatId);
        }
      }
      try {
        const doc = await deps.store.update(input.toWorkspaceId, (target) => {
          const merged = appendCanvasPages(target, source, { label: input.label, pathMap, newId: deps.newId });
          if (merged === null) {
            outcome = "too-large";
            throw STOP;
          }
          if (merged.pageIds.length === 0) throw STOP;
          outcome = "carried";
          firstPage = merged.pageIds[0]!;
          try {
            return claimPage(merged.doc, input.chatId, firstPage, isLive);
          } catch (error) {
            if (error instanceof ChatPagesFullError) return merged.doc;
            throw error;
          }
        });
        deps.broadcast?.({ workspaceId: input.toWorkspaceId, chatId: input.chatId, revision: doc.revision });
      } catch (error) {
        if (error !== STOP) throw error;
      }
      if (firstPage !== undefined) await deps.views.showPage(input.chatId, input.toWorkspaceId, firstPage);
      return outcome;
    },
  };
}
