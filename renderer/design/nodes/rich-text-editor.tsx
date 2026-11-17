// The editor for a note's or a text item's words: a contenteditable box that
// starts from the stored Markdown and hands back Markdown after each change.
// Formatting comes from the browser's own editing commands, ⌘B, ⌘I and ⌘U
// included, and pasting keeps only the plain words.

import * as React from "react";
import { cn } from "../../lib/ui-utils";
import { richTextHtml, serializeRichText } from "../../shared/design-canvas/rich-text";
import { readRichDom } from "../rich-text-dom";

export type RichTextCommand = "bold" | "italic" | "underline" | "bullets" | "numbers" | { link: string | null };

export type RichTextState = {
  bold: boolean;
  italic: boolean;
  underline: boolean;
  bullets: boolean;
  numbers: boolean;
  link: string | null;
};

export const NO_RICH_TEXT_STATE: RichTextState = {
  bold: false,
  italic: false,
  underline: false,
  bullets: false,
  numbers: false,
  link: null,
};

export type RichTextEditorHandle = {
  element: HTMLElement | null;
  /** Focuses the editor; `all` selects every word, else the caret goes to the end. */
  focus(all?: boolean): void;
  run(command: RichTextCommand): void;
  /** What the selection is now: which marks it has and the link it is in. */
  state(): RichTextState;
  /** Keeps the selection while something else (a link field) takes the focus. */
  saveSelection(): void;
  restoreSelection(): void;
};

type Props = {
  value: string;
  onChange(value: string): void;
  label: string;
  placeholder: string;
  maxLength: number;
  className?: string;
  style?: React.CSSProperties;
  autoFocus?: boolean;
  onFocus?(): void;
  onBlur?(event: React.FocusEvent<HTMLDivElement>): void;
  onKeyDown?(event: React.KeyboardEvent<HTMLDivElement>): void;
  /** The selection moved or the words changed, so the format bar can show what is on. */
  onSelectionChange?(): void;
};

const COMMANDS = {
  bold: "bold",
  italic: "italic",
  underline: "underline",
  bullets: "insertUnorderedList",
  numbers: "insertOrderedList",
} as const;

const escapeAttribute = (value: string) => value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");

