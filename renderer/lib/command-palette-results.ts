import { defaultFilter } from "cmdk";

export interface PaletteResult {
  identity: string;
  value: string;
  keywords: string[];
}

// cmdk 1.1.1 only refreshes its alias cache when value changes. Selection is
// reconciled through identity so metadata changes can safely produce new values.
export function paletteResult(identity: string, keywords: string[]): PaletteResult {
  return { identity, value: JSON.stringify([identity, keywords]), keywords };
}

export function filterPaletteResult(value: string, search: string, keywords?: string[]): number {
  return defaultFilter(keywords?.length ? keywords.join(" ") : value, search);
}

/** Reconcile cmdk's metadata-sensitive values through the stable record identity. */
export function reconcilePaletteResult(
  selectedValue: string,
  results: readonly PaletteResult[],
  search: string,
): string {
  let identity: string;
  try {
    const selected: unknown = JSON.parse(selectedValue);
    if (!Array.isArray(selected) || typeof selected[0] !== "string" || !Array.isArray(selected[1])) {
      return selectedValue;
    }
    identity = selected[0];
  } catch {
    // Static commands keep their existing cmdk values.
    return selectedValue;
  }
  const current = results.find((result) => result.identity === identity);
  if (current && (!search || filterPaletteResult(current.value, search, current.keywords) > 0)) {
    return current.value;
  }
  // If a rename/removal excludes the selected record, keep a visible destination
  // selected using cmdk scoring with stable input-order tie breaking.
  let bestValue = "";
  let bestScore = 0;
  for (const result of results) {
    const score = search ? filterPaletteResult(result.value, search, result.keywords) : 1;
    if (score > bestScore) {
      bestScore = score;
      bestValue = result.value;
    }
  }
  return bestValue;
}
