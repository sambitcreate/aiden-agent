import type { VisualSnapshotJob } from "./visual-snapshot-core.js";

/**
 * The process-wide snapshot queue, installed by the main process at startup.
 * Kept free of Electron imports so generation code can enqueue work without
 * pulling in a window implementation (and stays testable without one).
 */
interface SnapshotQueue {
  enqueue(job: VisualSnapshotJob): void;
  cancelChat(chatId: string): void;
  dispose(): void;
  idle(): Promise<void>;
}

let installed: SnapshotQueue | null = null;

export function installVisualSnapshotQueue(queue: SnapshotQueue): void {
  installed = queue;
}

/** Best-effort and non-blocking: never delays the reply it follows. */
export function enqueueVisualSnapshots(job: VisualSnapshotJob): void {
  installed?.enqueue(job);
}

export function cancelVisualSnapshots(chatId: string): void {
  installed?.cancelChat(chatId);
}

export function disposeVisualSnapshots(): void {
  installed?.dispose();
  installed = null;
}

export function visualSnapshotsIdle(): Promise<void> {
  return installed?.idle() ?? Promise.resolve();
}