export const RichTextEditor = React.forwardRef<RichTextEditorHandle, Props>(function RichTextEditor(
  { value, onChange, label, placeholder, maxLength, className, style, autoFocus, onFocus, onBlur, onKeyDown, onSelectionChange },
  ref,
) {
  const box = React.useRef<HTMLDivElement | null>(null);
  // The Markdown the editor last showed or sent, so a change from elsewhere
  // (undo, Aiden) is drawn again and the person's own typing is not.
  const shown = React.useRef<string | null>(null);
  const saved = React.useRef<Range | null>(null);
  const changeRef = React.useRef(onChange);
  changeRef.current = onChange;
  const selectionRef = React.useRef(onSelectionChange);
  selectionRef.current = onSelectionChange;

  React.useLayoutEffect(() => {
    const element = box.current;
    if (!element || shown.current === value) return;
    shown.current = value;
    element.innerHTML = richTextHtml(value);
  }, [value]);

  const emit = React.useCallback(() => {
    const element = box.current;
    if (!element) return;
    const next = serializeRichText(readRichDom(element));
    if (next.length > maxLength) {
      // Too long: take the last edit back rather than cutting words off.
      document.execCommand("undo");
      return;
    }
    if (next === shown.current) return;
    shown.current = next;
    changeRef.current(next);
  }, [maxLength]);

  const handle = React.useMemo<RichTextEditorHandle>(
    () => ({
      get element() {
        return box.current;
      },
      focus(all = false) {
        const element = box.current;
        if (!element) return;
        element.focus({ preventScroll: true });
        const selection = window.getSelection();
        if (!selection) return;
        const range = document.createRange();
        range.selectNodeContents(element);
        if (!all) range.collapse(false);
        selection.removeAllRanges();
        selection.addRange(range);
      },
      run(command) {
        const element = box.current;
        if (!element) return;
        if (document.activeElement !== element) element.focus({ preventScroll: true });
        if (typeof command === "object") {
          const selection = window.getSelection();
          if (command.link === null) {
            const anchor = selectionLink(element);
            if (anchor && selection) {
              // Unlink the whole link the caret is in, not just the selected part.
              const range = document.createRange();
              range.selectNodeContents(anchor);
              selection.removeAllRanges();
              selection.addRange(range);
            }
            document.execCommand("unlink");
          } else if (!selection || selection.isCollapsed) {
            const href = escapeAttribute(command.link);
            document.execCommand("insertHTML", false, `<a href="${href}">${href}</a>`);
          } else {
            document.execCommand("createLink", false, command.link);
          }
        } else {
          document.execCommand(COMMANDS[command]);
        }
        emit();
        selectionRef.current?.();
      },
      state() {
        const element = box.current;
        if (!element || !element.contains(window.getSelection()?.anchorNode ?? null)) return NO_RICH_TEXT_STATE;
        return {
          bold: document.queryCommandState("bold"),
          italic: document.queryCommandState("italic"),
          underline: document.queryCommandState("underline"),
          bullets: document.queryCommandState("insertUnorderedList"),
          numbers: document.queryCommandState("insertOrderedList"),
          link: selectionLink(element)?.getAttribute("href") ?? null,
        };
      },
      saveSelection() {
        const selection = window.getSelection();
        const element = box.current;
        saved.current =
          selection && selection.rangeCount > 0 && element?.contains(selection.anchorNode)
            ? selection.getRangeAt(0).cloneRange()
            : null;
      },
      restoreSelection() {
        const element = box.current;
        if (!element) return;
        element.focus({ preventScroll: true });
        const selection = window.getSelection();
        if (saved.current && selection) {
          selection.removeAllRanges();
          selection.addRange(saved.current);
        }
      },
    }),
    [emit],
  );
  React.useImperativeHandle(ref, () => handle, [handle]);

  React.useEffect(() => {
    if (autoFocus) handle.focus();
  }, [autoFocus, handle]);

  // ⌘B, ⌘I and ⌘U (Ctrl elsewhere) format the words here. The app binds ⌘B
  // to the sidebar from anywhere, so the editor takes these keys first, in
  // the window's capture phase, and marks them handled.
  React.useEffect(() => {
    const mac = /Mac/.test(navigator.platform);
    const formatKey = (event: KeyboardEvent) => {
      const element = box.current;
      if (!element || !(event.target instanceof Node) || !element.contains(event.target)) return;
      if (event.isComposing || event.shiftKey || event.altKey) return;
      if (!(mac ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey)) return;
      const command = ({ b: "bold", i: "italic", u: "underline" } as const)[event.key.toLowerCase()];
      if (!command) return;
      event.preventDefault();
      handle.run(command);
    };
    window.addEventListener("keydown", formatKey, true);
    return () => window.removeEventListener("keydown", formatKey, true);
  }, [handle]);

  // The format bar follows the caret while the editor has it.
  React.useEffect(() => {
    const changed = () => {
      if (box.current && box.current.contains(window.getSelection()?.anchorNode ?? null)) selectionRef.current?.();
    };
    document.addEventListener("selectionchange", changed);
    return () => document.removeEventListener("selectionchange", changed);
  }, []);

  return (
    <div className={cn("relative h-full w-full", className)} style={style}>
      {value === "" ? (
        <span aria-hidden className="pointer-events-none absolute left-0 top-0 text-tertiary">
          {placeholder}
        </span>
      ) : null}
      <div
        ref={box}
        role="textbox"
        aria-multiline="true"
        aria-label={label}
        contentEditable
        suppressContentEditableWarning
        spellCheck
        className="design-rich-text nodrag nopan nowheel relative h-full w-full cursor-text whitespace-pre-wrap break-words outline-none"
        onInput={emit}
        onFocus={onFocus}
        onBlur={onBlur}
        onKeyDown={onKeyDown}
        onPaste={(event) => {
          event.preventDefault();
          const text = event.clipboardData.getData("text/plain");
          if (text) document.execCommand("insertText", false, text);
        }}
        onDrop={(event) => {
          // Dropped markup would bring its own styles; dropped words come in plain.
          event.preventDefault();
          const text = event.dataTransfer.getData("text/plain");
          if (text) document.execCommand("insertText", false, text);
        }}
        onDoubleClick={(event) => event.stopPropagation()}
      />
    </div>
  );
});

function selectionLink(root: HTMLElement): HTMLAnchorElement | null {
  let node: Node | null = window.getSelection()?.anchorNode ?? null;
  while (node && node !== root) {
    if (node instanceof HTMLAnchorElement) return node;
    node = node.parentNode;
  }
  return null;
}
