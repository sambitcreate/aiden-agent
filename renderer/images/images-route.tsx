import "../canvas/styles";
import * as React from "react";
import { StudioCanvas, StudioSurface, type CanvasTool } from "../canvas";
import { EmptyState } from "../components/ui";

/** Placeholder until the real Images module replaces this one; the export name and props are the route contract. */
export function ImagesRoute(_props: { workflowId?: string }) {
  const [tool, setTool] = React.useState<CanvasTool>("select");
  const [minimap, setMinimap] = React.useState(false);
  return (
    <StudioSurface title="Images">
      <StudioCanvas
        label="Images canvas"
        nodes={[]}
        edges={[]}
        tool={tool}
        onToolChange={setTool}
        minimap={minimap}
        onMinimapChange={setMinimap}
        emptyState={
          <EmptyState
            placement="inline"
            title="No image workflows yet"
            description="Image workflows will appear here."
          />
        }
      />
    </StudioSurface>
  );
}
