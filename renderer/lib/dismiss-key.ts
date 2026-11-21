// Escape that should close something. An input method (Japanese, Chinese,
// Korean) uses Escape to cancel its composition: that press must never also
// close a field, a panel or a dialog.

/** The fields both a native and a React keyboard event carry. */
export interface DismissKeyEvent {
  key: string;
  keyCode?: number;
  defaultPrevented: boolean;
  isComposing?: boolean;
  nativeEvent?: { isComposing?: boolean };
}

/** An input method is composing; keyCode 229 is how Chromium marks its keys. */
export function isComposingKey(event: DismissKeyEvent): boolean {
  return event.isComposing === true || event.nativeEvent?.isComposing === true || event.keyCode === 229;
}

/**
 * Escape outside an input method's composition, handled or not. For a field's
 * own `onKeyDown` that must act even after the Radix layer around it ran first:
 * Radix listens on the document in the capture phase and marks the Escape it
 * dismisses with, or keeps open with, as handled.
 */
export function isEscapeKey(event: DismissKeyEvent): boolean {
  return event.key === "Escape" && !isComposingKey(event);
}

/** Escape that nothing nearer the focus has handled, outside a composition. */
export function isDismissKey(event: DismissKeyEvent): boolean {
  return isEscapeKey(event) && !event.defaultPrevented;
}
