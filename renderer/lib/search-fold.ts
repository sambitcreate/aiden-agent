// Text folded for a "contains" search: accents and case are ignored on both
// sides, so "cafe" finds "café". Long text (a last-message preview) is cut to
// a bounded prefix first, so a search never folds a whole message per row.

const COMBINING_MARKS = /\p{M}/gu;
export const SEARCH_TEXT_LIMIT = 240;

export function foldForSearch(text: string): string {
  return text.slice(0, SEARCH_TEXT_LIMIT).normalize("NFD").replace(COMBINING_MARKS, "").toLocaleLowerCase();
}

/** Whether any of `values` contains `query`, ignoring accents and case. An empty query matches. */
export function matchesSearch(values: readonly string[], query: string): boolean {
  const needle = foldForSearch(query.trim());
  if (!needle) return true;
  return values.some((value) => foldForSearch(value).includes(needle));
}
