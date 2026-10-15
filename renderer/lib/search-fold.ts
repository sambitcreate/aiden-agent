// Text folded for a "contains" search: Latin accents and case are ignored on
// both sides, so "cafe" finds "café". Only marks on Latin letters are dropped:
// in Devanagari, Thai or Arabic a mark is part of the letter, and dropping it
// would make unrelated words match. Long text (a last-message preview) is cut
// to a bounded prefix first, so a search never folds a whole message per row.

const LATIN_DIACRITICS = /(\p{Script=Latin})\p{M}+/gu;
const SEARCH_TEXT_LIMIT = 240;

function foldForSearch(text: string): string {
  return text.slice(0, SEARCH_TEXT_LIMIT).normalize("NFD").replace(LATIN_DIACRITICS, "$1").toLocaleLowerCase();
}

/** Whether any of `values` contains `query`, ignoring Latin accents and case. An empty query matches. */
export function matchesSearch(values: readonly string[], query: string): boolean {
  const needle = foldForSearch(query.trim());
  if (!needle) return true;
  return values.some((value) => foldForSearch(value).includes(needle));
}
