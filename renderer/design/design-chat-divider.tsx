import * as React from "react";

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
  const widthRef = React.useRef(width);
  widthRef.current = width;
  const clamp = React.useCallback((next: number) => Math.min(max, Math.max(min, next)), [max, min]);

  const beginResize = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture?.(event.pointerId);
    const startX = event.clientX;
    const startWidth = widthRef.current;
    onResizingChange(true);
    // The chat is on the left, so moving right widens it.
    const move = (moveEvent: PointerEvent) => onWidthChange(clamp(startWidth + moveEvent.clientX - startX));
    const finish = (endEvent: PointerEvent) => {
      onWidthCommit(
        endEvent.type === "pointerup" ? clamp(startWidth + endEvent.clientX - startX) : widthRef.current,
      );
      onResizingChange(false);
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", finish);
      window.removeEventListener("pointercancel", finish);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", finish);
    window.addEventListener("pointercancel", finish);
  };

  const resizeWithKeyboard = (event: React.KeyboardEvent<HTMLDivElement>) => {
    const increment = event.shiftKey ? 40 : 16;
    let next = width;
    if (event.key === "ArrowRight") next += increment;
    else if (event.key === "ArrowLeft") next -= increment;
    else if (event.key === "Home") next = min;
    else if (event.key === "End") next = max;
    else return;
    event.preventDefault();
    onWidthCommit(clamp(next));
  };

  return (
    <div
      role="separator"
      aria-label="Resize chat"
      aria-orientation="vertical"
      aria-valuemin={min}
      aria-valuemax={max}
      aria-valuenow={Math.round(width)}
      tabIndex={0}
      onPointerDown={beginResize}
      onKeyDown={resizeWithKeyboard}
      className="relative z-20 -mx-1 w-2 shrink-0 cursor-col-resize outline-none before:absolute before:inset-y-0 before:left-1 before:w-px before:bg-separator hover:before:bg-primary/20 focus-visible:before:w-0.5 focus-visible:before:bg-focus-ring"
    />
  );
}
