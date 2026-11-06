// What every design node reads from its canvas. Node data stays `{ frame }`,
// so React Flow only re-renders a node when its own frame changes; the rest
// (grant, live set, versions) arrives through this context.

import * as React from "react";
import type { DesignPoint } from "../../shared/design-canvas/connectors";
import type { DesignExportFormat } from "../../shared/design-canvas/frame-export";
import type { DesignFrame } from "../../shared/design-canvas/schema";

/** Height of a frame's title bar; a page frame's content box is the rest. */
export const DESIGN_FRAME_HEADER_PX = 36;
/** A page frame drawn without a design width is laid out at this width. */
export const DESIGN_DEFAULT_WIDTH = 1280;

/** The fields one edit can change; a key set to undefined is taken off. */
export type DesignFramePatch = Partial<
  Pick<
    DesignFrame,
    | "text"
    | "title"
    | "w"
    | "h"
    | "size"
    | "color"
    | "fill"
    | "paper"
    | "printMode"
    | "designWidth"
    | "strokeWidth"
    | "radius"
    | "guide"
    | "hidden"
    | "locked"
  >
>;

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
  /** Edits one frame; a key set to undefined is taken off. `record` adds an undo step. */
  update(id: string, patch: DesignFramePatch, options: { record: boolean }): void;
  /** Shows one frame alone, filling the window, until the person closes it. */
  openFullWindow(id: string): void;
  /** Saves a frame as a PNG, a PDF or its original file, through the save dialog. */
  download(id: string, format: DesignExportFormat): void;
  /** Opens a new comment on a frame, as the Comment tool would. */
  comment(id: string): void;
  /** Puts one end of an arrow or line at `point`, on the frame there if there is one. */
  moveEnd(id: string, index: 0 | 1, point: DesignPoint): void;
  /** The text item or shape whose words are being edited. */
  editing: string | null;
  /** Starts editing a text item's or shape's words, or stops (null). */
  edit(id: string | null): void;
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
