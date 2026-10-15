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

/** A per-viewer convenience. Unreadable storage falls back to the 3D view. */
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

export type FrameBlocker = "mjpeg" | "duo-hub" | "failed" | null;

/**
 * The 3D view needs decoded canvas frames and WebGL. The MJPEG fallback keeps
 * the flat screen, and the iPhone Duo's articulated body needs a hub that
 * reports hinge state (Device Hub 0.11.0 or newer).
 */
export function frameBlocker(input: {
  mjpeg: boolean;
  /** The device is an iPhone Duo but its screen config has no hinge fields. */
  duoWithoutHinge: boolean;
  /** WebGL failed or was lost, or a Duo display feed could not be decoded. Sticky until the viewer reopens. */
  frameFailed: boolean;
}): FrameBlocker {
  if (input.frameFailed) return "failed";
  if (input.mjpeg) return "mjpeg";
  if (input.duoWithoutHinge) return "duo-hub";
  return null;
}

export function frameBlockerLabel(blocker: FrameBlocker): string {
  if (blocker === "failed") return "3D view unavailable until this simulator is reopened";
  if (blocker === "mjpeg") return "3D view unavailable with the compatibility stream";
  if (blocker === "duo-hub") return "iPhone Duo 3D requires Device Hub 0.11.0 or newer";
  return "3D view";
}
