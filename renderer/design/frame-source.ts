// A page's file or an artifact's HTML as the side panel and the Tweaks panel
// read it: asked of main again after each change on disk.

import * as React from "react";
import type { DesignFrame } from "../shared/design-canvas/schema";

/** `designCanvas:source`'s answer. */
export type DesignFrameSourceResult =
  | { text: string; truncated: boolean }
  /** `unsaved`: the canvas couldn't be saved, so main's copy of the frame is older than the screen. */
  | { error: "unavailable" | "missing" | "unsaved" };

/** Reads a page's file or an artifact's HTML; the canvas saves first, since main reads the stored frame. */
export type DesignReadSource = (frameId: string) => Promise<DesignFrameSourceResult>;

export type DesignLoadedSource = { key: string; text: string; truncated: boolean } | { key: string; error: string };

const SOURCE_ERRORS = {
  missing: "This file is missing.",
  unavailable: "The code isn't available here.",
  unsaved: "The canvas couldn't be saved, so the code can't be shown yet.",
} as const;

/**
 * A frame's source, read again after each change on disk; null while the
 * first read loads. While a changed file is read again, the last read stays,
 * so the panels don't blink away (and lose keyboard focus) on every save.
 */
export function useFrameSource(
  readSource: DesignReadSource,
  frame: DesignFrame | null,
  versionOf: (path: string | undefined) => number,
): DesignLoadedSource | null {
  const identity = frame ? `${frame.id}:${frame.mediaId ?? frame.path}` : null;
  const key = frame ? `${identity}:${versionOf(frame.path)}` : null;
  const [loaded, setLoaded] = React.useState<DesignLoadedSource | null>(null);
  React.useEffect(() => {
    if (!frame || !key) return;
    let cancelled = false;
    void readSource(frame.id).then(
      (answer) => {
        if (cancelled) return;
        if ("text" in answer) setLoaded({ key, text: answer.text, truncated: answer.truncated });
        else setLoaded({ key, error: SOURCE_ERRORS[answer.error] });
      },
      () => !cancelled && setLoaded({ key, error: "The code couldn't be read." }),
    );
    return () => {
      cancelled = true;
    };
    // The key changes with the frame, its file and each change on disk.
  }, [readSource, key]);
  return loaded && identity !== null && loaded.key.slice(0, loaded.key.lastIndexOf(":")) === identity ? loaded : null;
}
