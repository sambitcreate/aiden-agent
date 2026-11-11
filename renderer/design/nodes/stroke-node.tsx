// A line drawn with the pencil or the pen. It takes the pointer only along
// the line, and resizing scales it.

import type { NodeProps } from "@xyflow/react";
import { strokePath } from "../../shared/design-canvas/drawing";
import { designMinSize } from "../../shared/design-canvas/schema";
import type { DesignNode } from "../canvas-adapter-core";
import { designColorVar, DESIGN_DRAW_DEFAULTS } from "./draw-style";
import { DesignNodeResizer } from "./frame-parts";

export function StrokeNode({ data, selected }: NodeProps<DesignNode>) {
  const { frame } = data;
  const d = strokePath(frame);
  const width = frame.strokeWidth ?? DESIGN_DRAW_DEFAULTS.stroke.strokeWidth;
  return (
    <>
      <DesignNodeResizer selected={selected} minSize={designMinSize("stroke")} />
      <svg
        role="img"
        aria-label={frame.handles ? "Pen path" : "Drawing"}
        data-selected={selected ? "true" : "false"}
        width={frame.w}
        height={frame.h}
        viewBox={`0 0 ${frame.w} ${frame.h}`}
        className="design-line overflow-visible"
        style={{ width: "100%", height: "100%" }}
      >
        {selected ? <path className="design-line-halo" d={d} strokeWidth={width + 8} /> : null}
        <path
          d={d}
          fill="none"
          stroke={designColorVar(frame.color ?? DESIGN_DRAW_DEFAULTS.stroke.color)}
          strokeWidth={width}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        <path className="design-line-hit" d={d} strokeWidth={Math.max(14, width + 8)} />
      </svg>
    </>
  );
}
