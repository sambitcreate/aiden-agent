import assert from "node:assert/strict";
import test from "node:test";
import { pngBytes } from "./studio-assets/test-fixture.js";
import { parseGeneratedImages } from "./pi-model-image-output.js";

const image = (seed: number, width = 8, height = 8) => ({
  type: "image" as const,
  mimeType: "image/png",
  data: Buffer.from(pngBytes(width, height, seed)).toString("base64"),
});

test("reject mode keeps the chat tool's 4-image limit and reports sizes once", () => {
  const parsed = parseGeneratedImages([{ type: "text", text: "Here you go" }, image(1, 10, 20)]);
  assert.equal(parsed.images.length, 1);
  assert.deepEqual(parsed.sizes, [{ bytes: Buffer.from(parsed.images[0]!.data, "base64").length, pixels: 200, width: 10, height: 20 }]);
  assert.equal(parsed.description, "Here you go");
  assert.equal(parsed.truncated, false);
  assert.throws(() => parseGeneratedImages([1, 2, 3, 4, 5].map((seed) => image(seed))), /4-image or 8 MiB/u);
});

test("truncate mode keeps the first four valid images of a paid result and flags the rest", () => {
  const parsed = parseGeneratedImages(
    [image(1), { type: "image", mimeType: "image/png", data: "AAAA" }, image(2), image(3), image(4), image(5)],
    { overflow: "truncate" },
  );
  assert.equal(parsed.images.length, 4);
  assert.equal(parsed.truncated, true);
  assert.deepEqual(parsed.images.map((entry) => entry.data), [image(1), image(2), image(3), image(4)].map((entry) => entry.data));
});

test("both modes refuse output with no usable image", () => {
  for (const overflow of ["reject", "truncate"] as const) {
    assert.throws(() => parseGeneratedImages([{ type: "text", text: "Sorry" }], { overflow }), /no generated images/u);
    assert.throws(() => parseGeneratedImages("nope", { overflow }), /Invalid image-generation output/u);
  }
});

test("truncate mode never fails a paid result over an unusable caption or stray entry", () => {
  const output = [{ type: "text", text: "x".repeat(40_000) }, null, { type: "text", text: "A caption" }, image(1)];
  const parsed = parseGeneratedImages(output, { overflow: "truncate" });
  assert.deepEqual([parsed.images.length, parsed.description], [1, "A caption"]);
  assert.throws(() => parseGeneratedImages(output), /Invalid image description/u);
});

test("truncate mode flags a dropped malformed image even when fewer than four arrive", () => {
  const parsed = parseGeneratedImages([image(1), { type: "image", mimeType: "image/png", data: "AAAA" }], { overflow: "truncate" });
  assert.deepEqual([parsed.images.length, parsed.truncated], [1, true]);
  assert.equal(parseGeneratedImages([image(1)], { overflow: "truncate" }).truncated, false);
});
