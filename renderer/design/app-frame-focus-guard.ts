// Live app frames can't take keyboard focus from Aiden (design mode v2 Phase
// 3a, S75). `inert` alone doesn't stop it: probe 8 showed a page's own
// `input.focus()` loop still pulls focus into an inert iframe in Electron
// 43.8.4. So while any app frame is on the canvas, one document-level guard
// watches focus leave Aiden's controls. When the new active element is an
// app iframe the person hasn't entered, focus goes straight back to the
// element that lost it, or, when nothing in Aiden had focus, the iframe is
// blurred so focus returns to the body. An entered frame is exempt until it
// is left. No polling and no timers: the guard runs only on focus events.
//
// In Chromium the move happens in two steps when the page is in another
// process (every app frame in a packaged build): the old element's
// `focusout` fires while the body is still the active element, and the
// iframe becomes the active element only as the window's `blur` fires,
// in the same task (Space probe, Electron 43.8.4). So `focusout` remembers
// what lost focus, and the window's `blur` hands focus back to it.
//
// Known limit (2026-11-27, escalated): this restores Aiden's DOM focus, but
// for a frame in another process Chromium keeps that frame focused, and a
// keyboard's keys are routed to it. Restoring later (a timer) still leaks
// some keys. See the plan's deviation 17 and the skipped K1 E2E.

/** Set on an app iframe while the person has entered it; the guard leaves that one alone. */
export const APP_FRAME_ENTERED_ATTRIBUTE = "data-app-frame-entered";
/** Every live app iframe carries this, with its canvas frame id. */
export const APP_FRAME_ID_ATTRIBUTE = "data-app-frame-id";

type Guard = { holders: number; remove(): void };
/** How long after a `focusout` the window's `blur` still counts as the same move. */
const SAME_MOVE_MS = 250;
const guards = new WeakMap<Document, Guard>();

/** An app iframe the person hasn't entered, or null. */
function guardedFrame(target: EventTarget | null | undefined): HTMLIFrameElement | null {
  const element = target as Element | null | undefined;
  if (!element || element.nodeType !== 1 || element.tagName !== "IFRAME") return null;
  if (!element.hasAttribute(APP_FRAME_ID_ATTRIBUTE) || element.hasAttribute(APP_FRAME_ENTERED_ATTRIBUTE)) return null;
  return element as HTMLIFrameElement;
}

/** Whether focus can go back to `target`: a connected element of Aiden's, not the body, not inert or disabled. */
function canTakeFocusBack(target: EventTarget | null | undefined, doc: Document): target is HTMLElement {
  const element = target as HTMLElement | null | undefined;
  if (!element || element.nodeType !== 1 || typeof element.focus !== "function") return false;
  if (!element.isConnected || element.ownerDocument !== doc || element === doc.body || element === doc.documentElement) return false;
  if (element.tagName === "IFRAME" || element.closest("[inert]")) return false;
  return !(element as HTMLButtonElement).disabled;
}

function install(doc: Document): Guard {
  const view = doc.defaultView;
  // Set while the guard itself moves focus, so its own `focusin` doesn't end the move it is answering.
  let restoring = false;
  const focusBack = (element: HTMLElement) => {
    restoring = true;
    try {
      element.focus({ preventScroll: true });
    } finally {
      restoring = false;
    }
  };
  /** Puts focus back where it belongs when an app iframe took it. True when it acted. */
  const settle = (frame: HTMLIFrameElement | null, lost: EventTarget | null): boolean => {
    if (!frame) return false;
    if (canTakeFocusBack(lost, doc)) {
      focusBack(lost);
      if (doc.activeElement === lost) return true;
    }
    frame.blur();
    return true;
  };
  // When the iframe is already the active element at `focusout` (a frame in
  // Aiden's own process), the check is synchronous; engines that finish the
  // move just after `focusout` are caught by a second look in a microtask,
  // which does nothing once focus is back.
  let recent: { lost: EventTarget | null; at: number } | null = null;
  const onFocusOut = (event: FocusEvent) => {
    const lost = event.target;
    // An app iframe losing focus (to the guard) is not a loss to answer.
    if (!guardedFrame(lost)) recent = { lost, at: event.timeStamp };
    settle(guardedFrame(doc.activeElement), lost);
    queueMicrotask(() => settle(guardedFrame(doc.activeElement), lost));
  };
  // Focus landed somewhere of Aiden's: an earlier loss no longer counts.
  const onFocusIn = (event: FocusEvent) => {
    if (!restoring && !guardedFrame(event.target)) recent = null;
  };
  // The window blurs as the iframe takes focus. The element whose `focusout`
  // just ran gets it back; with none (the body had focus), the iframe is blurred.
  const onWindowBlur = (event: Event) => {
    if (event.target !== view) return;
    const lost = recent && event.timeStamp - recent.at <= SAME_MOVE_MS ? recent.lost : null;
    recent = null;
    settle(guardedFrame(doc.activeElement), lost);
    queueMicrotask(() => settle(guardedFrame(doc.activeElement), lost));
  };
  doc.addEventListener("focusout", onFocusOut, true);
  doc.addEventListener("focusin", onFocusIn, true);
  view?.addEventListener("blur", onWindowBlur, true);
  return {
    holders: 0,
    remove() {
      doc.removeEventListener("focusout", onFocusOut, true);
      doc.removeEventListener("focusin", onFocusIn, true);
      view?.removeEventListener("blur", onWindowBlur, true);
    },
  };
}

/**
 * Holds the document's focus guard for one app frame. The guard is installed
 * with the first holder and removed with the last; the returned release is
 * idempotent.
 */
export function holdAppFrameFocusGuard(doc: Document = document): () => void {
  let guard = guards.get(doc);
  if (!guard) {
    guard = install(doc);
    guards.set(doc, guard);
  }
  guard.holders += 1;
  const held = guard;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    held.holders -= 1;
    if (held.holders > 0) return;
    held.remove();
    if (guards.get(doc) === held) guards.delete(doc);
  };
}
