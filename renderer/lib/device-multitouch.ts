/**
 * Two-finger input for the flat simulator view, modelled on Simulator.app:
 *
 * - Option-drag: two touches mirrored around the screen centre. Moving the
 *   pointer toward or away from the centre pinches; moving around it rotates.
 * - Option+Shift-drag: the same pair, moved together for a two-finger pan.
 * - A trackpad pinch (Chromium reports it as a `wheel` with `ctrlKey`) becomes
 *   a pinch around the pointer.
 *
 * Points are normalized 0..1 in the displayed screen, like single touches;
 * the stream client remaps them for a rotated device. serve-sim's helper takes
 * both contacts in one `0x05` packet (`{ type, x1, y1, x2, y2 }`).
 *
 * This module is pure geometry plus small state machines, so the 3D view can
 * reuse it with its own pointer mapping.
 */

export interface TouchPoint {
  x: number;
  y: number;
}
export type TouchPair = readonly [TouchPoint, TouchPoint];
export type MultiTouchPhase = "begin" | "move" | "end";
export type MultiTouchMode = "pinch" | "pan";

export interface MultiTouchSink {
  sendMultiTouch(phase: MultiTouchPhase, first: TouchPoint, second: TouchPoint): void;
}

export const SCREEN_CENTER: TouchPoint = { x: 0.5, y: 0.5 };

const clamp01 = (value: number) => Math.min(1, Math.max(0, value));
const clampPoint = (point: TouchPoint): TouchPoint => ({ x: clamp01(point.x), y: clamp01(point.y) });

/** Option alone pinches or rotates; Option+Shift pans; anything else is a normal touch. */
export function multiTouchMode(modifiers: { altKey: boolean; shiftKey: boolean; metaKey?: boolean; ctrlKey?: boolean }): MultiTouchMode | null {
  if (!modifiers.altKey || modifiers.metaKey || modifiers.ctrlKey) return null;
  return modifiers.shiftKey ? "pan" : "pinch";
}

/** The point opposite `point` through `center`, kept on the screen. */
export function mirrorPoint(point: TouchPoint, center: TouchPoint = SCREEN_CENTER): TouchPoint {
  return clampPoint({ x: 2 * center.x - point.x, y: 2 * center.y - point.y });
}

/** The pointer's touch and its mirror. */
export function mirroredPair(point: TouchPoint, center: TouchPoint = SCREEN_CENTER): TouchPair {
  const first = clampPoint(point);
  return [first, mirrorPoint(first, center)];
}

/** Midpoint, separation, and angle (radians, screen axes) of a pair. */
export function pairGeometry([first, second]: TouchPair): { center: TouchPoint; distance: number; angle: number } {
  return {
    center: { x: (first.x + second.x) / 2, y: (first.y + second.y) / 2 },
    distance: Math.hypot(second.x - first.x, second.y - first.y),
    angle: Math.atan2(second.y - first.y, second.x - first.x),
  };
}

/** Moves a pair by `delta`, limited so both touches stay on the screen and keep their spacing. */
export function translatePair([first, second]: TouchPair, delta: TouchPoint): TouchPair {
  const minX = Math.min(first.x, second.x);
  const maxX = Math.max(first.x, second.x);
  const minY = Math.min(first.y, second.y);
  const maxY = Math.max(first.y, second.y);
  const dx = Math.min(1 - maxX, Math.max(-minX, delta.x));
  const dy = Math.min(1 - maxY, Math.max(-minY, delta.y));
  return [
    { x: first.x + dx, y: first.y + dy },
    { x: second.x + dx, y: second.y + dy },
  ];
}

export interface MultiTouchGesture {
  /** The pair a press at `point` would start, for touch indicators while Option is held. */
  preview(point: TouchPoint, mode: MultiTouchMode): TouchPair;
  begin(point: TouchPoint, mode: MultiTouchMode): TouchPair;
  /** Null when no gesture is active. */
  move(point: TouchPoint): TouchPair | null;
  end(): void;
  active(): boolean;
}

