// The formatting bar above a selected note or text item: type size, text
// colour, bold, italic, underline, a link, bullet and numbered lists, a
// note's colour, and Comment. Bold through lists work on the selected words
// (or on all of them when nothing is being edited); size and colours apply
// to the whole note or text item.

import { NodeToolbar, Position } from "@xyflow/react";
import {
  ALargeSmall,
  Bold,
  ChevronDown,
  Italic,
  Link,
  List,
  ListOrdered,
  MessageCircle,
  PaintBucket,
  Underline,
} from "lucide-react";
import * as React from "react";
import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
  Input,
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "../../components/ui";
import { linkFromInput } from "../../shared/design-canvas/rich-text";
import { DESIGN_COLORS, type DesignColor, type DesignFrame, type DesignTextSize } from "../../shared/design-canvas/schema";
import { useDesignNodeContext } from "./design-node-context";
import { designColorVar, designFillVar } from "./draw-style";
import type { RichTextCommand, RichTextEditorHandle, RichTextState } from "./rich-text-editor";

/** Marks the bar and its menus, so an editor that loses focus to them keeps editing. */
export const FORMAT_BAR_ATTRIBUTE = "data-design-format-bar";

/** True when focus moved into the format bar or one of its menus. */
export function focusInFormatBar(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest(`[${FORMAT_BAR_ATTRIBUTE}]`) !== null;
}

const COLOR_NAMES: Record<DesignColor, string> = {
  ink: "Default",
  gray: "Gray",
  blue: "Blue",
  green: "Green",
  yellow: "Yellow",
  red: "Red",
  purple: "Purple",
  teal: "Teal",
  pink: "Pink",
};
const NOTE_COLORS: readonly DesignColor[] = ["yellow", "green", "blue", "purple", "pink", "red", "teal", "gray"];
const SIZES: readonly { size: DesignTextSize; label: string }[] = [
  { size: "small", label: "Small" },
  { size: "medium", label: "Medium" },
  { size: "large", label: "Large" },
];

const MOD = typeof navigator !== "undefined" && /Mac/.test(navigator.platform) ? "⌘" : "Ctrl+";

/**
 * Escape or ⌘↩ inside an editor hands the keyboard back to the canvas. (⌘K
 * stays the app's command palette, so links come from the bar's button.)
 */
export function richEditorKeyDown(event: React.KeyboardEvent<HTMLElement>) {
  if (event.nativeEvent.isComposing) return;
  if (event.key === "Escape" || (event.key === "Enter" && (event.metaKey || event.ctrlKey))) {
    event.preventDefault();
    event.stopPropagation();
    const field = event.currentTarget;
    const canvasRegion = field.closest<HTMLElement>(".studio-canvas");
    field.blur();
    canvasRegion?.focus({ preventScroll: true });
  }
}

type FormatBarProps = {
  frame: DesignFrame;
  editor: React.RefObject<RichTextEditorHandle | null>;
  /** The editor has the words: commands apply to its selection. */
  editing: boolean;
  /** Starts editing with every word selected, then runs `command` if there is one. */
  onEdit(command?: RichTextCommand): void;
  /** Focus left the bar and the editor for somewhere else. */
  onLeave(): void;
  state: RichTextState;
  linkOpen: boolean;
  onLinkOpenChange(open: boolean): void;
  /** Shown even when the frame is not the one selected (its words are being edited). */
  forceVisible: boolean;
};

