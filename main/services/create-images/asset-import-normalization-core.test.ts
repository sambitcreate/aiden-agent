import assert from "node:assert/strict";
import test from "node:test";
import {
  createImagesCanonicalValidationName,
  createImagesImportSourcePolicy,
} from "./asset-import-normalization-core.js";

function bytes(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

function gif(frames: number): Uint8Array {
  const header = [...bytes("GIF89a"), 1, 0, 1, 0, 0, 0, 0];
  const image = [0x2c, 0, 0, 0, 0, 1, 0, 1, 0, 0, 2, 2, 0x44, 0x01, 0];
  return Uint8Array.from([...header, ...Array.from({ length: frames }, () => image).flat(), 0x3b]);
}

test("classifies canonical and sandbox-normalized static raster formats", () => {
  assert.deepEqual(
    createImagesImportSourcePolicy(
      Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]),
      "photo.unknown",
    ),
    { kind: "canonical", format: "png" },
  );
  assert.deepEqual(createImagesImportSourcePolicy(Uint8Array.from([0xff, 0xd8]), "photo.bin"), {
    kind: "canonical",
    format: "jpeg",
  });
  assert.deepEqual(
    createImagesImportSourcePolicy(bytes("RIFF\u0004\u0000\u0000\u0000WEBPVP8 "), "photo.webp"),
    { kind: "normalize", format: "webp" },
  );
  assert.deepEqual(createImagesImportSourcePolicy(bytes("BMstatic"), "photo.bmp"), {
    kind: "normalize",
    format: "bmp",
  });
  assert.deepEqual(createImagesImportSourcePolicy(bytes("unknown"), "photo.heic"), {
    kind: "normalize",
    format: "heic",
  });
  assert.deepEqual(createImagesImportSourcePolicy(gif(1), "photo.gif"), {
    kind: "normalize",
    format: "gif",
  });
});

test("rejects vector and animation-bearing sources before sandbox conversion", () => {
  assert.deepEqual(createImagesImportSourcePolicy(bytes("<svg><script/></svg>"), "image.txt"), {
    kind: "reject",
    reason: "vector",
  });
  assert.deepEqual(createImagesImportSourcePolicy(gif(2), "image.bin"), {
    kind: "reject",
    reason: "animated",
  });
  assert.deepEqual(
    createImagesImportSourcePolicy(
      bytes("RIFF\u0004\u0000\u0000\u0000WEBPANIM\u0000\u0000\u0000\u0000"),
      "image.webp",
    ),
    { kind: "reject", reason: "animated" },
  );
  assert.deepEqual(createImagesImportSourcePolicy(bytes("anything"), "image.svgz"), {
    kind: "reject",
    reason: "vector",
  });
});

test("creates a bounded canonical validation name without exposing a path", () => {
  assert.equal(createImagesCanonicalValidationName("/private/example.WEBP", "png"), "example.png");
  assert.equal(createImagesCanonicalValidationName(undefined, "jpg"), "image.jpg");
  assert.ok(createImagesCanonicalValidationName(`${"a".repeat(500)}.tiff`, "png").length <= 240);
});
