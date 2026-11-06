import * as React from "react";
import { cn } from "../lib/ui-utils";

/** Shared frame for studio canvas nodes. Selection is a fill and an attribute, never a colored border. */
export function CanvasNodeChrome({
  title,
  selected,
  status,
  titleSlot,
  toolbar,
  flush = false,
  tint,
  children,
}: React.PropsWithChildren<{
  title: string;
  /** Drawn in place of the plain title text, for a title that can be edited. */
  titleSlot?: React.ReactNode;
  selected: boolean;
  status?: string;
  toolbar?: React.ReactNode;
  /** Fill the node's box and give the body no padding, for content drawn edge to edge. */
  flush?: boolean;
  /** A background colour in place of the card's own, such as a coloured note. */
  tint?: string;
}>) {
  return (
    <div
      role="group"
      aria-label={title}
      data-canvas-chrome
      data-selected={selected ? "true" : "false"}
      className={cn(
        "flex min-w-40 flex-col overflow-visible rounded-button bg-popover shadow-control",
        flush && "h-full w-full min-w-0 overflow-hidden",
        selected && !tint && "bg-list-selection",
      )}
      style={tint ? { background: tint } : undefined}
    >
      <div data-canvas-chrome-header className="flex min-h-9 items-center gap-2 px-3">
        {titleSlot ?? <span className="min-w-0 flex-1 truncate text-strong text-primary">{title}</span>}
        {status ? <span className="shrink-0 text-secondary">{status}</span> : null}
        {toolbar ? <div className="nodrag flex shrink-0 items-center gap-1">{toolbar}</div> : null}
      </div>
      <div className={cn("min-h-0 flex-1", !flush && "px-3 pb-3")}>{children}</div>
    </div>
  );
}
