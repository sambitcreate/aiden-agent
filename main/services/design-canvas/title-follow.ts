// A page made for a chat (`namedFor`) takes the chat's title whenever it
// changes. Each run reads the title itself when it starts, and a chat's runs
// go one after another, so the newest title always wins however the renames
// and design-mode entry interleave.

import { followChatTitle } from "../../../renderer/shared/design-canvas/chat-pages.js";
import type { DesignCanvasUpdated, DesignChatCanvases } from "./store.js";

export interface DesignTitleFollow {
  /** Renames the pages made for the chat to its current title. Never throws. */
  follow(chatId: string): Promise<void>;
}

const NOTHING_TO_RENAME = Symbol("nothing to rename");

export function createDesignTitleFollow(deps: {
  canvases: Pick<DesignChatCanvases, "update">;
  /** The chat's title now, or undefined when the chat is gone. */
  titleOf(chatId: string): Promise<string | undefined>;
  broadcast(update: DesignCanvasUpdated): void;
  onError?(error: unknown): void;
}): DesignTitleFollow {
  const runs = new Map<string, { running: Promise<void>; next?: Promise<void> }>();

  async function run(chatId: string): Promise<void> {
    try {
      const title = await deps.titleOf(chatId);
      if (title === undefined) return;
      // Through the chat's canvases, so a removed workspace is not written back.
      const { doc, workspaceId } = await deps.canvases.update(chatId, (current) => {
        const next = followChatTitle(current, chatId, title);
        if (next === current) throw NOTHING_TO_RENAME;
        return next;
      });
      deps.broadcast({ workspaceId, chatId, revision: doc.revision });
    } catch (error) {
      if (error !== NOTHING_TO_RENAME) deps.onError?.(error);
    }
  }

  function settle(chatId: string, done: Promise<void>): void {
    const entry = runs.get(chatId);
    if (entry?.running === done && !entry.next) runs.delete(chatId);
  }

  return {
    follow(chatId) {
      const entry = runs.get(chatId);
      if (!entry) {
        const running: Promise<void> = run(chatId).finally(() => settle(chatId, running));
        runs.set(chatId, { running });
        return running;
      }
      // Calls behind a running one share the next run, which reads the newest title.
      if (entry.next) return entry.next;
      const next: Promise<void> = entry.running
        .then(() => {
          entry.running = next;
          entry.next = undefined;
          return run(chatId);
        })
        .finally(() => settle(chatId, next));
      entry.next = next;
      return next;
    },
  };
}
