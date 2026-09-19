import { defaultFilter } from "cmdk";

export interface PaletteResult {
  identity: string;
  value: string;
  keywords: string[];
  disabled?: boolean;
  forceMount?: boolean;
}

// cmdk 1.1.1 only refreshes its alias cache when value changes. Selection is
// reconciled through identity so metadata changes can safely produce new values.
export function paletteResult(identity: string, keywords: string[]): PaletteResult {
  return { identity, value: JSON.stringify([identity, keywords]), keywords };
}

export function staticPaletteResult(
  value: string,
  state: Pick<PaletteResult, "disabled" | "forceMount"> = {},
): PaletteResult {
  return { identity: value, value, keywords: [value], ...state };
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
  let identity = selectedValue;
  try {
    const selected: unknown = JSON.parse(selectedValue);
    if (Array.isArray(selected) && typeof selected[0] === "string" && Array.isArray(selected[1])) {
      identity = selected[0];
    }
  } catch {
    // Static commands use their literal value as identity, but still must exist
    // in this mode's visible, enabled result inventory.
  }
  const scoreResult = (result: PaletteResult): number => {
    if (result.disabled) return 0;
    if (!search || result.forceMount) return 1;
    return filterPaletteResult(result.value, search, result.keywords);
  };
  const current = results.find((result) => result.identity === identity);
  if (current && scoreResult(current) > 0) {
    return current.value;
  }
  // If a rename/removal excludes the selected record, keep a visible destination
  // selected using cmdk scoring with stable input-order tie breaking.
  let bestValue = "";
  let bestScore = 0;
  for (const result of results) {
    const score = scoreResult(result);
    if (score > bestScore) {
      bestScore = score;
      bestValue = result.value;
    }
  }
  return bestValue;
}
