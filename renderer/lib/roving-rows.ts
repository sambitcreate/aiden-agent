// A sidebar list that takes one Tab stop: ↑ ↓ move between its rows, Home and
// End jump to the ends, → and ← open and close a folder row, ← on a row inside
// a folder goes back to the folder, and ↩ opens the row as a click would.
//
// Rows opt in with markup, so a list keeps its own components:
// - `data-roving-item` on each row's main button;
// - `data-roving-row` on a wrapper whose other buttons (such as •••) belong to
//   that row: they stay in the Tab order only for the row that holds the stop;
// - `data-roving-group` on a folder whose first item is the folder's own row.
// The stop is the row last focused while focus stays in the list, otherwise
// the open row (`aria-current="page"`), otherwise the first.

import * as React from "react";

const ITEM = "[data-roving-item]";
const ROW = "[data-roving-row]";
const GROUP = "[data-roving-group]";
const FOCUSABLE = "a[href], button, input, select, textarea, [tabindex]";
// Holds the tabindex an element had before the list took it out of the Tab order.
const MUTED = "data-roving-muted";

function setMuted(element: Element, muted: boolean): void {
  if (muted) {
    if (!element.hasAttribute(MUTED)) element.setAttribute(MUTED, element.getAttribute("tabindex") ?? "");
    if (element.getAttribute("tabindex") !== "-1") element.setAttribute("tabindex", "-1");
    return;
  }
  if (!element.hasAttribute(MUTED)) return;
  const original = element.getAttribute(MUTED);
  element.removeAttribute(MUTED);
  if (original) element.setAttribute("tabindex", original);
  else element.removeAttribute("tabindex");
}

/** The rows keys can move to, in screen order. */
export function rovingItems(container: ParentNode): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>(ITEM)).filter(
    (item) => !(item as HTMLButtonElement).disabled && !item.closest("[hidden], [inert]"),
  );
}

/**
 * Leave exactly one row in the Tab order, plus the other buttons of that row,
 * and return it. `preferred` wins while it is still a row here.
 */
export function syncRovingTabStops(container: ParentNode, preferred: HTMLElement | null): HTMLElement | null {
  const items = rovingItems(container);
  const stop =
    (preferred && items.includes(preferred) ? preferred : null) ??
    items.find((item) => item.getAttribute("aria-current") === "page") ??
    items[0] ??
    null;
  for (const item of container.querySelectorAll(ITEM)) setMuted(item, item !== stop);
  for (const row of container.querySelectorAll(ROW)) {
    const holdsStop = stop !== null && row.contains(stop);
    for (const element of row.querySelectorAll(FOCUSABLE)) {
      if (!element.matches(ITEM)) setMuted(element, !holdsStop);
    }
  }
  return stop;
}

function rovingTarget(container: HTMLElement, current: HTMLElement, key: string): HTMLElement | "toggle" | null {
  const items = rovingItems(container);
  const index = items.indexOf(current);
  if (index < 0) return null;
  const expanded = current.getAttribute("aria-expanded");
  switch (key) {
    case "ArrowDown":
      return items[index + 1] ?? current;
    case "ArrowUp":
      return items[index - 1] ?? current;
    case "Home":
      return items[0] ?? null;
    case "End":
      return items[items.length - 1] ?? null;
    case "ArrowRight":
      return expanded === "false" ? "toggle" : null;
    case "ArrowLeft": {
      if (expanded === "true") return "toggle";
      const folder = current.closest(GROUP)?.querySelector<HTMLElement>(ITEM);
      return folder && folder !== current && items.includes(folder) ? folder : null;
    }
    default:
      return null;
  }
}

/** Gives the list at `ref` one Tab stop and arrow-key movement between its rows. */
export function useRovingRows(ref: React.RefObject<HTMLElement | null>): void {
  React.useEffect(() => {
    const container = ref.current;
    if (!container) return;
    let preferred: HTMLElement | null = null;
    const sync = () => {
      syncRovingTabStops(container, preferred);
    };
    const onFocusIn = (event: FocusEvent) => {
      const item = event.target instanceof HTMLElement ? event.target.closest<HTMLElement>(ITEM) : null;
      if (!item || item === preferred) return;
      preferred = item;
      sync();
    };
    const onFocusOut = (event: FocusEvent) => {
      // Coming back to the list lands on the open row again, as after ⌘1.
      if (event.relatedTarget instanceof Node && container.contains(event.relatedTarget)) return;
      if (preferred === null) return;
      preferred = null;
      sync();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
      if (!(event.target instanceof HTMLElement) || !event.target.matches(ITEM)) return;
      const target = rovingTarget(container, event.target, event.key);
      if (!target) return;
      event.preventDefault();
      if (target === "toggle") event.target.click();
      else target.focus();
    };
    sync();
    // Rows come and go as folders open, searches narrow and chats arrive.
    const observer = new MutationObserver(sync);
    observer.observe(container, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["aria-current", "disabled", "hidden"],
    });
    container.addEventListener("focusin", onFocusIn);
    container.addEventListener("focusout", onFocusOut);
    container.addEventListener("keydown", onKeyDown);
    return () => {
      observer.disconnect();
      container.removeEventListener("focusin", onFocusIn);
      container.removeEventListener("focusout", onFocusOut);
      container.removeEventListener("keydown", onKeyDown);
    };
  }, [ref]);
}
