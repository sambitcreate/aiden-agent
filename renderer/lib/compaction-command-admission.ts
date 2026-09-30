/** Synchronously reserve a manual compaction before React can rerender. */
export function claimCompactionCommand(
  busyRef: { current: boolean },
  sessionCommandBusy: boolean,
  compactionActive: boolean,
): boolean {
  if (busyRef.current || sessionCommandBusy || compactionActive) return false;
  busyRef.current = true;
  return true;
}
