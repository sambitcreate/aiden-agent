import * as React from "react";
import { cn } from "../lib/ui-utils";

/** Shared frame for studio canvas nodes. Selection is a fill and an attribute, never a colored border. */
export function CanvasNodeChrome({
  title,
  selected,
  status,
  toolbar,
  children,
}: React.PropsWithChildren<{
  title: string;
  selected: boolean;
  status?: string;
  toolbar?: React.ReactNode;
}>) {
  return (
    <div
      role="group"
      aria-label={title}
      data-selected={selected ? "true" : "false"}
      className={cn(
        "flex min-w-40 flex-col overflow-visible rounded-button bg-popover shadow-control",
        selected && "bg-list-selection",
      )}
    >
      <div className="flex min-h-9 items-center gap-2 px-3">
        <span className="min-w-0 flex-1 truncate text-strong text-primary">{title}</span>
        {status ? <span className="shrink-0 text-secondary">{status}</span> : null}
        {toolbar ? <div className="nodrag flex shrink-0 items-center gap-1">{toolbar}</div> : null}
      </div>
      <div className="min-h-0 flex-1 px-3 pb-3">{children}</div>
    </div>
  );
}
