// Each chat's view of its workspace canvas, as main knows it: the page the
// chat looks at, where, and whether its canvas is open. Aiden's canvas tools
// read the page on screen from here, since the shared document holds no view.
//
// The renderer reports the view as the person pans, zooms and switches pages
// (`designCanvas:view`), and `null` when the canvas unmounts. Main keeps the
// last page after an unmount, so a placement for that chat in the background
// still lands where the person last looked, and the canvas reads it back when
// it mounts again (`designCanvas:view:get`).
//
// When Aiden shows a page, it counts at once: main sets the page here and
// gives the change a new `focusId`, which `designCanvas:focus` carries to the
// canvas. Every view report echoes the last `focusId` its canvas applied, and
// a report older than main's is dropped, so a pan reported just before the
// focus arrived cannot take Aiden's page back. Memory only.
//
// Keyed by chat alone: design mode lives in the one main window.

import { DESIGN_FRESH_VIEWPORT, type DesignChatView } from "../../../renderer/shared/design-canvas/view.js";

type Entry = {
  workspaceId: string;
  view: DesignChatView;
  mounted: boolean;
  /** The latest Aiden page change for this chat; 0 before any. */
  focusId: number;
};

export class DesignCanvasViews {
  private readonly entries = new Map<string, Entry>();

  /**
   * A canvas's report: its view, or `null` when it unmounted. `focusId` is the
   * last Aiden page change that canvas applied; a report behind main's is not
   * taken as the view, though it still says the canvas is open.
   */
  set(chatId: string, workspaceId: string | null, view: DesignChatView | null, focusId = 0): void {
    const entry = this.entries.get(chatId);
    if (view === null) {
      if (entry) entry.mounted = false;
      return;
    }
    if (workspaceId === null) return;
    if (entry && focusId < entry.focusId) {
      entry.mounted = true;
      entry.workspaceId = workspaceId;
      return;
    }
    this.entries.set(chatId, { workspaceId, view: copyView(view), mounted: true, focusId: entry?.focusId ?? 0 });
  }

  /**
   * Aiden shows `pageId` to the chat: from now on its tools read that page,
   * whether or not a canvas is open. A page other than the current one is
   * looked at from the fresh viewport. Returns the change's `focusId`.
   */
  showPage(chatId: string, workspaceId: string, pageId: string): number {
    const entry = this.entries.get(chatId);
    const focusId = (entry?.focusId ?? 0) + 1;
    const before = entry?.view;
    const view: DesignChatView = {
      pageId,
      viewport: { ...(before && before.pageId === pageId ? before.viewport : DESIGN_FRESH_VIEWPORT) },
      ...(before?.size ? { size: { ...before.size } } : {}),
    };
    this.entries.set(chatId, { workspaceId, view, mounted: entry?.mounted ?? false, focusId });
    return focusId;
  }

  /** The chat's view: the open canvas's, or the last one kept. */
  get(chatId: string): DesignChatView | undefined {
    const entry = this.entries.get(chatId);
    return entry ? copyView(entry.view) : undefined;
  }

  /** The kept view and the latest `focusId`, for a canvas that is mounting. */
  kept(chatId: string): { view: DesignChatView; focusId: number } | undefined {
    const entry = this.entries.get(chatId);
    return entry ? { view: copyView(entry.view), focusId: entry.focusId } : undefined;
  }

  /** How many chats have this workspace's canvas open. */
  mounted(workspaceId: string): number {
    let count = 0;
    for (const entry of this.entries.values()) if (entry.mounted && entry.workspaceId === workspaceId) count += 1;
    return count;
  }

  /** The window went away: no canvas is open, and every page is kept. */
  unmountAll(): void {
    for (const entry of this.entries.values()) entry.mounted = false;
  }

  /** The chat was deleted. */
  forget(chatId: string): void {
    this.entries.delete(chatId);
  }
}

function copyView(view: DesignChatView): DesignChatView {
  return { pageId: view.pageId, viewport: { ...view.viewport }, ...(view.size ? { size: { ...view.size } } : {}) };
}
