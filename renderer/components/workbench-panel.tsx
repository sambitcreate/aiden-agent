import * as React from "react";
import { storedWorkbenchWidth } from "../lib/environment-panel-layout";

export interface WorkbenchWidthState {
  /** The person's preferred width; the rendered width is resolved against the container. */
  preferredWidth: number;
  /** Live updates while dragging. Not persisted. */
  setPreferredWidth: (width: number) => void;
  /** Sets and persists an already-clamped width. */
  commitPreferredWidth: (width: number) => void;
  resizing: boolean;
  setResizing: (resizing: boolean) => void;
}

/** Preferred width and drag state for a workbench, persisted under `storageKey`. */
export function useWorkbenchWidth(storageKey: string): WorkbenchWidthState {
  const [preferredWidth, setPreferredWidth] = React.useState(() =>
    storedWorkbenchWidth(localStorage.getItem(storageKey)),
  );
  const [resizing, setResizing] = React.useState(false);
  const commitPreferredWidth = React.useCallback(
    (width: number) => {
      setPreferredWidth(width);
      localStorage.setItem(storageKey, String(Math.round(width)));
    },
    [storageKey],
  );
  return { preferredWidth, setPreferredWidth, commitPreferredWidth, resizing, setResizing };
}
