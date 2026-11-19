// Put focus back after something closes. The element to return to can be gone
// by then (a deleted row, a menu item, a toggle the layout hid), and focusing it
// silently drops focus on the document. Instead each candidate gets a turn, and
// one counts only if focus really landed on it. When none takes it and focus
// is lost (on the page, or still in the surface that closed), the message box's
// entry point and then the app's focus root do; focus the app already moved
// somewhere on purpose stays there.

import { focusRegionEntry, type FocusRegion } from "./focus-regions";

export type FocusCandidate = HTMLElement | null | undefined | (() => HTMLElement | null | undefined);

export interface ReturnFocusOptions {
  /** The area whose entry point is the fallback; null for none. Default: the message box. */
  region?: FocusRegion | null;
  preventScroll?: boolean;
  /** The surface that is closing: focus still inside it counts as lost. */
  closing?: Element | null;
}

// A depth, since a focus handler can itself put focus back.
let restoring = 0;

/** True while `returnFocus` is moving focus, so a tooltip on the target stays closed. */
export function isRestoringFocus(): boolean {
  return restoring > 0;
}

function usable(element: HTMLElement): boolean {
  if (!element.isConnected || element === element.ownerDocument.body) return false;
  if (element.closest("[hidden], [inert], [aria-hidden='true']") || element.matches(":disabled")) return false;
  // display: none on it or an ancestor.
  return typeof element.checkVisibility !== "function" || element.checkVisibility();
}

/**
 * Focus the first candidate that is connected, shown, not inert or disabled,
 * and actually takes focus, then the fallbacks. Returns the element that holds
 * focus, or null when nothing would take it (focus is left where it was).
 */
export function returnFocus(candidates: readonly FocusCandidate[], options: ReturnFocusOptions = {}): HTMLElement | null {
  const { region = "composer", preventScroll = false, closing } = options;
  const take = (candidate: FocusCandidate): HTMLElement | null => {
    const element = typeof candidate === "function" ? candidate() : candidate;
    if (!element || !usable(element)) return null;
    restoring += 1;
    try {
      element.focus({ preventScroll });
    } finally {
      restoring -= 1;
    }
    return element.ownerDocument.activeElement === element ? element : null;
  };
  for (const candidate of candidates) {
    const landed = take(candidate);
    if (landed) return landed;
  }
  const active = document.activeElement;
  const lost = !active || active === document.body || !active.isConnected || closing?.contains(active) === true;
  if (!lost) return null;
  return (
    take(() => (region ? focusRegionEntry(region) : null)) ??
    take(() => document.querySelector<HTMLElement>("[data-app-focus-root]"))
  );
}
