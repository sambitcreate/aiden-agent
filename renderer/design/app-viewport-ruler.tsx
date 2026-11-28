// The live readout and breakpoint ticks while a live app frame is resized
// (design mode v2 Phase 3c, S91). The ticks are the page's own CSS width
// breakpoints, which its bridge reported: untrusted, display only, never
// stored and never snapped to. Drawn in screen space beside the frame, so the
// readout stays legible at any zoom.

import { NodeToolbar, Position, useViewport } from "@xyflow/react";
import type { AppResizeMode } from "../shared/design-canvas/app-frame";

/** A tick's label is left out when it would sit closer than this to the last label shown, in screen px. */
const LABEL_GAP_PX = 40;

export type AppViewportRulerProps = {
  side: AppResizeMode;
  viewport: { width: number; height: number };
  scale: number;
  /** The canvas's zoom: a tick is `breakpoint × scale × zoom` screen px from the fixed edge. */
  zoom: number;
  breakpoints: readonly number[];
};

export function AppViewportRuler({ side, viewport, scale, zoom, breakpoints }: AppViewportRulerProps) {
  const widthDrag = side === "left" || side === "right";
  const track = Math.round(viewport.width * scale * zoom);
  let lastLabel = Number.NEGATIVE_INFINITY;
  const ticks = widthDrag
    ? breakpoints.map((width) => {
        const at = Math.round(width * scale * zoom);
        const labelled = at - lastLabel >= LABEL_GAP_PX;
        if (labelled) lastLabel = at;
        return { width, at, labelled };
      })
    : [];
  return (
    <div
      aria-hidden
      className="design-viewport-ruler"
      data-side={side}
      style={widthDrag ? { width: `${track}px` } : undefined}
    >
      <span className="design-viewport-readout">{`${viewport.width} × ${viewport.height}`}</span>
      {ticks.length > 0 ? (
        <div className="design-viewport-track">
          {ticks.map((tick) => (
            <span
              key={tick.width}
              className="design-viewport-tick"
              data-breakpoint={tick.width}
              style={side === "left" ? { right: `${tick.at}px` } : { left: `${tick.at}px` }}
            >
              {tick.labelled ? <span className="design-viewport-tick-label">{tick.width}</span> : null}
            </span>
          ))}
        </div>
      ) : null}
    </div>
  );
}

/**
 * The ruler under a frame while it is resized, lined up with the edge that
 * stays put: the frame's left for a right drag, its right for a left drag.
 * Mounted only during a resize, so following the zoom costs nothing otherwise.
 */
export function AppViewportRulerToolbar({ nodeId, ...ruler }: Omit<AppViewportRulerProps, "zoom"> & { nodeId: string }) {
  const { zoom } = useViewport();
  return (
    <NodeToolbar nodeId={nodeId} isVisible position={Position.Bottom} align={ruler.side === "left" ? "end" : "start"} offset={8}>
      <AppViewportRuler {...ruler} zoom={zoom} />
    </NodeToolbar>
  );
}
