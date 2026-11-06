// An arrow or a line. It takes the pointer only along the line. Selected,
// it shows a handle at each end; dragging a handle moves that end, onto the
// frame it is dropped on if there is one.

import { useReactFlow, type NodeProps } from "@xyflow/react";
import * as React from "react";
import type { DesignPoint } from "../../shared/design-canvas/connectors";
import type { DesignNode } from "../canvas-adapter-core";
import { designColorVar, DESIGN_DRAW_DEFAULTS } from "./draw-style";
import { useDesignNodeContext } from "./design-node-context";

/** How wide the invisible band along a line is that takes the pointer, in canvas units. */
const HIT_WIDTH = 14;

/** The arrowhead at `tip`, coming from `from`, as an SVG polygon; and where the line should stop. */
export function arrowHead(from: DesignPoint, tip: DesignPoint, width: number): { points: string; base: DesignPoint } {
  const length = Math.hypot(tip.x - from.x, tip.y - from.y) || 1;
  const ux = (tip.x - from.x) / length;
  const uy = (tip.y - from.y) / length;
  const size = Math.min(length, 8 + width * 2);
  const base = { x: tip.x - ux * size, y: tip.y - uy * size };
  const spread = size * 0.5;
  const left = { x: base.x - uy * spread, y: base.y + ux * spread };
  const right = { x: base.x + uy * spread, y: base.y - ux * spread };
  const fmt = (point: DesignPoint) => `${Math.round(point.x * 100) / 100},${Math.round(point.y * 100) / 100}`;
  return { points: `${fmt(tip)} ${fmt(left)} ${fmt(right)}`, base };
}

export function ConnectorNode({ id, data, selected, positionAbsoluteX, positionAbsoluteY }: NodeProps<DesignNode>) {
  const { frame } = data;
  const canvas = useDesignNodeContext();
  const flow = useReactFlow();
  const [dragging, setDragging] = React.useState<{ index: 0 | 1; point: DesignPoint } | null>(null);
  const ends = data.ends ?? [
    { x: frame.x, y: frame.y },
    { x: frame.x + frame.w, y: frame.y + frame.h },
  ];
  const shown: [DesignPoint, DesignPoint] = dragging
    ? dragging.index === 0
      ? [dragging.point, ends[1]]
      : [ends[0], dragging.point]
    : ends;
  // Points relative to the node's top left; while an end is dragged it can leave the box, which SVG allows.
  const local = shown.map((point) => ({ x: point.x - positionAbsoluteX, y: point.y - positionAbsoluteY })) as [
    DesignPoint,
    DesignPoint,
  ];
  const width = frame.strokeWidth ?? DESIGN_DRAW_DEFAULTS.connector.strokeWidth;
  const color = designColorVar(frame.color ?? DESIGN_DRAW_DEFAULTS.connector.color);
  const endHead = frame.arrow ? arrowHead(local[0], local[1], width) : null;
  const startHead = frame.arrow === "both" ? arrowHead(local[1], local[0], width) : null;
  const lineFrom = startHead?.base ?? local[0];
  const lineTo = endHead?.base ?? local[1];
  const name = frame.arrow ? "Arrow" : "Line";

  const startDrag = (index: 0 | 1) => (event: React.PointerEvent<SVGCircleElement>) => {
    if (event.button !== 0) return;
    event.stopPropagation();
    event.preventDefault();
    const handle = event.currentTarget;
    handle.setPointerCapture(event.pointerId);
    const at = (move: PointerEvent | React.PointerEvent) => flow.screenToFlowPosition({ x: move.clientX, y: move.clientY });
    setDragging({ index, point: at(event) });
    const onMove = (move: PointerEvent) => setDragging({ index, point: at(move) });
    const onUp = (up: PointerEvent) => {
      handle.removeEventListener("pointermove", onMove);
      handle.removeEventListener("pointerup", onUp);
      handle.removeEventListener("pointercancel", onCancel);
      setDragging(null);
      canvas.moveEnd(id, index, at(up));
    };
    const onCancel = () => {
      handle.removeEventListener("pointermove", onMove);
      handle.removeEventListener("pointerup", onUp);
      handle.removeEventListener("pointercancel", onCancel);
      setDragging(null);
    };
    handle.addEventListener("pointermove", onMove);
    handle.addEventListener("pointerup", onUp);
    handle.addEventListener("pointercancel", onCancel);
  };

  return (
    <svg
      role="img"
      aria-label={name}
      data-selected={selected ? "true" : "false"}
      width={frame.w}
      height={frame.h}
      className="design-line overflow-visible"
      style={{ width: "100%", height: "100%" }}
    >
      {selected ? (
        <line
          className="design-line-halo"
          x1={local[0].x}
          y1={local[0].y}
          x2={local[1].x}
          y2={local[1].y}
          strokeWidth={width + 8}
        />
      ) : null}
      <line x1={lineFrom.x} y1={lineFrom.y} x2={lineTo.x} y2={lineTo.y} stroke={color} strokeWidth={width} strokeLinecap="round" />
      {endHead ? <polygon points={endHead.points} fill={color} /> : null}
      {startHead ? <polygon points={startHead.points} fill={color} /> : null}
      <line
        className="design-line-hit"
        x1={local[0].x}
        y1={local[0].y}
        x2={local[1].x}
        y2={local[1].y}
        strokeWidth={Math.max(HIT_WIDTH, width + 8)}
      />
      {selected
        ? local.map((point, index) => (
            <circle
              key={index}
              role="presentation"
              data-design-end={index === 0 ? "start" : "end"}
              className="design-line-end nodrag nopan"
              cx={point.x}
              cy={point.y}
              r={5}
              onPointerDown={startDrag(index as 0 | 1)}
            />
          ))
        : null}
    </svg>
  );
}
