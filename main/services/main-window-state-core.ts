export interface WindowBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface MainWindowState {
  version: 1;
  bounds?: WindowBounds;
  maximized: boolean;
  fullScreen: boolean;
}

export const DEFAULT_MAIN_WINDOW_SIZE = {
  width: 1_280,
  height: 800,
} as const;

export const MIN_MAIN_WINDOW_SIZE = {
  width: 390,
  height: 456,
} as const;

const DEFAULT_STATE: MainWindowState = {
  version: 1,
  maximized: false,
  fullScreen: false,
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function boundedInteger(value: unknown, limit: number): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && Math.abs(value) <= limit
    ? Math.round(value)
    : undefined;
}

export function normalizeMainWindowState(value: unknown): MainWindowState {
  if (!isRecord(value) || value.version !== 1) return { ...DEFAULT_STATE };
  const candidate = isRecord(value.bounds) ? value.bounds : null;
  const x = boundedInteger(candidate?.x, 1_000_000);
  const y = boundedInteger(candidate?.y, 1_000_000);
  const width = boundedInteger(candidate?.width, 16_384);
  const height = boundedInteger(candidate?.height, 16_384);
  const bounds =
    x !== undefined &&
    y !== undefined &&
    width !== undefined &&
    height !== undefined &&
    width >= MIN_MAIN_WINDOW_SIZE.width &&
    height >= MIN_MAIN_WINDOW_SIZE.height
      ? { x, y, width, height }
      : undefined;
  return {
    version: 1,
    ...(bounds ? { bounds } : {}),
    maximized: value.maximized === true,
    fullScreen: value.fullScreen === true,
  };
}

function intersectionArea(left: WindowBounds, right: WindowBounds): number {
  const width = Math.max(
    0,
    Math.min(left.x + left.width, right.x + right.width) - Math.max(left.x, right.x),
  );
  const height = Math.max(
    0,
    Math.min(left.y + left.height, right.y + right.height) - Math.max(left.y, right.y),
  );
  return width * height;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(Math.max(value, minimum), maximum);
}

/**
 * Restore onto the display with the greatest saved overlap. When a monitor was
 * removed, the primary work area (first in the list) becomes the safe fallback.
 */
export function restoredMainWindowBounds(
  saved: WindowBounds | undefined,
  workAreas: readonly WindowBounds[],
): WindowBounds {
  const fallbackWorkArea = workAreas[0] ?? {
    x: 0,
    y: 0,
    width: DEFAULT_MAIN_WINDOW_SIZE.width,
    height: DEFAULT_MAIN_WINDOW_SIZE.height,
  };
  const workArea = saved
    ? workAreas.reduce(
        (best, candidate) =>
          intersectionArea(saved, candidate) > intersectionArea(saved, best) ? candidate : best,
        fallbackWorkArea,
      )
    : fallbackWorkArea;
  const desired = saved ?? {
    x: workArea.x,
    y: workArea.y,
    ...DEFAULT_MAIN_WINDOW_SIZE,
  };
  const width = clamp(
    desired.width,
    Math.min(MIN_MAIN_WINDOW_SIZE.width, workArea.width),
    workArea.width,
  );
  const height = clamp(
    desired.height,
    Math.min(MIN_MAIN_WINDOW_SIZE.height, workArea.height),
    workArea.height,
  );
  const centeredX = workArea.x + Math.round((workArea.width - width) / 2);
  const centeredY = workArea.y + Math.round((workArea.height - height) / 2);
  return {
    x: saved ? clamp(desired.x, workArea.x, workArea.x + workArea.width - width) : centeredX,
    y: saved ? clamp(desired.y, workArea.y, workArea.y + workArea.height - height) : centeredY,
    width,
    height,
  };
}
