// Keeps a design canvas frame on the workspace page it was given. A workspace page
// runs its own scripts, and a sandboxed frame may still navigate itself. The
// window's own policy already refuses the web, but it lets a frame show other
// aiden-design: grants, generated UI pages and the app's own pages; a page there
// would keep the frame's window and could post the messages a workspace page sends.
//
// So once a frame of the app's window has been sent to an aiden-design: page, it may
// only go to another page on that same aiden-design: host (a newer version of the
// file, a link between workspace pages). The canvas gives a frame shown through a
// different host a new iframe, so that never needs a frame to change host.

import { DESIGN_SCHEME } from "../../../renderer/shared/design-canvas/url.js";

/** The parts of Electron's WebFrameMain the guard reads. */
export type GuardedFrame = {
  readonly frameTreeNodeId: number;
  readonly url: string;
};

export type FrameNavigation = {
  url: string;
  isMainFrame: boolean;
  frame: GuardedFrame | null;
};

const PREFIX = `${DESIGN_SCHEME}:`;

function designHost(url: string): string | null {
  if (!url.toLowerCase().startsWith(PREFIX)) return null;
  try {
    return new URL(url).host.toLowerCase();
  } catch {
    return null;
  }
}

function safeUrl(frame: GuardedFrame): string {
  try {
    return frame.url;
  } catch {
    return "";
  }
}

export function createDesignFrameNavigationGuard(): {
  allows(navigation: FrameNavigation): boolean;
  /** The window's own document changed, and with it every frame. */
  reset(): void;
} {
  /** Frames that have shown a design page, by Chromium's frame tree node id. */
  const designFrames = new Set<number>();
  return {
    allows({ url, isMainFrame, frame }) {
      if (isMainFrame || !frame) return true;
      const target = designHost(url);
      const current = designHost(safeUrl(frame));
      if (current === null && !designFrames.has(frame.frameTreeNodeId)) {
        if (target !== null) designFrames.add(frame.frameTreeNodeId);
        return true;
      }
      if (target === null) return false;
      // Still on its way to its first page: nothing of the workspace runs in it yet.
      if (current === null) return true;
      return target === current;
    },
    reset() {
      designFrames.clear();
    },
  };
}
