import assert from "node:assert/strict";
import test from "node:test";
import { PNG } from "pngjs";
import { optimizePng, quantizeRgba } from "./optimize-onboarding-assets.mjs";

const SIZE = 96;

// A smooth gradient with an opaque body, an anti-aliased translucent ring, and
// a fully transparent surround whose RGB holds junk.
function illustration() {
  const png = new PNG({ width: SIZE, height: SIZE });
  for (let y = 0; y < SIZE; y += 1) {
    for (let x = 0; x < SIZE; x += 1) {
      const offset = (y * SIZE + x) * 4;
      const distance = Math.hypot(x - SIZE / 2, y - SIZE / 2);
      const alpha = distance < 36 ? 255 : distance < 44 ? Math.round(255 * (44 - distance) / 8) : 0;
      png.data.set([x * 2 + 40, y * 2 + 30, (x + y) % 256, alpha], offset);
    }
  }
  return png;
}

const distinctColors = (pixels) => {
  const colors = new Set();
  for (let offset = 0; offset < pixels.length; offset += 4) colors.add(pixels.readUInt32BE(offset));
  return colors.size;
};

test("quantized illustrations keep their silhouette, stay close in color, and cap the palette", () => {
  const source = illustration();
  assert.ok(distinctColors(source.data) > 256, "the fixture needs quantizing");
  const output = quantizeRgba(source.data);

  assert.ok(distinctColors(output) <= 256);
  let squaredError = 0;
  let visible = 0;
  for (let offset = 0; offset < output.length; offset += 4) {
    const alpha = source.data[offset + 3];
    if (alpha === 0) {
      assert.deepEqual([...output.subarray(offset, offset + 4)], [0, 0, 0, 0], "transparent pixels stay clear");
      continue;
    }
    if (alpha === 255) assert.equal(output[offset + 3], 255, "opaque pixels stay opaque");
    else assert.ok(output[offset + 3] > 0 && output[offset + 3] < 255, "edges stay anti-aliased");
    for (let channel = 0; channel < 3; channel += 1) {
      squaredError += (output[offset + channel] - source.data[offset + channel]) ** 2;
    }
    visible += 3;
  }
  const psnr = 10 * Math.log10(255 ** 2 / (squaredError / visible));
  assert.ok(psnr > 30, `quantized colors stay close to the source (PSNR ${psnr.toFixed(1)} dB)`);
});

test("re-optimizing is lossless, and the encoding stays same-size truecolor PNG with alpha", () => {
  const original = PNG.sync.write(illustration());
  const once = optimizePng(original);
  const twice = optimizePng(once);
  assert.ok(once.length < original.length, "the optimized asset is smaller");

  const decoded = PNG.sync.read(once);
  assert.deepEqual(PNG.sync.read(twice).data, decoded.data, "a second pass changes no pixels");
  // IHDR: width, height, bit depth 8, color type 6 (RGBA), as onboarding requires.
  assert.equal(once.readUInt32BE(16), SIZE);
  assert.equal(once.readUInt32BE(20), SIZE);
  assert.equal(once[24], 8);
  assert.equal(once[25], 6);
});
