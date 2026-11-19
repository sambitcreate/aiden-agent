// The selection maths of a multi-select list, on ids in screen order. A Shift
// range runs from the anchor (the row chosen last without Shift) to the row
// pressed, and adds to the base (the selection when the anchor was set). So a
// second Shift range from the same anchor replaces the first range rather than
// adding to it, as in Finder. Pure, so it is tested without a DOM.

export interface RangeSelection {
  /** The chosen ids, in the order they were chosen. */
  readonly ids: readonly string[];
  /** Where Shift ranges start and what they add to; null before the first choice. */
  readonly anchor: { readonly id: string; readonly base: readonly string[] } | null;
}

export const EMPTY_SELECTION: RangeSelection = { ids: [], anchor: null };

/** `id` added, or removed when it was chosen, like ⌘-click. It becomes the anchor. */
export function toggleSelection(selection: RangeSelection, id: string): RangeSelection {
  const ids = selection.ids.includes(id) ? selection.ids.filter((item) => item !== id) : [...selection.ids, id];
  return { ids, anchor: { id, base: ids } };
}

/** The ids from `from` to `to` in `order`, both included, in either direction. */
export function idsBetween(order: readonly string[], from: string, to: string): string[] {
  const start = order.indexOf(from);
  const end = order.indexOf(to);
  if (start === -1 || end === -1) return [];
  return order.slice(Math.min(start, end), Math.max(start, end) + 1);
}

/**
 * The selection a Shift range to `to` makes: the anchor's base plus every id
 * between the anchor and `to`. With no anchor yet (or one no longer listed),
 * `fallbackAnchor` starts the range and the current selection is its base.
 */
export function extendSelection(
  selection: RangeSelection,
  order: readonly string[],
  to: string,
  fallbackAnchor: string = to,
): RangeSelection {
  const anchor =
    selection.anchor && order.includes(selection.anchor.id)
      ? selection.anchor
      : { id: order.includes(fallbackAnchor) ? fallbackAnchor : to, base: selection.ids };
  const kept = new Set(anchor.base);
  const range = idsBetween(order, anchor.id, to).filter((id) => !kept.has(id));
  return { ids: [...anchor.base, ...range], anchor };
}

/**
 * Only the ids still listed. Returns `selection` itself when nothing left, so
 * a caller can skip a state update.
 */
export function retainSelection(selection: RangeSelection, listed: ReadonlySet<string>): RangeSelection {
  const ids = selection.ids.filter((id) => listed.has(id));
  const anchorListed = selection.anchor === null || listed.has(selection.anchor.id);
  if (ids.length === selection.ids.length && anchorListed) return selection;
  if (ids.length === 0) return EMPTY_SELECTION;
  return {
    ids,
    anchor:
      selection.anchor && anchorListed
        ? { id: selection.anchor.id, base: selection.anchor.base.filter((id) => listed.has(id)) }
        : null,
  };
}
