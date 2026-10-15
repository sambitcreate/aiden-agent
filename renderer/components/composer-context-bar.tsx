import * as React from "react";
import { APPEARANCE_CHANGE_EVENT, readCachedAppearance } from "../lib/appearance-runtime";
import type { ComposerContextBarMode } from "../lib/composer-context-chips";

function subscribe(listener: () => void) {
  window.addEventListener(APPEARANCE_CHANGE_EVENT, listener);
  return () => window.removeEventListener(APPEARANCE_CHANGE_EVENT, listener);
}

function autoHideEnabled() {
  return readCachedAppearance()?.autoHideComposerContext ?? true;
}

/** Appearance: collapse the bar to the branch and pull request after the first message. */
export function useAutoHideComposerContext(): boolean {
  return React.useSyncExternalStore(subscribe, autoHideEnabled, () => true);
}

/**
 * The strip above the composer. `full` is a draft's setup bar, `summary` a
 * shorter strip after the first message, `hidden` collapses it. Children stay
 * mounted while hidden so portal-based branch/worktree dialogs survive.
 */
export function ComposerContextBar({
  mode,
  chipsKey = "",
  inputRef,
  children,
}: React.PropsWithChildren<{
  mode: ComposerContextBarMode;
  /** Changes whenever a chip enters or leaves, so focus inside a removed chip returns to the input. */
  chipsKey?: string;
  inputRef?: React.RefObject<HTMLTextAreaElement | null>;
}>) {
  const hidden = mode === "hidden";
  const stripRef = React.useRef<HTMLDivElement>(null);
  // Whether keyboard focus was last inside the strip. A chip that unmounts
  // while focused drops focus to <body> without a focusin anywhere else.
  const focusInsideRef = React.useRef(false);
  React.useEffect(() => {
    const track = (event: FocusEvent) => {
      focusInsideRef.current = Boolean(
        event.target instanceof Node && stripRef.current?.contains(event.target),
      );
    };
    document.addEventListener("focusin", track);
    return () => document.removeEventListener("focusin", track);
  }, []);
  React.useLayoutEffect(() => {
    const active = document.activeElement;
    const insideHidden = hidden && Boolean(active && stripRef.current?.contains(active));
    const dropped =
      focusInsideRef.current && (!active || active === document.body || !active.isConnected);
    if (insideHidden || dropped) {
      focusInsideRef.current = false;
      inputRef?.current?.focus({ preventScroll: true });
    }
  }, [hidden, chipsKey, inputRef]);
  return (
    <div
      ref={stripRef}
      role="group"
      className="composer-context-collapse"
      data-collapsed={hidden}
      data-mode={mode}
      aria-label="Composer workspace bar"
      aria-hidden={hidden || undefined}
      inert={hidden || undefined}
    >
      <div className="composer-context-content">{children}</div>
    </div>
  );
}
