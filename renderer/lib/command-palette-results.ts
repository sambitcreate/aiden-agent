import { rankMatches, type MatchRange } from "./text-match";

/** One palette row: its stable cmdk value, the title it shows and what else it answers to. */
export interface PaletteResult {
  identity: string;
  title: string;
  keywords: string[];
  disabled?: boolean;
  /** Shown whatever was typed, and chosen only when no ordinary row matches. */
  forceMount?: boolean;
}

export function paletteResult(
  identity: string,
  title: string,
  keywords: string[] = [],
  state: Pick<PaletteResult, "disabled" | "forceMount"> = {},
): PaletteResult {
  return { identity, title, keywords, ...state };
}

/**
 * The rows that match the query, best first with ties in input order, each with
 * its title's matched ranges. Force-mounted rows always stay, unhighlighted.
 */
export function rankPaletteResults<T extends { result: PaletteResult }>(
  items: readonly T[],
  query: string,
): Array<T & { ranges: MatchRange[] }> {
  const forced = items.filter((item) => item.result.forceMount);
  const ranked = rankMatches(
    items.filter((item) => !item.result.forceMount),
    query,
    (item) => item.result,
  );
  return [
    ...forced.map((item) => ({ ...item, ranges: [] })),
    ...ranked.map(({ item, ranges }) => ({ ...item, ranges })),
  ];
}

/**
 * The row to keep selected among the visible rows, in the order they render:
 * the current one while it is still there and enabled, else the first enabled
 * ordinary row, else the first enabled force-mounted one (a Retry).
 */
export function reconcilePaletteResult(selected: string, visible: readonly PaletteResult[]): string {
  const ordinary = visible.filter((result) => !result.disabled && !result.forceMount);
  const candidates = ordinary.length > 0
    ? ordinary
    : visible.filter((result) => !result.disabled && result.forceMount);
  if (candidates.some((result) => result.identity === selected)) return selected;
  return candidates[0]?.identity ?? "";
}
