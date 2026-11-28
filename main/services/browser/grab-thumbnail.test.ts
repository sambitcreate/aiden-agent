import assert from "node:assert/strict";
import test from "node:test";
import { MAX_GRABBED_ELEMENT_THUMBNAIL_BYTES } from "../../../renderer/shared/browser-element-grab.js";
import { CREDENTIAL_MASK_GRAY } from "./credential-mask.js";
import {
  computeGrabCropPlan,
  computeThumbnailResizeTarget,
  finalizeGrabThumbnail,
  maskSensitiveFieldsInCroppedBitmap,
  type NativeImageFactory,
  type NativeImageLike,
} from "./grab-thumbnail.js";

test("computeGrabCropPlan pads by 8px CSS, clamps to viewport, scales for responsive letterbox/zoom, and omits off-screen elements", () => {
  // Element near top-left edge under 0.5x responsive scaling (pageBounds 640x360 for 1280x720 viewport).
  const plan = computeGrabCropPlan(
    { x: 2, y: 4, width: 100, height: 50 },
    { width: 1280, height: 720 },
    { x: 0, y: 0, width: 640, height: 360 },
  );
  assert.ok(plan);
  assert.deepEqual(plan.cssCrop, { x: 0, y: 0, width: 110, height: 62 });
  assert.deepEqual(plan.captureRect, { x: 0, y: 0, width: 55, height: 31 });

  // Off-screen element returns null cleanly rather than throwing.
  const offScreen = computeGrabCropPlan(
    { x: 2000, y: 2000, width: 100, height: 40 },
    { width: 1280, height: 720 },
    { x: 0, y: 0, width: 1280, height: 720 },
  );
  assert.equal(offScreen, null);

  // Collapsed 0x0 element near edge still respects 8px padding if visible; far negative returns null.
  const farNegative = computeGrabCropPlan(
    { x: -500, y: -500, width: 10, height: 10 },
    { width: 1280, height: 720 },
    { x: 0, y: 0, width: 1280, height: 720 },
  );
  assert.equal(farNegative, null);
});

test("maskSensitiveFieldsInCroppedBitmap paints neutral gray over password fields inside Retina crops", () => {
  // Crop covers CSS (100, 100, 100, 100) rendered at 2x Retina (200x200 bitmap).
  const width = 200;
  const height = 200;
  const data = new Uint8Array(width * height * 4).fill(0x11);
  const masked = maskSensitiveFieldsInCroppedBitmap(
    { width, height, data },
    [
      // Inside crop at local CSS (20..60, 30..50) -> Retina pixels (40..120, 60..100) +/- 4px CSS padding.
      { x: 120, y: 130, width: 40, height: 20 },
      // Completely outside crop: ignored.
      { x: 500, y: 500, width: 80, height: 20 },
    ],
    { x: 100, y: 100, width: 100, height: 100 },
  );
  assert.equal(masked, 1);

  // Pixel at center of password field (x=80, y=80) is masked to CREDENTIAL_MASK_GRAY.
  const maskedAt = (80 * width + 80) * 4;
  assert.equal(data[maskedAt], CREDENTIAL_MASK_GRAY);
  assert.equal(data[maskedAt + 1], CREDENTIAL_MASK_GRAY);
  assert.equal(data[maskedAt + 2], CREDENTIAL_MASK_GRAY);
  assert.equal(data[maskedAt + 3], 0xff);

  // Pixel outside password field (x=4, y=4) stays untouched.
  const clearAt = (4 * width + 4) * 4;
  assert.equal(data[clearAt], 0x11);
});

test("computeThumbnailResizeTarget and finalizeGrabThumbnail cap longest edge at 640px and fall back to JPEG when PNG exceeds 512 KiB", () => {
  assert.deepEqual(computeThumbnailResizeTarget(1280, 640), { width: 640, height: 320 });
  assert.deepEqual(computeThumbnailResizeTarget(320, 1280), { width: 160, height: 640 });
  assert.equal(computeThumbnailResizeTarget(400, 300), null);

  let resizeCalledWith: { width?: number; height?: number } | null = null;
  let bitmapRecreated = false;

  const makeMockImage = (
    w: number,
    h: number,
    pngBytes: Buffer,
    jpegBytes: Buffer,
  ): NativeImageLike => ({
    isEmpty: () => false,
    getSize: () => ({ width: w, height: h }),
    toBitmap: () => Buffer.alloc(w * h * 4, 0x22),
    resize: (opts) => {
      resizeCalledWith = opts;
      return makeMockImage(opts.width ?? w, opts.height ?? h, pngBytes, jpegBytes);
    },
    toPNG: () => pngBytes,
    toJPEG: () => jpegBytes,
  });

  const factory: NativeImageFactory = {
    createFromBitmap: (_buf, opts) => {
      bitmapRecreated = true;
      return makeMockImage(
        opts.width,
        opts.height,
        Buffer.alloc(MAX_GRABBED_ELEMENT_THUMBNAIL_BYTES + 100),
        Buffer.from("/9j/small"),
      );
    },
  };

  const hugePng = Buffer.alloc(MAX_GRABBED_ELEMENT_THUMBNAIL_BYTES + 100);
  const smallJpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
  const initial = makeMockImage(1280, 800, hugePng, smallJpeg);

  const result = finalizeGrabThumbnail(
    initial,
    factory,
    [{ x: 10, y: 10, width: 50, height: 20 }],
    { x: 0, y: 0, width: 640, height: 400 },
  );

  assert.equal(bitmapRecreated, true);
  assert.deepEqual(resizeCalledWith, { width: 640, height: 400 });
  assert.ok(result);
  assert.equal(result.mimeType, "image/jpeg");
  assert.equal(result.width, 640);
  assert.equal(result.height, 400);
});
