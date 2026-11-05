// What every design node reads from its canvas. Node data stays `{ frame }`,
// so React Flow only re-renders a node when its own frame changes; the rest
// (grant, live set, versions) arrives through this context.

import * as React from "react";
import type { DesignFrame } from "../../shared/design-canvas/schema";

/** Height of a frame's title bar; a page frame's content box is the rest. */
export const DESIGN_FRAME_HEADER_PX = 36;
/** A page frame drawn without a design width is laid out at this width. */
export const DESIGN_DEFAULT_WIDTH = 1280;

export type DesignNodeContextValue = {
  chatId: string;
  /** The chat's aiden-design grant, or null while it loads or when the chat cannot frame files. */
  grant: string | null;
  live: ReadonlySet<string>;
  entered: string | null;
  /** How many times the file at this workspace path changed since the canvas opened. */
  versionOf(path: string | undefined): number;
  /** The frame to focus once it mounts (a note the person just added). */
  autoFocusId: string | null;
  enter(id: string): void;
  markMissing(id: string, version: number): void;
  remove(id: string): void;
  /** Edits one frame. `record` adds an undo step. */
  update(id: string, patch: Partial<Pick<DesignFrame, "text" | "title">>, options: { record: boolean }): void;
  /** The frame took the focus it was asked to; it is not focused again on a later mount. */
  autoFocusDone(id: string): void;
  /** The frame whose title is being edited. */
  renaming: string | null;
  /** Starts editing a frame's title, or stops (null). */
  rename(id: string | null): void;
};

export const DesignNodeContext = React.createContext<DesignNodeContextValue | null>(null);

export function useDesignNodeContext(): DesignNodeContextValue {
  const value = React.useContext(DesignNodeContext);
  if (!value) throw new Error("Design nodes render inside the design canvas.");
  return value;
}

/** `aiden-design` addresses carry the file's version so a changed file reloads in place. */
export function withVersion(url: string, version: number): string {
  return version > 0 ? `${url}?v=${version}` : url;
}
