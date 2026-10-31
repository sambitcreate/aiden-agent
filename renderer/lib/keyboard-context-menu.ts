import type * as React from "react";

/** Shift+F10 or the Menu key: the keys that open a right-click menu. */
export function isContextMenuKey(event: Pick<KeyboardEvent, "key" | "shiftKey">): boolean {
  return (event.shiftKey && event.key === "F10") || event.key === "ContextMenu";
}

/**
 * Shift+F10 and the Menu key open a right-click menu where the platform
 * doesn't (macOS sends no contextmenu for them), anchored under the focused
 * control, or under the menu's own target when focus is on it.
 */
export function openContextMenuFromKeyboard(event: React.KeyboardEvent<HTMLElement>): void {
  if (event.defaultPrevented || !isContextMenuKey(event)) return;
  event.preventDefault();
  const focused = event.target instanceof HTMLElement ? event.target : event.currentTarget;
  const rect = focused.getBoundingClientRect();
  focused.dispatchEvent(
    new MouseEvent("contextmenu", {
      bubbles: true,
      cancelable: true,
      clientX: rect.left + 16,
      clientY: rect.bottom,
    }),
  );
}
