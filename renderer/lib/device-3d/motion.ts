/** Radians of turn per CSS pixel of drag. */
export const ORBIT_GAIN = 0.006;
export const PITCH_LIMIT = 0.9;
/** On release the device settles facing the viewer, turned at most this far. */
export const REST_YAW_LIMIT = Math.PI / 3;

const OMEGA = (2 * Math.PI) / 0.5;
const STEP_SECONDS = 1 / 120;
const EPSILON = 0.0005;

export interface DeviceMotion {
  readonly yaw: () => number;
  readonly pitch: () => number;
  /** Deltas are CSS pixels. */
  readonly orbit: (deltaX: number, deltaY: number, now: number) => void;
  readonly release: (now: number) => void;
  readonly reset: (now: number) => void;
  /** Advances toward the target. Returns whether the pose changed. */
  readonly advance: (now: number, reduced: boolean) => boolean;
  readonly needsFrame: () => boolean;
}

const clamp = (value: number, limit: number) => Math.min(limit, Math.max(-limit, value));

/**
 * A critically damped yaw/pitch spring. Dragging moves the target; release
 * settles on the nearest useful front view. Reduced motion jumps to the target.
 */
export function createDeviceMotion(): DeviceMotion {
  const current = { yaw: 0, pitch: 0 };
  const target = { yaw: 0, pitch: 0 };
  const velocity = { yaw: 0, pitch: 0 };
  let at = 0;
  const moving = () =>
    Math.abs(target.yaw - current.yaw) > EPSILON ||
    Math.abs(target.pitch - current.pitch) > EPSILON ||
    Math.abs(velocity.yaw) > EPSILON * 10 ||
    Math.abs(velocity.pitch) > EPSILON * 10;
  const wake = (now: number) => {
    if (!moving()) at = now;
  };
  return {
    yaw: () => current.yaw,
    pitch: () => current.pitch,
    orbit(deltaX, deltaY, now) {
      if (![deltaX, deltaY, now].every(Number.isFinite) || (!deltaX && !deltaY)) return;
      wake(now);
      target.yaw += deltaX * ORBIT_GAIN;
      target.pitch = clamp(target.pitch + deltaY * ORBIT_GAIN, PITCH_LIMIT);
    },
    release(now) {
      wake(now);
      // Unwind whole turns from both ends so a long spin settles by the short way.
      const turns = Math.round(target.yaw / (2 * Math.PI)) * 2 * Math.PI;
      target.yaw -= turns;
      current.yaw -= turns;
      target.yaw = clamp(target.yaw, REST_YAW_LIMIT);
      target.pitch = 0;
    },
    reset(now) {
      wake(now);
      const turns = Math.round(current.yaw / (2 * Math.PI)) * 2 * Math.PI;
      current.yaw -= turns;
      target.yaw = 0;
      target.pitch = 0;
    },
    advance(now, reduced) {
      if (!Number.isFinite(now)) return false;
      if (!moving()) {
        at = now;
        return false;
      }
      if (reduced) {
        current.yaw = target.yaw;
        current.pitch = target.pitch;
        velocity.yaw = 0;
        velocity.pitch = 0;
        at = now;
        return true;
      }
      const seconds = Math.min(0.05, Math.max(0, (now - at) / 1000));
      at = now;
      const steps = Math.ceil(seconds / STEP_SECONDS);
      const dt = steps ? seconds / steps : 0;
      for (let step = 0; step < steps; step++) {
        for (const axis of ["yaw", "pitch"] as const) {
          const acceleration = OMEGA * OMEGA * (target[axis] - current[axis]) - 2 * OMEGA * velocity[axis];
          velocity[axis] += acceleration * dt;
          current[axis] += velocity[axis] * dt;
        }
      }
      if (!moving()) {
        current.yaw = target.yaw;
        current.pitch = target.pitch;
        velocity.yaw = 0;
        velocity.pitch = 0;
      }
      return steps > 0;
    },
    needsFrame: moving,
  };
}
