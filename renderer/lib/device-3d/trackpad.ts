// Adapted from t3code apps/web/src/components/device/phoneTrackpad.ts @ a6ec88f7 (MIT).
// Aiden addition: without a hinge pinch, pinch zooms the camera logarithmically.
import { phoneWheelNavigation, type PhoneInteraction } from "./interaction";

type Timer = ReturnType<typeof setTimeout>;

export interface TrackpadTimers {
  setTimeout(callback: () => void, ms: number): Timer;
  clearTimeout(timer: Timer): void;
}

export interface TrackpadPinch {
  /** Normalized canvas point; returns whether the pinch is over the device. */
  begin(x: number, y: number): boolean;
  /** Natural-log scale step. */
  move(logScale: number): void;
  end(): void;
}

/** A pinch wheel sequence ends after this long without another Ctrl-wheel event. */
export const TRACKPAD_PINCH_IDLE_MS = 180;
/** Browsers without a native release signal still return the device to a useful view. */
export const TRACKPAD_ORBIT_FALLBACK_MS = 1_200;

/**
 * Canvas-local, non-passive listeners consume page scrolling and browser zoom.
 * Safari reports cumulative pinch scale instead of Ctrl-wheel.
 */
export function bindPhoneTrackpad(
  canvas: Pick<HTMLCanvasElement, "addEventListener" | "removeEventListener" | "getBoundingClientRect">,
  interaction: Pick<PhoneInteraction, "navigate" | "endWheel">,
  pinch?: TrackpadPinch,
  timers: TrackpadTimers = { setTimeout: (callback, ms) => setTimeout(callback, ms), clearTimeout: (timer) => clearTimeout(timer) },
) {
  let scale: number | null = null;
  let wheelActive = false;
  let timer: Timer | null = null;
  let orbitActive = false;
  let orbitTimer: Timer | null = null;
  const endOrbit = () => {
    if (orbitTimer) timers.clearTimeout(orbitTimer);
    orbitTimer = null;
    if (!orbitActive) return;
    orbitActive = false;
    interaction.endWheel();
  };
  const finish = () => {
    if (timer) timers.clearTimeout(timer);
    timer = null;
    wheelActive = false;
    scale = null;
    pinch?.end();
  };
  const begin = (event: Event) => {
    const rect = canvas.getBoundingClientRect();
    const x = "clientX" in event && typeof event.clientX === "number" ? event.clientX : Number.NaN;
    const y = "clientY" in event && typeof event.clientY === "number" ? event.clientY : Number.NaN;
    pinch?.begin((x - rect.left) / rect.width, (y - rect.top) / rect.height);
  };
  const consume = (event: Event) => {
    event.preventDefault();
    event.stopPropagation();
  };
  const zoom = (delta: number) => {
    if (Number.isFinite(delta) && delta) interaction.navigate({ type: "zoom", delta: Math.max(-1, Math.min(1, delta)) });
  };
  const wheel = (event: WheelEvent) => {
    consume(event);
    if (scale !== null) return;
    if (event.ctrlKey) {
      endOrbit();
      const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? canvas.getBoundingClientRect().height : 1;
      if (!pinch) {
        zoom((-event.deltaY * unit) / 100);
        return;
      }
      if (!wheelActive) {
        begin(event);
        wheelActive = true;
      }
      pinch.move((-event.deltaY * unit) / 100);
      if (timer) timers.clearTimeout(timer);
      timer = timers.setTimeout(finish, TRACKPAD_PINCH_IDLE_MS);
      return;
    }
    if (wheelActive) finish();
    if ("momentum" in event && event.momentum === true) {
      endOrbit();
      return;
    }
    const rect = canvas.getBoundingClientRect();
    const navigation = phoneWheelNavigation({
      width: rect.width,
      height: rect.height,
      deltaX: event.deltaX,
      deltaY: event.deltaY,
      deltaMode: event.deltaMode,
      ctrlKey: false,
    });
    if (navigation && interaction.navigate(navigation)) {
      orbitActive = true;
      if (orbitTimer) timers.clearTimeout(orbitTimer);
      orbitTimer = timers.setTimeout(endOrbit, TRACKPAD_ORBIT_FALLBACK_MS);
    }
  };
  const gestureScale = (event: Event) => {
    if (!("scale" in event) || typeof event.scale !== "number" || !Number.isFinite(event.scale) || event.scale <= 0) {
      return null;
    }
    return event.scale;
  };
  const start = (event: Event) => {
    consume(event);
    endOrbit();
    finish();
    begin(event);
    scale = gestureScale(event) ?? 1;
  };
  const change = (event: Event) => {
    consume(event);
    const next = gestureScale(event);
    if (scale === null || next === null) return;
    const step = Math.log(next / scale);
    if (pinch) pinch.move(step);
    else zoom(step);
    scale = next;
  };
  const end = (event: Event) => {
    consume(event);
    finish();
  };
  canvas.addEventListener("wheel", wheel as EventListener, { passive: false });
  canvas.addEventListener("gesturestart", start, { passive: false });
  canvas.addEventListener("gesturechange", change, { passive: false });
  canvas.addEventListener("gestureend", end, { passive: false });
  return {
    /** The native trackpad gesture ended (Electron's `gestureScrollEnd`). */
    endOrbit,
    cancel() {
      endOrbit();
      finish();
    },
    dispose() {
      canvas.removeEventListener("wheel", wheel as EventListener);
      canvas.removeEventListener("gesturestart", start);
      canvas.removeEventListener("gesturechange", change);
      canvas.removeEventListener("gestureend", end);
      endOrbit();
      finish();
    },
  };
}

export type PhoneTrackpad = ReturnType<typeof bindPhoneTrackpad>;
