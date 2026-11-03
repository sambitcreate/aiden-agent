import * as React from "react";
import { MoreHorizontal } from "lucide-react";
import { Button, DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } from "../ui";

const VIEWPORT_PADDING = 8;

export interface OverflowMenuPlacement {
  /** Distance from the trigger's right edge to just past the sidebar's right edge. */
  sideOffset: number;
  /** Opens downward from the trigger's top ("start") or upward from its bottom ("end"). */
  align: "start" | "end";
  /** How far the menu's anchored edge moves back inside the viewport. */
  alignOffset: number;
  maxHeight: number;
}

/**
 * Where a sidebar overflow menu opens: to the right of the sidebar, growing
 * away from the nearer viewport edge, kept inside the viewport and scrolling
 * when it would not fit.
 */
export function overflowMenuPlacement(
  trigger: Pick<DOMRect, "top" | "bottom" | "right">,
  sidebar: Pick<DOMRect, "right">,
  viewportHeight: number,
): OverflowMenuPlacement {
  const align = trigger.bottom > viewportHeight / 2 ? "end" : "start";
  const alignOffset =
    align === "end"
      ? Math.max(0, trigger.bottom - (viewportHeight - VIEWPORT_PADDING))
      : Math.max(0, VIEWPORT_PADDING - trigger.top);
  const contentEdge = align === "end" ? trigger.bottom - alignOffset : trigger.top + alignOffset;
  return {
    sideOffset: Math.max(8, Math.ceil(sidebar.right - trigger.right) + 8),
    align,
    alignOffset,
    maxHeight: Math.max(
      1,
      Math.floor(
        align === "end"
          ? contentEdge - VIEWPORT_PADDING
          : viewportHeight - contentEdge - VIEWPORT_PADDING,
      ),
    ),
  };
}

/**
 * A ••• (or custom icon) dropdown that opens past the sidebar's right edge, so
 * its items never cover the rows they act on.
 */
export function SidebarOverflowMenu({
  ariaLabel,
  triggerClassName,
  contentClassName,
  triggerIcon = <MoreHorizontal />,
  children,
}: React.PropsWithChildren<{
  ariaLabel: string;
  triggerClassName?: string;
  contentClassName: string;
  triggerIcon?: React.ReactNode;
}>) {
  const triggerRef = React.useRef<HTMLButtonElement>(null);
  const [sideOffset, setSideOffset] = React.useState(8);
  const [contentAlign, setContentAlign] = React.useState<"start" | "end">("start");
  const [contentAlignOffset, setContentAlignOffset] = React.useState(0);
  const [contentMaxHeight, setContentMaxHeight] = React.useState<number>();
  const [open, setOpen] = React.useState(false);

  const positionOutsideSidebar = React.useCallback(() => {
    const trigger = triggerRef.current;
    const sidebar = trigger?.closest<HTMLElement>("[data-sidebar]");
    if (!trigger || !sidebar) return;
    const placement = overflowMenuPlacement(
      trigger.getBoundingClientRect(),
      sidebar.getBoundingClientRect(),
      window.innerHeight,
    );
    setSideOffset(placement.sideOffset);
    setContentAlign(placement.align);
    setContentAlignOffset(placement.alignOffset);
    setContentMaxHeight(placement.maxHeight);
  }, []);

  React.useEffect(() => {
    if (!open) return;
    window.addEventListener("resize", positionOutsideSidebar);
    return () => window.removeEventListener("resize", positionOutsideSidebar);
  }, [open, positionOutsideSidebar]);

  return (
    <DropdownMenu
      onOpenChange={(nextOpen) => {
        setOpen(nextOpen);
        if (nextOpen) positionOutsideSidebar();
      }}
    >
      <DropdownMenuTrigger asChild>
        <Button
          ref={triggerRef}
          variant="transparent"
          size="small"
          iconOnly
          className={triggerClassName}
          aria-label={ariaLabel}
        >
          {triggerIcon}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        side="right"
        align={contentAlign}
        alignOffset={contentAlignOffset}
        sideOffset={sideOffset}
        avoidCollisions={false}
        className={contentClassName}
        style={{ maxHeight: contentMaxHeight, overflowY: "auto" }}
      >
        {children}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
