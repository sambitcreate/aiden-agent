// Design canvas cleanup when a chat or a workspace goes.
//
// A deleted chat's comments and its view leave its workspace's canvas before
// the delete commits. Its artifact frames (the images and visuals it sent),
// its page claim and its pages' `namedFor` marks go after the delete commits,
// so a delete that fails keeps them. The canvas is the workspace's and stays,
// and so do the chat's pages, notes and other frames: they are the
// workspace's work now. A chat moving to another workspace leaves the same
// way, and an empty page made for it goes too. A removed workspace takes its
// canvas file, the copies set aside as corrupt, and every chat's view of it.

import { persistedChatWorkspaceId } from "../../../renderer/shared/chat-workspace.js";
import { forgetChatMove, forgetChatOnCanvas } from "../../../renderer/shared/design-canvas/chat-pages.js";
import type { DesignCanvas } from "../../../renderer/shared/design-canvas/schema.js";
import type { DesignCanvasStore, DesignCanvasUpdated } from "./store.js";
import type { DesignCanvasViews } from "./views.js";

/**
 * What a chat cleanup takes off the canvas:
 * - `comments`: the chat's comments, before a delete commits;
 * - `all`: also its claim, `namedFor` marks and artifact frames, after it commits;
 * - `move`: `all`, plus an empty page made for the chat, for a chat moving away.
 */
export type DesignChatCleanupScope = "comments" | "all" | "move";

export interface DesignChatCleanup {
  /**
   * Takes `chatId` off `workspaceId`'s canvas by `scope`, and drops its view
   * of it. The workspace is the one the chat was in before the delete, read
   * before it. Safe to run twice: chat delete runs `comments` before the
   * delete commits and `all` after, so a save that landed in between does not
   * bring anything back. Writes nothing when nothing changes.
   */
  forgetChat(chatId: string, workspaceId: string, scope: DesignChatCleanupScope): Promise<void>;
}

const NOTHING_TO_DROP = Symbol("nothing to drop");

function withoutChatComments(doc: DesignCanvas, chatId: string): DesignCanvas {
  if (!doc.comments.some((comment) => comment.chatId === chatId)) return doc;
  return { ...doc, comments: doc.comments.filter((comment) => comment.chatId !== chatId) };
}

export function createDesignChatCleanup(deps: {
  store: Pick<DesignCanvasStore, "update">;
  views: Pick<DesignCanvasViews, "forget">;
  /** Tells open canvases what went; the deleted chat is named as the one acting. */
  broadcast?(update: DesignCanvasUpdated): void;
}): DesignChatCleanup {
  return {
    async forgetChat(chatId, workspaceId, scope) {
      try {
        const doc = await deps.store.update(workspaceId, (current) => {
          let next = withoutChatComments(current, chatId);
          if (scope === "all") next = forgetChatOnCanvas(next, chatId);
          if (scope === "move") next = forgetChatMove(next, chatId);
          // A canvas without anything of the chat's (or no canvas at all) is not written.
          if (next === current) throw NOTHING_TO_DROP;
          return next;
        });
        deps.broadcast?.({ workspaceId, chatId, revision: doc.revision });
      } catch (error) {
        if (error !== NOTHING_TO_DROP) throw error;
      }
      await deps.views.forget(chatId, workspaceId);
    },
  };
}

/**
 * A chat delete rolled forward at startup: the same two canvas passes as the
 * live delete around `remove`. The chat's workspace is read before the
 * remove. When its metadata is already gone (the crash came after the remove
 * committed), no record names its workspace: the pending-deletion marker
 * belongs to the subagent run stores, whose strict format older builds must
 * still read, so it cannot carry one. Every canvas is checked instead, and
 * `all` runs on each, writing only those that hold something of the chat's.
 * A failed pass before the remove throws, so the delete stays pending; one
 * after it is reported to `onError`.
 */
export async function recoverDeletedChatCanvas(
  deps: {
    getMeta(chatId: string): Promise<{ workspaceId?: string } | null>;
    remove(chatId: string): Promise<void>;
    cleanup: Pick<DesignChatCleanup, "forgetChat">;
    /** The workspaces with a canvas file (`DesignCanvasStore.workspaceIds`). */
    workspaceIds(): Promise<string[]>;
    onError(error: unknown): void;
  },
  chatId: string,
): Promise<void> {
  const meta = await deps.getMeta(chatId);
  const workspaceId = meta ? persistedChatWorkspaceId(meta.workspaceId) : undefined;
  if (workspaceId !== undefined) await deps.cleanup.forgetChat(chatId, workspaceId, "comments");
  await deps.remove(chatId);
  try {
    const workspaceIds = workspaceId !== undefined ? [workspaceId] : await deps.workspaceIds();
    for (const id of workspaceIds) {
      await deps.cleanup.forgetChat(chatId, id, "all").catch(deps.onError);
    }
  } catch (error) {
    deps.onError(error);
  }
}

export interface DesignWorkspaceCleanup {
  /** Deletes the workspace's canvas, its corrupt copies and its views file. Run once its record is gone. */
  removeWorkspace(workspaceId: string): Promise<void>;
}

export function createDesignWorkspaceCleanup(deps: {
  store: Pick<DesignCanvasStore, "delete">;
  views: Pick<DesignCanvasViews, "removeWorkspace">;
  /** Design mode's live apps: stops the workspace's dev servers and forgets their records. */
  apps?: { forgetWorkspace(workspaceId: string): Promise<void> };
}): DesignWorkspaceCleanup {
  return {
    async removeWorkspace(workspaceId) {
      // The servers stop while the canvas goes; a failure to stop one never keeps the canvas.
      const forgotten = deps.apps ? deps.apps.forgetWorkspace(workspaceId).then(() => undefined, (error: unknown) => error) : undefined;
      await deps.views.removeWorkspace(workspaceId);
      await deps.store.delete(workspaceId);
      const failure = await forgotten;
      if (failure !== undefined) throw failure;
    },
  };
}
