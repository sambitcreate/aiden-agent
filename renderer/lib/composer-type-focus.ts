// Redirect ordinary typing into the chat composer when the user is not already
// in another text field, overlay, or reserved surface.

export interface ComposerTypeFocusEvent {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  defaultPrevented?: boolean;
  isComposing?: boolean;
  repeat?: boolean;
}

export interface ComposerTypeFocusContext {
  composerFocused: boolean;
  composerAvailable: boolean;
  composerWritable: boolean;
  editable: boolean;
  overlayOpen: boolean;
  reservedSurface: boolean;
  composing: boolean;
}

export type ComposerTypeFocusDecision =
  | { action: "ignore" }
  | { action: "focus" }
  | { action: "focus-and-insert"; text: string };

const NON_TEXT_KEYS = new Set([
  "Alt",
  "AltGraph",
  "CapsLock",
  "Compose",
  "Control",
  "Dead",
  "Delete",
  "End",
  "Enter",
  "Escape",
  "Fn",
  "FnLock",
  "Help",
  "Home",
  "Hyper",
  "Insert",
  "Meta",
  "NumLock",
  "OS",
  "PageDown",
  "PageUp",
  "Pause",
  "PrintScreen",
  "Process",
  "ScrollLock",
  "Shift",
  "Super",
  "Symbol",
  "SymbolLock",
  "Tab",
  "Unidentified",
  "ArrowDown",
  "ArrowLeft",
  "ArrowRight",
  "ArrowUp",
  "Backspace",
  "ContextMenu",
]);

export function composerInsertTextFromKey(key: string): string | null {
  if (NON_TEXT_KEYS.has(key) || /^F\d{1,2}$/u.test(key)) return null;
  if (key.length !== 1) return null;
  return key.charCodeAt(0) >= 32 ? key : null;
}

export function isEditableTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable || Boolean(target.closest("[contenteditable='true']"))) return true;
  if (target.closest("[role='textbox'], [role='searchbox']")) return true;
  const tag = target.tagName;
  if (tag === "TEXTAREA" || tag === "SELECT") return true;
  if (tag !== "INPUT") return Boolean(target.closest("[role='combobox']"));
  const type = target instanceof HTMLInputElement ? target.type : "text";
  return ![
    "button",
    "checkbox",
    "color",
    "file",
    "hidden",
    "image",
    "radio",
    "range",
    "reset",
    "submit",
  ].includes(type);
}

export function isReservedTypingSurface(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  return Boolean(
    target.closest(
      "[data-command-scope='terminal'], .ghostty-screen, [data-command-scope='fileEditor'], [data-shortcut-recorder='true']",
    ),
  );
}

export function typingRedirectBlockedByOverlay(root: ParentNode): boolean {
  return Boolean(
    root.querySelector('[data-slot="dialog-content"][data-state="open"]') ||
      root.querySelector('[data-slot="popover-content"][data-state="open"]') ||
      root.querySelector('[role="menu"][data-state="open"]'),
  );
}

export function composerCanAcceptTyping(composer: HTMLTextAreaElement | null): boolean {
  return Boolean(
    composer?.isConnected &&
      composer.getClientRects().length > 0 &&
      !composer.closest("[inert], [aria-hidden='true']"),
  );
}

export function decideComposerTypeFocus(
  event: ComposerTypeFocusEvent,
  context: ComposerTypeFocusContext,
): ComposerTypeFocusDecision {
  if (
    !context.composerAvailable ||
    context.composerFocused ||
    context.editable ||
    context.overlayOpen ||
    context.reservedSurface ||
    context.composing ||
    event.defaultPrevented ||
    event.isComposing ||
    event.metaKey ||
    event.ctrlKey ||
    event.altKey
  ) {
    return { action: "ignore" };
  }
  const text = composerInsertTextFromKey(event.key);
  if (text === null) return { action: "ignore" };
  if (!context.composerWritable) return { action: "focus" };
  return { action: "focus-and-insert", text };
}

export function insertTextIntoTextarea(textarea: HTMLTextAreaElement, text: string): void {
  if (textarea.disabled || textarea.readOnly || text.length === 0) return;
  const start = textarea.selectionStart ?? textarea.value.length;
  const end = textarea.selectionEnd ?? start;
  const next = `${textarea.value.slice(0, start)}${text}${textarea.value.slice(end)}`;
  const descriptor = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value");
  descriptor?.set?.call(textarea, next);
  textarea.dispatchEvent(
    new InputEvent("input", { bubbles: true, data: text, inputType: "insertText" }),
  );
  const caret = start + text.length;
  textarea.setSelectionRange(caret, caret);
}
