/**
 * Geometry for the floating device player over the chat. The frame keeps the
 * screen's aspect ratio under a compact header, stays inside the chat area,
 * and snaps to the nearest edge or corner when released close to it. Sizing
 * reuses the floating browser's math, which is adapted from T3 Code's
 * `previewMiniPlayerLayout.ts` (MIT, see THIRD_PARTY_NOTICES.md).
 */
import {
  BROWSER_FLOATING_GAP,
  browserFloatingFrame,
  resizeBrowserFloatingFrame,
  type BrowserFloatingEdge,
  type BrowserFloatingFrame,
  type BrowserFloatingSize,
} from "./browser-floating-layout";
import type { DeviceKind } from "../shared/devices";

export type DeviceMiniPlayerFrame = BrowserFloatingFrame;
export type DeviceMiniPlayerEdge = BrowserFloatingEdge;

/** The header with the title, Dock and Close above the screen. */
export const DEVICE_MINI_PLAYER_CHROME_HEIGHT = 36;
/** A release this close to an edge lands on it; near two edges, in the corner. */
export const DEVICE_MINI_PLAYER_SNAP_DISTANCE = 48;
export const DEVICE_MINI_PLAYER_GAP = BROWSER_FLOATING_GAP;
export const DEVICE_MINI_PLAYER_KEY_STEP = 16;
export const DEVICE_MINI_PLAYER_KEY_STEP_LARGE = 48;

/** What the user chose; the rendered frame is always re-fitted to the current chat area. */
export interface DeviceMiniPlayerGeometry {
  width: number | null;
  position: { x: number; y: number } | null;
}

export const DEFAULT_DEVICE_MINI_PLAYER_GEOMETRY: DeviceMiniPlayerGeometry = {
  width: null,
  position: null,
};

/** The screen as it is displayed, so a rotated phone floats as a landscape box. */
export function deviceMiniPlayerSource(
  kind: DeviceKind,
  screen: BrowserFloatingSize | null,
): BrowserFloatingSize {
  if (screen && screen.width > 0 && screen.height > 0) {
    return { width: screen.width, height: screen.height };
  }
  // Before the first frame reports a size, the viewer's own placeholder shape stands in.
  return kind === "ipad" ? { width: 820, height: 1180 } : { width: 390, height: 844 };
}

/**
 * The on-screen frame for a stored choice. Clamping happens on every layout
 * pass instead of being written back, so a briefly narrow window never
 * destroys the size the user picked. A fresh player sits in the top-right.
 */
export function deviceMiniPlayerFrame(input: {
  source: BrowserFloatingSize;
  container: BrowserFloatingSize;
  geometry: DeviceMiniPlayerGeometry;
}): DeviceMiniPlayerFrame {
  return browserFloatingFrame({
    source: input.source,
    container: input.container,
    chromeHeight: DEVICE_MINI_PLAYER_CHROME_HEIGHT,
    ...(input.geometry.width === null ? {} : { width: input.geometry.width }),
    ...(input.geometry.position === null ? {} : { position: input.geometry.position }),
  });
}

/** Moves by a pointer or keyboard delta from where the gesture started, clamped inside the chat. */
export function moveDeviceMiniPlayer(input: {
  start: DeviceMiniPlayerFrame;
  delta: { x: number; y: number };
  source: BrowserFloatingSize;
  container: BrowserFloatingSize;
}): DeviceMiniPlayerFrame {
  const { start, delta } = input;
  return deviceMiniPlayerFrame({
    source: input.source,
    container: input.container,
    geometry: { width: start.width, position: { x: start.x + delta.x, y: start.y + delta.y } },
  });
}

/** Resizes from an edge or corner while holding the aspect ratio; the opposite edge stays put. */
export function resizeDeviceMiniPlayer(input: {
  start: DeviceMiniPlayerFrame;
  edge: DeviceMiniPlayerEdge;
  delta: { x: number; y: number };
  source: BrowserFloatingSize;
  container: BrowserFloatingSize;
}): DeviceMiniPlayerFrame {
  return resizeBrowserFloatingFrame({ ...input, chromeHeight: DEVICE_MINI_PLAYER_CHROME_HEIGHT });
}

