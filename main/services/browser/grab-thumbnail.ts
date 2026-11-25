import {
  MAX_GRABBED_ELEMENT_THUMBNAIL_BYTES,
  type GrabbedElementBoundingBox,
  type GrabbedElementThumbnail,
} from "../../../renderer/shared/browser-element-grab.js";
import type { CssRect } from "./credential-fields.js";
import { cssRectsToImageRects, paintRects, type RawBitmap } from "./credential-mask.js";

export const GRAB_THUMBNAIL_PADDING_CSS = 8;
export const GRAB_THUMBNAIL_MAX_EDGE_PX = 640;

export interface GrabCropPlan {
  /** Clamped CSS rect in top-level viewport coordinates. */
  cssCrop: CssRect;
  /** Corresponding native capture rectangle inside `pageBounds`. */
  captureRect: { x: number; y: number; width: number; height: number };
}

/**
 * Pads the grabbed element's bounding box by `paddingCss` CSS pixels, intersects with
 * `[0, 0, viewport.width, viewport.height]`, and maps to `pageBounds` capture coordinates
 * (automatically handling zoomFactor and responsive letterboxing).
 * Returns `null` when the element is collapsed or completely off-screen.
 */
export function computeGrabCropPlan(
  boundingBox: GrabbedElementBoundingBox,
  viewport: { width: number; height: number },
  pageBounds: { x: number; y: number; width: number; height: number },
  paddingCss = GRAB_THUMBNAIL_PADDING_CSS,
): GrabCropPlan | null {
  if (
    !(viewport.width > 0 && viewport.height > 0 && pageBounds.width > 0 && pageBounds.height > 0)
  ) {
    return null;
  }
  const left = Math.max(0, boundingBox.x - paddingCss);
  const top = Math.max(0, boundingBox.y - paddingCss);
  const right = Math.min(viewport.width, boundingBox.x + boundingBox.width + paddingCss);
  const bottom = Math.min(viewport.height, boundingBox.y + boundingBox.height + paddingCss);
  const cssWidth = right - left;
  const cssHeight = bottom - top;
  if (!(cssWidth >= 1 && cssHeight >= 1)) return null;

  const scaleX = pageBounds.width / viewport.width;
  const scaleY = pageBounds.height / viewport.height;

  const x = Math.max(0, Math.floor(left * scaleX));
  const y = Math.max(0, Math.floor(top * scaleY));
  const captureRight = Math.min(pageBounds.width, Math.ceil(right * scaleX));
  const captureBottom = Math.min(pageBounds.height, Math.ceil(bottom * scaleY));
  const width = captureRight - x;
  const height = captureBottom - y;
  if (!(width >= 1 && height >= 1)) return null;

  return {
    cssCrop: { x: left, y: top, width: cssWidth, height: cssHeight },
    captureRect: {
      x: pageBounds.x + x,
      y: pageBounds.y + y,
      width,
      height,
    },
  };
}

/**
 * Translates top-viewport sensitive field CSS rects into crop-local coordinates,
 * maps them to bitmap pixels via `credential-mask.ts`, and paints them neutral gray in place.
 * Returns the number of masked regions painted.
 */
export function maskSensitiveFieldsInCroppedBitmap(
  bitmap: RawBitmap,
  sensitiveCssRects: readonly CssRect[],
  cssCrop: CssRect,
): number {
  if (sensitiveCssRects.length === 0) return 0;
  const relative: CssRect[] = [];
  for (const rect of sensitiveCssRects) {
    const left = Math.max(0, rect.x - cssCrop.x);
    const top = Math.max(0, rect.y - cssCrop.y);
    const right = Math.min(cssCrop.width, rect.x + rect.width - cssCrop.x);
    const bottom = Math.min(cssCrop.height, rect.y + rect.height - cssCrop.y);
    if (right > left && bottom > top) {
      relative.push({ x: left, y: top, width: right - left, height: bottom - top });
    }
  }
  if (relative.length === 0) return 0;
  const pixelRects = cssRectsToImageRects(
    relative,
    { width: cssCrop.width, height: cssCrop.height },
    { width: bitmap.width, height: bitmap.height },
  );
  if (pixelRects.length === 0) return 0;
  paintRects(bitmap, pixelRects);
  return pixelRects.length;
}

/** Computes target dimensions fitting inside `maxEdge` on the longest side. */
export function computeThumbnailResizeTarget(
  width: number,
  height: number,
  maxEdge = GRAB_THUMBNAIL_MAX_EDGE_PX,
): { width: number; height: number } | null {
  if (!(width > 0 && height > 0)) return null;
  if (width <= maxEdge && height <= maxEdge) return null;
  if (width >= height) {
    return {
      width: maxEdge,
      height: Math.max(1, Math.round((height * maxEdge) / width)),
    };
  }
  return {
    width: Math.max(1, Math.round((width * maxEdge) / height)),
    height: maxEdge,
  };
}

export interface NativeImageLike {
  isEmpty(): boolean;
  getSize(): { width: number; height: number };
  toBitmap(): Buffer;
  resize(options: { width?: number; height?: number }): NativeImageLike;
  toPNG(): Buffer;
  toJPEG(quality: number): Buffer;
}

export interface NativeImageFactory {
  createFromBitmap(buffer: Buffer, options: { width: number; height: number }): NativeImageLike;
}

/**
 * Pixel-masks any sensitive fields inside a cropped `NativeImage`, resizes to at most
 * 640px on the longest side, and encodes PNG (or JPEG fallback) within 512 KiB.
 */
export function finalizeGrabThumbnail(
  captured: NativeImageLike,
  factory: NativeImageFactory,
  sensitiveCssRects: readonly CssRect[],
  cssCrop: CssRect,
): GrabbedElementThumbnail | undefined {
  if (captured.isEmpty()) return undefined;
  let image = captured;
  const initialSize = image.getSize();
  if (!(initialSize.width > 0 && initialSize.height > 0)) return undefined;

  if (sensitiveCssRects.length > 0) {
    const raw = Buffer.from(image.toBitmap());
    const maskedCount = maskSensitiveFieldsInCroppedBitmap(
      { width: initialSize.width, height: initialSize.height, data: raw },
      sensitiveCssRects,
      cssCrop,
    );
    if (maskedCount > 0) {
      image = factory.createFromBitmap(raw, {
        width: initialSize.width,
        height: initialSize.height,
      });
    }
  }

  const resizeTarget = computeThumbnailResizeTarget(
    image.getSize().width,
    image.getSize().height,
    GRAB_THUMBNAIL_MAX_EDGE_PX,
  );
  if (resizeTarget) {
    image = image.resize(resizeTarget);
  }

  const finalSize = image.getSize();
  if (!(finalSize.width > 0 && finalSize.height > 0)) return undefined;

  const png = image.toPNG();
  if (png.byteLength > 0 && png.byteLength <= MAX_GRABBED_ELEMENT_THUMBNAIL_BYTES) {
    return {
      data: png.toString("base64"),
      mimeType: "image/png",
      width: finalSize.width,
      height: finalSize.height,
    };
  }

  for (const quality of [82, 65]) {
    const jpeg = image.toJPEG(quality);
    if (jpeg.byteLength > 0 && jpeg.byteLength <= MAX_GRABBED_ELEMENT_THUMBNAIL_BYTES) {
      return {
        data: jpeg.toString("base64"),
        mimeType: "image/jpeg",
        width: finalSize.width,
        height: finalSize.height,
      };
    }
  }

  return undefined;
}
