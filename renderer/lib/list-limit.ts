import * as React from "react";

// Long cmdk lists render a page of rows and a "Show N more" row instead of
// every match: cmdk registers each mounted item and walks them all on every
// arrow key, so thousands of rows make each keystroke slow.

/**
 * How many rows a list renders. Starts at `page`, grows by `page` with
 * `showMore`, and goes back to `page` whenever `resetKey` changes (a new
 * query, mode or opening), before anything renders with the old size; a key
 * that comes back later starts from one page too.
 *
 * `grown` says Show more was used. Keep the Show more item mounted while it
 * is, hidden and disabled once nothing is left out: cmdk selects the first row
 * when the selected item unmounts, which would undo moving the selection to
 * the first row the last Show more revealed.
 */
export function useListLimit(
  page: number,
  resetKey: string,
): { limit: number; grown: boolean; showMore: () => void } {
  const [state, setState] = React.useState({ key: resetKey, limit: page });
  // Adjusting state while rendering: React re-renders at once, before commit.
  if (state.key !== resetKey) setState({ key: resetKey, limit: page });
  const limit = state.key === resetKey ? state.limit : page;
  const showMore = React.useCallback(
    () => setState({ key: resetKey, limit: limit + page }),
    [resetKey, limit, page],
  );
  return { limit, grown: limit > page, showMore };
}

/**
 * The first `limit` rows across `sections`, in order, keeping each section's
 * rows together, plus any later row `keep` asks for (the current or the
 * highlighted one), so cmdk can still select it and Enter still chooses it.
 * `next` is the first row left out: the one "Show more" reveals first, and so
 * the row to select after it.
 */
export function limitRows<T>(
  sections: ReadonlyArray<readonly T[]>,
  limit: number,
  keep?: (row: T) => boolean,
): { sections: T[][]; hidden: number; next: T | undefined } {
  let index = 0;
  let hidden = 0;
  let next: T | undefined;
  const shown = sections.map((rows) =>
    rows.filter((row) => {
      if (index++ < limit || keep?.(row)) return true;
      hidden += 1;
      next ??= row;
      return false;
    }),
  );
  return { sections: shown, hidden, next };
}

/**
 * The "Show more" row's words: how many the next press reveals, how many are
 * left out, and both as its accessible name.
 */
export function showMoreLabel(
  hidden: number,
  page: number,
): { title: string; detail: string; label: string } {
  const title = `Show ${Math.min(hidden, page).toLocaleString()} more`;
  const detail = `${hidden.toLocaleString()} not shown`;
  return { title, detail, label: `${title}, ${detail}` };
}
