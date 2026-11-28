// A sidebar list that takes one Tab stop: ↑ ↓ move between its rows, Home and
// End jump to the ends, → and ← open and close a folder row (swapped in a
// right-to-left layout), ← on a row inside a folder goes back to the folder,
// and ↩ opens the row as a click would. Typing a title's first letters moves
// to it (a 500 ms typeahead) once the person is moving through the list by
// keyboard; after a click, typing still goes to the message box. When the
// focused row leaves the page, focus goes to the row that took its place
// (`focus-recovery.ts`).
//
// Rows opt in with markup, so a list keeps its own components:
// - `data-roving-item` on each row's main button;
// - `data-roving-row` on a wrapper whose other buttons (such as •••) belong to
//   that row: they stay in the Tab order only for the row that holds the stop;
// - `data-roving-group` on a folder whose first item is the folder's own row.
// The stop is the row last focused while focus stays in the list, otherwise
// the open row (`aria-current="page"`), otherwise the first.

import * as React from "react";
import { watchFocusRecovery } from "./focus-recovery";
import { INPUT_MODALITY_ATTRIBUTE } from "./input-modality";

const ITEM = "[data-roving-item]";
const ROW = "[data-roving-row]";
const GROUP = "[data-roving-group]";
const FOCUSABLE = "a[href], button, input, select, textarea, [tabindex]";
// Holds the tabindex an element had before the list took it out of the Tab order.
const MUTED = "data-roving-muted";
// Set on the list while typed letters search it rather than go to the message
// box (type-to-focus reads it through `isTypeaheadTarget`).
const TYPEAHEAD = "data-typeahead";
export const TYPEAHEAD_TIMEOUT_MS = 500;

/** The key event's target is in a list whose typeahead has the letters. */
export function isTypeaheadTarget(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest(`[${TYPEAHEAD}='on']`) !== null;
}

