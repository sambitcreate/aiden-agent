// Adapted from t3code packages/client-runtime/src/device/phoneInteraction.ts and renderScheduler.ts @ 1c127066 (MIT).

export interface Point {
  readonly x: number;
  readonly y: number;
}

/** Coalesces invalidations into one render. No work is scheduled while the view is idle. */
export function createRenderScheduler(
  render: () => void,
  request: (callback: FrameRequestCallback) => number = requestAnimationFrame,
  cancel: (id: number) => void = cancelAnimationFrame,
) {
  let pending: number | null = null;
  let disposed = false;
  return {
    invalidate() {
      if (disposed || pending !== null) return;
      pending = request(() => {
        pending = null;
        if (!disposed) render();
      });
    },
    dispose() {
      disposed = true;
      if (pending !== null) cancel(pending);
      pending = null;
    },
  };
}

/**
 * Two-finger trackpad swipes orbit, in viewport fractions. Pinch (ctrlKey) and
 * malformed deltas are ignored, so the event keeps its default behavior.
 */
export function wheelOrbit(input: {
  readonly deltaX: number;
  readonly deltaY: number;
  readonly deltaMode: number;
  readonly ctrlKey: boolean;
  readonly width: number;
  readonly height: number;
}): Point | null {
  const { deltaX, deltaY, deltaMode, ctrlKey, width, height } = input;
  if (ctrlKey) return null;
  if (![deltaX, deltaY, width, height].every(Number.isFinite) || width <= 0 || height <= 0) return null;
  if (deltaMode !== 0 && deltaMode !== 1 && deltaMode !== 2) return null;
  if (!deltaX && !deltaY) return null;
  const unit = deltaMode === 1 ? 16 : deltaMode === 2 ? height : 1;
  const clamp = (value: number) => Math.min(0.25, Math.max(-0.25, value));
  return { x: clamp((-deltaX * unit) / width), y: clamp((-deltaY * unit) / height) };
}

/** A single pointer owns either a device touch or an orbit until released or cancelled. */
export function createPhoneInteraction(options: {
  /** Normalized viewport point to normalized device point, or null off the display. */
  readonly screenPoint: (point: Point, captured: boolean) => Point | null;
  readonly touch: (phase: "begin" | "move" | "end", point: Point) => void;
  /** Deltas in viewport fractions. */
  readonly orbit: (deltaX: number, deltaY: number) => void;
  readonly release: () => void;
}) {
  let active: { id: number; mode: "touch" | "orbit"; last: Point; screen: Point | null } | null = null;
  return {
    active: () => active !== null,
    /** Wheel orbit. Moving the camera during a captured touch would change its projected coordinates. */
    wheel(delta: Point) {
      if (active) return false;
      options.orbit(delta.x, delta.y);
      return true;
    },
    begin(id: number, point: Point, forceOrbit = false) {
      if (active) return false;
      const screen = forceOrbit ? null : options.screenPoint(point, false);
      active = { id, mode: screen ? "touch" : "orbit", last: point, screen };
      if (screen) options.touch("begin", screen);
      return true;
    },
    move(id: number, point: Point) {
      if (active?.id !== id) return;
      if (active.mode === "touch") {
        const screen = options.screenPoint(point, true);
        if (screen) {
          active.screen = screen;
          options.touch("move", screen);
        }
      } else {
        options.orbit(point.x - active.last.x, point.y - active.last.y);
      }
      active.last = point;
    },
    end(id?: number) {
      if (!active || (id !== undefined && active.id !== id)) return;
      const previous = active;
      active = null;
      if (previous.mode === "touch" && previous.screen) options.touch("end", previous.screen);
      else options.release();
    },
  };
}
