// A frame's title, renamed in place: double-click it, or press F2 with the
// frame selected. Enter or leaving the field keeps the new name, Escape keeps
// the old one, and an empty name changes nothing.

import * as React from "react";
import { cn } from "../../lib/ui-utils";
import { DESIGN_CANVAS_LIMITS, type DesignFrame } from "../../shared/design-canvas/schema";
import { useDesignNodeContext } from "./design-node-context";

export function FrameTitle({ frame, className }: { frame: DesignFrame; className?: string }) {
  const canvas = useDesignNodeContext();
  const editing = canvas.renaming === frame.id;
  if (!editing) {
    return (
      <span
        className={cn("min-w-0 flex-1 truncate text-strong text-primary", className)}
        title="Double-click to rename"
        onDoubleClick={(event) => {
          event.stopPropagation();
          canvas.rename(frame.id);
        }}
      >
        {frame.title}
      </span>
    );
  }
  return <FrameTitleField frame={frame} className={className} />;
}

function FrameTitleField({ frame, className }: { frame: DesignFrame; className?: string }) {
  const canvas = useDesignNodeContext();
  const [value, setValue] = React.useState(frame.title);
  const done = React.useRef(false);
  const finish = (save: boolean) => {
    if (done.current) return;
    done.current = true;
    const clean = value.replace(/\s+/gu, " ").trim();
    if (save && clean && clean !== frame.title) canvas.update(frame.id, { title: clean }, { record: true });
    canvas.rename(null);
  };
  return (
    <input
      aria-label="Frame name"
      value={value}
      maxLength={DESIGN_CANVAS_LIMITS.titleChars}
      autoFocus
      onFocus={(event) => event.currentTarget.select()}
      onChange={(event) => setValue(event.target.value)}
      onBlur={() => finish(true)}
      onKeyDown={(event) => {
        if (event.nativeEvent.isComposing) return;
        if (event.key === "Enter") {
          event.preventDefault();
          event.stopPropagation();
          finish(true);
          focusCanvas(event.currentTarget);
        } else if (event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          finish(false);
          focusCanvas(event.currentTarget);
        }
      }}
      onDoubleClick={(event) => event.stopPropagation()}
      className={cn(
        "nodrag nopan h-7 min-w-0 flex-1 rounded-control border border-field bg-input px-1.5 text-strong text-primary outline-none focus:bg-control",
        className,
      )}
    />
  );
}

/** Keys go back to the canvas once the name is set, so V, H and the rest work again. */
function focusCanvas(field: HTMLElement) {
  const canvas = field.closest<HTMLElement>(".studio-canvas");
  queueMicrotask(() => canvas?.focus({ preventScroll: true }));
}