function setMuted(element: Element, muted: boolean): void {
  if (muted) {
    if (!element.hasAttribute(MUTED))
      element.setAttribute(MUTED, element.getAttribute("tabindex") ?? "");
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
export function syncRovingTabStops(
  container: ParentNode,
  preferred: HTMLElement | null,
): HTMLElement | null {
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

function isRightToLeft(element: Element): boolean {
  const dir = element.closest("[dir]")?.getAttribute("dir");
  if (dir === "rtl" || dir === "ltr") return dir === "rtl";
  return element.ownerDocument.defaultView?.getComputedStyle(element).direction === "rtl";
}

function fold(text: string): string {
  return text
    .normalize("NFD")
    .replace(/\p{M}+/gu, "")
    .toLocaleLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * What a person types to find a row: its visible text without parts hidden
 * from assistive tech (shortcut hints), else its `aria-label`.
 */
export function typeaheadLabel(element: HTMLElement): string {
  let text = "";
  const walker = element.ownerDocument.createTreeWalker(element, NodeFilter.SHOW_TEXT);
  while (walker.nextNode()) {
    const node = walker.currentNode;
    const hidden = node.parentElement?.closest("[aria-hidden='true'], [hidden]");
    if (hidden && element.contains(hidden)) continue;
    text += node.textContent ?? "";
  }
  return text.replace(/\s+/g, " ").trim() || (element.getAttribute("aria-label") ?? "");
}

/**
 * The index of the label a typeahead `query` lands on, or -1, searching from
 * the row after `current` for a first letter and from `current` for a longer
 * query, wrapping round. Repeating one letter ("aaa") steps through the
 * labels that start with it, unless a label starts with the repeat itself.
 * Case and accents are ignored.
 */
export function typeaheadMatch(labels: readonly string[], current: number, query: string): number {
  const folded = fold(query);
  if (!folded) return -1;
  const starts = labels.map(fold);
  const repeated = folded.length > 1 && [...folded].every((letter) => letter === folded[0]);
  const search =
    repeated && !starts.some((label) => label.startsWith(folded)) ? folded[0]! : folded;
  const from = search.length === 1 ? current + 1 : Math.max(current, 0);
  for (let offset = 0; offset < starts.length; offset += 1) {
    const index = (from + offset) % starts.length;
    if (starts[index]!.startsWith(search)) return index;
  }
  return -1;
}

function rovingTarget(
  container: HTMLElement,
  current: HTMLElement,
  key: string,
): HTMLElement | "toggle" | null {
  const items = rovingItems(container);
  const index = items.indexOf(current);
  if (index < 0) return null;
  const expanded = current.getAttribute("aria-expanded");
  // In a right-to-left layout the folder opens toward the left.
  if ((key === "ArrowRight" || key === "ArrowLeft") && isRightToLeft(container)) {
    key = key === "ArrowRight" ? "ArrowLeft" : "ArrowRight";
  }
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
    // How the person last reached the list. Focus that script moves here
    // (focus return, recovery) keeps it, so a mouse user's letters still go
    // to the message box after a dialog closes.
    let arrival: "keyboard" | "pointer" = "keyboard";
    let query = "";
    let queryTimer: ReturnType<typeof setTimeout> | undefined;
    const sync = () => {
      syncRovingTabStops(container, preferred);
    };
    const setTypeahead = (on: boolean) => {
      if (on) container.setAttribute(TYPEAHEAD, "on");
      else container.removeAttribute(TYPEAHEAD);
    };
    const resetQuery = () => {
      clearTimeout(queryTimer);
      query = "";
    };
    const onPointerDown = () => {
      arrival = "pointer";
      setTypeahead(false);
      resetQuery();
    };
    const onFocusIn = (event: FocusEvent) => {
      const item =
        event.target instanceof HTMLElement ? event.target.closest<HTMLElement>(ITEM) : null;
      // A click leaves typing to the message box; Tab, F6 and the arrows search the list.
      const modality =
        container.ownerDocument.documentElement.getAttribute(INPUT_MODALITY_ATTRIBUTE);
      if (modality === "keyboard" || modality === "pointer") arrival = modality;
      if (item) setTypeahead(arrival === "keyboard");
      if (!item || item === preferred) return;
      preferred = item;
      sync();
    };
    const onFocusOut = (event: FocusEvent) => {
      // Coming back to the list lands on the open row again, as after ⌘1.
      if (event.relatedTarget instanceof Node && container.contains(event.relatedTarget)) return;
      setTypeahead(false);
      resetQuery();
      if (preferred === null) return;
      preferred = null;
      sync();
    };
    const typeahead = (event: KeyboardEvent, current: HTMLElement): boolean => {
      if (container.getAttribute(TYPEAHEAD) !== "on" || event.key.length !== 1) return false;
      // Space continues a query ("New p") and otherwise presses the row.
      if (event.key === " " && !query) return false;
      clearTimeout(queryTimer);
      query += event.key;
      queryTimer = setTimeout(resetQuery, TYPEAHEAD_TIMEOUT_MS);
      const items = rovingItems(container);
      const index = typeaheadMatch(items.map(typeaheadLabel), items.indexOf(current), query);
      if (index >= 0) items[index]!.focus();
      return true;
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey) return;
      if (!(event.target instanceof HTMLElement) || !event.target.matches(ITEM)) return;
      if (typeahead(event, event.target)) {
        event.preventDefault();
        return;
      }
      if (event.shiftKey) return;
      const target = rovingTarget(container, event.target, event.key);
      if (!target) return;
      event.preventDefault();
      arrival = "keyboard";
      setTypeahead(true);
      resetQuery();
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
    const stopRecovery = watchFocusRecovery(
      container,
      () => rovingItems(container),
      (target) =>
        target.closest<HTMLElement>(ITEM) ??
        target.closest(ROW)?.querySelector<HTMLElement>(ITEM) ??
        null,
      () => syncRovingTabStops(container, null),
    );
    container.addEventListener("pointerdown", onPointerDown, true);
    container.addEventListener("focusin", onFocusIn);
    container.addEventListener("focusout", onFocusOut);
    container.addEventListener("keydown", onKeyDown);
    return () => {
      observer.disconnect();
      stopRecovery();
      resetQuery();
      setTypeahead(false);
      container.removeEventListener("pointerdown", onPointerDown, true);
      container.removeEventListener("focusin", onFocusIn);
      container.removeEventListener("focusout", onFocusOut);
      container.removeEventListener("keydown", onKeyDown);
    };
  }, [ref]);
}
