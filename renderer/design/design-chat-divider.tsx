import { useResizeHandle } from "../lib/use-resize-handle";

/**
 * The drag handle between the design chat column and the canvas. Dragging or
 * the arrow keys move it live; the width is saved when the drag ends.
 */
export function DesignChatDivider({
  width,
  min,
  max,
  onWidthChange,
  onWidthCommit,
  onResizingChange,
}: {
  /** The chat column's rendered width. */
  width: number;
  min: number;
  max: number;
  onWidthChange(width: number): void;
  onWidthCommit(width: number): void;
  onResizingChange(resizing: boolean): void;
}) {
  // The chat is before the divider, so moving it toward the end widens the chat.
  const handle = useResizeHandle({
    orientation: "vertical",
    panel: "start",
    value: width,
    min,
    max,
    onResize: onWidthChange,
    onCommit: onWidthCommit,
    onResizingChange,
  });

  return (
    <div
      {...handle}
      aria-label="Resize chat"
      className="relative z-20 -mx-1 w-2 shrink-0 cursor-col-resize outline-none before:absolute before:inset-y-0 before:left-1 before:w-px before:bg-separator hover:before:bg-primary/20 focus-visible:before:w-0.5 focus-visible:before:bg-focus-ring"
    />
  );
}
