import * as React from "react";
import { APPEARANCE_CHANGE_EVENT, readCachedAppearance } from "../lib/appearance-runtime";

function subscribe(listener: () => void) {
  window.addEventListener(APPEARANCE_CHANGE_EVENT, listener);
  return () => window.removeEventListener(APPEARANCE_CHANGE_EVENT, listener);
}

function autoHideEnabled() {
  return readCachedAppearance()?.autoHideComposerContext ?? true;
}

/** Keep portal-based branch/worktree dialogs mounted while their context strip collapses. */
export function ComposerContextBar({
  hasUserMessages,
  inputRef,
  children,
}: React.PropsWithChildren<{
  hasUserMessages: boolean;
  inputRef?: React.RefObject<HTMLTextAreaElement | null>;
}>) {
  const autoHide = React.useSyncExternalStore(subscribe, autoHideEnabled, () => true);
  const hidden = autoHide && hasUserMessages;
  const stripRef = React.useRef<HTMLDivElement>(null);
  React.useLayoutEffect(() => {
    if (hidden && stripRef.current?.contains(document.activeElement)) {
      inputRef?.current?.focus({ preventScroll: true });
    }
  }, [hidden, inputRef]);
  return (
    <div
      ref={stripRef}
      role="group"
      className="composer-context-collapse"
      data-collapsed={hidden}
      aria-label="Composer workspace bar"
      aria-hidden={hidden || undefined}
      inert={hidden || undefined}
    >
      <div className="composer-context-content">{children}</div>
    </div>
  );
}
