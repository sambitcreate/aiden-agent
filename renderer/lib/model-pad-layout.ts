import * as React from "react";

export const MODEL_PAD_LAYOUT_KEY = "aiden-agent.modelPadLayout.v1";
const MODEL_PAD_LAYOUT_EVENT = "aiden:model-pad-layout-change";
const MAX_PLACEMENTS = 2_000;

export const BASE_MODEL_PAD_GRID_SIZE = 7;
export const MODEL_PAD_GRID_DENSITY = 6;
export const MODEL_PAD_INSET_PERCENT = 8;
export const MODEL_PAD_RANGE_PERCENT = 100 - MODEL_PAD_INSET_PERCENT * 2;

export type ModelPadPlacementSource = "user" | "benchmark" | "neutral";

export interface ModelPadPlacement {
  x: number;
  y: number;
  xSource: ModelPadPlacementSource;
  ySource: ModelPadPlacementSource;
}

export interface ModelPadLayout {
  schemaVersion: 2;
  placements: Record<string, ModelPadPlacement>;
}

export interface ModelPadPoint {
  x: number;
  y: number;
}

export interface ModelPadCapabilitySuggestion {
  value: string;
  capabilityPercentile: number;
}

export type ModelPadDirection = "left" | "right" | "up" | "down";

interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export function emptyModelPadLayout(): ModelPadLayout {
  return { schemaVersion: 2, placements: {} };
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function coordinate(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1
    ? value
    : null;
}

export function parseModelPadLayout(value: unknown): ModelPadLayout {
  const layout = record(value);
  const rawPlacements = record(layout?.placements);
  if ((layout?.schemaVersion !== 1 && layout?.schemaVersion !== 2) || !rawPlacements) {
    return emptyModelPadLayout();
  }

  const rawEntries = Object.entries(rawPlacements);
  if (rawEntries.length > MAX_PLACEMENTS) return emptyModelPadLayout();

  const placements: Record<string, ModelPadPlacement> = {};
  for (const [modelValue, rawPlacement] of rawEntries) {
    const placement = record(rawPlacement);
    const x = coordinate(placement?.x);
    const y = coordinate(placement?.y);
    const legacySource = placement?.source;
    const xSource =
      layout.schemaVersion === 1
        ? legacySource === "user"
          ? "user"
          : legacySource === "artificial-analysis"
            ? "benchmark"
            : null
        : placement?.xSource;
    const ySource =
      layout.schemaVersion === 1
        ? legacySource === "user"
          ? "user"
          : legacySource === "artificial-analysis"
            ? "benchmark"
            : null
        : placement?.ySource;
    if (
      !modelValue ||
      modelValue.length > 1_024 ||
      x === null ||
      y === null ||
      (xSource !== "user" && xSource !== "benchmark" && xSource !== "neutral") ||
      (ySource !== "user" && ySource !== "benchmark" && ySource !== "neutral")
    ) {
      continue;
    }
    placements[modelValue] = { x, y, xSource, ySource };
  }
  return { schemaVersion: 2, placements };
}

function browserStorage(): StorageLike | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

export function readModelPadLayout(storage: StorageLike | null = browserStorage()): ModelPadLayout {
  if (!storage) return emptyModelPadLayout();
  try {
    const raw = storage.getItem(MODEL_PAD_LAYOUT_KEY);
    return raw ? parseModelPadLayout(JSON.parse(raw) as unknown) : emptyModelPadLayout();
  } catch {
    return emptyModelPadLayout();
  }
}

export function writeModelPadLayout(
  layout: ModelPadLayout,
  storage: StorageLike | null = browserStorage(),
): ModelPadLayout {
  const normalized = parseModelPadLayout(layout);
  if (!storage) throw new Error("Model Pad preferences are unavailable.");
  storage.setItem(MODEL_PAD_LAYOUT_KEY, JSON.stringify(normalized));
  if (typeof window !== "undefined") window.dispatchEvent(new Event(MODEL_PAD_LAYOUT_EVENT));
  return normalized;
}

export function modelPadLayoutsEqual(left: ModelPadLayout, right: ModelPadLayout): boolean {
  return JSON.stringify(parseModelPadLayout(left)) === JSON.stringify(parseModelPadLayout(right));
}

function nextOdd(value: number): number {
  return value % 2 === 0 ? value + 1 : value;
}

/**
 * Leave enough open nodes to arrange models meaningfully, while keeping a true
 * center point for neutral benchmark suggestions.
 */
export function modelPadGridSize(visibleModelCount: number): number {
  const scaled = Math.ceil(Math.sqrt(Math.max(0, visibleModelCount) * MODEL_PAD_GRID_DENSITY));
  return Math.max(BASE_MODEL_PAD_GRID_SIZE, nextOdd(scaled));
}

export function modelPadGridPoints(gridSize: number): ModelPadPoint[] {
  const size = Math.max(2, Math.ceil(gridSize));
  return Array.from({ length: size * size }, (_, index) => ({
    x: (index % size) / (size - 1),
    y: Math.floor(index / size) / (size - 1),
  }));
}

export function modelPadLeftPercent(x: number): number {
  return MODEL_PAD_INSET_PERCENT + x * MODEL_PAD_RANGE_PERCENT;
}

export function modelPadTopPercent(y: number): number {
  return MODEL_PAD_INSET_PERCENT + (1 - y) * MODEL_PAD_RANGE_PERCENT;
}

export function modelPadPointKey(point: ModelPadPoint, gridSize: number): string {
  const divisions = Math.max(1, gridSize - 1);
  return `${Math.round(point.x * divisions)}:${Math.round(point.y * divisions)}`;
}

export function snapToModelPadGrid(point: ModelPadPoint, gridSize: number): ModelPadPoint {
  const divisions = Math.max(1, gridSize - 1);
  return {
    x: Math.round(Math.min(1, Math.max(0, point.x)) * divisions) / divisions,
    y: Math.round(Math.min(1, Math.max(0, point.y)) * divisions) / divisions,
  };
}

function nearestPointIndex(desired: ModelPadPoint, candidates: readonly ModelPadPoint[]): number {
  let bestIndex = 0;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (let index = 0; index < candidates.length; index += 1) {
    const point = candidates[index];
    const pointDistance = (point.x - desired.x) ** 2 + (point.y - desired.y) ** 2;
    const best = candidates[bestIndex];
    if (
      pointDistance < bestDistance ||
      (pointDistance === bestDistance &&
        (point.y < best.y || (point.y === best.y && point.x < best.x)))
    ) {
      bestIndex = index;
      bestDistance = pointDistance;
    }
  }
  return bestIndex;
}

/** Choose the nearest free node with stable tie-breaking. */
export function nearestAvailableModelPadPoint(
  desired: ModelPadPoint,
  gridSize: number,
  occupied: readonly ModelPadPoint[],
): ModelPadPoint {
  const occupiedKeys = new Set(occupied.map((point) => modelPadPointKey(point, gridSize)));
  const candidates = modelPadGridPoints(gridSize).filter(
    (point) => !occupiedKeys.has(modelPadPointKey(point, gridSize)),
  );
  if (candidates.length === 0) return snapToModelPadGrid(desired, gridSize);
  return candidates[nearestPointIndex(desired, candidates)];
}

function balancedColumnOrder(size: number): number[] {
  const remaining = new Set(Array.from({ length: size }, (_, column) => column));
  const order: number[] = [];

  while (remaining.size > 0) {
    let bestColumn = 0;
    let bestDistance = -1;
    for (const column of remaining) {
      const distance =
        order.length === 0
          ? -Math.abs(column - (size - 1) / 2)
          : Math.min(...order.map((used) => Math.abs(column - used)));
      if (distance > bestDistance || (distance === bestDistance && column < bestColumn)) {
        bestColumn = column;
        bestDistance = distance;
      }
    }
    order.push(bestColumn);
    remaining.delete(bestColumn);
  }

  return order;
}

/**
 * Pack capability-only benchmark suggestions across the free grid without
 * pretending their horizontal position measures pace. Capability order stays
 * monotonic on Y, while a balanced column sequence prevents neutral-X models
 * from collapsing into a single vertical stack.
 */
export function distributeCapabilityOnlyModelPadSuggestions(
  suggestions: readonly ModelPadCapabilitySuggestion[],
  gridSize: number,
  occupied: readonly ModelPadPoint[],
): Record<string, ModelPadPlacement> {
  const size = Math.max(2, Math.ceil(gridSize));
  const divisions = size - 1;
  const occupiedKeys = new Set(
    occupied.map((point) => modelPadPointKey(snapToModelPadGrid(point, size), size)),
  );
  const freeColumnsByRow = Array.from({ length: size }, (_, row) =>
    Array.from({ length: size }, (_unused, column) => column).filter(
      (column) => !occupiedKeys.has(`${column}:${row}`),
    ),
  );
  const freeCount = freeColumnsByRow.reduce((total, columns) => total + columns.length, 0);
  const normalizedSuggestions = suggestions
    .filter(
      ({ value, capabilityPercentile }) => Boolean(value) && Number.isFinite(capabilityPercentile),
    )
    .sort(
      (left, right) =>
        (left.value < right.value ? -1 : left.value > right.value ? 1 : 0) ||
        left.capabilityPercentile - right.capabilityPercentile,
    );
  const sorted = [
    ...new Map(normalizedSuggestions.map((suggestion) => [suggestion.value, suggestion])).values(),
  ]
    .sort(
      (left, right) =>
        left.capabilityPercentile - right.capabilityPercentile ||
        (left.value < right.value ? -1 : left.value > right.value ? 1 : 0),
    )
    .slice(0, freeCount);
  const columnOrder = balancedColumnOrder(size);
  const columnRank = new Map(columnOrder.map((column, rank) => [column, rank]));
  const columnUse = Array.from({ length: size }, () => 0);
  for (const key of occupiedKeys) {
    const [column] = key.split(":").map(Number);
    if (Number.isInteger(column) && column >= 0 && column < size) columnUse[column] += 1;
  }

  const placements: Record<string, ModelPadPlacement> = {};
  let minimumRow = 0;
  sorted.forEach((suggestion, index) => {
    const remaining = sorted.length - index - 1;
    const desiredRow = Math.round(
      Math.min(1, Math.max(0, suggestion.capabilityPercentile)) * divisions,
    );
    const rowCandidates = freeColumnsByRow
      .map((columns, row) => ({ row, capacity: columns.length }))
      .filter(({ row, capacity }) => {
        if (row < minimumRow || capacity === 0) return false;
        const capacityAtOrAbove = freeColumnsByRow
          .slice(row)
          .reduce((total, columns) => total + columns.length, 0);
        return capacityAtOrAbove - 1 >= remaining;
      })
      .sort(
        (left, right) =>
          Math.abs(left.row - desiredRow) - Math.abs(right.row - desiredRow) ||
          left.row - right.row,
      );
    const row = rowCandidates[0]?.row;
    if (row === undefined) return;

    const columns = freeColumnsByRow[row];
    columns.sort(
      (left, right) =>
        columnUse[left] - columnUse[right] ||
        (columnRank.get(left) ?? left) - (columnRank.get(right) ?? right),
    );
    const column = columns.shift();
    if (column === undefined) return;
    columnUse[column] += 1;
    minimumRow = row;
    placements[suggestion.value] = {
      x: column / divisions,
      y: row / divisions,
      xSource: "neutral",
      ySource: "benchmark",
    };
  });

  return placements;
}

function placementPriority(placement: ModelPadPlacement): number {
  return Number(placement.xSource !== "user") + Number(placement.ySource !== "user");
}

/**
 * Project visible placements onto one collision-free grid. Placements that are
 * hidden or temporarily unavailable remain byte-for-byte intact and reserve no
 * nodes.
 */
export function reflowVisibleModelPadPlacements(
  placements: Readonly<Record<string, ModelPadPlacement>>,
  visibleValues: readonly string[],
  gridSize = modelPadGridSize(visibleValues.length),
): Record<string, ModelPadPlacement> {
  const next = { ...placements };
  const available = modelPadGridPoints(gridSize);
  const visible = [...new Set(visibleValues)]
    .filter((value) => Boolean(placements[value]))
    .sort((left, right) => {
      const priority = placementPriority(placements[left]) - placementPriority(placements[right]);
      return priority || (left < right ? -1 : left > right ? 1 : 0);
    });

  for (const value of visible) {
    const placement = placements[value];
    const point =
      available.length > 0
        ? available.splice(nearestPointIndex(placement, available), 1)[0]
        : snapToModelPadGrid(placement, gridSize);
    next[value] = { ...placement, ...point };
  }
  return next;
}

/** Move along one axis, skipping occupied nodes without changing the other axis. */
export function moveModelPadPoint(
  point: ModelPadPoint,
  direction: ModelPadDirection,
  steps: number,
  gridSize: number,
  occupied: readonly ModelPadPoint[],
): ModelPadPoint {
  const divisions = Math.max(1, gridSize - 1);
  const current = snapToModelPadGrid(point, gridSize);
  const column = Math.round(current.x * divisions);
  const row = Math.round(current.y * divisions);
  const deltaColumn = direction === "left" ? -1 : direction === "right" ? 1 : 0;
  const deltaRow = direction === "down" ? -1 : direction === "up" ? 1 : 0;
  const occupiedKeys = new Set(occupied.map((candidate) => modelPadPointKey(candidate, gridSize)));

  for (let distance = Math.max(1, steps); distance <= divisions; distance += 1) {
    const nextColumn = column + deltaColumn * distance;
    const nextRow = row + deltaRow * distance;
    if (nextColumn < 0 || nextColumn > divisions || nextRow < 0 || nextRow > divisions) break;
    const candidate = { x: nextColumn / divisions, y: nextRow / divisions };
    if (!occupiedKeys.has(modelPadPointKey(candidate, gridSize))) return candidate;
  }
  return current;
}

/** Choose a calm, deterministic open cell near the center for a newly added model. */
export function nextModelPadPlacement(
  placements: Readonly<Record<string, ModelPadPlacement>>,
  visibleModelCount = Object.keys(placements).length + 1,
): ModelPadPlacement {
  const gridSize = modelPadGridSize(visibleModelCount);
  const candidate = nearestAvailableModelPadPoint(
    { x: 0.5, y: 0.5 },
    gridSize,
    Object.values(placements),
  );
  return { x: candidate.x, y: candidate.y, xSource: "user", ySource: "user" };
}

export function useModelPadLayout(): ModelPadLayout {
  const [layout, setLayout] = React.useState(readModelPadLayout);

  React.useEffect(() => {
    const refresh = () => setLayout(readModelPadLayout());
    const onStorage = (event: StorageEvent) => {
      if (event.key === MODEL_PAD_LAYOUT_KEY) refresh();
    };
    window.addEventListener(MODEL_PAD_LAYOUT_EVENT, refresh);
    window.addEventListener("storage", onStorage);
    return () => {
      window.removeEventListener(MODEL_PAD_LAYOUT_EVENT, refresh);
      window.removeEventListener("storage", onStorage);
    };
  }, []);

  return layout;
}
