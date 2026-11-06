import * as React from "react";
import type { GalleryItem } from "../../shared/images/ipc-types";
import { canZoom, clampPan, fitScale, zoomAnchorPan, type Point, type Size } from "./viewer-core";

/** Movement, in pixels, after which a press on an actual-size image is a pan rather than a click. */
const PAN_THRESHOLD = 3;

export interface StageZoom {
  actual: boolean;
  zoomable: boolean;
  toggle(): void;
}

/**
 * The image at fit, or at 100% with drag-to-pan. A click toggles between them (only when 100%
 * shows more), keeping the clicked spot under the pointer. At fit, dragging the image starts a
 * native drag of the file out of the window. Each image opens at fit.
 */
export function ViewerStage({
  item,
  src,
  alt,
  onDragOut,
  onZoomState,
}: {
  item: GalleryItem;
  /** The thumbnail until the original has decoded; empty while neither is available. */
  src: string;
  alt: string;
  onDragOut(): void;
  /** Reports the zoom state and its toggle, for the toolbar's keyboard-reachable button. */
  onZoomState?(zoom: StageZoom): void;
}) {
  const stage = React.useRef<HTMLDivElement>(null);
  const [box, setBox] = React.useState<Size>({ width: 0, height: 0 });
  const [actual, setActual] = React.useState(false);
  const [pan, setPan] = React.useState<Point>({ x: 0, y: 0 });
  const press = React.useRef<{ x: number; y: number; origin: Point; moved: boolean } | null>(null);
  // Stepping to another image starts it at fit; the stage itself stays mounted, so its measured size is kept.
  const [shown, setShown] = React.useState(item.assetId);
  if (shown !== item.assetId) {
    setShown(item.assetId);
    setActual(false);
    setPan({ x: 0, y: 0 });
  }
  const natural: Size = { width: item.width, height: item.height };
  const zoomable = canZoom(natural, box);
  const scale = actual ? 1 : fitScale(natural, box);

  React.useEffect(() => {
    const element = stage.current;
    if (!element || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setBox({ width: entry.contentRect.width, height: entry.contentRect.height });
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  // A resize can shrink the overhang; keep the pan inside it.
  React.useEffect(() => {
    if (actual) setPan((current) => clampPan(current, natural, box));
  }, [actual, box.width, box.height, item.width, item.height]);

  const toggleAt = React.useCallback(
    (point: Point) => {
      if (actual) {
        setActual(false);
        setPan({ x: 0, y: 0 });
      } else if (zoomable) {
        setActual(true);
        setPan(zoomAnchorPan(point, natural, box));
      }
    },
    [actual, zoomable, box.width, box.height, item.width, item.height],
  );

  React.useEffect(() => {
    onZoomState?.({ actual, zoomable, toggle: () => toggleAt({ x: 0, y: 0 }) });
  }, [actual, zoomable, toggleAt, onZoomState]);

  const fromCentre = (event: React.MouseEvent): Point => {
    const rect = stage.current?.getBoundingClientRect();
    if (!rect) return { x: 0, y: 0 };
    return { x: event.clientX - rect.left - rect.width / 2, y: event.clientY - rect.top - rect.height / 2 };
  };

  const measured = box.width > 0 && box.height > 0;
  return (
    <div
      ref={stage}
      className="image-viewer-stage"
      data-zoom={actual ? "actual" : "fit"}
      data-zoomable={zoomable ? "true" : undefined}
      onPointerDown={(event) => {
        if (!actual || event.button !== 0) return;
        event.currentTarget.setPointerCapture(event.pointerId);
        press.current = { x: event.clientX, y: event.clientY, origin: pan, moved: false };
      }}
      onPointerMove={(event) => {
        const current = press.current;
        if (!current) return;
        const dx = event.clientX - current.x;
        const dy = event.clientY - current.y;
        if (!current.moved && Math.hypot(dx, dy) < PAN_THRESHOLD) return;
        current.moved = true;
        setPan(clampPan({ x: current.origin.x + dx, y: current.origin.y + dy }, natural, box));
      }}
      onPointerUp={(event) => {
        const current = press.current;
        press.current = null;
        if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
        if (current && !current.moved) toggleAt(fromCentre(event));
      }}
      onPointerCancel={() => {
        press.current = null;
      }}
    >
      {src ? (
        <img
          src={src}
          alt={alt}
          data-image-viewer-image=""
          draggable={!actual}
          onDragStart={(event) => {
            // The file leaves through the main process; the HTML drag would carry only a URL.
            event.preventDefault();
            if (!actual) onDragOut();
          }}
          onClick={(event) => {
            if (!actual) toggleAt(fromCentre(event));
          }}
          style={{
            width: natural.width * scale,
            height: natural.height * scale,
            transform: `translate(calc(-50% + ${pan.x}px), calc(-50% + ${pan.y}px))`,
            visibility: measured ? undefined : "hidden",
          }}
        />
      ) : (
        <div className="image-viewer-placeholder" role="img" aria-label={`${alt}, loading`} />
      )}
    </div>
  );
}
