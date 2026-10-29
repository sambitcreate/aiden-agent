import * as React from "react";
import { isMacPlatform } from "./ghostty-terminal/host-platform";
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
      // The page checks are getters: most keys (typing in the composer,
      // shortcuts) are settled before any of them runs.
      const decision = decideComposerTypeFocus({
        key: event.key,
        metaKey: event.metaKey,
        ctrlKey: event.ctrlKey,
        altKey: event.altKey,
        altGraph: event.getModifierState("AltGraph"),
        defaultPrevented: event.defaultPrevented,
        isComposing: event.isComposing,
        repeat: event.repeat,
        keyCode: event.keyCode,
      }, {
        macOS: isMacPlatform(),
        composing: event.isComposing || event.key === "Dead" || event.keyCode === 229,
        get composerFocused() {
          return composer !== null && document.activeElement === composer;
        },
        get composerAvailable() {
          return composerCanAcceptTyping(composer);
        },
        get composerWritable() {
          return Boolean(composer && !composer.disabled && !composer.readOnly);
        },
        get editable() {
          return isEditableTypingTarget(event.target);
        },
        get overlayOpen() {
          return typingRedirectBlockedByOverlay(
            document,
            document.activeElement instanceof Element ? document.activeElement : null,
          );
        },
        get reservedSurface() {
          return isReservedTypingSurface(event.target);
        },
        get activationControl() {
          return isActivationControl(event.target) || isActivationControl(document.activeElement);
        },
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
