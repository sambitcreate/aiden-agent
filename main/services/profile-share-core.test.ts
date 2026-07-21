import assert from "node:assert/strict";
import test from "node:test";
import { deflateSync } from "node:zlib";
import {
  decodeProfileSharePng,
  PROFILE_SHARE_HEIGHT,
  PROFILE_SHARE_WIDTH,
} from "./profile-share-core.js";

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

function crc32(value: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of value) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data = Buffer.alloc(0)): Buffer {
  const typeBytes = Buffer.from(type, "ascii");
  const result = Buffer.alloc(12 + data.length);
  result.writeUInt32BE(data.length, 0);
  typeBytes.copy(result, 4);
  data.copy(result, 8);
  result.writeUInt32BE(crc32(Buffer.concat([typeBytes, data])), 8 + data.length);
  return result;
}

function profilePng(width = PROFILE_SHARE_WIDTH, height = PROFILE_SHARE_HEIGHT): Buffer {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 1;
  header[9] = 0;
  const rowBytes = Math.ceil(width / 8);
  const pixels = Buffer.alloc((rowBytes + 1) * height);
  return Buffer.concat([
    PNG_SIGNATURE,
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(pixels)),
    chunk("IEND"),
  ]);
}

function dataUrl(image: Buffer): string {
  return `data:image/png;base64,${image.toString("base64")}`;
}

test("accepts a complete 1200 by 1600 PNG share image", () => {
  const image = profilePng();
  assert.deepEqual(decodeProfileSharePng(dataUrl(image)), image);
});

test("rejects malformed, non-canonical, or incorrectly sized PNG payloads", () => {
  assert.throws(() => decodeProfileSharePng(dataUrl(profilePng(1600, 1200))), /3:4 share size/u);
  assert.throws(() => decodeProfileSharePng("data:image/jpeg;base64,AAAA"), /PNG image/u);
  assert.throws(() => decodeProfileSharePng("data:image/png;base64,not base64"), /valid base64/u);

  const incomplete = profilePng().subarray(0, -12);
  assert.throws(() => decodeProfileSharePng(dataUrl(incomplete)), /incomplete PNG payload/u);

  const corrupt = profilePng();
  corrupt[corrupt.length - 1] ^= 1;
  assert.throws(() => decodeProfileSharePng(dataUrl(corrupt)), /integrity check/u);

  assert.throws(
    () => decodeProfileSharePng(`${dataUrl(profilePng())}AAAA`),
    /canonical base64|valid base64/u,
  );
});
