// Pieces the design frame nodes share: the resize handles, the skeleton a
// frame shows before it has a picture, the missing-file state, and keeping a
// leaving iframe on screen until its snapshot is taken.

import { NodeResizeControl, NodeResizer, ResizeControlVariant, type ControlLinePosition, type ControlPosition } from "@xyflow/react";
import * as React from "react";
import { Button } from "../../components/ui";
import { appEdgeBounds, type AppResizeMode, type AppResizeSide } from "../../shared/design-canvas/app-frame";
import { DESIGN_CANVAS_LIMITS } from "../../shared/design-canvas/schema";
import { captureFrameSnapshot, designFrameSnapshots } from "../frame-snapshots";

/** How long a leaving iframe waits for its snapshot before it goes anyway. */
const CAPTURE_FALLBACK_MS = 1000;

export function DesignNodeResizer({
  selected,
  minSize = DESIGN_CANVAS_LIMITS.minSize,
  keepAspectRatio = false,
}: {
  selected: boolean;
  /** The smallest width and height the frame's kind keeps (`designMinSize`). */
  minSize?: number;
  /** A live app frame keeps its viewport's shape; the canvas recomputes the box from the new scale. */
  keepAspectRatio?: boolean;
}) {
  return (
    <NodeResizer
      isVisible={selected}
      keepAspectRatio={keepAspectRatio}
      minWidth={minSize}
      minHeight={minSize}
      maxWidth={DESIGN_CANVAS_LIMITS.maxSize}
      maxHeight={DESIGN_CANVAS_LIMITS.maxSize}
      handleClassName="design-resize-handle"
      lineClassName="design-resize-line"
    />
  );
}

const APP_CORNERS: readonly ControlPosition[] = ["top-left", "top-right", "bottom-left", "bottom-right"];
const APP_EDGES: readonly (AppResizeSide & ControlLinePosition)[] = ["top", "right", "bottom", "left"];

/**
 * A live app frame's resize controls with design live on (3c, S89): the four
 * corner handles keep the aspect and change the scale, as 3a's single resizer
 * does; the four edge lines change the viewport and keep the scale. xyflow's
 * resize events don't name the control, so each one tells `onStart` its own
 * side. The edges' bounds come from the viewport limits at this scale, so
 * xyflow never drags past what the viewport can be. The controls stay
 * pointer-only; the device menu is the keyboard's way to resize.
 */
export function AppFrameResizers({
  nodeId,
  selected,
  minSize,
  scale,
  onStart,
}: {
  nodeId: string;
  selected: boolean;
  minSize: number;
  scale: number;
  onStart(mode: AppResizeMode): void;
}) {
  const startRef = React.useRef(onStart);
  startRef.current = onStart;
  // Stable per control, so a render mid-drag doesn't rebind xyflow's resizer.
  const starts = React.useMemo(
    () =>
      Object.fromEntries((["corner", ...APP_EDGES] as const).map((mode) => [mode, () => startRef.current(mode)])) as Record<AppResizeMode, () => void>,
    [],
  );
  if (!selected) return null;
  const edges = appEdgeBounds(scale, minSize, DESIGN_CANVAS_LIMITS.maxSize);
  return (
    <>
      {APP_EDGES.map((side) => (
        <NodeResizeControl
          key={side}
          nodeId={nodeId}
          position={side}
          variant={ResizeControlVariant.Line}
          className="design-resize-line"
          {...edges}
          onResizeStart={starts[side]}
        />
      ))}
      {APP_CORNERS.map((corner) => (
        <NodeResizeControl
          key={corner}
          nodeId={nodeId}
          position={corner}
          variant={ResizeControlVariant.Handle}
          className="design-resize-handle"
          keepAspectRatio
          minWidth={minSize}
          minHeight={minSize}
          maxWidth={DESIGN_CANVAS_LIMITS.maxSize}
          maxHeight={DESIGN_CANVAS_LIMITS.maxSize}
          onResizeStart={starts.corner}
        />
      ))}
    </>
  );
}

/** A frame with nothing to show yet: skeleton bars, and the frame's name for assistive tech. */
export function FrameSkeleton({ title }: { title: string }) {
  return (
    <div role="img" aria-label={title} className="flex h-full w-full flex-col gap-2 p-4">
      <div aria-hidden className="h-3 w-2/3 rounded-full bg-control" />
      <div aria-hidden className="h-3 w-1/2 rounded-full bg-control" />
      <div aria-hidden className="mt-2 min-h-0 w-full flex-1 rounded-button bg-control" />
    </div>
  );
}

export function MissingFrame({
  path,
  onRemove,
  label = "File not found",
}: {
  path: string | undefined;
  onRemove(): void;
  label?: string;
}) {
  return (
    <div className="flex h-full w-full flex-col items-center justify-center gap-2 p-4 text-center">
      <span className="text-strong text-primary">{label}</span>
      {path ? <span className="max-w-full truncate text-secondary">{path}</span> : null}
      <Button variant="muted" size="small" className="nodrag" onClick={onRemove}>
        Remove frame
      </Button>
    </div>
  );
}

/**
 * The element's on-screen rectangle when it is wholly inside the canvas (so a
 * capture holds only it), else null.
 */
export function rectOnCanvas(element: HTMLElement | null): DOMRect | null {
  const rect = element?.getBoundingClientRect();
  if (!element || !rect) return null;
  const canvas = element.closest(".studio-canvas")?.getBoundingClientRect() ?? {
    left: 0,
    top: 0,
    right: window.innerWidth,
    bottom: window.innerHeight,
  };
  return visibleWithin(rect, canvas) ? rect : null;
}

function visibleWithin(rect: DOMRect, bounds: { left: number; top: number; right: number; bottom: number }) {
  return (
    rect.width > 0 &&
    rect.height > 0 &&
    rect.left >= bounds.left &&
    rect.top >= bounds.top &&
    rect.right <= bounds.right &&
    rect.bottom <= bounds.bottom
  );
}

/**
 * True while a frame that just left the live set still shows its iframe, so
 * its snapshot can be taken first and the frame never flashes a skeleton. A
 * frame partly outside the canvas is not captured (the picture would hold
 * whatever covers the rest); it keeps the snapshot it had.
 */
export function useRetiringFrame(input: {
  frameId: string;
  version: number;
  live: boolean;
  /** The iframe is on screen right now. */
  showing: boolean;
  content: React.RefObject<HTMLElement | null>;
}): boolean {
  const { frameId, version, live, showing, content } = input;
  const [previousLive, setPreviousLive] = React.useState(live);
  const [retiring, setRetiring] = React.useState(false);
  // Decided while rendering, so the render that drops the frame from the live set still draws the iframe.
  if (previousLive !== live) {
    setPreviousLive(live);
    setRetiring(!live && showing);
  }

  React.useEffect(() => {
    if (!retiring) return;
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      setRetiring(false);
    };
    const element = content.current;
    const rect = element?.getBoundingClientRect();
    const canvas = element?.closest(".studio-canvas")?.getBoundingClientRect() ?? {
      left: 0,
      top: 0,
      right: window.innerWidth,
      bottom: window.innerHeight,
    };
    if (!rect || !visibleWithin(rect, canvas)) {
      finish();
      return;
    }
    const fallback = setTimeout(finish, CAPTURE_FALLBACK_MS);
    void captureFrameSnapshot(designFrameSnapshots, frameId, version, rect).finally(finish);
    return () => {
      clearTimeout(fallback);
      done = true;
    };
  }, [retiring, frameId, version, content]);

  return retiring && !live;
}
