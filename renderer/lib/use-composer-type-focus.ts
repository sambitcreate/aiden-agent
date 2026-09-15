import * as React from "react";
import {
  composerCanAcceptTyping,
  decideComposerTypeFocus,
  insertTextIntoTextarea,
  isEditableTypingTarget,
  isReservedTypingSurface,
  typingRedirectBlockedByOverlay,
} from "./composer-type-focus";

export function useComposerTypeFocus(
  inputRef: React.RefObject<HTMLTextAreaElement | null>,
  enabled = true,
  scopeRef?: React.RefObject<HTMLElement | null>,
): void {
  React.useEffect(() => {
    if (!enabled) return;
    const onKeyDown = (event: KeyboardEvent) => {
      const composer = inputRef.current;
      const scope = scopeRef?.current;
      if (
        scope &&
        event.target instanceof Node &&
        event.target !== composer &&
        !scope.contains(event.target)
      ) {
        return;
      }
      const decision = decideComposerTypeFocus(event, {
        composerFocused: composer !== null && document.activeElement === composer,
        composerAvailable: composerCanAcceptTyping(composer),
        composerWritable: Boolean(composer && !composer.disabled && !composer.readOnly),
        editable: isEditableTypingTarget(event.target),
        overlayOpen: typingRedirectBlockedByOverlay(document),
        reservedSurface:
          isReservedTypingSurface(event.target) ||
          Boolean(
            !scope &&
              event.target instanceof Element &&
              event.target.closest(".assistant-dock-panel"),
          ),
        composing: event.isComposing || event.key === "Dead",
      });
      if (decision.action === "ignore" || !composer) return;
      composer.focus({ preventScroll: true });
      if (decision.action === "focus-and-insert") {
        event.preventDefault();
        insertTextIntoTextarea(composer, decision.text);
      } else {
        event.preventDefault();
      }
    };
    document.addEventListener("keydown", onKeyDown, true);
    return () => document.removeEventListener("keydown", onKeyDown, true);
  }, [enabled, inputRef, scopeRef]);
}
