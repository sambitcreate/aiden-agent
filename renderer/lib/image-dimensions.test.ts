import assert from "node:assert/strict";
import test from "node:test";
import { imagePixelSize } from "./image-dimensions";

const b64 = (bytes: number[]) => Buffer.from(bytes).toString("base64");

function pngHeader(width: number, height: number): number[] {
  const header = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(header, 0);
  header.writeUInt32BE(13, 8);
  header.write("IHDR", 12, "ascii");
  header.writeUInt32BE(width, 16);
  header.writeUInt32BE(height, 20);
  return [...header];
}

test("reads PNG, GIF, BMP, WebP and JPEG sizes from the header", () => {
  assert.deepEqual(imagePixelSize("image/png", b64(pngHeader(1536, 1024))), { width: 1536, height: 1024 });

  const gif = Buffer.alloc(13);
  gif.write("GIF89a", 0, "ascii");
  gif.writeUInt16LE(320, 6);
  gif.writeUInt16LE(200, 8);
  assert.deepEqual(imagePixelSize("image/gif", gif.toString("base64")), { width: 320, height: 200 });

  const bmp = Buffer.alloc(54);
  bmp.write("BM", 0, "ascii");
  bmp.writeInt32LE(640, 18);
  bmp.writeInt32LE(-480, 22); // top-down rows
  assert.deepEqual(imagePixelSize("image/bmp", bmp.toString("base64")), { width: 640, height: 480 });

  const webp = Buffer.alloc(30);
  webp.write("RIFF", 0, "ascii");
  webp.write("WEBP", 8, "ascii");
  webp.write("VP8X", 12, "ascii");
  webp.writeUIntLE(1023, 24, 3);
  webp.writeUIntLE(767, 27, 3);
  assert.deepEqual(imagePixelSize("image/webp", webp.toString("base64")), { width: 1024, height: 768 });

  // SOI, an APP0 segment to skip, then SOF0 (height before width).
  const jpeg = [0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x02, 0xd0, 0x05, 0x00, 0x03, 0, 0, 0];
  assert.deepEqual(imagePixelSize("image/jpeg", b64(jpeg)), { width: 1280, height: 720 });
});

test("unreadable or implausible headers reserve nothing", () => {
  assert.equal(imagePixelSize("image/png", b64(pngHeader(0, 10))), undefined);
  assert.equal(imagePixelSize("image/png", b64(pngHeader(100_000, 10))), undefined);
  assert.equal(imagePixelSize("image/png", "not base64!"), undefined);
  assert.equal(imagePixelSize("image/png", b64([1, 2, 3])), undefined);
  assert.equal(imagePixelSize("image/jpeg", b64(pngHeader(10, 10))), undefined);
  assert.equal(imagePixelSize("image/heic", b64(pngHeader(10, 10))), undefined);
});
