import * as React from "react";
import {
  findDirectionalModel,
  modelOptionId,
  nearestModel,
  type ModelDirection,
  type ModelPoint,
  type PositionedModel,
} from "../lib/model-picker-data";
import {
  MODEL_PAD_INSET_PERCENT,
  MODEL_PAD_PLACEMENT_KIND_LABELS,
  MODEL_PAD_RANGE_PERCENT,
  modelPadLabelPlacement,
  modelPadLeftPercent,
  modelPadTopPercent,
} from "../lib/model-pad-layout";
import { cn } from "../lib/ui-utils";
import { ProviderIcon } from "./provider-icon";

function pointFromPointer(event: React.PointerEvent<HTMLDivElement>, rect: DOMRect): ModelPoint {
  const inset = MODEL_PAD_INSET_PERCENT / 100;
  const range = MODEL_PAD_RANGE_PERCENT / 100;
  const rawX = (event.clientX - rect.left) / rect.width;
  const rawY = (event.clientY - rect.top) / rect.height;
  return {
    x: Math.min(1, Math.max(0, (rawX - inset) / range)),
    y: 1 - Math.min(1, Math.max(0, (rawY - inset) / range)),
  };
}

function directionForKey(key: string): ModelDirection | null {
  if (key === "ArrowLeft") return "left";
  if (key === "ArrowRight") return "right";
  if (key === "ArrowUp") return "up";
  if (key === "ArrowDown") return "down";
  return null;
}

/** Half the knob (24px): start/end tags line up with the knob's outer edge. */
const KNOB_TAG_OFFSET_PX = 12;
/** Space kept between the tag and the Pad's edge. */
const KNOB_TAG_EDGE_GUTTER_PX = 4;

/**
 * The widest the tag can be without leaving the Pad square, given where it is anchored.
 * The Pad clips its content (`contain: paint`), so the tag must fit by construction.
 */
function knobTagMaxWidth(leftPercent: number, align: "start" | "center" | "end"): string {
  if (align === "center") {
    const room = 2 * Math.min(leftPercent, 100 - leftPercent);
    return `min(12rem, calc(${room}% - ${KNOB_TAG_EDGE_GUTTER_PX * 2}px))`;
  }
  const room = align === "start" ? 100 - leftPercent : leftPercent;
  return `min(12rem, calc(${room}% + ${KNOB_TAG_OFFSET_PX - KNOB_TAG_EDGE_GUTTER_PX}px))`;
}

interface ModelPadKnobTagProps {
  point: ModelPoint;
  label: string;
  providerLabel: string;
  /** Optional extra line under the provider, such as another route to the same model. */
  secondary?: React.ReactNode;
}

/**
 * The previewed model's name beside the knob. Visual only: the listbox announces the
 * active option through `aria-activedescendant`, so the tag stays `aria-hidden`.
 */
function ModelPadKnobTag({ point, label, providerLabel, secondary }: ModelPadKnobTagProps) {
  const { align, side } = modelPadLabelPlacement(point);
  const leftPercent = modelPadLeftPercent(point.x);
  return (
    <span
      aria-hidden="true"
      data-model-pad-knob-tag=""
      data-label-align={align}
      data-label-side={side}
      className="model-pad-knob-tag absolute z-20"
      style={{
        left: `${leftPercent}%`,
        top: `${modelPadTopPercent(point.y)}%`,
        maxWidth: knobTagMaxWidth(leftPercent, align),
      }}
    >
      <span className="block truncate text-small-strong text-primary">{label}</span>
      <span className="block truncate text-mini font-normal text-secondary">{providerLabel}</span>
      {secondary ? (
        <span className="block truncate text-mini font-normal text-secondary">{secondary}</span>
      ) : null}
    </span>
  );
}

interface ModelPickerPadProps {
  models: PositionedModel[];
  gridSize: number;
  selectedValue?: string;
  previewValue?: string;
  onPreview: (value: string | undefined) => void;
  onCommit: (model: PositionedModel) => void;
}

