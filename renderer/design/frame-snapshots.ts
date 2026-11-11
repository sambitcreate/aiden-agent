// Pictures of design frames that are not live. A file or artifact frame that
// leaves the live set is captured first, so it keeps showing what it showed
// instead of flashing a skeleton. Kept for this app run only.

import * as React from "react";
import { designCanvasApi } from "../lib/ipc";

/** The most snapshots kept at once; the least recently used goes first. */
export const DESIGN_SNAPSHOT_LIMIT = 60;

type Rect = { x: number; y: number; width: number; height: number };

export class FrameSnapshotCache {
  // A Map iterates in insertion order, so the first key is the least recently used.
  private readonly entries = new Map<string, { version: number; dataUrl: string }>();
  /**
   * Per frame, how many times its picture was kept or forgotten. A capture
   * that started before the latest of those is older than what it would replace.
   */
  private readonly changes = new Map<string, number>();
  private readonly listeners = new Set<() => void>();

  constructor(private readonly limit = DESIGN_SNAPSHOT_LIMIT) {}

  /** The frame's picture for this version of its file, if one was taken. */
  get(frameId: string, version: number): string | undefined {
    const entry = this.entries.get(frameId);
    if (!entry || entry.version !== version) return undefined;
    this.entries.delete(frameId);
    this.entries.set(frameId, entry);
    return entry.dataUrl;
  }

  /** Taken when a capture starts and handed back to `set`. */
  stamp(frameId: string): number {
    return this.changes.get(frameId) ?? 0;
  }

  /**
   * Keeps the frame's picture for `version`. False, and nothing kept, when
   * `stamp` is from before the frame's picture was last kept or forgotten:
   * the page may have changed since the capture started.
   */
  set(frameId: string, version: number, dataUrl: string, stamp?: number): boolean {
    if (stamp !== undefined && stamp !== this.stamp(frameId)) return false;
    this.changes.set(frameId, this.stamp(frameId) + 1);
    this.entries.delete(frameId);
    this.entries.set(frameId, { version, dataUrl });
    while (this.entries.size > this.limit) {
      const oldest = this.entries.keys().next().value as string;
      this.entries.delete(oldest);
    }
    for (const listener of this.listeners) listener();
    return true;
  }

  /** Drops the frame's picture, and any capture still on its way: what it showed is no longer what its page shows. */
  forget(frameId: string): void {
    this.changes.set(frameId, this.stamp(frameId) + 1);
    if (!this.entries.delete(frameId)) return;
    for (const listener of this.listeners) listener();
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}

export const designFrameSnapshots = new FrameSnapshotCache();

/**
 * Captures `rect` of this window and keeps it as the frame's picture for
 * `version`, unless the frame's picture was forgotten, or another kept,
 * while the capture ran.
 */
export async function captureFrameSnapshot(
  cache: FrameSnapshotCache,
  frameId: string,
  version: number,
  rect: Rect,
): Promise<string | undefined> {
  const stamp = cache.stamp(frameId);
  try {
    const result = await designCanvasApi.captureDesignFrame({
      x: rect.x,
      y: rect.y,
      width: rect.width,
      height: rect.height,
    });
    if (!("dataUrl" in result)) return undefined;
    // The page changed under a capture that took a while: its picture is of before.
    if (!cache.set(frameId, version, result.dataUrl, stamp)) return undefined;
    return result.dataUrl;
  } catch {
    // The frame keeps the picture it had, or its skeleton.
    return undefined;
  }
}

/**
 * The frame's snapshot for `version` of its file, and `capture` to take a new
 * one of the frame's on-screen rectangle (from `getBoundingClientRect`).
 */
export function useFrameSnapshot(
  frameId: string,
  version = 0,
): { snapshot: string | undefined; capture(rect: DOMRect): void } {
  const snapshot = React.useSyncExternalStore(
    React.useCallback((listener: () => void) => designFrameSnapshots.subscribe(listener), []),
    () => designFrameSnapshots.get(frameId, version),
  );
  const capture = React.useCallback(
    (rect: DOMRect) => {
      void captureFrameSnapshot(designFrameSnapshots, frameId, version, rect);
    },
    [frameId, version],
  );
  return { snapshot, capture };
}
