// Painting over secrets in a captured page image, in main, before the image
// reaches a model. Pure pixel work, so it is tested without Electron: the
// page's own CSS can't undo it, because it happens after capture.

import type { CssRect } from "./credential-fields.js";

/** A whole-pixel rectangle inside an image. */
export interface PixelRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface RawBitmap {
  width: number;
  height: number;
  /** 4 bytes per pixel, rows top to bottom with no padding (BGRA or RGBA). */
  data: Uint8Array;
}

/** CSS pixels added around each field, so a focus ring or caret is covered too. */
export const CREDENTIAL_MASK_PADDING = 4;
/** One neutral gray, so the channel order (BGRA or RGBA) doesn't matter. */
export const CREDENTIAL_MASK_GRAY = 0x8a;

/**
 * Map CSS-pixel rectangles of a `viewport` onto an image of that viewport,
 * padded and grown outward to whole pixels, then clipped to the image.
 * Rectangles entirely outside the image are dropped.
 */
export function cssRectsToImageRects(
  rects: readonly CssRect[],
  viewport: { width: number; height: number },
  image: { width: number; height: number },
  padding = CREDENTIAL_MASK_PADDING,
): PixelRect[] {
  if (!(viewport.width > 0 && viewport.height > 0 && image.width > 0 && image.height > 0)) {
    throw new Error("The page image can't be matched to the page.");
  }
  const scaleX = image.width / viewport.width;
  const scaleY = image.height / viewport.height;
  const out: PixelRect[] = [];
  for (const rect of rects) {
    if (![rect.x, rect.y, rect.width, rect.height].every(Number.isFinite)) {
      throw new Error("A password field's position could not be read.");
    }
    const left = Math.max(0, Math.floor((rect.x - padding) * scaleX));
    const top = Math.max(0, Math.floor((rect.y - padding) * scaleY));
    const right = Math.min(image.width, Math.ceil((rect.x + rect.width + padding) * scaleX));
    const bottom = Math.min(image.height, Math.ceil((rect.y + rect.height + padding) * scaleY));
    if (right > left && bottom > top) out.push({ x: left, y: top, width: right - left, height: bottom - top });
  }
  return out;
}

/** Fill every rectangle with opaque neutral gray, in place. */
export function paintRects(bitmap: RawBitmap, rects: readonly PixelRect[], gray = CREDENTIAL_MASK_GRAY): void {
  const { width, height, data } = bitmap;
  if (data.length !== width * height * 4) throw new Error("The page image has an unexpected pixel layout.");
  for (const rect of rects) {
    const x0 = Math.max(0, Math.floor(rect.x));
    const y0 = Math.max(0, Math.floor(rect.y));
    const x1 = Math.min(width, Math.ceil(rect.x + rect.width));
    const y1 = Math.min(height, Math.ceil(rect.y + rect.height));
    for (let y = y0; y < y1; y += 1) {
      const row = y * width * 4;
      for (let x = x0; x < x1; x += 1) {
        const at = row + x * 4;
        data[at] = gray;
        data[at + 1] = gray;
        data[at + 2] = gray;
        data[at + 3] = 0xff;
      }
    }
  }
}
