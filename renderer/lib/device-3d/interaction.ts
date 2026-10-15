// Adapted from t3code packages/client-runtime/src/device/phoneInteraction.ts and
// renderScheduler.ts @ a6ec88f7 (MIT). Framework-free; no three.js import.

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

export type RenderScheduler = ReturnType<typeof createRenderScheduler>;

export type PhoneNavigation =
  | { readonly type: "orbit"; readonly x: number; readonly y: number }
  | { readonly type: "zoom"; readonly delta: number };

/**
 * Browser wheel units vary by device. Navigation uses viewport fractions and a
 * logarithmic zoom step, so a coarse wheel cannot jump the device off-screen.
 */
export function phoneWheelNavigation(input: {
  readonly deltaX: number;
  readonly deltaY: number;
  readonly deltaMode: number;
  readonly ctrlKey: boolean;
  readonly width: number;
  readonly height: number;
}): PhoneNavigation | null {
  const { deltaX, deltaY, deltaMode, ctrlKey, width, height } = input;
  if (![deltaX, deltaY, width, height].every(Number.isFinite) || width <= 0 || height <= 0) return null;
  if (deltaMode !== 0 && deltaMode !== 1 && deltaMode !== 2) return null;
  const unit = deltaMode === 1 ? 16 : deltaMode === 2 ? height : 1;
  const clamp = (value: number, limit: number) => Math.min(limit, Math.max(-limit, value));
  if (ctrlKey) return { type: "zoom", delta: clamp(-deltaY * unit * 0.01, 1) };
  return {
    type: "orbit",
    x: clamp((-deltaX * unit) / width, 0.25),
    y: clamp((-deltaY * unit) / height, 0.25),
  };
}

/** A single pointer owns either a device gesture or an orbit until released or cancelled. */
export function createPhoneInteraction(options: {
  /** Normalized viewport point to normalized device point, or null off the display. */
  readonly screenPoint: (point: Point, captured: boolean) => Point | null;
  readonly touch: (phase: "begin" | "move" | "end", point: Point) => void;
  /** Deltas in viewport fractions. */
  readonly orbit: (deltaX: number, deltaY: number) => void;
  /** Natural-log zoom step; positive moves closer. */
  readonly zoomBy: (logDelta: number) => void;
  readonly onInteractionActive?: (active: boolean, mode: "touch" | "orbit") => void;
}) {
  let active: { id: number; mode: "touch" | "orbit"; last: Point; screen: Point | null } | null = null;
  return {
    active: () => active !== null,
    navigate(gesture: PhoneNavigation) {
      // Moving the camera during a captured device touch would change its projected coordinates.
      if (active) return false;
      if (gesture.type === "zoom") options.zoomBy(gesture.delta);
      else options.orbit(gesture.x, gesture.y);
      return true;
    },
    /** A trackpad orbit has ended; the device may settle on its nearest view. */
    endWheel() {
      if (!active) options.onInteractionActive?.(false, "orbit");
    },
    begin(id: number, point: Point, forceOrbit = false) {
      if (active) return false;
      const screen = forceOrbit ? null : options.screenPoint(point, false);
      active = { id, mode: screen ? "touch" : "orbit", last: point, screen };
      options.onInteractionActive?.(true, active.mode);
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
      options.onInteractionActive?.(false, previous.mode);
    },
  };
}

export type PhoneInteraction = ReturnType<typeof createPhoneInteraction>;
