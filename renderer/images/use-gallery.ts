import * as React from "react";
import { createImagesIpc } from "../lib/create-images-ipc";
import type { GalleryItem } from "../shared/images/ipc-types";
import type { RunState } from "../shared/images/run-types";
import { galleryRefreshKey } from "./gallery-core";

/** Most recent runs whose state the History tab names; older runs show their images without it. */
const RUN_STATE_LIMIT = 50;

export interface GalleryState {
  status: "loading" | "ready" | "error";
  items: readonly GalleryItem[];
  saveFolderLabel: string;
  /** Each recent run's state, for one workflow's history. Empty for the cross-workflow library. */
  runStates: ReadonlyMap<string, RunState>;
  error: string | null;
}

const INITIAL: GalleryState = { status: "loading", items: [], saveFolderLabel: "", runStates: new Map(), error: null };

/**
 * One workflow's generated images (every workflow's when `workflowId` is absent), newest
 * first, re-read whenever a run reaches a terminal state. The last good list stays on screen
 * while a re-read is in flight or fails.
 */
export function useGallery(workflowId?: string) {
  const [state, setState] = React.useState<GalleryState>(INITIAL);
  const sequence = React.useRef(0);

  const load = React.useCallback(async () => {
    // Back-to-back refreshes can resolve out of order; only the newest read is applied.
    const current = ++sequence.current;
    try {
      const [gallery, runs] = await Promise.all([
        createImagesIpc.gallery(workflowId === undefined ? {} : { workflowId }),
        workflowId === undefined
          ? Promise.resolve(null)
          : createImagesIpc.listRuns(workflowId, RUN_STATE_LIMIT).catch(() => null),
      ]);
      if (current !== sequence.current) return;
      setState((previous) => ({
        status: "ready",
        items: gallery.items,
        saveFolderLabel: gallery.saveFolderLabel,
        runStates: runs ? new Map(runs.runs.map((run) => [run.runId, run.state])) : previous.runStates,
        error: null,
      }));
    } catch (failure) {
      if (current !== sequence.current) return;
      const error = failure instanceof Error && failure.message ? failure.message : "Aiden couldn't read your images.";
      setState((previous) => ({ ...previous, status: previous.status === "ready" ? "ready" : "error", error }));
    }
  }, [workflowId]);

  React.useEffect(() => {
    setState(INITIAL);
    const seen = new Set<string>();
    // Subscribe first, then read: a run that ends between the two is not missed.
    const unsubscribe = createImagesIpc.onRunChanged((snapshot) => {
      const key = galleryRefreshKey(snapshot, workflowId);
      if (key === null || seen.has(key)) return;
      seen.add(key);
      void load();
    });
    void load();
    return () => {
      unsubscribe();
      // A read still in flight belongs to the previous workflow.
      sequence.current += 1;
    };
  }, [workflowId, load]);

  const refresh = React.useCallback(() => void load(), [load]);
  return { ...state, refresh };
}

export type GalleryController = ReturnType<typeof useGallery>;
