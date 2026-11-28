// Which transcript subagent cards are on screen right now. The composer pill
// reads this so it shows only while a batch's card has scrolled out of view:
// one indicator at a time, never the card and the pill together.

import * as React from "react";

type Listener = () => void;

/** On-screen card elements per group key (a generation id). The live and saved cards can overlap briefly. */
const visibleElementsByGroup = new Map<string, Set<Element>>();
const groupByElement = new Map<Element, string>();
const listeners = new Set<Listener>();
let observer: IntersectionObserver | null = null;
/** How much of the window's bottom the composer covers; a card behind it is not on screen. */
let bottomInset = 0;

function emit() {
  for (const listener of listeners) listener();
}

function setVisible(element: Element, visible: boolean) {
  const groupKey = groupByElement.get(element);
  if (groupKey === undefined) return;
  const shown = visibleElementsByGroup.get(groupKey) ?? new Set<Element>();
  if (shown.has(element) === visible) return;
  if (visible) shown.add(element);
  else shown.delete(element);
  if (shown.size) visibleElementsByGroup.set(groupKey, shown);
  else visibleElementsByGroup.delete(groupKey);
  emit();
}

function sharedObserver(): IntersectionObserver | null {
  if (observer) return observer;
  if (typeof IntersectionObserver === "undefined") return null;
  // The viewport as root also honours the transcript's own scroll clipping.
  observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) setVisible(entry.target, entry.isIntersecting);
    },
    { rootMargin: `0px 0px ${-Math.round(bottomInset)}px 0px` },
  );
  return observer;
}

/**
 * Sets the strip at the bottom of the window that the composer covers. Small
 * changes are ignored; a real one rebuilds the observer around every card.
 */
export function setSubagentGroupBottomInset(px: number): void {
  const next = Math.max(0, px);
  if (Math.abs(next - bottomInset) < 8) return;
  bottomInset = next;
  if (!observer) return;
  observer.disconnect();
  observer = null;
  const io = sharedObserver();
  if (!io) return;
  for (const element of groupByElement.keys()) io.observe(element);
}

/**
 * Tracks one card element for its group. Returns the cleanup. Without
 * IntersectionObserver nothing counts as on screen, so the pill keeps showing.
 */
export function observeSubagentGroup(element: Element, groupKey: string): () => void {
  const io = sharedObserver();
  if (!io || !groupKey) return () => undefined;
  groupByElement.set(element, groupKey);
  io.observe(element);
  return () => {
    // The observer may have been rebuilt since; unobserve with the current one.
    observer?.unobserve(element);
    setVisible(element, false);
    groupByElement.delete(element);
  };
}

function subscribe(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** True while any of these groups' cards is at least partly on screen. */
export function isAnySubagentGroupOnScreen(groupKeys: readonly string[]): boolean {
  return groupKeys.some((key) => visibleElementsByGroup.has(key));
}

/** The first on-screen card of these groups, for handing focus to it. */
export function onScreenSubagentGroupElement(groupKeys: readonly string[]): Element | null {
  for (const key of groupKeys) {
    const element = visibleElementsByGroup.get(key)?.values().next().value;
    if (element) return element;
  }
  return null;
}

/** Re-renders when the answer to {@link isAnySubagentGroupOnScreen} changes. */
export function useSubagentGroupOnScreen(groupKeys: readonly string[]): boolean {
  const key = groupKeys.join("\n");
  const getSnapshot = React.useCallback(
    () => isAnySubagentGroupOnScreen(key ? key.split("\n") : []),
    [key],
  );
  return React.useSyncExternalStore(subscribe, getSnapshot, () => false);
}

/** Registers a card element for as long as it is mounted under this group key. */
export function useObserveSubagentGroup(
  ref: React.RefObject<Element | null>,
  groupKey: string,
): void {
  React.useEffect(() => {
    const element = ref.current;
    if (!element) return;
    return observeSubagentGroup(element, groupKey);
  }, [groupKey, ref]);
}
