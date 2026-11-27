// Live app frames can't take keyboard focus from Aiden (design mode v2 Phase
// 3a, S75). `inert` alone doesn't stop it: probe 8 showed a page's own
// `input.focus()` loop still pulls focus into an inert iframe in Electron
// 43.8.4. So while any app frame is on the canvas, one document-level guard
// watches focus leave Aiden's controls. When the new active element is an
// app iframe the person hasn't entered, focus goes straight back to the
// element that lost it, or, when nothing in Aiden had focus, the iframe is
// blurred so focus returns to the body. An entered frame is exempt until it
// is left. No polling and no timers: the guard runs only on focus events.

/** Set on an app iframe while the person has entered it; the guard leaves that one alone. */
export const APP_FRAME_ENTERED_ATTRIBUTE = "data-app-frame-entered";
/** Every live app iframe carries this, with its canvas frame id. */
export const APP_FRAME_ID_ATTRIBUTE = "data-app-frame-id";

type Guard = { holders: number; remove(): void };
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
  /** Puts focus back where it belongs when an app iframe took it. True when it acted. */
  const settle = (frame: HTMLIFrameElement | null, lost: EventTarget | null): boolean => {
    if (!frame) return false;
    if (canTakeFocusBack(lost, doc)) {
      lost.focus({ preventScroll: true });
      if (doc.activeElement === lost) return true;
    }
    frame.blur();
    return true;
  };
  // Chromium has already made the iframe the active element while the old
  // element's `focusout` runs (probe 8), so the check is synchronous. Engines
  // that finish the move after `focusout` are caught by a second look in a
  // microtask, which does nothing once focus is back.
  const onFocusOut = (event: FocusEvent) => {
    const lost = event.target;
    settle(guardedFrame(doc.activeElement), lost);
    queueMicrotask(() => settle(guardedFrame(doc.activeElement), lost));
  };
  // Nothing in Aiden had focus (the body): no element loses it, but the window does.
  const onWindowBlur = (event: Event) => {
    if (event.target !== view) return;
    settle(guardedFrame(doc.activeElement), null);
    queueMicrotask(() => settle(guardedFrame(doc.activeElement), null));
  };
  doc.addEventListener("focusout", onFocusOut, true);
  view?.addEventListener("blur", onWindowBlur, true);
  return {
    holders: 0,
    remove() {
      doc.removeEventListener("focusout", onFocusOut, true);
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
