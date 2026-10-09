import * as React from "react";
import {
  findDirectionalModel,
  MODEL_PAD_CAPTURE_RADIUS,
  modelOptionId,
  nearestModel,
  type ModelDirection,
  type ModelPoint,
  type PositionedModel,
} from "../lib/model-picker-data";
import {
  MODEL_PAD_INSET_PERCENT,
  MODEL_PAD_KNOB_TAG_MAX_WIDTH_PX,
  MODEL_PAD_PLACEMENT_KIND_LABELS,
  MODEL_PAD_RANGE_PERCENT,
  modelPadKnobTagLayout,
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

const PAD_CENTER: ModelPoint = { x: 0.5, y: 0.5 };

function directionForKey(key: string): ModelDirection | null {
  if (key === "ArrowLeft") return "left";
  if (key === "ArrowRight") return "right";
  if (key === "ArrowUp") return "up";
  if (key === "ArrowDown") return "down";
  return null;
}

interface ModelPadKnobTagProps {
  point: ModelPoint;
  label: string;
  providerLabel: string;
  /** Optional extra line under the provider, such as another route to the same model. */
  secondary?: React.ReactNode;
}

interface KnobTagMeasurements {
  padWidth: number;
  padHeight: number;
  tagHeight: number;
}

/**
 * The previewed model's name beside the knob. Visual only: the listbox announces the
 * active option through `aria-activedescendant`, so the tag stays `aria-hidden`.
 * It is laid out from the measured Pad and tag so it never leaves the clipped square,
 * and stays hidden until it has been measured.
 */
function ModelPadKnobTag({ point, label, providerLabel, secondary }: ModelPadKnobTagProps) {
  const tagRef = React.useRef<HTMLSpanElement>(null);
  const [size, setSize] = React.useState<KnobTagMeasurements>({
    padWidth: 0,
    padHeight: 0,
    tagHeight: 0,
  });

  const measure = React.useCallback(() => {
    // The tag is a direct child of the Pad; a parent ref is not attached yet when this
    // child's layout effect first runs.
    const tag = tagRef.current;
    const pad = tag?.parentElement;
    if (!tag || !pad) return;
    const next = {
      padWidth: pad.clientWidth,
      padHeight: pad.clientHeight,
      tagHeight: tag.offsetHeight,
    };
    setSize((current) =>
      current.padWidth === next.padWidth &&
      current.padHeight === next.padHeight &&
      current.tagHeight === next.tagHeight
        ? current
        : next,
    );
  }, []);

  React.useLayoutEffect(measure, [measure, label, providerLabel, secondary]);

  React.useEffect(() => {
    if (typeof ResizeObserver === "undefined") return;
    const tag = tagRef.current;
    const pad = tag?.parentElement;
    if (!tag || !pad) return;
    const observer = new ResizeObserver(measure);
    observer.observe(pad);
    observer.observe(tag);
    return () => observer.disconnect();
  }, [measure]);

  const measured = size.padWidth > 0 && size.padHeight > 0 && size.tagHeight > 0;
  const layout = measured ? modelPadKnobTagLayout({ point, ...size }) : null;
  const fallback = modelPadLabelPlacement(point);
  return (
    <span
      ref={tagRef}
      aria-hidden="true"
      data-model-pad-knob-tag=""
      data-label-align={layout?.align ?? fallback.align}
      data-label-side={layout?.side ?? fallback.side}
      className="model-pad-knob-tag absolute z-20"
      style={
        layout
          ? { left: layout.x, top: layout.y, maxWidth: layout.maxWidth }
          : { left: 0, top: 0, maxWidth: MODEL_PAD_KNOB_TAG_MAX_WIDTH_PX, visibility: "hidden" }
      }
    >
      <span className="block truncate text-small-strong text-primary">{label}</span>
      <span className="block truncate text-mini font-normal text-secondary">{providerLabel}</span>
      {secondary ? (
        <span className="block truncate text-mini font-normal text-secondary">{secondary}</span>
      ) : null}
    </span>
  );
}

// A single printable character typed without Ctrl, Meta or Alt (Shift is fine).
// Space commits on the Pad, and IME composition belongs to the input method.
function isSearchCharacter(event: React.KeyboardEvent): boolean {
  return (
    event.key.length === 1 &&
    event.key !== " " &&
    !event.ctrlKey &&
    !event.metaKey &&
    !event.altKey &&
    !event.nativeEvent.isComposing
  );
}

interface ModelPickerPadProps {
  models: PositionedModel[];
  gridSize: number;
  selectedValue?: string;
  previewValue?: string;
  onPreview: (value: string | undefined) => void;
  onCommit: (model: PositionedModel) => void;
  /** Called with a printable character typed on the Pad, so the picker can search for it. */
  onTypeToSearch?: (character: string) => void;
}

export function ModelPickerPad({
  models,
  gridSize,
  selectedValue,
  previewValue,
  onPreview,
  onCommit,
  onTypeToSearch,
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
  // A current model that is not on the Pad leaves it without an active option:
  // no knob, no tag and nothing for Enter to commit.
  const active = preview ?? selected;
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

  // Pointer input only reaches models within the capture radius; empty areas of the
  // Pad leave the preview where it is.
  const modelNearPoint = React.useCallback(
    (point: ModelPoint) =>
      nearestModel(models, point, activeValueRef.current, undefined, MODEL_PAD_CAPTURE_RADIUS),
    [models],
  );

  const applyPoint = React.useCallback(
    (point: ModelPoint) => {
      const nearest = modelNearPoint(point);
      if (nearest && nearest.value !== activeValueRef.current) {
        activeValueRef.current = nearest.value;
        setConfirmedValue(undefined);
        onPreview(nearest.value);
      }
    },
    [modelNearPoint, onPreview],
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
    const releasePoint = pointFromPointer(event, rect);
    queuedPointRef.current = releasePoint;
    flushQueuedPoint();
    // A release in an empty area chooses nothing, even after previewing a model.
    const committed = modelNearPoint(releasePoint)
      ? models.find((model) => model.value === activeValueRef.current)
      : undefined;
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
      const hasActive = models.some((model) => model.value === activeValueRef.current);
      // Without an active model, the first press lands on the model nearest the
      // center whatever the direction, so it is predictable.
      const next = hasActive
        ? findDirectionalModel(models, activeValueRef.current, direction)
        : nearestModel(models, PAD_CENTER);
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
      return;
    }
    if (onTypeToSearch && isSearchCharacter(event)) {
      // The picker inserts the character itself, so the native keypress must not
      // add it a second time once focus has moved to the filter.
      event.preventDefault();
      event.stopPropagation();
      onTypeToSearch(event.key);
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

        {/* Axis captions sit in the inset margin outside the lattice; the knob and its
            tag render above them. */}
        <span aria-hidden="true" className="model-pad-axis-captions">
          <span data-axis="capability">More capable</span>
          <span data-axis="faster">Faster</span>
          <span data-axis="deliberate">More deliberate</span>
        </span>

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
        press Enter or Space to select. Type to search the list.
      </p>
    </>
  );
}
