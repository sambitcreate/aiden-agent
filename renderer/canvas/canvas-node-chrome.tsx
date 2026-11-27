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
  busy = false,
  children,
}: React.PropsWithChildren<{
  title: string;
  /** Drawn in place of the plain title text, for a title that can be edited. */
  titleSlot?: React.ReactNode;
  selected: boolean;
  /** Quiet text after the title, such as a page's size; a live app frame adds its path and labels. */
  status?: React.ReactNode;
  toolbar?: React.ReactNode;
  /** Fill the node's box and give the body no padding, for content drawn edge to edge. */
  flush?: boolean;
  /** A background colour in place of the card's own, such as a coloured note. */
  tint?: string;
  /** Dimmed and marked busy while an action on it is in flight (a page file going to the Trash). */
  busy?: boolean;
}>) {
  return (
    <div
      role="group"
      aria-label={title}
      data-canvas-chrome
      data-selected={selected ? "true" : "false"}
      aria-busy={busy ? true : undefined}
      className={cn(
        "transition-opacity duration-(--motion-duration) ease-standard",
        busy && "opacity-45",
        "flex min-w-40 flex-col overflow-visible rounded-button bg-popover shadow-control",
        flush && "h-full w-full min-w-0 overflow-hidden",
        selected && !tint && "bg-list-selection",
      )}
      style={tint ? { background: tint } : undefined}
    >
      <div data-canvas-chrome-header className="flex min-h-9 items-center gap-2 px-3">
        {titleSlot ?? <span className="min-w-0 flex-1 truncate text-strong text-primary">{title}</span>}
        {/* The status gives way before the toolbar, so a narrow frame keeps its actions in reach. */}
        {status ? <span className="flex min-w-0 items-center gap-2 overflow-hidden whitespace-nowrap text-secondary">{status}</span> : null}
        {toolbar ? <div className="nodrag flex shrink-0 items-center gap-1">{toolbar}</div> : null}
      </div>
      <div className={cn("min-h-0 flex-1", !flush && "px-3 pb-3")}>{children}</div>
    </div>
  );
}
