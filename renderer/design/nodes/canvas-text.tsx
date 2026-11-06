// Words on the canvas that are edited in place: a text item, or a shape's
// label. Double-click or Enter starts editing; leaving the field or Escape
// stops. Each round of editing is one undo step. A text item grows to fit
// its words; one left empty goes away.

import * as React from "react";
import { cn } from "../../lib/ui-utils";
import { DESIGN_CANVAS_LIMITS, type DesignFrame } from "../../shared/design-canvas/schema";
import { useDesignNodeContext } from "./design-node-context";

export function CanvasText({
  frame,
  label,
  placeholder,
  className,
  style,
  grow = false,
  removeWhenEmpty = false,
}: {
  frame: DesignFrame;
  /** The editing field's accessible name. */
  label: string;
  placeholder: string;
  className?: string;
  style?: React.CSSProperties;
  /** The frame grows taller to fit its words (it never shrinks on its own). */
  grow?: boolean;
  removeWhenEmpty?: boolean;
}) {
  const canvas = useDesignNodeContext();
  const editing = canvas.editing === frame.id;
  const box = React.useRef<HTMLElement | null>(null);
  const startsUndoStep = React.useRef(true);
  const text = frame.text ?? "";
  const { update } = canvas;

  React.useLayoutEffect(() => {
    if (!grow || !box.current) return;
    const needed = Math.ceil(box.current.scrollHeight);
    if (needed > frame.h + 0.5) update(frame.id, { h: needed }, { record: false });
  }, [grow, text, frame.w, frame.h, frame.id, editing, update]);

  if (!editing) {
    return (
      <div
        ref={(element) => {
          box.current = element;
        }}
        className={cn("h-full w-full whitespace-pre-wrap break-words", className)}
        style={style}
        onDoubleClick={(event) => {
          event.stopPropagation();
          canvas.edit(frame.id);
        }}
      >
        {text || <span className="text-tertiary">{placeholder}</span>}
      </div>
    );
  }

  const finish = (field: HTMLTextAreaElement) => {
    canvas.edit(null);
    if (removeWhenEmpty && !field.value.trim()) canvas.remove(frame.id);
  };
  return (
    <textarea
      ref={(element) => {
        box.current = element;
      }}
      aria-label={label}
      value={text}
      maxLength={DESIGN_CANVAS_LIMITS.noteChars}
      placeholder={placeholder}
      autoFocus
      onFocus={(event) => {
        startsUndoStep.current = true;
        const end = event.currentTarget.value.length;
        event.currentTarget.setSelectionRange(end, end);
      }}
      onChange={(event) => {
        update(frame.id, { text: event.target.value }, { record: startsUndoStep.current });
        startsUndoStep.current = false;
      }}
      onBlur={(event) => finish(event.currentTarget)}
      onKeyDown={(event) => {
        if (event.nativeEvent.isComposing) return;
        if (event.key === "Escape" || (event.key === "Enter" && (event.metaKey || event.ctrlKey))) {
          event.preventDefault();
          event.stopPropagation();
          const field = event.currentTarget;
          const canvasRegion = field.closest<HTMLElement>(".studio-canvas");
          field.blur();
          canvasRegion?.focus({ preventScroll: true });
        }
      }}
      onDoubleClick={(event) => event.stopPropagation()}
      className={cn(
        "nodrag nopan nowheel block h-full w-full resize-none overflow-hidden bg-transparent outline-none placeholder:text-tertiary",
        className,
      )}
      style={style}
    />
  );
}
