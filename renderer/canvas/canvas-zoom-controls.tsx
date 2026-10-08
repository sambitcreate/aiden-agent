import { Map as MapIcon, Maximize, ZoomIn, ZoomOut } from "lucide-react";
import { Button } from "../components/ui";
import { CANVAS_COMMAND_SHORTCUTS } from "./canvas-keymap-core";
import { CANVAS_MAX_ZOOM, CANVAS_MIN_ZOOM, formatZoomPercent } from "./canvas-viewport-core";

export interface CanvasZoomControlsProps {
  zoom: number;
  minimapVisible: boolean;
  onZoomIn(): void;
  onZoomOut(): void;
  onResetZoom(): void;
  onFitView(): void;
  onToggleMinimap(): void;
}

const EPSILON = 1e-6;

export function CanvasZoomControls({
  zoom,
  minimapVisible,
  onZoomIn,
  onZoomOut,
  onResetZoom,
  onFitView,
  onToggleMinimap,
}: CanvasZoomControlsProps) {
  const percent = formatZoomPercent(zoom);
  return (
    <div
      role="toolbar"
      aria-label="Zoom"
      className="glass-surface flex items-center gap-0.5 rounded-button p-1 shadow-control"
    >
      <Button
        variant="transparent"
        iconOnly
        aria-label="Zoom out"
        aria-keyshortcuts={CANVAS_COMMAND_SHORTCUTS.zoomOut}
        disabled={zoom <= CANVAS_MIN_ZOOM + EPSILON}
        onClick={onZoomOut}
      >
        <ZoomOut />
      </Button>
      <Button
        variant="transparent"
        aria-label={`Zoom ${percent}, reset to 100%`}
        aria-keyshortcuts={CANVAS_COMMAND_SHORTCUTS.zoomReset}
        className="min-w-14 tabular-nums"
        onClick={onResetZoom}
      >
        {percent}
      </Button>
      <Button
        variant="transparent"
        iconOnly
        aria-label="Zoom in"
        aria-keyshortcuts={CANVAS_COMMAND_SHORTCUTS.zoomIn}
        disabled={zoom >= CANVAS_MAX_ZOOM - EPSILON}
        onClick={onZoomIn}
      >
        <ZoomIn />
      </Button>
      <Button
        variant="transparent"
        iconOnly
        aria-label="Fit to screen"
        aria-keyshortcuts={CANVAS_COMMAND_SHORTCUTS.fitView}
        onClick={onFitView}
      >
        <Maximize />
      </Button>
      <Button
        variant={minimapVisible ? "muted" : "transparent"}
        iconOnly
        aria-label="Overview map"
        aria-pressed={minimapVisible}
        aria-keyshortcuts={CANVAS_COMMAND_SHORTCUTS.toggleMinimap}
        onClick={onToggleMinimap}
      >
        <MapIcon />
      </Button>
    </div>
  );
}
