// Where Aiden Live's floating ribbon sits: centred above the chat composer by
// default, or wherever the user dragged it in this window. Double-click puts
// it back. The offset is a per-window convenience in localStorage.

import * as React from "react";

export interface LiveRibbonOffset {
  x: number;
  y: number;
}

export interface LiveRibbonAnchor {
  /** Horizontal centre of the chat column, in viewport pixels. */
  centerX: number;
  /** Distance from the window's bottom edge to the pill's bottom edge. */
  bottom: number;
}

const STORAGE_PREFIX = "aiden.live.ribbon-offset";
const GAP_ABOVE_COMPOSER = 12;
const EDGE_MARGIN = 8;

function storageKey(): string {
  let name = "";
  try {
    name = window.name;
  } catch {
    // Some embedders forbid reading the window name.
  }
  return `${STORAGE_PREFIX}:${name || "main"}`;
}

export function readLiveRibbonOffset(): LiveRibbonOffset {
  try {
    const parsed: unknown = JSON.parse(window.localStorage.getItem(storageKey()) ?? "null");
    if (parsed && typeof parsed === "object") {
      const { x, y } = parsed as Record<string, unknown>;
      if (typeof x === "number" && typeof y === "number" && Number.isFinite(x) && Number.isFinite(y)) return { x, y };
    }
  } catch {
    // Missing, blocked or malformed storage means the default place.
  }
  return { x: 0, y: 0 };
}

function writeLiveRibbonOffset(offset: LiveRibbonOffset): void {
  try {
    if (offset.x === 0 && offset.y === 0) window.localStorage.removeItem(storageKey());
    else window.localStorage.setItem(storageKey(), JSON.stringify(offset));
  } catch {
    // The position still applies for this session.
  }
}

/** The chat composer's column, or the window's bottom centre when no chat is open. */
export function measureLiveRibbonAnchor(doc: Document = document, view: Window = window): LiveRibbonAnchor {
  const composers = Array.from(doc.querySelectorAll<HTMLElement>('[data-browser-composer-inset="true"]'));
  for (const inset of composers) {
    const target = inset.querySelector<HTMLElement>('[data-focus-region="composer"]') ?? inset;
    const rect = target.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) continue;
    return { centerX: rect.left + rect.width / 2, bottom: Math.max(EDGE_MARGIN, view.innerHeight - rect.top + GAP_ABOVE_COMPOSER) };
  }
  return { centerX: view.innerWidth / 2, bottom: 24 };
}

/** Keeps the whole pill inside the window, whatever the stored offset says. */
export function placeLiveRibbon(
  anchor: LiveRibbonAnchor,
  offset: LiveRibbonOffset,
  size: { width: number; height: number },
  viewport: { width: number; height: number },
): { left: number; bottom: number } {
  const half = size.width / 2;
  const minCenter = half + EDGE_MARGIN;
  const maxCenter = Math.max(minCenter, viewport.width - half - EDGE_MARGIN);
  const maxBottom = Math.max(EDGE_MARGIN, viewport.height - size.height - EDGE_MARGIN);
  return {
    left: Math.min(maxCenter, Math.max(minCenter, anchor.centerX + offset.x)),
    // A drag downwards (positive y) brings the pill closer to the bottom edge.
    bottom: Math.min(maxBottom, Math.max(EDGE_MARGIN, anchor.bottom - offset.y)),
  };
}

export function useLiveRibbonPlacement(pillRef: React.RefObject<HTMLElement | null>): {
  left: number;
  bottom: number;
  dragging: boolean;
  onPointerDown(event: React.PointerEvent<HTMLElement>): void;
  onDoubleClick(event: React.MouseEvent<HTMLElement>): void;
} {
  const [anchor, setAnchor] = React.useState<LiveRibbonAnchor>(() =>
    typeof document === "undefined" ? { centerX: 0, bottom: 24 } : measureLiveRibbonAnchor(),
  );
  const [offset, setOffset] = React.useState<LiveRibbonOffset>(() =>
    typeof window === "undefined" ? { x: 0, y: 0 } : readLiveRibbonOffset(),
  );
  const [viewport, setViewport] = React.useState(() =>
    typeof window === "undefined" ? { width: 0, height: 0 } : { width: window.innerWidth, height: window.innerHeight },
  );
  const [dragging, setDragging] = React.useState(false);

  React.useEffect(() => {
    let frame = 0;
    const measure = () => {
      frame = 0;
      const next = measureLiveRibbonAnchor();
      setAnchor((current) => (current.centerX === next.centerX && current.bottom === next.bottom ? current : next));
      setViewport((current) =>
        current.width === window.innerWidth && current.height === window.innerHeight
          ? current
          : { width: window.innerWidth, height: window.innerHeight },
      );
    };
    const schedule = () => {
      if (!frame) frame = window.requestAnimationFrame(measure);
    };
    window.addEventListener("resize", schedule);
    document.addEventListener("transitionend", schedule, true);
    // Chats open and close and the composer grows while the session runs.
    const interval = window.setInterval(schedule, 500);
    measure();
    return () => {
      window.cancelAnimationFrame(frame);
      window.clearInterval(interval);
      window.removeEventListener("resize", schedule);
      document.removeEventListener("transitionend", schedule, true);
    };
  }, []);

  const size = {
    width: pillRef.current?.offsetWidth || 380,
    height: pillRef.current?.offsetHeight || 64,
  };
  const placed = placeLiveRibbon(anchor, offset, size, viewport);
  const layoutRef = React.useRef({ anchor, size, viewport });
  layoutRef.current = { anchor, size, viewport };

  const onPointerDown = React.useCallback(
    (event: React.PointerEvent<HTMLElement>) => {
      if (event.button !== 0) return;
      // Buttons and menus keep their own clicks.
      if ((event.target as Element).closest("button, a, input, [role='menu'], [role='menuitem']")) return;
      const element = event.currentTarget;
      const start = { x: event.clientX, y: event.clientY, offset };
      let latest = offset;
      try {
        element.setPointerCapture(event.pointerId);
      } catch {
        // Synthetic events in tests have no capturable pointer.
      }
      setDragging(true);
      const move = (moveEvent: PointerEvent) => {
        const wanted = { x: start.offset.x + moveEvent.clientX - start.x, y: start.offset.y + moveEvent.clientY - start.y };
        // Store only an offset the window can show, so dragging back responds at once.
        const layout = layoutRef.current;
        const at = placeLiveRibbon(layout.anchor, wanted, layout.size, layout.viewport);
        latest = { x: at.left - layout.anchor.centerX, y: layout.anchor.bottom - at.bottom };
        setOffset(latest);
      };
      const end = () => {
        element.removeEventListener("pointermove", move);
        element.removeEventListener("pointerup", end);
        element.removeEventListener("pointercancel", end);
        setDragging(false);
        writeLiveRibbonOffset(latest);
      };
      element.addEventListener("pointermove", move);
      element.addEventListener("pointerup", end);
      element.addEventListener("pointercancel", end);
    },
    [offset],
  );

  const onDoubleClick = React.useCallback((event: React.MouseEvent<HTMLElement>) => {
    if ((event.target as Element).closest("button, a, input")) return;
    setOffset({ x: 0, y: 0 });
    writeLiveRibbonOffset({ x: 0, y: 0 });
  }, []);

  return { ...placed, dragging, onPointerDown, onDoubleClick };
}
