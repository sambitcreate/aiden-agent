// An empty artboard drawn with the Frame tool: a plain surface that holds
// shapes, text and drawings the way a group holds frames. Its name sits just
// above it.

import type { NodeProps } from "@xyflow/react";
import { cn } from "../../lib/ui-utils";
import type { DesignNode } from "../canvas-adapter-core";
import { DesignNodeResizer } from "./frame-parts";
import { designFillVar } from "./draw-style";
import { FrameTitle } from "./frame-title";
import { LayoutGuide } from "./layout-guide";

export function ArtboardNode({ data, selected }: NodeProps<DesignNode>) {
  const { frame } = data;
  return (
    <>
      <DesignNodeResizer selected={selected} />
      <div
        role="group"
        aria-label={frame.title}
        data-selected={selected ? "true" : "false"}
        className="relative h-full w-full"
      >
        <div className="absolute bottom-full left-0 flex max-w-full pb-1">
          <FrameTitle frame={frame} className={cn("text-small text-secondary", selected && "text-primary")} />
        </div>
        <div
          className="relative h-full w-full overflow-hidden bg-popover shadow-control"
          style={{
            borderRadius: frame.radius ?? 4,
            ...(frame.fill ? { background: designFillVar(frame.fill) } : {}),
          }}
        >
          {frame.guide ? <LayoutGuide guide={frame.guide} scale={1} /> : null}
        </div>
      </div>
    </>
  );
}
