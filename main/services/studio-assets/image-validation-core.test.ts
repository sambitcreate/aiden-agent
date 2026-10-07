import assert from "node:assert/strict";
import test from "node:test";
import { holderKey, parseHolderKey, StudioAssetError } from "./contract.js";
import { sniffStudioImageType, validateStudioImage } from "./image-validation-core.js";
import { pngBytes } from "./test-fixture.js";

const code = (expected: StudioAssetError["code"]) => (error: unknown) =>
  error instanceof StudioAssetError && error.code === expected;

test("magic bytes decide the type; a mismatched declaration is rejected", () => {
  const png = pngBytes(640, 480);
  assert.equal(sniffStudioImageType(png), "image/png");
  assert.deepEqual(validateStudioImage(png, "image/png"), { mediaType: "image/png", width: 640, height: 480 });
  assert.deepEqual(validateStudioImage(png, undefined), { mediaType: "image/png", width: 640, height: 480 });
  assert.throws(() => validateStudioImage(png, "image/jpeg"), code("invalid_image"));
  assert.equal(sniffStudioImageType(new TextEncoder().encode("<svg xmlns='http://www.w3.org/2000/svg'/>")), undefined);
  assert.throws(() => validateStudioImage(new TextEncoder().encode("GIF89a"), "image/gif"), code("invalid_image"));
});

test("a recognized signature with broken structure is rejected", () => {
  const truncated = pngBytes(10, 10).slice(0, 40);
  assert.throws(() => validateStudioImage(truncated, "image/png"), code("invalid_image"));
  const fakeWebp = new Uint8Array([...new TextEncoder().encode("RIFF"), 4, 0, 0, 0, ...new TextEncoder().encode("WEBPVP8 ")]);
  assert.equal(sniffStudioImageType(fakeWebp), "image/webp");
  assert.throws(() => validateStudioImage(fakeWebp, "image/webp"), code("invalid_image"));
});

test("oversize dimensions are rejected before any decode", () => {
  assert.throws(() => validateStudioImage(pngBytes(20_000, 2), "image/png"), code("too_large"));
  assert.throws(() => validateStudioImage(pngBytes(5_000, 5_000), "image/png"), code("too_large"));
  assert.throws(
    () => validateStudioImage(pngBytes(300, 300), "image/png", { maxEdge: 256, maxPixels: 1_000_000 }),
    code("too_large"),
  );
});

test("holder keys round-trip the ADR strings and reject unsafe holders", () => {
  assert.equal(holderKey({ kind: "design", id: "project-1" }), "design:project-1");
  assert.equal(holderKey({ kind: "images-run", id: "run_42" }), "images-run:run_42");
  assert.deepEqual(parseHolderKey("images-workflow:wf.1"), { kind: "images-workflow", id: "wf.1" });
  for (const holder of [
    { kind: "bot", id: "b" },
    { kind: "design", id: "../escape" },
    { kind: "design", id: "" },
    { kind: "design", id: "a:b" },
  ]) {
    assert.throws(() => holderKey(holder as never), code("invalid_holder"), JSON.stringify(holder));
  }
});
