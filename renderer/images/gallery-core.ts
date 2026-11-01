// Electron-free logic behind the gallery hook, the History tab and the Output node's viewer:
// grouping by run, relative times, when to re-read, and matching node outputs to gallery items.
import type { GalleryItem } from "../shared/images/ipc-types";
import type { AttemptSnapshot, OutputRef, RunSnapshot, RunState } from "../shared/images/run-types";
import { ownValue } from "./run-view-core";

export interface GalleryRunGroup {
  runId: string;
  /** When the run's newest image finished. */
  createdAt: number;
  /** The run's images, each with its position in the whole gallery (the viewer's index). */
  entries: { item: GalleryItem; index: number }[];
}

/** Groups a newest-first gallery by run, keeping that order for runs and for images. */
export function groupGalleryByRun(items: readonly GalleryItem[]): GalleryRunGroup[] {
  const groups = new Map<string, GalleryRunGroup>();
  items.forEach((item, index) => {
    const group = groups.get(item.runId);
    if (group) {
      group.entries.push({ item, index });
      group.createdAt = Math.max(group.createdAt, item.createdAt);
    } else {
      groups.set(item.runId, { runId: item.runId, createdAt: item.createdAt, entries: [{ item, index }] });
    }
  });
  return [...groups.values()];
}

const RUN_STATE_LABELS: Record<RunState, string> = {
  running: "Running",
  succeeded: "Finished",
  partial: "Finished with errors",
  failed: "Failed",
  cancelled: "Stopped",
  interrupted: "Interrupted",
};

export function runStateLabel(state: RunState): string {
  return RUN_STATE_LABELS[state];
}

export function imageCountLabel(count: number): string {
  return `${count} image${count === 1 ? "" : "s"}`;
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** "Just now", "5 min ago", "3 h ago", "Yesterday", then the date. */
export function relativeTime(timestamp: number, now: number, formatDate: (timestamp: number) => string): string {
  const elapsed = Math.max(0, now - timestamp);
  if (elapsed < MINUTE) return "Just now";
  if (elapsed < HOUR) return `${Math.floor(elapsed / MINUTE)} min ago`;
  if (elapsed < DAY) return `${Math.floor(elapsed / HOUR)} h ago`;
  if (elapsed < 2 * DAY) return "Yesterday";
  return formatDate(timestamp);
}

const TERMINAL = new Set<RunState>(["succeeded", "partial", "failed", "cancelled", "interrupted"]);

/**
 * A key for a run-changed notification that should re-read the gallery: a run of this
 * workflow (any workflow when none is given) reaching a terminal state. A run is re-read
 * once per terminal state, however many times its final snapshot is broadcast.
 */
export function galleryRefreshKey(snapshot: RunSnapshot, workflowId: string | undefined): string | null {
  if (workflowId !== undefined && snapshot.run.workflowId !== workflowId) return null;
  if (!TERMINAL.has(snapshot.run.state)) return null;
  return `${snapshot.run.runId}:${snapshot.run.state}`;
}

/**
 * The viewer's items for an Output node's images: the gallery's record of each image, or,
 * for one the gallery has not listed yet (a run still going), what the run's attempt says.
 */
export function viewerItemsForOutputs(
  images: readonly OutputRef[],
  context: {
    gallery: readonly GalleryItem[];
    workflowId: string;
    nodeId: string;
    assetUrls: Readonly<Record<string, string>>;
    attempts: readonly AttemptSnapshot[];
    runId?: string;
  },
): GalleryItem[] {
  const known = new Map(context.gallery.map((item) => [item.assetId, item]));
  return images.map((image, index) => {
    const listed = known.get(image.assetId);
    if (listed) return listed;
    const attempt = context.attempts.find((candidate) => candidate.output.some((output) => output.assetId === image.assetId));
    return {
      ...image,
      runId: context.runId ?? "",
      workflowId: context.workflowId,
      nodeId: context.nodeId,
      variant: attempt?.variant ?? 0,
      index,
      provider: attempt?.provider ?? "",
      model: attempt?.model ?? "",
      ...(attempt?.prompt ? { prompt: attempt.prompt } : {}),
      createdAt: attempt?.finishedAt ?? 0,
      saved: false,
      thumbUrl: ownValue(context.assetUrls, image.assetId) ?? "",
    };
  });
}
