import "../canvas/styles";
import * as React from "react";
import { StudioCanvas, StudioSurface, type CanvasTool } from "../canvas";
import { EmptyState } from "../components/ui";

/** Placeholder until the real Design module replaces this one; the export name and props are the route contract. */
export function DesignRoute(_props: { projectId?: string }) {
  const [tool, setTool] = React.useState<CanvasTool>("select");
  const [minimap, setMinimap] = React.useState(false);
  return (
    <StudioSurface title="Design">
      <StudioCanvas
        label="Design canvas"
        nodes={[]}
        edges={[]}
        tool={tool}
        onToolChange={setTool}
        minimap={minimap}
        onMinimapChange={setMinimap}
        emptyState={
          <EmptyState
            placement="inline"
            title="No design projects yet"
            description="Design projects will appear here."
          />
        }
      />
    </StudioSurface>
  );
}
