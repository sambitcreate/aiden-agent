/**
 * Adapted from t3code apps/web/src/components/device/DeviceStreamView.tsx @ a6ec88f7 (MIT)
 *
 * serve-sim streams the raw framebuffer. A simulator that reports a landscape
 * or upside-down orientation while its frames stay portrait-sized is drawn
 * turned, so what the user sees matches the touch remap in `device-stream.ts`
 * (`rawPoint`), which applies the inverse turn under the same condition.
 */
import type * as React from "react";
import type { DevicePlatform } from "../shared/devices";
import type { DeviceScreenSize } from "./device-stream";

export type DeviceDisplayRotation = 0 | 90 | -90 | 180;

/** How far to turn the raw frame so it shows upright for the reported orientation. */
export function deviceDisplayRotation(platform: DevicePlatform, screen: DeviceScreenSize | null): DeviceDisplayRotation {
  if (platform !== "ios" || !screen || screen.width > screen.height) return 0;
  switch (screen.orientation) {
    case "landscape_left":
      return 90;
    case "landscape_right":
      return -90;
    case "portrait_upside_down":
      return 180;
    default:
      return 0;
  }
}

/** Width over height of the device as the user sees it, after any turn. */
export function displayedAspect(screen: DeviceScreenSize, rotation: DeviceDisplayRotation): number {
  const sideways = rotation === 90 || rotation === -90;
  return sideways ? screen.height / screen.width : screen.width / screen.height;
}

/**
 * The media element's style for a turn. A sideways turn draws the raw frame at
 * the screen box's transposed size (box height wide, box width tall), centred
 * and rotated, so it covers the box exactly. The box must be a size container
 * (`containerType: "size"`, see `DEVICE_SCREEN_CONTAINER_STYLE`) for the
 * `cqh`/`cqw` units to refer to it.
 */
export function rotatedMediaStyle(rotation: DeviceDisplayRotation): React.CSSProperties | undefined {
  if (rotation === 0) return undefined;
  if (rotation === 180) return { transform: "rotate(180deg)" };
  return {
    position: "absolute",
    left: "50%",
    top: "50%",
    width: "100cqh",
    height: "100cqw",
    transform: `translate(-50%, -50%) rotate(${rotation}deg)`,
  };
}

/** Makes the device screen box the size container its turned media is measured against. */
export const DEVICE_SCREEN_CONTAINER_STYLE: React.CSSProperties = { containerType: "size" };
