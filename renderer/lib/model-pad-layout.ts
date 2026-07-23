import * as React from "react";

export const MODEL_PAD_LAYOUT_KEY = "aiden-agent.modelPadLayout.v1";
const MODEL_PAD_LAYOUT_EVENT = "aiden:model-pad-layout-change";
const MAX_PLACEMENTS = 2_000;

export type ModelPadPlacementSource = "user" | "artificial-analysis";

export interface ModelPadPlacement {
  x: number;
  y: number;
  source: ModelPadPlacementSource;
}

export interface ModelPadLayout {
  schemaVersion: 1;
  placements: Record<string, ModelPadPlacement>;
}

interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export function emptyModelPadLayout(): ModelPadLayout {
  return { schemaVersion: 1, placements: {} };
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
  if (layout?.schemaVersion !== 1 || !rawPlacements) return emptyModelPadLayout();

  const rawEntries = Object.entries(rawPlacements);
  if (rawEntries.length > MAX_PLACEMENTS) return emptyModelPadLayout();

  const placements: Record<string, ModelPadPlacement> = {};
  for (const [modelValue, rawPlacement] of rawEntries) {
    const placement = record(rawPlacement);
    const x = coordinate(placement?.x);
    const y = coordinate(placement?.y);
    const source = placement?.source;
    if (
      !modelValue ||
      modelValue.length > 1_024 ||
      x === null ||
      y === null ||
      (source !== "user" && source !== "artificial-analysis")
    ) {
      continue;
    }
    placements[modelValue] = { x, y, source };
  }
  return { schemaVersion: 1, placements };
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

/** Choose a calm, deterministic open cell near the center for a newly added model. */
export function nextModelPadPlacement(
  placements: Readonly<Record<string, ModelPadPlacement>>,
): ModelPadPlacement {
  const occupied = Object.values(placements);
  const gridSize = Math.max(7, Math.ceil(Math.sqrt(occupied.length + 1)));
  const candidates = Array.from({ length: gridSize * gridSize }, (_, index) => {
    const column = index % gridSize;
    const row = Math.floor(index / gridSize);
    const x = 0.08 + (column / (gridSize - 1)) * 0.84;
    const y = 0.08 + (row / (gridSize - 1)) * 0.84;
    return { x, y, distance: (x - 0.5) ** 2 + (y - 0.5) ** 2 };
  }).sort((left, right) => left.distance - right.distance || left.y - right.y || left.x - right.x);
  const minimumDistance = 0.42 / (gridSize - 1);
  const candidate =
    candidates.find((point) =>
      occupied.every(
        (placement) => Math.hypot(point.x - placement.x, point.y - placement.y) > minimumDistance,
      ),
    ) ??
    candidates.reduce(
      (best, point) => {
        const nearest = Math.min(
          ...occupied.map((placement) => Math.hypot(point.x - placement.x, point.y - placement.y)),
        );
        return nearest > best.nearest ? { point, nearest } : best;
      },
      { point: candidates[0], nearest: Number.NEGATIVE_INFINITY },
    ).point;
  return { x: candidate.x, y: candidate.y, source: "user" };
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
