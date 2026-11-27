/**
 * Whether in-app Back/Forward can move from the current entry. `entryIndex` is
 * the router's per-entry index (absent before the first navigation commits);
 * `entryCount` is the memory history's length.
 */
export function historyNavigationAvailability(
  entryIndex: number | undefined,
  entryCount: number,
): { canGoBack: boolean; canGoForward: boolean } {
  if (entryIndex === undefined || !Number.isInteger(entryIndex) || entryIndex < 0) {
    return { canGoBack: false, canGoForward: false };
  }
  return { canGoBack: entryIndex > 0, canGoForward: entryIndex < entryCount - 1 };
}

/** Reason an in-flight Git operation or open-file edit blocks navigation or workspace actions. */
export function environmentWorkBlockedReason(
  state: { gitBusy: boolean; saving: boolean; dirty?: boolean },
  before?: string,
): string | undefined {
  if (state.gitBusy) {
    return before
      ? `Wait for the current Git operation to finish before ${before}.`
      : "Wait for the current Git operation to finish";
  }
  if (state.saving) {
    return before
      ? `Wait for the open file to finish saving before ${before}.`
      : "Wait for the open file to finish saving";
  }
  if (state.dirty) {
    return before
      ? `Save or discard the open file's edits before ${before}.`
      : "Save or discard the open file's edits first";
  }
  return undefined;
}
