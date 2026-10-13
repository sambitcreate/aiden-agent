import * as React from "react";
import { Button } from "../../ui";
import { ModelPadLattice } from "../../model-pad-lattice";
import {
  modelPadLabelPlacement,
  modelPadLeftPercent,
  modelPadTopPercent,
  type ModelPadPlacementKind,
  type ModelPadPoint,
} from "../../../lib/model-pad-layout";
import { cn } from "../../../lib/ui-utils";

/** The floating tag a marker shows on hover, focus, selection or tray hover. */
export interface ModelPadTag {
  title: string;
  lines: readonly string[];
}

/** A placed model's marker, with the handlers its container wires up. */
export interface ModelPadMarkerView {
  value: string;
  point: ModelPadPoint;
  kind: ModelPadPlacementKind;
  ariaLabel: string;
  selected: boolean;
  dragging: boolean;
  linked: boolean;
  hot: boolean;
  tag: ModelPadTag;
  handlers: Pick<
    React.ButtonHTMLAttributes<HTMLButtonElement>,
    | "onFocus"
    | "onBlur"
    | "onPointerEnter"
    | "onPointerLeave"
    | "onPointerDown"
    | "onPointerMove"
    | "onPointerUp"
    | "onPointerCancel"
    | "onKeyDown"
  >;
}

/** A previewed benchmark suggestion: a dashed ghost the user can keep. */
export interface ModelPadGhostView {
  value: string;
  point: ModelPadPoint;
  ariaLabel: string;
  hot: boolean;
  tag: ModelPadTag;
  onKeep: () => void;
  onHotChange: (hot: boolean) => void;
}

/** Edge-aware via the marker's `data-label-*` attributes, so it stays inside the square. */
function MarkerTag({ tag }: { tag: ModelPadTag }) {
  return (
    <span aria-hidden="true" className="model-pad-marker-label">
      <span className="block truncate text-small-strong text-primary">{tag.title}</span>
      {tag.lines.map((line) => (
        <span key={line} className="block truncate text-mini font-normal text-secondary">
          {line}
        </span>
      ))}
    </span>
  );
}

/**
 * The Pad square: the dot lattice, axis captions, markers, suggestion ghosts
 * and the empty state. Under it, the suggestion bar while a preview is open.
 */
