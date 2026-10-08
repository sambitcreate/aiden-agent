import {
  Background,
  BackgroundVariant,
  MiniMap,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
  useViewport,
  type Edge,
  type Node,
  type ReactFlowProps,
} from "@xyflow/react";
import * as React from "react";
import { CanvasToolRail } from "./canvas-tool-rail";
import { CanvasZoomControls } from "./canvas-zoom-controls";
import { resolveCanvasKey, type CanvasTool } from "./canvas-keymap-core";
import { CANVAS_MAX_ZOOM, CANVAS_MIN_ZOOM } from "./canvas-viewport-core";

export type StudioCanvasProps<N extends Node = Node, E extends Edge = Edge> = Omit<
  ReactFlowProps<N, E>,
  "panOnDrag" | "selectionOnDrag" | "minZoom" | "maxZoom" | "proOptions"
> & {
  label: string;
  tool: CanvasTool;
  onToolChange(tool: CanvasTool): void;
  minimap: boolean;
  onMinimapChange(visible: boolean): void;
  emptyState?: React.ReactNode;
};

function isEditableTarget(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLElement &&
    (target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName))
  );
}

export function StudioCanvas<N extends Node = Node, E extends Edge = Edge>(
  props: StudioCanvasProps<N, E>,
) {
  return (
    <ReactFlowProvider>
      <StudioCanvasInner {...props} />
    </ReactFlowProvider>
  );
}

function StudioCanvasInner<N extends Node, E extends Edge>({
  label,
  tool,
  onToolChange,
  minimap,
  onMinimapChange,
  emptyState,
  nodes,
  nodesDraggable,
  elementsSelectable,
  ...flowProps
}: StudioCanvasProps<N, E>) {
  const flow = useReactFlow<N, E>();
  const { zoom } = useViewport();
  const hand = tool === "hand";

  const zoomIn = () => void flow.zoomIn({ duration: 0 });
  const zoomOut = () => void flow.zoomOut({ duration: 0 });
  const resetZoom = () => void flow.zoomTo(1, { duration: 0 });
  const fitView = () => void flow.fitView({ duration: 0, padding: 0.2 });
  const toggleMinimap = () => onMinimapChange(!minimap);

  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.defaultPrevented) return;
    const command = resolveCanvasKey(
      {
        key: event.key,
        code: event.code,
        metaKey: event.metaKey,
        ctrlKey: event.ctrlKey,
        altKey: event.altKey,
        shiftKey: event.shiftKey,
        repeat: event.repeat,
        isComposing: event.nativeEvent.isComposing,
      },
      { editable: isEditableTarget(event.target) },
    );
    if (!command) return;
    event.preventDefault();
    if (command.type === "tool") onToolChange(command.tool);
    else if (command.type === "zoomIn") zoomIn();
    else if (command.type === "zoomOut") zoomOut();
    else if (command.type === "zoomReset") resetZoom();
    else if (command.type === "fitView") fitView();
    else toggleMinimap();
  };

  return (
    <div
      role="region"
      aria-label={label}
      tabIndex={0}
      data-tool={tool}
      className="studio-canvas relative h-full min-h-0 w-full"
      onKeyDown={onKeyDown}
    >
      <ReactFlow<N, E>
        {...flowProps}
        nodes={nodes}
        panOnDrag={hand ? true : [1, 2]}
        selectionOnDrag={!hand}
        panOnScroll
        nodesDraggable={!hand && nodesDraggable !== false}
        elementsSelectable={!hand && elementsSelectable !== false}
        minZoom={CANVAS_MIN_ZOOM}
        maxZoom={CANVAS_MAX_ZOOM}
        proOptions={{ hideAttribution: true }}
      >
        <Background variant={BackgroundVariant.Dots} gap={24} size={1} />
        {minimap ? <MiniMap pannable zoomable ariaLabel="Canvas overview" /> : null}
      </ReactFlow>
      {(nodes?.length ?? 0) === 0 && emptyState ? (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
          {emptyState}
        </div>
      ) : null}
      <div className="absolute left-3 top-1/2 -translate-y-1/2">
        <CanvasToolRail tool={tool} onToolChange={onToolChange} />
      </div>
      <div className="absolute bottom-3 right-3">
        <CanvasZoomControls
          zoom={zoom}
          minimapVisible={minimap}
          onZoomIn={zoomIn}
          onZoomOut={zoomOut}
          onResetZoom={resetZoom}
          onFitView={fitView}
          onToggleMinimap={toggleMinimap}
        />
      </div>
    </div>
  );
}
