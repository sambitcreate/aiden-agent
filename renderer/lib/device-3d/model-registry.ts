/**
 * Simulator name → Aiden's hardware-accurate procedural model.
 *
 * Adapted from t3code packages/client-runtime/src/device/model.ts @ a6ec88f7 (MIT).
 * T3 matches names to Apple GLB assets; Aiden builds original procedural models
 * in code (`hardware-models.ts`, `duo-model.ts`) and bundles no vendor art.
 *
 * Only exact simulator names map to a model, and only when the named hardware
 * shares the modelled chassis. Everything else uses a family profile, so a model
 * is never stretched to impersonate another device. No three.js import, so the
 * main bundle can resolve models without loading the 3D chunk.
 */

export type DeviceModelId = "iphone-pro" | "iphone-pro-max" | "ipad-pro-13" | "iphone-duo";

/** Kept as data so the matching table is reviewable, not hidden in regex alternation. */
const MODEL_NAMES: Readonly<Record<DeviceModelId, readonly string[]>> = {
  // 6.3-inch class, full-width camera plateau.
  "iphone-pro": ["iPhone 17 Pro", "iPhone 18 Pro"],
  // 6.9-inch class, full-width camera plateau.
  "iphone-pro-max": ["iPhone 17 Pro Max", "iPhone 18 Pro Max"],
  // The M4 and M5 13-inch iPad Pro share one chassis.
  "ipad-pro-13": ["iPad Pro 13-inch (M4)", "iPad Pro 13-inch (M5)"],
  "iphone-duo": ["iPhone Duo"],
};

const BY_NAME = new Map<string, DeviceModelId>(
  (Object.entries(MODEL_NAMES) as Array<[DeviceModelId, readonly string[]]>).flatMap(([id, names]) =>
    names.map((name) => [name.toLowerCase(), id] as const),
  ),
);

/** Match actual hardware by exact simulator name; never stretch a model to impersonate another device. */
export function resolveDeviceModelId(platform: string, name: string): DeviceModelId | null {
  if (platform !== "ios") return null;
  return BY_NAME.get(name.trim().toLowerCase()) ?? null;
}

/** The hinged iPhone Duo is the only iOS simulator that reports hinge fields. */
export function isDuoDevice(platform: string, name: string, screen: { supportsHingeAngle?: boolean } | null): boolean {
  return resolveDeviceModelId(platform, name) === "iphone-duo" || (platform === "ios" && screen?.supportsHingeAngle === true);
}
