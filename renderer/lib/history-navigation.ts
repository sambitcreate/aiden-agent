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
