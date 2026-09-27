import type { ChatReadMarkersSnapshot } from "../shared/chat-row-state";

/** Ignore late snapshots so an initial read cannot undo a newer change event. */
export function applyChatReadMarkersSnapshot(
  current: ChatReadMarkersSnapshot | null,
  snapshot: ChatReadMarkersSnapshot,
): ChatReadMarkersSnapshot {
  if (current && snapshot.revision < current.revision) return current;
  return snapshot;
}
