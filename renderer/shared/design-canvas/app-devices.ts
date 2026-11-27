// Device sizes for live app frames (design mode v2 Phase 3b, S85; shared with
// 3c's device menu): the viewport each preset draws at, and the bucket an
// app frame's viewport width reports in `design_app_frame_added` (S88).

export type AppDevice = "phone" | "tablet" | "laptop" | "desktop";

export const APP_DEVICES: Readonly<Record<AppDevice, { label: string; width: number; height: number }>> = Object.freeze({
  phone: Object.freeze({ label: "iPhone", width: 390, height: 844 }),
  tablet: Object.freeze({ label: "iPad", width: 768, height: 1024 }),
  laptop: Object.freeze({ label: "Laptop", width: 1280, height: 800 }),
  desktop: Object.freeze({ label: "Desktop", width: 1440, height: 900 }),
});

export const APP_DEVICE_NAMES: readonly AppDevice[] = Object.freeze(["phone", "tablet", "laptop", "desktop"]);

export function isAppDevice(value: unknown): value is AppDevice {
  return typeof value === "string" && (APP_DEVICE_NAMES as readonly string[]).includes(value);
}

/** The device a viewport width reads as: phone up to 480, tablet to 1023, laptop to 1439, desktop from 1440. */
export function deviceBucket(viewportWidth: number): AppDevice {
  if (viewportWidth <= 480) return "phone";
  if (viewportWidth <= 1023) return "tablet";
  if (viewportWidth <= 1439) return "laptop";
  return "desktop";
}
