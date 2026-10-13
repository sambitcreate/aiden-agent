import * as React from "react";
import {
  modelPadLeftPercent,
  modelPadPointKey,
  modelPadTopPercent,
} from "../lib/model-pad-layout";
import { cn } from "../lib/ui-utils";

/**
 * The Pad's dot lattice, shared by the composer picker and the settings
 * editor. Memoized: hovering or dragging a marker re-renders the Pad but not
 * its `gridSize²` dots, as long as `hiddenCells` keeps its identity.
 */
export const ModelPadLattice = React.memo(function ModelPadLattice({
  gridSize,
  hiddenCells,
  activeColumn,
  activeLevel,
  dotClassName = "bg-primary/16",
}: {
  gridSize: number;
  /**
   * `modelPadPointKey` cells under a marker. A dot there would read as a dot
   * inside a hollow ring, so it is skipped; the marker is the affordance.
   */
  hiddenCells?: ReadonlySet<string>;
  /** Column (from the left) and level (from the bottom) whose dots are highlighted. */
  activeColumn?: number;
  activeLevel?: number;
  dotClassName?: string;
}) {
  const divisions = Math.max(1, gridSize - 1);
  return Array.from({ length: gridSize * gridSize }, (_, index) => {
    const column = index % gridSize;
    // Rows render top to bottom; levels count up from the bottom like Pad y.
    const level = divisions - Math.floor(index / gridSize);
    const point = { x: column / divisions, y: level / divisions };
    if (hiddenCells?.has(modelPadPointKey(point, gridSize))) return null;
    const highlighted = column === activeColumn || level === activeLevel;
    return (
      <span
        key={index}
        aria-hidden="true"
        data-grid-cell=""
        className={cn(
          "model-pad-node absolute size-1 -translate-x-1/2 -translate-y-1/2 rounded-full transition-[background-color,opacity] duration-100",
          highlighted ? "bg-primary/50" : dotClassName,
        )}
        style={{
          left: `${modelPadLeftPercent(point.x)}%`,
          top: `${modelPadTopPercent(point.y)}%`,
        }}
      />
    );
  });
});
