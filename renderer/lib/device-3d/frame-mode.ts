export type DeviceFramePreference = "3d" | "flat";

export const DEVICE_FRAME_PREFERENCE_KEY = "aiden.devices.framePreference";

interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

function defaultStorage(): StorageLike | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

/** A per-viewer convenience. Unreadable storage falls back to the 3D frame. */
export function readFramePreference(storage: StorageLike | null = defaultStorage()): DeviceFramePreference {
  try {
    return storage?.getItem(DEVICE_FRAME_PREFERENCE_KEY) === "flat" ? "flat" : "3d";
  } catch {
    return "3d";
  }
}

export function writeFramePreference(
  preference: DeviceFramePreference,
  storage: StorageLike | null = defaultStorage(),
): void {
  try {
    storage?.setItem(DEVICE_FRAME_PREFERENCE_KEY, preference);
  } catch {
    // The toggle still applies for this session.
  }
}

export type FrameBlocker = "mjpeg" | "hinged" | "webgl" | null;

/**
 * The 3D frame needs decoded canvas frames and WebGL. The MJPEG fallback and
 * hinged iPhone Duo simulators keep the flat screen.
 */
export function frameBlocker(input: { mjpeg: boolean; hinged: boolean; webglUnavailable: boolean }): FrameBlocker {
  if (input.webglUnavailable) return "webgl";
  if (input.mjpeg) return "mjpeg";
  if (input.hinged) return "hinged";
  return null;
}

export function frameBlockerLabel(blocker: FrameBlocker): string {
  if (blocker === "webgl") return "3D frame unavailable: graphics acceleration is off";
  if (blocker === "mjpeg") return "3D frame unavailable with the compatibility stream";
  if (blocker === "hinged") return "3D frame unavailable for hinged simulators";
  return "3D frame";
}
