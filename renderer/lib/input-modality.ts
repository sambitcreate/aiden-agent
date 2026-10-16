// Remember whether the person last used the keyboard or a pointer, so focus
// rings only draw for keyboard navigation. Chromium matches :focus-visible on
// script focus that follows a click (Radix menus focus the hovered row, dialogs
// focus their first control), which drew a ring under the mouse.

export type InputModality = "keyboard" | "pointer";

export const INPUT_MODALITY_ATTRIBUTE = "data-input-modality";

export interface InputModalityKeyEvent {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
}

/** The modality a keydown implies, or null when it should not change it. */
export function modalityFromKeydown(event: InputModalityKeyEvent): InputModality | null {
  // Bare modifiers and ⌘/Ctrl/Alt chords are shortcuts and clicks with a
  // modifier held, not navigation, so they keep whatever was in use.
  if (event.key === "Meta" || event.key === "Control" || event.key === "Alt" || event.key === "Shift") return null;
  if (event.metaKey || event.ctrlKey || event.altKey) return null;
  return "keyboard";
}

// Menus and listboxes move focus to the row under a moving pointer, so moving
// the mouse there is pointer navigation even without a click. Elsewhere a
// moving mouse leaves a keyboard user's ring alone.
const HOVER_FOCUS_CONTAINER = '[role="menu"], [role="menubar"], [role="listbox"]';

export interface InputModalityPointerMove {
  movementX: number;
  movementY: number;
  target: EventTarget | null;
}

/** Whether a pointermove is the person steering hover focus in a menu. */
export function pointerMoveSteersFocus(event: InputModalityPointerMove): boolean {
  // Chromium sends zero-movement moves when content shifts under a still cursor.
  if (event.movementX === 0 && event.movementY === 0) return false;
  const target = event.target as { closest?: (selector: string) => unknown } | null;
  return typeof target?.closest === "function" && target.closest(HOVER_FOCUS_CONTAINER) !== null;
}

/** Track the modality on `<html>` for the lifetime of the window. */
export function installInputModality(doc: Document = document): () => void {
  const root = doc.documentElement;
  const set = (modality: InputModality) => {
    if (root.getAttribute(INPUT_MODALITY_ATTRIBUTE) !== modality) root.setAttribute(INPUT_MODALITY_ATTRIBUTE, modality);
  };
  const onKeydown = (event: KeyboardEvent) => {
    const modality = modalityFromKeydown(event);
    if (modality) set(modality);
  };
  const onPointerdown = () => set("pointer");
  const onPointermove = (event: PointerEvent) => {
    if (pointerMoveSteersFocus(event)) set("pointer");
  };
  doc.addEventListener("keydown", onKeydown, true);
  doc.addEventListener("pointerdown", onPointerdown, true);
  doc.addEventListener("pointermove", onPointermove, true);
  return () => {
    doc.removeEventListener("keydown", onKeydown, true);
    doc.removeEventListener("pointerdown", onPointerdown, true);
    doc.removeEventListener("pointermove", onPointermove, true);
  };
}
