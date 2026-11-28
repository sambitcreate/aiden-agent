// Multi-select for a roving list (`roving-rows.ts`). Rows opt in with
// `data-select-id` on their `data-roving-item` button:
// - ⌘-click (Ctrl-click outside macOS) adds or removes a row;
// - Shift-click and Shift+↑/↓ select a range from the anchor (`range-selection.ts`);
// - Escape clears the selection.
// A plain click or ↩ still opens the row as before; a plain click also clears
// the selection. Every listener sits on the list, none on a row.

import * as React from "react";
import { isDismissKey } from "./dismiss-key";
import {
  EMPTY_SELECTION,
  extendSelection,
  retainSelection,
  toggleSelection,
  type RangeSelection,
} from "./range-selection";
import { rovingItems } from "./roving-rows";

const SELECTABLE = "[data-roving-item][data-select-id]";

function selectableOrder(container: HTMLElement): string[] {
  return rovingItems(container).flatMap((item) =>
    item.dataset.selectId ? [item.dataset.selectId] : [],
  );
}

export interface RowSelection {
  /** The selected ids, in the order they were chosen. */
  ids: readonly string[];
  has: (id: string) => boolean;
  clear: () => void;
}

export function useRowSelection(
  ref: React.RefObject<HTMLElement | null>,
  { enabled, platform }: { enabled: boolean; platform: string },
): RowSelection {
  const [selection, setSelection] = React.useState<RangeSelection>(EMPTY_SELECTION);
  const selectionRef = React.useRef(selection);
  selectionRef.current = selection;

  React.useEffect(() => {
    const container = ref.current;
    if (!enabled || !container) {
      setSelection(EMPTY_SELECTION);
      return;
    }
    const mac = platform === "darwin";
    const selectableFrom = (target: EventTarget | null) => {
      const item = target instanceof Element ? target.closest<HTMLElement>(SELECTABLE) : null;
      return item && container.contains(item) ? item : null;
    };
    const onMouseDown = (event: MouseEvent) => {
      // Shift-click would otherwise select the rows' text.
      if (event.shiftKey && selectableFrom(event.target)) event.preventDefault();
    };
    const onClick = (event: MouseEvent) => {
      // `detail` is 0 for a click made with ↩ or Space: those open the row as before.
      if (event.detail === 0 || event.button !== 0) return;
      const item = selectableFrom(event.target);
      if (!item) return;
      const id = item.dataset.selectId!;
      if (event.shiftKey) {
        const open = container.querySelector<HTMLElement>(`${SELECTABLE}[aria-current="page"]`)
          ?.dataset.selectId;
        setSelection((current) =>
          extendSelection(current, selectableOrder(container), id, open ?? id),
        );
      } else if (mac ? event.metaKey : event.ctrlKey) {
        setSelection((current) => toggleSelection(current, id));
      } else {
        if (selectionRef.current.ids.length > 0) setSelection(EMPTY_SELECTION);
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      item.focus();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      if (isDismissKey(event)) {
        if (selectionRef.current.ids.length === 0) return;
        event.preventDefault();
        setSelection(EMPTY_SELECTION);
        return;
      }
      if (!event.shiftKey || event.altKey || event.ctrlKey || event.metaKey) return;
      if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
      if (!(event.target instanceof HTMLElement) || !event.target.matches("[data-roving-item]"))
        return;
      const items = rovingItems(container);
      const index = items.indexOf(event.target);
      if (index < 0) return;
      event.preventDefault();
      const next = items[index + (event.key === "ArrowDown" ? 1 : -1)];
      if (!next) return;
      next.focus();
      const to = next.dataset.selectId;
      // A folder row takes focus but is never selected.
      if (!to) return;
      const from = event.target.dataset.selectId ?? to;
      setSelection((current) => extendSelection(current, selectableOrder(container), to, from));
    };
    container.addEventListener("mousedown", onMouseDown, true);
    container.addEventListener("click", onClick, true);
    container.addEventListener("keydown", onKeyDown);
    return () => {
      container.removeEventListener("mousedown", onMouseDown, true);
      container.removeEventListener("click", onClick, true);
      container.removeEventListener("keydown", onKeyDown);
    };
  }, [enabled, platform, ref]);

  // Rows that leave the list (deleted, a search narrowed it, a folder closed)
  // leave the selection, so a bulk action never reaches a chat out of sight.
  React.useLayoutEffect(() => {
    const container = ref.current;
    if (!container || selection.ids.length === 0) return;
    const next = retainSelection(selection, new Set(selectableOrder(container)));
    if (next !== selection) setSelection(next);
  });

  const clear = React.useCallback(() => setSelection(EMPTY_SELECTION), []);
  const ids = selection.ids;
  const has = React.useMemo(() => {
    const set = new Set(ids);
    return (id: string) => set.has(id);
  }, [ids]);
  return { ids, has, clear };
}
