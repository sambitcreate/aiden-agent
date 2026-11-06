// A group: a soft filled region with its title, drawn under its frames. It has
// no border; selection shows as the list-selection fill.

import type { NodeProps } from "@xyflow/react";
import { cn } from "../../lib/ui-utils";
import type { DesignNode } from "../canvas-adapter-core";
import { DesignNodeResizer } from "./frame-parts";
import { FrameTitle } from "./frame-title";

export function GroupNode({ data, selected }: NodeProps<DesignNode>) {
  const { frame } = data;
  return (
    <>
      <DesignNodeResizer selected={selected} />
      <div
        role="group"
        aria-label={frame.title}
        data-selected={selected ? "true" : "false"}
        className={cn("h-full w-full rounded-button bg-control/50", selected && "bg-list-selection")}
      >
        <div className="flex min-w-0 px-3 pt-2">
          <FrameTitle frame={frame} className="text-secondary" />
        </div>
      </div>
    </>
  );
}
