import * as React from "react";
import { MoreHorizontal } from "lucide-react";
import { Button, DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } from "../ui";

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

    const triggerBounds = trigger.getBoundingClientRect();
    const sidebarBounds = sidebar.getBoundingClientRect();
    const nextAlign = triggerBounds.bottom > window.innerHeight / 2 ? "end" : "start";
    const viewportPadding = 8;
    const nextAlignOffset =
      nextAlign === "end"
        ? Math.max(0, triggerBounds.bottom - (window.innerHeight - viewportPadding))
        : Math.max(0, viewportPadding - triggerBounds.top);
    const contentEdge =
      nextAlign === "end"
        ? triggerBounds.bottom - nextAlignOffset
        : triggerBounds.top + nextAlignOffset;
    setSideOffset(Math.max(8, Math.ceil(sidebarBounds.right - triggerBounds.right) + 8));
    setContentAlign(nextAlign);
    setContentAlignOffset(nextAlignOffset);
    setContentMaxHeight(
      Math.max(
        1,
        Math.floor(
          nextAlign === "end"
            ? contentEdge - viewportPadding
            : window.innerHeight - contentEdge - viewportPadding,
        ),
      ),
    );
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