export function ModelPickerPad({
  models,
  gridSize,
  selectedValue,
  previewValue,
  onPreview,
  onCommit,
}: ModelPickerPadProps) {
  const helpId = React.useId();
  const rectRef = React.useRef<DOMRect | null>(null);
  const frameRef = React.useRef<number | null>(null);
  const queuedPointRef = React.useRef<ModelPoint | null>(null);
  const activeValueRef = React.useRef(previewValue ?? selectedValue);
  const draggingRef = React.useRef(false);
  const [dragging, setDragging] = React.useState(false);
  const [confirmedValue, setConfirmedValue] = React.useState<string>();

  React.useEffect(() => {
    activeValueRef.current = previewValue ?? selectedValue;
  }, [previewValue, selectedValue]);

  const selected = models.find((model) => model.value === selectedValue);
  const preview = models.find((model) => model.value === (previewValue ?? selectedValue));
  const active = preview ?? selected ?? models[0];
  const puckPoint = active;
  const crosshairPoint = active;
  const activeColumn = crosshairPoint ? Math.round(crosshairPoint.x * (gridSize - 1)) : -1;
  const activeRow = crosshairPoint ? Math.round((1 - crosshairPoint.y) * (gridSize - 1)) : -1;
  // A grid dot under a marker would read as a dot inside a hollow ring, so occupied cells skip it.
  const occupiedCells = new Set(
    models.map(
      (model) =>
        `${Math.round(model.x * (gridSize - 1))}:${Math.round((1 - model.y) * (gridSize - 1))}`,
    ),
  );

  const applyPoint = React.useCallback(
    (point: ModelPoint) => {
      const nearest = nearestModel(models, point, activeValueRef.current);
      if (nearest && nearest.value !== activeValueRef.current) {
        activeValueRef.current = nearest.value;
        setConfirmedValue(undefined);
        onPreview(nearest.value);
      }
    },
    [models, onPreview],
  );

  const flushQueuedPoint = React.useCallback(() => {
    if (frameRef.current !== null) {
      cancelAnimationFrame(frameRef.current);
      frameRef.current = null;
    }
    const point = queuedPointRef.current;
    queuedPointRef.current = null;
    if (point) applyPoint(point);
  }, [applyPoint]);

  const schedulePoint = React.useCallback(
    (point: ModelPoint) => {
      queuedPointRef.current = point;
      if (frameRef.current !== null) return;
      frameRef.current = requestAnimationFrame(() => {
        frameRef.current = null;
        const queued = queuedPointRef.current;
        queuedPointRef.current = null;
        if (queued) applyPoint(queued);
      });
    },
    [applyPoint],
  );

  React.useEffect(() => {
    return () => {
      if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
    };
  }, []);

  const handlePointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    rectRef.current = event.currentTarget.getBoundingClientRect();
    draggingRef.current = true;
    setDragging(true);
    event.currentTarget.setPointerCapture(event.pointerId);
    event.currentTarget.focus();
    const point = pointFromPointer(event, rectRef.current);
    applyPoint(point);
  };

  const handlePointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.pointerType !== "mouse" && !draggingRef.current) return;
    rectRef.current ??= event.currentTarget.getBoundingClientRect();
    schedulePoint(pointFromPointer(event, rectRef.current));
  };

  const handlePointerUp = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!draggingRef.current) return;
    event.preventDefault();
    const rect = rectRef.current ?? event.currentTarget.getBoundingClientRect();
    queuedPointRef.current = pointFromPointer(event, rect);
    flushQueuedPoint();
    const committed = models.find((model) => model.value === activeValueRef.current);
    draggingRef.current = false;
    setDragging(false);
    rectRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    if (committed) onCommit(committed);
    if (committed) setConfirmedValue(committed.value);
  };

  const handlePointerCancel = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!draggingRef.current) return;
    draggingRef.current = false;
    setDragging(false);
    rectRef.current = null;
    queuedPointRef.current = null;
    if (frameRef.current !== null) {
      cancelAnimationFrame(frameRef.current);
      frameRef.current = null;
    }
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    activeValueRef.current = selectedValue;
    onPreview(selectedValue);
  };

  const handlePointerLeave = () => {
    if (draggingRef.current) return;
    rectRef.current = null;
    queuedPointRef.current = null;
    if (frameRef.current !== null) {
      cancelAnimationFrame(frameRef.current);
      frameRef.current = null;
    }
    activeValueRef.current = selectedValue;
    onPreview(selectedValue);
  };

  const handleKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    const direction = directionForKey(event.key);
    if (direction) {
      event.preventDefault();
      event.stopPropagation();
      const next = findDirectionalModel(models, activeValueRef.current, direction);
      if (next) {
        activeValueRef.current = next.value;
        setConfirmedValue(undefined);
        onPreview(next.value);
      }
      return;
    }
    if (event.key === "Enter" || event.key === " ") {
      const next = models.find((model) => model.value === activeValueRef.current);
      if (next) {
        event.preventDefault();
        event.stopPropagation();
        onCommit(next);
        setConfirmedValue(next.value);
      }
      return;
    }
    if (event.key === "Escape" && activeValueRef.current !== selectedValue) {
      event.preventDefault();
      event.stopPropagation();
      activeValueRef.current = selectedValue;
      onPreview(selectedValue);
    }
  };

  return (
    <>
      <div
        role="listbox"
        tabIndex={0}
        aria-label={`Model pad with ${gridSize} rows and ${gridSize} columns. Faster models are to the left and more capable models are toward the top.`}
        aria-roledescription="two-dimensional model picker"
        aria-describedby={helpId}
        aria-activedescendant={active ? modelOptionId(active.value) : undefined}
        data-dragging={dragging ? "true" : "false"}
        className="model-pad relative aspect-square w-full touch-none overflow-hidden rounded-card outline-none"
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerCancel}
        onPointerLeave={handlePointerLeave}
        onKeyDown={handleKeyDown}
      >
        <span
          aria-hidden="true"
          className="absolute size-2 -translate-x-1/2 -translate-y-1/2 rounded-full border border-primary/25"
          style={{ left: "50%", top: "50%" }}
        />

        {Array.from({ length: gridSize * gridSize }, (_, index) => {
          const column = index % gridSize;
          const row = Math.floor(index / gridSize);
          if (occupiedCells.has(`${column}:${row}`)) return null;
          const highlighted = column === activeColumn || row === activeRow;
          return (
            <span
              key={index}
              aria-hidden="true"
              data-grid-cell=""
              className={cn(
                "absolute size-1 -translate-x-1/2 -translate-y-1/2 rounded-full transition-[background-color,opacity] duration-100",
                highlighted ? "bg-primary/50" : "bg-primary/16",
              )}
              style={{
                left: `${MODEL_PAD_INSET_PERCENT + (column / (gridSize - 1)) * MODEL_PAD_RANGE_PERCENT}%`,
                top: `${MODEL_PAD_INSET_PERCENT + (row / (gridSize - 1)) * MODEL_PAD_RANGE_PERCENT}%`,
              }}
            />
          );
        })}

        {models.map((model) => {
          const isSelected = model.value === selectedValue;
          const isPreview = model.value === active?.value;
          return (
            <span
              key={model.value}
              id={modelOptionId(model.value)}
              role="option"
              aria-selected={isSelected}
              aria-label={`${model.label}, ${model.providerLabel}, ${model.capabilityLabel}, ${model.paceLabel}, ${MODEL_PAD_PLACEMENT_KIND_LABELS[model.placementKind]}`}
              data-placement-source={model.placementKind}
              data-state={isSelected ? "selected" : isPreview ? "preview" : "resting"}
              className="model-pad-model absolute -translate-x-1/2 -translate-y-1/2 rounded-full"
              style={{
                left: `${modelPadLeftPercent(model.x)}%`,
                top: `${modelPadTopPercent(model.y)}%`,
              }}
            />
          );
        })}

        {puckPoint ? (
          <span
            aria-hidden="true"
            data-confirmed={confirmedValue === puckPoint.value ? "true" : "false"}
            className="model-pad-knob absolute z-10 flex size-6 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full bg-white shadow-popover ring-1 ring-black/20"
            style={{
              left: `${modelPadLeftPercent(puckPoint.x)}%`,
              top: `${modelPadTopPercent(puckPoint.y)}%`,
            }}
          >
            <ProviderIcon
              providerId={puckPoint.providerId}
              providerLabel={puckPoint.providerLabel}
              modelId={puckPoint.model}
              artwork={puckPoint.providerArtwork}
              className="size-3.5"
            />
          </span>
        ) : null}

        {puckPoint ? (
          <ModelPadKnobTag
            point={puckPoint}
            label={puckPoint.label}
            providerLabel={puckPoint.providerLabel}
          />
        ) : null}
      </div>
      <p id={helpId} className="sr-only">
        Drag or point to preview the nearest model. Use the arrow keys to move between models, then
        press Enter or Space to select.
      </p>
    </>
  );
}
