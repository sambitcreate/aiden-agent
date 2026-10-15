// The "Lens" placeholder shown where a chat's generated image will appear
// while `generate_image` runs. These numbers are the shared spec: desktop CSS
// (`.image-scan` in renderer/styles.css) and the iOS and Android placeholders
// use the same values. Renderer-safe: no Node or Electron imports.
//
// Motion: a dim dot field is drawn once. A lens window (LENS_HEIGHT of the
// placeholder) travels top to bottom during the first TRAVEL_FRACTION of each
// period with SCAN_EASING, then rests until the next pass. Inside the lens a
// brighter dot field moves the opposite way so the dots stay put and appear to
// light up. A hairline in the accent colour leads the lens. Everything moves by
// transform only. Under Reduce Motion the lens rests at STILL_LENS_POSITION.
//
// Arrival: the cover slides down over ARRIVAL_SLIDE_MS (ARRIVAL_EASING) under a
// bright edge, revealing the image. Under Reduce Motion it is an
// ARRIVAL_FADE_MS opacity fade instead.

import {
  DEFAULT_IMAGE_ASPECT_RATIO,
  IMAGE_ASPECT_RATIOS,
  isImageAspectRatio,
  type ImageAspectRatio,
} from "./aspect-ratio.js";

export { IMAGE_ASPECT_RATIOS, type ImageAspectRatio };

export const IMAGE_SCAN_SPEC = {
  /**
   * Layout: the placeholder (and the generated image that replaces it) stands
   * alone at the requested shape, width = min(available, maxWidth,
   * maxHeight × aspect), with the card corner radius and its caption row below.
   */
  maxWidth: 672,
  maxHeight: 512,
  cornerRadius: 12,
  /** One scan pass, in milliseconds, during the first minute. */
  periodMs: 2_800,
  /** After this long the scan slows down and the caption says "Still generating". */
  longPeriodAfterMs: 60_000,
  /** One scan pass once the job has run past `longPeriodAfterMs`. */
  longPeriodMs: 5_200,
  /** Lens height as a fraction of the placeholder height. */
  lensHeight: 0.34,
  /** Fraction of each period spent travelling; the rest is a rest. */
  travelFraction: 0.78,
  /** Pass easing, as CSS cubic-bezier control points. */
  scanEasing: [0.55, 0.06, 0.3, 1] as const,
  /** Where the still (Reduce Motion) lens centre rests, as a fraction of the height. */
  stillLensPosition: 0.4,
  /** Dot grid pitch in points. */
  dotPitch: 12,
  /** Dot radius in points: dim field, lit field. */
  dotRadius: 1,
  litDotRadius: 1.1,
  /** Leading-edge hairline thickness and glow blur, in points. */
  edgeThickness: 1,
  edgeGlow: 10,
  /** Arrival: cover slide, its easing, and the Reduce Motion fade. */
  arrivalSlideMs: 720,
  arrivalEasing: [0.65, 0.05, 0.25, 1] as const,
  arrivalFadeMs: 260,
  /** Caption timer resolution. */
  captionTickMs: 1_000,
} as const;

/** The placeholder's shape for a call's `aspectRatio` argument (1:1 when absent or unknown). */
export function placeholderAspectRatio(value: unknown): ImageAspectRatio {
  return isImageAspectRatio(value) ? value : DEFAULT_IMAGE_ASPECT_RATIO;
}

/** Whether the scan has slowed to its long period. */
export function isLongImageScan(elapsedMs: number): boolean {
  return elapsedMs >= IMAGE_SCAN_SPEC.longPeriodAfterMs;
}

/** The scan period for a job that has been running `elapsedMs`. */
export function imageScanPeriodMs(elapsedMs: number): number {
  return isLongImageScan(elapsedMs) ? IMAGE_SCAN_SPEC.longPeriodMs : IMAGE_SCAN_SPEC.periodMs;
}

/** "Generating · 12s", then "Still generating · 1m 12s" once the scan slows. */
export function imageScanElapsedLabel(elapsedMs: number): string {
  const seconds = Math.max(0, Math.floor(elapsedMs / 1000));
  if (!isLongImageScan(elapsedMs)) return `Generating · ${seconds}s`;
  return `Still generating · ${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, "0")}s`;
}
