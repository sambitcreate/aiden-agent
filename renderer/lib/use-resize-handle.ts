// The drag-and-keyboard behavior every panel divider shares: the sidebar, the
// workbench panels, the design chat column and the terminal drawer. Each panel
// keeps its own size state, bounds and saving; this turns pointer and key input
// on a role="separator" into sizes. Pattern from the UI SDK's resizable handle.
import * as React from "react";

/** How far, in CSS pixels, a press moves before it resizes, so a click never does. */
export const RESIZE_DRAG_THRESHOLD = 3;
/** How far an arrow key moves a divider, and how far Shift with an arrow does. */
const STEP = 16;
const LARGE_STEP = 40;

export interface ResizeHandleOptions {
  /**
   * Which way the divider runs. A `vertical` one sits between columns and
   * changes a width; a `horizontal` one sits between rows and changes a height.
   */
  orientation: "vertical" | "horizontal";
  /**
   * Where the sized panel sits beside the divider: `start` is before it (left
   * in left-to-right text, right in right-to-left, or above), `end` after it.
   */
  panel: "start" | "end";
  /** The panel's current size. */
  value: number;
  min: number;
  max: number;
  /** A disabled divider leaves the tab order and ignores input. */
  disabled?: boolean;
  /** The size while a pointer drags, clamped to the bounds. */
  onResize(size: number): void;
  /** The settled size: on release, or after an arrow, Home or End. */
  onCommit(size: number): void;
  /** True once a press passes the drag threshold, false when it ends. */
  onResizingChange?(resizing: boolean): void;
  /** Enter on the divider, for a panel that can collapse. */
  onToggleCollapse?(): void;
}

// Keyboard focus (Tab) is unaffected; only a mouse press is kept from focusing.
const preventMouseFocus = (event: React.MouseEvent) => event.preventDefault();

const isRTL = (element: Element) => getComputedStyle(element).direction === "rtl";

/**
 * Props for a divider element: role, ARIA value, tab stop and the pointer and
 * key handlers. A press with a modifier or a button other than the primary one
 * is left alone, as are Alt, Control and Meta with a key, which belong to the
 * system and the browser. A mouse press never focuses the divider, so after a
 * drag Enter still goes to whatever had focus instead of collapsing the panel.
 */
export function useResizeHandle(options: ResizeHandleOptions) {
  const optionsRef = React.useRef(options);
  optionsRef.current = options;
  const stopDragRef = React.useRef<(() => void) | null>(null);
  React.useEffect(() => () => stopDragRef.current?.(), []);

  const { orientation, value, min, max, disabled = false } = options;

  const onPointerDown = React.useCallback((event: React.PointerEvent<HTMLElement>) => {
    const current = optionsRef.current;
    if (current.disabled || event.button !== 0 || !event.isPrimary) return;
    if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
    event.preventDefault();
    stopDragRef.current?.();
    const element = event.currentTarget;
    const { pointerId } = event;
    try {
      element.setPointerCapture(pointerId);
    } catch {
      // A synthetic press has no active pointer to capture.
    }
    const horizontal = current.orientation === "horizontal";
    // Moving toward the end (right in left-to-right text, or down) grows a start panel.
    const sign = (current.panel === "start" ? 1 : -1) * (!horizontal && isRTL(element) ? -1 : 1);
    const origin = horizontal ? event.clientY : event.clientX;
    const startSize = current.value;
    let started = false;
    let lastSize = startSize;
    const sizeAt = (pointer: PointerEvent) => {
      const { min: low, max: high } = optionsRef.current;
      const moved = (horizontal ? pointer.clientY : pointer.clientX) - origin;
      return Math.min(high, Math.max(low, startSize + sign * moved));
    };
    const body = element.ownerDocument.body;

    const stop = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", finish);
      window.removeEventListener("pointercancel", finish);
      if (started) {
        body.style.removeProperty("cursor");
        body.style.removeProperty("user-select");
      }
      stopDragRef.current = null;
    };
    const finish = (end: PointerEvent) => {
      if (end.pointerId !== pointerId) return;
      stop();
      if (!started) return;
      // A canceled pointer keeps the last size it reached.
      optionsRef.current.onCommit(end.type === "pointercancel" ? lastSize : sizeAt(end));
      optionsRef.current.onResizingChange?.(false);
    };
    function move(pointer: PointerEvent) {
      if (pointer.pointerId !== pointerId) return;
      // A mouse released outside the window, whose pointerup never arrived.
      if (pointer.pointerType === "mouse" && pointer.buttons === 0) return finish(pointer);
      if (!started) {
        if (
          Math.abs((horizontal ? pointer.clientY : pointer.clientX) - origin) <
          RESIZE_DRAG_THRESHOLD
        )
          return;
        started = true;
        // The cursor stays a resize cursor over whatever the pointer crosses.
        body.style.cursor = horizontal ? "row-resize" : "col-resize";
        body.style.userSelect = "none";
        optionsRef.current.onResizingChange?.(true);
      }
      lastSize = sizeAt(pointer);
      optionsRef.current.onResize(lastSize);
    }
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", finish);
    window.addEventListener("pointercancel", finish);
    stopDragRef.current = () => {
      const wasStarted = started;
      stop();
      if (wasStarted) optionsRef.current.onResizingChange?.(false);
    };
  }, []);

  const onKeyDown = React.useCallback((event: React.KeyboardEvent<HTMLElement>) => {
    const current = optionsRef.current;
    if (current.disabled || event.altKey || event.ctrlKey || event.metaKey) return;
    if (event.key === "Enter") {
      if (!current.onToggleCollapse || event.repeat) return;
      event.preventDefault();
      current.onToggleCollapse();
      return;
    }
    const horizontal = current.orientation === "horizontal";
    const amount = event.shiftKey ? LARGE_STEP : STEP;
    const [back, forward] = horizontal
      ? ["ArrowUp", "ArrowDown"]
      : isRTL(event.currentTarget)
        ? ["ArrowRight", "ArrowLeft"]
        : ["ArrowLeft", "ArrowRight"];
    const grow = current.panel === "start" ? 1 : -1;
    let next: number;
    if (event.key === forward) next = current.value + grow * amount;
    else if (event.key === back) next = current.value - grow * amount;
    else if (event.key === "Home") next = current.min;
    else if (event.key === "End") next = current.max;
    else return;
    event.preventDefault();
    current.onCommit(Math.min(current.max, Math.max(current.min, next)));
  }, []);

  return {
    role: "separator" as const,
    onMouseDown: preventMouseFocus,
    "aria-orientation": orientation,
    "aria-valuemin": Math.round(min),
    "aria-valuemax": Math.round(max),
    "aria-valuenow": Math.round(value),
    tabIndex: disabled ? -1 : 0,
    onPointerDown,
    onKeyDown,
  };
}