/**
 * Lands a released player on the edges it was dropped near. Each axis snaps
 * on its own, so a drop near a corner lands in that corner and a drop near one
 * edge slides flush to it; anywhere else the player stays where it was put.
 */
export function snapDeviceMiniPlayer(
  frame: DeviceMiniPlayerFrame,
  container: BrowserFloatingSize,
  distance = DEVICE_MINI_PLAYER_SNAP_DISTANCE,
): DeviceMiniPlayerFrame {
  const gap = DEVICE_MINI_PLAYER_GAP;
  const left = gap;
  const right = Math.max(gap, container.width - frame.width - gap);
  const top = gap;
  const bottom = Math.max(gap, container.height - frame.height - gap);
  const snap = (value: number, start: number, end: number) => {
    const toStart = Math.abs(value - start);
    const toEnd = Math.abs(end - value);
    if (toStart <= distance && toStart <= toEnd) return start;
    if (toEnd <= distance) return end;
    return value;
  };
  return { ...frame, x: snap(frame.x, left, right), y: snap(frame.y, top, bottom) };
}

/** What a frame stores: its width and position, never the clamped height. */
export function deviceMiniPlayerGeometry(frame: DeviceMiniPlayerFrame): DeviceMiniPlayerGeometry {
  return { width: Math.round(frame.width), position: { x: Math.round(frame.x), y: Math.round(frame.y) } };
}

/**
 * Keyboard control for the focused player: arrows move it (Shift for larger
 * steps) and plus or minus resize it from the top-left corner. Returns null
 * for keys the player does not handle.
 */
export function keyboardDeviceMiniPlayer(input: {
  key: string;
  shiftKey: boolean;
  frame: DeviceMiniPlayerFrame;
  source: BrowserFloatingSize;
  container: BrowserFloatingSize;
}): DeviceMiniPlayerFrame | null {
  const step = input.shiftKey ? DEVICE_MINI_PLAYER_KEY_STEP_LARGE : DEVICE_MINI_PLAYER_KEY_STEP;
  const moves: Record<string, { x: number; y: number }> = {
    ArrowLeft: { x: -step, y: 0 },
    ArrowRight: { x: step, y: 0 },
    ArrowUp: { x: 0, y: -step },
    ArrowDown: { x: 0, y: step },
  };
  const delta = moves[input.key];
  if (delta) return moveDeviceMiniPlayer({ start: input.frame, delta, source: input.source, container: input.container });
  const grow = input.key === "+" || input.key === "=" ? step : input.key === "-" || input.key === "_" ? -step : 0;
  if (!grow) return null;
  return resizeDeviceMiniPlayer({
    start: input.frame,
    edge: "southeast",
    delta: { x: grow, y: 0 },
    source: input.source,
    container: input.container,
  });
}

const finite = (value: unknown, max: number): value is number =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= max;

export function parseDeviceMiniPlayerGeometry(raw: string | null): DeviceMiniPlayerGeometry {
  try {
    const data = JSON.parse(raw ?? "null") as Record<string, unknown> | null;
    if (!data || data.version !== 1) return DEFAULT_DEVICE_MINI_PLAYER_GEOMETRY;
    const position = data.position as Record<string, unknown> | null | undefined;
    return {
      width: finite(data.width, 10_000) && data.width > 0 ? data.width : null,
      position:
        position && finite(position.x, 20_000) && finite(position.y, 20_000)
          ? { x: position.x, y: position.y }
          : null,
    };
  } catch {
    return DEFAULT_DEVICE_MINI_PLAYER_GEOMETRY;
  }
}

export function serializeDeviceMiniPlayerGeometry(geometry: DeviceMiniPlayerGeometry): string {
  return JSON.stringify({ version: 1, ...geometry });
}
