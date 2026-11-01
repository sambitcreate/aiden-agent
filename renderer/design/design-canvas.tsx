// Loaded on demand so React Flow and its CSS stay out of the entry chunk.
import "../canvas/styles";
import * as React from "react";
import { StudioCanvas, type CanvasTool } from "../canvas";
import { DesignCanvasEmpty } from "./design-canvas-empty";

/** The design canvas for one chat. P1 has no frames yet; P2 fills it. */
export default function DesignCanvas() {
  const [tool, setTool] = React.useState<CanvasTool>("select");
  const [minimap, setMinimap] = React.useState(false);
  return (
    <StudioCanvas
      label="Design canvas"
      tool={tool}
      onToolChange={setTool}
      minimap={minimap}
      onMinimapChange={setMinimap}
      nodes={[]}
      edges={[]}
      emptyState={<DesignCanvasEmpty />}
    />
  );
}
