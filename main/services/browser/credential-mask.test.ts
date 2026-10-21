import assert from "node:assert/strict";
import test from "node:test";
import {
  CREDENTIAL_MASK_GRAY,
  CREDENTIAL_MASK_PADDING,
  cssRectsToImageRects,
  paintRects,
  type RawBitmap,
} from "./credential-mask.js";

/** A bitmap whose every pixel encodes its own position, so moved or missed pixels show. */
function patterned(width: number, height: number): RawBitmap {
  const data = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y += 1)
    for (let x = 0; x < width; x += 1) {
      const at = (y * width + x) * 4;
      data[at] = x % 251; data[at + 1] = y % 251; data[at + 2] = 7; data[at + 3] = 200;
    }
  return { width, height, data };
}

function pixel(bitmap: RawBitmap, x: number, y: number): number[] {
  const at = (y * bitmap.width + x) * 4;
  return [...bitmap.data.slice(at, at + 4)];
}

const GRAY = [CREDENTIAL_MASK_GRAY, CREDENTIAL_MASK_GRAY, CREDENTIAL_MASK_GRAY, 255];

test("a field box on a 2x capture covers the field and its padding, and nothing else", () => {
  // 400×300 CSS viewport captured at 800×600 pixels; the field is 100×20 at (50, 40).
  const rects = cssRectsToImageRects([{ x: 50, y: 40, width: 100, height: 20 }], { width: 400, height: 300 }, { width: 800, height: 600 });
  const pad = CREDENTIAL_MASK_PADDING * 2;
  assert.deepEqual(rects, [{ x: 100 - pad, y: 80 - pad, width: 200 + 2 * pad, height: 40 + 2 * pad }]);
  const bitmap = patterned(800, 600);
  paintRects(bitmap, rects);
  // Every pixel of the field itself is gray and opaque.
  for (let y = 80; y < 120; y += 1) for (let x = 100; x < 300; x += 1) assert.deepEqual(pixel(bitmap, x, y), GRAY, `${x},${y}`);
  // The padding is covered too; one pixel beyond it is untouched.
  assert.deepEqual(pixel(bitmap, 100 - pad, 80 - pad), GRAY);
  assert.deepEqual(pixel(bitmap, 100 - pad - 1, 100), [100 - pad - 1, 100, 7, 200]);
  assert.deepEqual(pixel(bitmap, 200, 120 + pad), [200, 120 + pad, 7, 200]);
});

test("fractional boxes grow outward to whole pixels, so no edge column of the field survives", () => {
  const [rect] = cssRectsToImageRects([{ x: 10.4, y: 5.6, width: 20.3, height: 9.9 }], { width: 100, height: 100 }, { width: 150, height: 150 }, 0);
  assert.ok(rect);
  assert.ok(rect.x <= 10.4 * 1.5 && rect.y <= 5.6 * 1.5);
  assert.ok(rect.x + rect.width >= (10.4 + 20.3) * 1.5);
  assert.ok(rect.y + rect.height >= (5.6 + 9.9) * 1.5);
  assert.ok(Number.isInteger(rect.x) && Number.isInteger(rect.width));
});

test("boxes are clipped to the image and boxes outside it are dropped", () => {
  const rects = cssRectsToImageRects(
    [
      { x: -30, y: -30, width: 50, height: 50 },
      { x: 390, y: 290, width: 50, height: 50 },
      { x: 900, y: 10, width: 20, height: 20 },
      { x: 10, y: -200, width: 20, height: 20 },
    ],
    { width: 400, height: 300 },
    { width: 400, height: 300 },
  );
  assert.deepEqual(rects, [
    { x: 0, y: 0, width: 20 + CREDENTIAL_MASK_PADDING, height: 20 + CREDENTIAL_MASK_PADDING },
    { x: 390 - CREDENTIAL_MASK_PADDING, y: 290 - CREDENTIAL_MASK_PADDING, width: 10 + CREDENTIAL_MASK_PADDING, height: 10 + CREDENTIAL_MASK_PADDING },
  ]);
  const bitmap = patterned(400, 300);
  paintRects(bitmap, rects);
  assert.deepEqual(pixel(bitmap, 0, 0), GRAY);
  assert.deepEqual(pixel(bitmap, 399, 299), GRAY);
});

test("a downscaled capture maps boxes by the image's own size", () => {
  // A 1600-px-wide viewport resized to a 1280-px image.
  const [rect] = cssRectsToImageRects([{ x: 800, y: 100, width: 200, height: 40 }], { width: 1600, height: 1000 }, { width: 1280, height: 800 }, 0);
  assert.deepEqual(rect, { x: 640, y: 80, width: 160, height: 32 });
});

test("an unreadable layout or position refuses instead of guessing", () => {
  assert.throws(() => cssRectsToImageRects([], { width: 0, height: 300 }, { width: 10, height: 10 }));
  assert.throws(() => cssRectsToImageRects([{ x: Number.NaN, y: 0, width: 1, height: 1 }], { width: 10, height: 10 }, { width: 10, height: 10 }));
  assert.throws(() => paintRects({ width: 2, height: 2, data: new Uint8Array(15) }, []));
});