/** One Option-drag (pinch/rotate) or Option+Shift-drag (pan), sent as begin, moves, and end. */
export function createMultiTouchGesture(sink: MultiTouchSink): MultiTouchGesture {
  let state: { mode: MultiTouchMode; start: TouchPoint; anchor: TouchPair; last: TouchPair } | null = null;
  const send = (phase: MultiTouchPhase, pair: TouchPair) => sink.sendMultiTouch(phase, pair[0], pair[1]);
  return {
    preview: (point) => mirroredPair(point),
    begin(point, mode) {
      if (state) send("end", state.last);
      const pair = mirroredPair(point);
      state = { mode, start: clampPoint(point), anchor: pair, last: pair };
      send("begin", pair);
      return pair;
    },
    move(point) {
      if (!state) return null;
      const target = clampPoint(point);
      const pair =
        state.mode === "pan"
          ? translatePair(state.anchor, { x: target.x - state.start.x, y: target.y - state.start.y })
          : mirroredPair(target);
      state.last = pair;
      send("move", pair);
      return pair;
    },
    end() {
      if (!state) return;
      send("end", state.last);
      state = null;
    },
    active: () => state !== null,
  };
}

/** The radius a trackpad pinch starts at, as a fraction of the screen. */
export const TRACKPAD_PINCH_START_RADIUS = 0.15;
const TRACKPAD_PINCH_MIN_RADIUS = 0.03;
const TRACKPAD_PINCH_MAX_RADIUS = 0.48;
/** Wheel deltas per e-fold of scale; Chromium's trackpad pinch deltas are small. */
const TRACKPAD_PINCH_SENSITIVITY = 100;
export const TRACKPAD_PINCH_IDLE_MS = 150;

type Timer = ReturnType<typeof setTimeout>;

export interface TrackpadPinch {
  /** One `ctrlKey` wheel event. Returns the pair it moved to. */
  wheel(input: { deltaY: number; point: TouchPoint }): TouchPair;
  /** Ends an active pinch now, e.g. when the view goes away. */
  cancel(): void;
  active(): boolean;
}

/**
 * Turns a run of trackpad pinch events into one two-finger pinch around the
 * pointer. The pinch ends once events stop arriving for `idleMs`.
 */
export function createTrackpadPinch(options: {
  sink: MultiTouchSink;
  setTimeout(callback: () => void, ms: number): Timer;
  clearTimeout(timer: Timer): void;
  idleMs?: number;
  onEnd?(): void;
}): TrackpadPinch {
  const idleMs = options.idleMs ?? TRACKPAD_PINCH_IDLE_MS;
  let state: { center: TouchPoint; radius: number; last: TouchPair; timer: Timer | null } | null = null;
  const pairAt = (center: TouchPoint, radius: number): TouchPair => [
    { x: center.x - radius, y: center.y },
    { x: center.x + radius, y: center.y },
  ];
  const finish = () => {
    if (!state) return;
    if (state.timer) options.clearTimeout(state.timer);
    options.sink.sendMultiTouch("end", state.last[0], state.last[1]);
    state = null;
    options.onEnd?.();
  };
  return {
    wheel({ deltaY, point }) {
      if (!state) {
        // The pinch centre sits where both fingers fit on the screen at the largest radius.
        const margin = TRACKPAD_PINCH_START_RADIUS;
        const center = { x: Math.min(1 - margin, Math.max(margin, point.x)), y: clamp01(point.y) };
        const last = pairAt(center, TRACKPAD_PINCH_START_RADIUS);
        state = { center, radius: TRACKPAD_PINCH_START_RADIUS, last, timer: null };
        options.sink.sendMultiTouch("begin", last[0], last[1]);
      }
      const scale = Math.exp(-deltaY / TRACKPAD_PINCH_SENSITIVITY);
      const limit = Math.min(TRACKPAD_PINCH_MAX_RADIUS, state.center.x, 1 - state.center.x);
      state.radius = Math.min(limit, Math.max(TRACKPAD_PINCH_MIN_RADIUS, state.radius * scale));
      state.last = pairAt(state.center, state.radius);
      options.sink.sendMultiTouch("move", state.last[0], state.last[1]);
      if (state.timer) options.clearTimeout(state.timer);
      state.timer = options.setTimeout(finish, idleMs);
      return state.last;
    },
    cancel: finish,
    active: () => state !== null,
  };
}
