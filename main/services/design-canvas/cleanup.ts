// Design canvas cleanup when a chat or a workspace goes.
//
// A deleted chat's comments and its view leave its workspace's canvas. The
// canvas itself is the workspace's and stays, and so do the chat's frames:
// they are the workspace's work now. A removed workspace takes its canvas
// file, the copies set aside as corrupt, and every chat's view of it.

import type { DesignCanvasStore, DesignCanvasUpdated } from "./store.js";
import type { DesignCanvasViews } from "./views.js";

export interface DesignChatCleanup {
  /**
   * Drops `chatId`'s comments from `workspaceId`'s canvas and its view of it.
   * The workspace is the one the chat was in before the delete, read before it.
   * Safe to run twice: chat delete runs it before and after the delete commits,
   * so a save that landed in between does not bring the comments back.
   */
  forgetChat(chatId: string, workspaceId: string): Promise<void>;
}

const NOTHING_TO_DROP = Symbol("nothing to drop");

export function createDesignChatCleanup(deps: {
  store: Pick<DesignCanvasStore, "update">;
  views: Pick<DesignCanvasViews, "forget">;
  /** Tells open canvases the comments went; the deleted chat is named as the one acting. */
  broadcast?(update: DesignCanvasUpdated): void;
}): DesignChatCleanup {
  return {
    async forgetChat(chatId, workspaceId) {
      try {
        const doc = await deps.store.update(workspaceId, (current) => {
          // A canvas without the chat's comments (or no canvas at all) is not written.
          if (!current.comments.some((comment) => comment.chatId === chatId)) throw NOTHING_TO_DROP;
          return { ...current, comments: current.comments.filter((comment) => comment.chatId !== chatId) };
        });
        deps.broadcast?.({ workspaceId, chatId, revision: doc.revision });
      } catch (error) {
        if (error !== NOTHING_TO_DROP) throw error;
      }
      await deps.views.forget(chatId, workspaceId);
    },
  };
}

export interface DesignWorkspaceCleanup {
  /** Deletes the workspace's canvas, its corrupt copies and its views file. Run once its record is gone. */
  removeWorkspace(workspaceId: string): Promise<void>;
}

export function createDesignWorkspaceCleanup(deps: {
  store: Pick<DesignCanvasStore, "delete">;
  views: Pick<DesignCanvasViews, "removeWorkspace">;
}): DesignWorkspaceCleanup {
  return {
    async removeWorkspace(workspaceId) {
      await deps.views.removeWorkspace(workspaceId);
      await deps.store.delete(workspaceId);
    },
  };
}
