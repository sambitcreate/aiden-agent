// Text placed with the Text tool: words straight on the canvas, no card.

import type { NodeProps } from "@xyflow/react";
import { designMinSize } from "../../shared/design-canvas/schema";
import type { DesignNode } from "../canvas-adapter-core";
import { CanvasText } from "./canvas-text";
import { designColorVar, DESIGN_DRAW_DEFAULTS, DESIGN_TEXT_PX } from "./draw-style";
import { DesignNodeResizer } from "./frame-parts";
import { useDesignNodeContext } from "./design-node-context";

export function TextNode({ data, selected }: NodeProps<DesignNode>) {
  const { frame } = data;
  const canvas = useDesignNodeContext();
  const size = DESIGN_TEXT_PX[frame.size ?? DESIGN_DRAW_DEFAULTS.text.size];
  return (
    <>
      <DesignNodeResizer selected={selected && canvas.editing !== frame.id} minSize={designMinSize("text")} />
      <div
        role="group"
        aria-label={frame.text ? `Text: ${frame.text.slice(0, 80)}` : "Text"}
        data-selected={selected ? "true" : "false"}
        className="h-full w-full"
      >
        <CanvasText
          frame={frame}
          label="Text"
          placeholder="Type something"
          grow
          removeWhenEmpty
          style={{
            fontSize: size,
            lineHeight: 1.3,
            color: frame.color ? designColorVar(frame.color) : "var(--text-primary)",
          }}
        />
      </div>
    </>
  );
}
