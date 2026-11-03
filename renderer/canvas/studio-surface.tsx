import * as React from "react";
import { useSplitViewCollapsedHeaderInset } from "../components/ui";
import { useTrailingWindowControlsClearance } from "../lib/window-chrome";

/** Full-height studio chrome: a drag-region header like ScrollArea's, then an unscrolled body. */
export function StudioSurface({
  title,
  actions,
  children,
}: React.PropsWithChildren<{ title: string; actions?: React.ReactNode }>) {
  const collapsedInset = useSplitViewCollapsedHeaderInset();
  const headerRef = React.useRef<HTMLElement>(null);
  const trailingClearance = useTrailingWindowControlsClearance(headerRef);
  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      <header
        className="drag-region flex min-h-13 shrink-0 items-center gap-3 px-4 transition-[padding] duration-300 ease-out motion-reduce:transition-none"
        ref={headerRef}
        style={{
          paddingLeft: collapsedInset,
          paddingRight: trailingClearance ? trailingClearance + 4 : undefined,
        }}
      >
        <h1 className="min-w-0 flex-1 truncate text-strong text-primary">{title}</h1>
        {actions ? <div className="no-drag flex items-center gap-2">{actions}</div> : null}
      </header>
      <div className="relative min-h-0 flex-1">{children}</div>
    </div>
  );
}
