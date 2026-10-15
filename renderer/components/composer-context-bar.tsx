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

interface StripFocusKeeperProps {
  stripRef: React.RefObject<HTMLDivElement | null>;
  hidden: boolean;
  inputRef?: React.RefObject<HTMLTextAreaElement | null>;
  children?: React.ReactNode;
}

/**
 * Returns focus to the composer input when the chip holding it leaves the
 * strip or the strip hides. The snapshot is read before React mutates the
 * DOM, so only focus that was inside the strip at that moment moves; focus
 * the user already put elsewhere (or dropped on <body>) is left alone.
 */
class StripFocusKeeper extends React.Component<StripFocusKeeperProps> {
  getSnapshotBeforeUpdate(): Element | null {
    const active = document.activeElement;
    return active && this.props.stripRef.current?.contains(active) ? active : null;
  }

  componentDidUpdate(_previous: StripFocusKeeperProps, _state: unknown, focusedBefore: Element | null) {
    if (!focusedBefore) return;
    const active = document.activeElement;
    const removed = !focusedBefore.isConnected && (!active || active === document.body);
    const hiddenWithFocus = this.props.hidden && active === focusedBefore;
    if (removed || hiddenWithFocus) this.props.inputRef?.current?.focus({ preventScroll: true });
  }

  render() {
    return this.props.children;
  }
}

/**
 * The strip above the composer. `full` is a draft's setup bar, `summary` a
 * shorter strip after the first message, `hidden` collapses it. Children stay
 * mounted while hidden so portal-based branch/worktree dialogs survive.
 */
export function ComposerContextBar({
  mode,
  inputRef,
  children,
}: React.PropsWithChildren<{
  mode: ComposerContextBarMode;
  inputRef?: React.RefObject<HTMLTextAreaElement | null>;
}>) {
  const hidden = mode === "hidden";
  const stripRef = React.useRef<HTMLDivElement>(null);
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
      <div className="composer-context-content">
        <StripFocusKeeper stripRef={stripRef} hidden={hidden} inputRef={inputRef}>
          {children}
        </StripFocusKeeper>
      </div>
    </div>
  );
}
