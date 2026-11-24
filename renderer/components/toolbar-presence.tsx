import * as React from "react";
import { usePresence } from "../lib/use-presence";

/**
 * Names what the header currently shows, usually the open chat. A header button
 * animates in or out only when its availability changes while this stays the
 * same; switching chats, or a button first rendering, shows the final state at once.
 */
export const ToolbarPresenceScopeContext = React.createContext<string | undefined>(undefined);

interface Tracked {
  scope: string | undefined;
  present: boolean;
  animateEnter: boolean;
  animateExit: boolean;
}

/** Bar buttons a leaving one may hand keyboard focus to. */
const FOCUSABLE = "button:not([disabled]), [href], [tabindex]:not([tabindex='-1'])";

/**
 * Moves keyboard focus off `leaving` to the nearest control left in its bar: the
 * next one after it, else the one before it. Focus is never dropped on the page.
 */
function handOffFocus(leaving: HTMLElement): void {
  const active = document.activeElement;
  if (!(active instanceof HTMLElement) || !leaving.contains(active)) return;
  const bar = leaving.closest<HTMLElement>("[data-toolbar-presence-bar]");
  if (!bar) return;
  const candidates = [...bar.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
    (candidate) => !leaving.contains(candidate) && !candidate.closest("[inert]"),
  );
  const after = candidates.find(
    (candidate) => leaving.compareDocumentPosition(candidate) & Node.DOCUMENT_POSITION_FOLLOWING,
  );
  (after ?? candidates[candidates.length - 1])?.focus({ preventScroll: true });
}

/**
 * A header control that is left out while it can't be used. When it becomes
 * usable its slot widens and it fades in; when it stops being usable it leaves
 * the same way, can't be clicked or focused on the way out, and hands keyboard
 * focus to a neighbour. Reduce Motion, a first render and a chat switch skip the
 * motion. Styled by `.toolbar-presence` in styles.css.
 */
export function ToolbarPresence({ present, children }: { present: boolean; children: React.ReactNode }) {
  const scope = React.useContext(ToolbarPresenceScopeContext);
  const [tracked, setTracked] = React.useState<Tracked>({
    scope,
    present,
    animateEnter: false,
    animateExit: false,
  });
  let current = tracked;
  if (tracked.scope !== scope || tracked.present !== present) {
    const sameScope = tracked.scope === scope;
    current = {
      scope,
      present,
      animateEnter: sameScope && present && !tracked.present,
      animateExit: sameScope && !present,
    };
    setTracked(current);
  }

  const ref = React.useRef<HTMLSpanElement>(null);
  const { rendered, exiting } = usePresence(present, ref);
  const lastChildren = React.useRef(children);
  if (present) lastChildren.current = children;

  React.useLayoutEffect(() => {
    if (exiting && ref.current) handOffFocus(ref.current);
  }, [exiting]);

  // A chat switch lands on the final state at once, even in the middle of a slide.
  React.useLayoutEffect(() => {
    for (const animation of ref.current?.getAnimations?.() ?? []) {
      if (Number.isFinite(Number(animation.effect?.getComputedTiming().endTime))) animation.finish();
    }
  }, [scope]);

  // Only a mid-chat change slides out. Anything else (a chat switch, even one that
  // lands while this control is still sliding) drops it before the next paint,
  // rather than letting a running transition keep the last chat's control around.
  if (!rendered || (exiting && !current.animateExit)) return null;
  return (
    <span
      ref={ref}
      className="toolbar-presence"
      data-presence={exiting ? "exiting" : "visible"}
      data-enter={current.animateEnter ? "animate" : undefined}
      aria-hidden={exiting ? "true" : undefined}
      inert={exiting || undefined}
    >
      {present ? children : lastChildren.current}
    </span>
  );
}
