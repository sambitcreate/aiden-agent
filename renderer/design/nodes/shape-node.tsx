// A rectangle or an oval, with an optional label in the middle.

import type { NodeProps } from "@xyflow/react";
import { cn } from "../../lib/ui-utils";
import { designMinSize } from "../../shared/design-canvas/schema";
import type { DesignNode } from "../canvas-adapter-core";
import { CanvasText } from "./canvas-text";
import { designColorVar, designFillVar, DESIGN_TEXT_PX } from "./draw-style";
import { DesignNodeResizer } from "./frame-parts";
import { useDesignNodeContext } from "./design-node-context";

export function ShapeNode({ data, selected }: NodeProps<DesignNode>) {
  const { frame } = data;
  const canvas = useDesignNodeContext();
  const oval = frame.shape === "oval";
  const name = oval ? "Oval" : "Rectangle";
  const outline = frame.color ? designColorVar(frame.color) : undefined;
  return (
    <>
      <DesignNodeResizer selected={selected && canvas.editing !== frame.id} minSize={designMinSize("shape")} />
      <div
        role="group"
        aria-label={frame.text ? `${name}: ${frame.text.slice(0, 80)}` : name}
        data-selected={selected ? "true" : "false"}
        className={cn("flex h-full w-full items-center justify-center overflow-hidden p-2", oval ? "rounded-full" : "rounded-[8px]")}
        style={{
          ...(!oval && frame.radius !== undefined ? { borderRadius: frame.radius } : {}),
          background: frame.fill ? designFillVar(frame.fill) : "transparent",
          boxShadow: outline ? `inset 0 0 0 ${frame.strokeWidth ?? 2}px ${outline}` : undefined,
        }}
      >
        {frame.text || canvas.editing === frame.id ? (
          <CanvasText
            frame={frame}
            label={`${name} label`}
            placeholder="Label"
            className="h-auto max-h-full text-center"
            style={{ fontSize: DESIGN_TEXT_PX.small, lineHeight: 1.3, color: "var(--text-primary)" }}
          />
        ) : (
          // An empty shape still takes a double-click to start its label.
          <div aria-hidden className="h-full w-full" onDoubleClick={() => canvas.edit(frame.id)} />
        )}
      </div>
    </>
  );
}
