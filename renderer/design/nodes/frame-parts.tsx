// Pieces the design frame nodes share: the resize handles, the skeleton a
// frame shows before it has a picture, the missing-file state, and keeping a
// leaving iframe on screen until its snapshot is taken.

import { NodeResizer } from "@xyflow/react";
import * as React from "react";
import { Button } from "../../components/ui";
import { DESIGN_CANVAS_LIMITS } from "../../shared/design-canvas/schema";
import { captureFrameSnapshot, designFrameSnapshots } from "../frame-snapshots";

/** How long a leaving iframe waits for its snapshot before it goes anyway. */
const CAPTURE_FALLBACK_MS = 1000;

export function DesignNodeResizer({
  selected,
  minSize = DESIGN_CANVAS_LIMITS.minSize,
}: {
  selected: boolean;
  /** The smallest width and height the frame's kind keeps (`designMinSize`). */
  minSize?: number;
}) {
  return (
    <NodeResizer
      isVisible={selected}
      minWidth={minSize}
      minHeight={minSize}
      maxWidth={DESIGN_CANVAS_LIMITS.maxSize}
      maxHeight={DESIGN_CANVAS_LIMITS.maxSize}
      handleClassName="design-resize-handle"
      lineClassName="design-resize-line"
    />
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

export function MissingFrame({ path, onRemove }: { path: string | undefined; onRemove(): void }) {
  return (
    <div className="flex h-full w-full flex-col items-center justify-center gap-2 p-4 text-center">
      <span className="text-strong text-primary">File not found</span>
      {path ? <span className="max-w-full truncate text-secondary">{path}</span> : null}
      <Button variant="muted" size="small" className="nodrag" onClick={onRemove}>
        Remove frame
      </Button>
    </div>
  );
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