export function FormatBar({
  frame,
  editor,
  editing,
  onEdit,
  onLeave,
  state,
  linkOpen,
  onLinkOpenChange,
  forceVisible,
}: FormatBarProps) {
  const canvas = useDesignNodeContext();
  const isNote = frame.kind === "note";
  const size = frame.size ?? (isNote ? "small" : "medium");
  const kind = isNote ? "Note" : "Text";

  const run = (command: RichTextCommand) => {
    const handle = editor.current;
    if (editing && handle) {
      if (!handle.element?.contains(document.activeElement)) handle.restoreSelection();
      handle.run(command);
    } else {
      onEdit(command);
    }
  };

  // Menus hand the focus back to the editor (and its selection) when they close.
  const backToEditor = (event: Event) => {
    event.preventDefault();
    if (editing) editor.current?.restoreSelection();
  };
  const keepSelection = () => {
    if (editing) editor.current?.saveSelection();
  };

  const mark = (label: string, key: string, command: RichTextCommand, on: boolean, Icon: typeof Bold) => (
    <Button
      variant={on ? "muted" : "transparent"}
      iconOnly
      aria-label={label}
      aria-pressed={on}
      title={key ? `${label} (${MOD}${key})` : label}
      // The editor keeps its selection: the click must not take the focus.
      onMouseDown={(event) => event.preventDefault()}
      onClick={() => run(command)}
    >
      <Icon />
    </Button>
  );

  return (
    <NodeToolbar
      isVisible={forceVisible ? true : undefined}
      position={Position.Top}
      align="start"
      offset={10}
      className="nodrag nopan nowheel"
    >
      <div
        role="toolbar"
        aria-label={`${kind} formatting`}
        {...{ [FORMAT_BAR_ATTRIBUTE]: "" }}
        className="flex items-center gap-0.5 rounded-button bg-popover p-1 shadow-control"
        onBlur={(event) => {
          const next = event.relatedTarget;
          if (focusInFormatBar(next)) return;
          if (next instanceof Node && editor.current?.element?.contains(next)) return;
          // A menu or the link field opening moves the focus into a portal that carries the attribute too.
          if (next === null && (linkOpen || document.activeElement?.closest(`[${FORMAT_BAR_ATTRIBUTE}]`))) return;
          onLeave();
        }}
      >
        <DropdownMenu onOpenChange={(open) => open && keepSelection()}>
          <DropdownMenuTrigger asChild>
            <Button variant="transparent" size="small" aria-label={`Text size: ${size}`} title="Text size" className="gap-0.5 px-1.5">
              <ALargeSmall />
              <ChevronDown aria-hidden className="size-3 text-secondary" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" {...{ [FORMAT_BAR_ATTRIBUTE]: "" }} onCloseAutoFocus={backToEditor}>
            <DropdownMenuLabel>Text size</DropdownMenuLabel>
            <DropdownMenuRadioGroup
              value={size}
              onValueChange={(value) => canvas.update(frame.id, { size: value as DesignTextSize }, { record: true })}
            >
              {SIZES.map((entry) => (
                <DropdownMenuRadioItem key={entry.size} value={entry.size}>
                  {entry.label}
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
          </DropdownMenuContent>
        </DropdownMenu>
        <ColorMenu
          label="Text colour"
          value={frame.color ?? "ink"}
          colors={DESIGN_COLORS}
          swatch={designColorVar}
          onOpen={keepSelection}
          onCloseAutoFocus={backToEditor}
          onChange={(color) =>
            canvas.update(frame.id, { color: color === "ink" || color === "none" ? undefined : color }, { record: true })
          }
          trigger={
            <span
              aria-hidden
              className="block size-4 rounded-full"
              style={{ background: designColorVar(frame.color ?? "ink") }}
            />
          }
        />
        <div aria-hidden className="mx-1 h-5 w-px shrink-0 bg-separator" />
        {mark("Bold", "B", "bold", state.bold, Bold)}
        {mark("Italic", "I", "italic", state.italic, Italic)}
        {mark("Underline", "U", "underline", state.underline, Underline)}
        <LinkButton
          editor={editor}
          editing={editing}
          current={state.link}
          open={linkOpen}
          onOpenChange={onLinkOpenChange}
          onApply={(href) => run({ link: href })}
        />
        <div aria-hidden className="mx-1 h-5 w-px shrink-0 bg-separator" />
        {mark("Bulleted list", "", "bullets", state.bullets, List)}
        {mark("Numbered list", "", "numbers", state.numbers, ListOrdered)}
        {isNote ? (
          <>
            <div aria-hidden className="mx-1 h-5 w-px shrink-0 bg-separator" />
            <ColorMenu
              label="Note colour"
              value={frame.fill ?? "none"}
              colors={NOTE_COLORS}
              swatch={designFillVar}
              withDefault
              onOpen={keepSelection}
              onCloseAutoFocus={backToEditor}
              onChange={(color) => canvas.update(frame.id, { fill: color === "none" ? undefined : color }, { record: true })}
              trigger={<PaintBucket />}
            />
          </>
        ) : null}
        <div aria-hidden className="mx-1 h-5 w-px shrink-0 bg-separator" />
        <Button
          variant="transparent"
          iconOnly
          aria-label={`Comment on this ${kind.toLowerCase()}`}
          title="Comment"
          onClick={() => canvas.comment(frame.id)}
        >
          <MessageCircle />
        </Button>
      </div>
    </NodeToolbar>
  );
}

function ColorMenu({
  label,
  value,
  colors,
  swatch,
  withDefault = false,
  trigger,
  onOpen,
  onCloseAutoFocus,
  onChange,
}: {
  label: string;
  value: DesignColor | "none";
  colors: readonly DesignColor[];
  swatch(color: DesignColor): string;
  /** A "Default" row that takes the colour off. */
  withDefault?: boolean;
  trigger: React.ReactNode;
  onOpen(): void;
  onCloseAutoFocus(event: Event): void;
  onChange(color: DesignColor | "none"): void;
}) {
  const shown = value === "none" ? "Default" : COLOR_NAMES[value];
  return (
    <DropdownMenu onOpenChange={(open) => open && onOpen()}>
      <DropdownMenuTrigger asChild>
        <Button variant="transparent" size="small" aria-label={`${label}: ${shown}`} title={label} className="gap-0.5 px-1.5">
          {trigger}
          <ChevronDown aria-hidden className="size-3 text-secondary" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="min-w-40" {...{ [FORMAT_BAR_ATTRIBUTE]: "" }} onCloseAutoFocus={onCloseAutoFocus}>
        <DropdownMenuLabel>{label}</DropdownMenuLabel>
        <DropdownMenuRadioGroup value={value} onValueChange={(next) => onChange(next as DesignColor | "none")}>
          {withDefault ? (
            <DropdownMenuRadioItem value="none">
              <span aria-hidden className="size-3.5 rounded-full bg-popover shadow-control" />
              Default
            </DropdownMenuRadioItem>
          ) : null}
          {colors.map((color) => (
            <DropdownMenuRadioItem key={color} value={color}>
              <span aria-hidden className="size-3.5 rounded-full" style={{ background: swatch(color) }} />
              {COLOR_NAMES[color]}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function LinkButton({
  editor,
  editing,
  current,
  open,
  onOpenChange,
  onApply,
}: {
  editor: React.RefObject<RichTextEditorHandle | null>;
  editing: boolean;
  current: string | null;
  open: boolean;
  onOpenChange(open: boolean): void;
  onApply(href: string | null): void;
}) {
  const [draft, setDraft] = React.useState("");
  const [invalid, setInvalid] = React.useState(false);
  const applied = React.useRef(false);

  React.useEffect(() => {
    if (!open) return;
    applied.current = false;
    setDraft(current ?? "");
    setInvalid(false);
  }, [open, current]);

  const close = (href: string | null) => {
    applied.current = true;
    onOpenChange(false);
    // The editor gets its selection back first, then the link goes on it.
    if (editing) editor.current?.restoreSelection();
    onApply(href);
  };

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        if (next && editing) editor.current?.saveSelection();
        onOpenChange(next);
      }}
    >
      <PopoverTrigger asChild>
        <Button
          variant={current ? "muted" : "transparent"}
          iconOnly
          aria-label="Link"
          aria-pressed={current !== null}
          title="Link"
          onMouseDown={(event) => event.preventDefault()}
        >
          <Link />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className="w-72 p-2"
        aria-label="Link"
        {...{ [FORMAT_BAR_ATTRIBUTE]: "" }}
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          if (!applied.current && editing) editor.current?.restoreSelection();
        }}
      >
        <form
          className="flex flex-col gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            if (!draft.trim()) {
              close(null);
              return;
            }
            const href = linkFromInput(draft);
            if (!href) {
              setInvalid(true);
              return;
            }
            close(href);
          }}
        >
          <Input
            autoFocus
            aria-label="Link address"
            aria-invalid={invalid || undefined}
            placeholder="https://example.com"
            value={draft}
            onChange={(event) => {
              setDraft(event.target.value);
              setInvalid(false);
            }}
          />
          {invalid ? <p className="px-1 text-secondary">Use a web or email address.</p> : null}
          <div className="flex justify-end gap-1">
            {current ? (
              <Button type="button" variant="transparent" size="small" onClick={() => close(null)}>
                Remove link
              </Button>
            ) : null}
            <Button type="submit" size="small">
              {current ? "Save" : "Add link"}
            </Button>
          </div>
        </form>
      </PopoverContent>
    </Popover>
  );
}