export function ModelPadCanvas({
  canvasRef,
  padRef,
  gridSize,
  hiddenCells,
  markers,
  ghosts,
  dragging,
  describedBy,
  emptyState,
  previewBar,
  children,
  onBackgroundPointerDown,
}: {
  canvasRef: React.Ref<HTMLDivElement>;
  padRef: React.Ref<HTMLDivElement>;
  gridSize: number;
  /** `modelPadPointKey` cells under a marker or ghost; no grid dot is drawn there. */
  hiddenCells: ReadonlySet<string>;
  markers: readonly ModelPadMarkerView[];
  ghosts: readonly ModelPadGhostView[];
  dragging: boolean;
  describedBy: string;
  emptyState?: React.ReactNode;
  previewBar?: React.ReactNode;
  /** Screen reader help and announcements, outside the square. */
  children?: React.ReactNode;
  onBackgroundPointerDown: () => void;
}) {
  return (
    <div ref={canvasRef} className="model-pad-canvas min-w-0">
      <div
        ref={padRef}
        aria-describedby={describedBy}
        aria-label="Personal Model Pad arrangement"
        role="group"
        data-dragging={dragging ? "true" : "false"}
        data-grid-size={gridSize}
        className="model-pad relative aspect-square w-full touch-none overflow-hidden rounded-card"
        onPointerDown={(event) => {
          const target = event.target;
          if (target instanceof Element && !target.closest(".model-pad-marker")) {
            onBackgroundPointerDown();
          }
        }}
      >
        <span aria-hidden="true" className="model-pad-axis-captions">
          <span data-axis="capability">More capable</span>
          <span data-axis="faster">Faster</span>
          <span data-axis="deliberate">More deliberate</span>
        </span>

        <ModelPadLattice gridSize={gridSize} hiddenCells={hiddenCells} />

        {emptyState}

        {markers.map((marker) => {
          const labelPlacement = modelPadLabelPlacement(marker.point);
          return (
            <button
              key={marker.value}
              type="button"
              aria-label={marker.ariaLabel}
              aria-pressed={marker.selected}
              data-value={marker.value}
              data-placement-source={marker.kind}
              data-selected={marker.selected ? "true" : "false"}
              data-hot={marker.hot ? "true" : undefined}
              data-linked={marker.linked ? "true" : undefined}
              data-label-align={labelPlacement.align}
              data-label-side={labelPlacement.side}
              className={cn(
                "model-pad-chip model-pad-marker group absolute z-10 grid size-6 -translate-x-1/2 -translate-y-1/2 cursor-grab place-items-center rounded-full bg-transparent outline-none transition-[left,top,opacity] duration-150 ease-out active:cursor-grabbing focus-visible:outline-none",
                marker.selected && "z-30",
                marker.dragging && "z-30 cursor-grabbing opacity-80 duration-75",
              )}
              style={{
                left: `${modelPadLeftPercent(marker.point.x)}%`,
                top: `${modelPadTopPercent(marker.point.y)}%`,
              }}
              {...marker.handlers}
            >
              <span aria-hidden="true" className="model-pad-marker-visual block size-3 rounded-full" />
              <MarkerTag tag={marker.tag} />
            </button>
          );
        })}

        {ghosts.map((ghost) => {
          const labelPlacement = modelPadLabelPlacement(ghost.point);
          return (
            <button
              key={ghost.value}
              type="button"
              aria-label={ghost.ariaLabel}
              data-value={ghost.value}
              data-placement-source="suggestion"
              data-hot={ghost.hot ? "true" : undefined}
              data-label-align={labelPlacement.align}
              data-label-side={labelPlacement.side}
              className="model-pad-marker absolute z-10 grid size-6 -translate-x-1/2 -translate-y-1/2 place-items-center rounded-full bg-transparent outline-none focus-visible:outline-none"
              style={{
                left: `${modelPadLeftPercent(ghost.point.x)}%`,
                top: `${modelPadTopPercent(ghost.point.y)}%`,
              }}
              onClick={ghost.onKeep}
              onPointerEnter={() => ghost.onHotChange(true)}
              onPointerLeave={() => ghost.onHotChange(false)}
            >
              <span aria-hidden="true" className="model-pad-marker-visual block size-3 rounded-full" />
              <MarkerTag tag={ghost.tag} />
            </button>
          );
        })}
      </div>
      {previewBar}
      {children}
    </div>
  );
}

/**
 * An empty-Pad quick start that can be unavailable. When it can't run it stays
 * focusable (aria-disabled) so keyboard and screen reader users hear why.
 */
export function ModelPadQuickStart({
  icon,
  label,
  disabledReason,
  variant,
  onClick,
}: {
  icon: React.ReactNode;
  label: string;
  disabledReason?: string;
  variant?: React.ComponentProps<typeof Button>["variant"];
  onClick: () => void;
}) {
  const reasonId = React.useId();
  return (
    <>
      <Button
        size="small"
        variant={variant}
        // Wraps instead of clipping on a small Pad.
        className={cn(
          "h-auto min-h-7 max-w-full whitespace-normal py-1 text-center",
          disabledReason && "cursor-default opacity-45",
        )}
        aria-disabled={Boolean(disabledReason)}
        aria-describedby={disabledReason ? reasonId : undefined}
        title={disabledReason}
        onClick={() => {
          if (!disabledReason) onClick();
        }}
      >
        {icon}
        {label}
      </Button>
      {disabledReason ? (
        <span id={reasonId} className="sr-only">
          {disabledReason}.
        </span>
      ) : null}
    </>
  );
}

/** The bar under the Pad while benchmark suggestions are previewed. */
export function ModelPadPreviewBar({
  count,
  onKeepAll,
  onDismiss,
}: {
  count: number;
  onKeepAll: () => void;
  onDismiss: () => void;
}) {
  return (
    <div role="group" aria-label="Benchmark suggestions" className="model-pad-preview-bar">
      <span className="px-1 tabular-nums">{`${count} suggestion${count === 1 ? "" : "s"}`}</span>
      <Button size="small" variant="accent" onClick={onKeepAll}>
        Keep all
      </Button>
      <Button size="small" variant="transparent" onClick={onDismiss}>
        Dismiss
      </Button>
    </div>
  );
}
