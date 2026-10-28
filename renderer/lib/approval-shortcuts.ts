// Fixed keys for the approval waiting above the composer: ⌘↩ allows it once and
// ⌘⌫ denies it (Ctrl on Linux and Windows). They act only while the message box
// is empty, so they never take a key someone meant for their own text.

import * as React from "react";
import { detectedKeyboardPlatform, type KeyboardPlatform } from "../shared/keybindings";
import { isEditableTypingTarget, isReservedTypingSurface, typingRedirectBlockedByOverlay } from "./composer-type-focus";

export type ApprovalShortcut = "allow" | "deny";

type ShortcutKeyEvent = Pick<KeyboardEvent, "key" | "metaKey" | "ctrlKey" | "altKey" | "shiftKey" | "repeat">;

export function approvalShortcutForKey(event: ShortcutKeyEvent, platform: KeyboardPlatform): ApprovalShortcut | null {
  if (event.repeat || event.altKey || event.shiftKey) return null;
  const primary = platform === "darwin" ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;
  if (!primary) return null;
  if (event.key === "Enter") return "allow";
  if (event.key === "Backspace") return "deny";
  return null;
}

export function approvalShortcutLabel(shortcut: ApprovalShortcut, platform: KeyboardPlatform): string {
  if (platform === "darwin") return shortcut === "allow" ? "⌘↩" : "⌘⌫";
  return shortcut === "allow" ? "Ctrl+Enter" : "Ctrl+Backspace";
}

/** The `aria-keyshortcuts` value for a shortcut on this platform. */
export function approvalAriaKeyShortcut(shortcut: ApprovalShortcut, platform: KeyboardPlatform): string {
  return `${platform === "darwin" ? "Meta" : "Control"}+${shortcut === "allow" ? "Enter" : "Backspace"}`;
}

function editableText(target: Element): string | null {
  if (target instanceof HTMLTextAreaElement) return target.value;
  if (target instanceof HTMLInputElement) return target.value;
  if (target instanceof HTMLElement && target.isContentEditable) return target.textContent ?? "";
  return null;
}

// Any character counts, spaces included, and so does a staged attachment or skill,
// which the message box marks with a non-empty `data-message-draft`.
const holdsDraft = (element: Element) =>
  (editableText(element) ?? "") !== "" || (element.getAttribute("data-message-draft") ?? "") !== "";

/**
 * Whether the keys are free for the approval: focus is on the message box or
 * on something that takes no typing (never another text field, the terminal,
 * the file editor or a device screen), the message box is empty (no text, not
 * even spaces, and nothing attached) even after focus moves to a button, and no dialog, menu or picker is open on top.
 */
export function approvalShortcutTargetIsFree(target: EventTarget | null, root: ParentNode): boolean {
  const focused = target instanceof Element ? target : null;
  if (isReservedTypingSurface(focused)) return false;
  if (isEditableTypingTarget(focused) && !focused?.closest("[data-message-draft]")) return false;
  for (const draft of root.querySelectorAll("[data-message-draft]")) {
    if (holdsDraft(draft)) return false;
  }
  return !typingRedirectBlockedByOverlay(root, focused);
}

/** Listens for the approval keys while `enabled`. */
export function useApprovalShortcuts({
  enabled,
  canAllow,
  onShortcut,
}: {
  enabled: boolean;
  canAllow: boolean;
  onShortcut(shortcut: ApprovalShortcut): void;
}): void {
  const onShortcutRef = React.useRef(onShortcut);
  React.useEffect(() => {
    onShortcutRef.current = onShortcut;
  }, [onShortcut]);
  React.useEffect(() => {
    if (!enabled) return;
    const platform = detectedKeyboardPlatform();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing) return;
      const shortcut = approvalShortcutForKey(event, platform);
      if (!shortcut || (shortcut === "allow" && !canAllow)) return;
      if (!approvalShortcutTargetIsFree(event.target, document)) return;
      event.preventDefault();
      event.stopPropagation();
      onShortcutRef.current(shortcut);
    };
    // Capture, so the empty composer's own Enter handling never sees the key.
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [canAllow, enabled]);
}
