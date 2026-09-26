import * as React from "react";
import {
  composerCanAcceptTyping,
  decideComposerTypeFocus,
  insertTextIntoTextarea,
  isEditableTypingTarget,
  isActivationControl,
  isReservedTypingSurface,
  typingRedirectBlockedByOverlay,
} from "./composer-type-focus";

export function useComposerTypeFocus(
  inputRef: React.RefObject<HTMLTextAreaElement | null>,
  enabled = true,
): void {
  React.useEffect(() => {
    if (!enabled) return;
    const onKeyDown = (event: KeyboardEvent) => {
      const composer = inputRef.current;
      const decision = decideComposerTypeFocus(event, {
        composerFocused: composer !== null && document.activeElement === composer,
        composerAvailable: composerCanAcceptTyping(composer),
        composerWritable: Boolean(composer && !composer.disabled && !composer.readOnly),
        editable: isEditableTypingTarget(event.target),
        overlayOpen: typingRedirectBlockedByOverlay(
          document,
          document.activeElement instanceof Element ? document.activeElement : null,
        ),
        reservedSurface: isReservedTypingSurface(event.target),
        composing: event.isComposing || event.key === "Dead" || event.keyCode === 229,
        activationControl:
          isActivationControl(event.target) || isActivationControl(document.activeElement),
      });
      if (decision.action === "ignore" || !composer) return;
      event.preventDefault();
      composer.focus({ preventScroll: true });
      if (decision.action === "focus-and-insert") insertTextIntoTextarea(composer, decision.text);
    };
    document.addEventListener("keydown", onKeyDown, true);
    return () => document.removeEventListener("keydown", onKeyDown, true);
  }, [enabled, inputRef]);
}
