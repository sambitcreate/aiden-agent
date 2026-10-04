// Decides when a key press inside a dialog should run its primary (confirm) action.
// Plain Enter confirms from a single-line text field; Mod+Enter confirms from anywhere,
// including multi-line text. Native forms and widgets that own Enter are left alone.

export type DialogEnterKey = {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  isComposing: boolean;
  defaultPrevented: boolean;
};

export type DialogEnterTarget = {
  tagName: string;
  /** The `type` of an input element; ignored for other elements. */
  type?: string;
  role?: string | null;
  /** Whether the element sits inside a `<form>`, whose own submit handles Enter. */
  inForm: boolean;
};

const SINGLE_LINE_INPUT_TYPES = new Set([
  "",
  "text",
  "search",
  "email",
  "url",
  "tel",
  "password",
  "number",
]);

export function shouldSubmitDialogOnEnter(
  key: DialogEnterKey,
  target: DialogEnterTarget,
): boolean {
  if (key.key !== "Enter" || key.isComposing || key.defaultPrevented) return false;
  if (key.shiftKey || key.altKey) return false;
  if (target.inForm) return false;
  if (key.metaKey || key.ctrlKey) return true;
  if (target.role === "combobox") return false;
  return (
    target.tagName.toUpperCase() === "INPUT" &&
    SINGLE_LINE_INPUT_TYPES.has((target.type ?? "").toLowerCase())
  );
}

export function dialogEnterTarget(element: Element): DialogEnterTarget {
  return {
    tagName: element.tagName,
    type: element.tagName === "INPUT" ? (element.getAttribute("type") ?? "") : undefined,
    role: element.getAttribute("role"),
    inForm: element.closest("form") !== null,
  };
}
