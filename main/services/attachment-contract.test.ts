import assert from "node:assert/strict";
import test from "node:test";
import { MAX_ATTACHMENT_INLINE_BYTES } from "../../renderer/shared/attachment-contract.js";
import { parseAttachments, safeStoredAttachments } from "./attachment-contract.js";
import { MAX_IMAGE_BYTES } from "./attachments.js";

const ONE_PIXEL_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScL2aQAAAABJRU5ErkJggg==",
  "base64",
);
const ONE_PIXEL_GIF = Buffer.from("R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==", "base64");

function paddedPngData(size: number): string {
  assert.ok(size >= ONE_PIXEL_PNG.byteLength);
  const bytes = Buffer.alloc(size);
  ONE_PIXEL_PNG.copy(bytes);
  return bytes.toString("base64");
}

function image(data: string, id = "image") {
  return {
    id,
    name: `${id}.png`,
    mimeType: "image/png",
    kind: "image",
    size: Buffer.byteLength(data, "base64"),
    data,
  };
}

test("attachment parsing accepts the exact image cap without recursive Base64 matching", () => {
  const data = paddedPngData(MAX_IMAGE_BYTES);
  const parsed = parseAttachments([image(data)]);
  assert.equal(parsed?.[0].size, MAX_IMAGE_BYTES);
});

test("attachment parsing rejects malformed and non-canonical Base64 padding", () => {
  for (const data of ["AA=A", "A===", "AAAA=", "AB==", "AAB="]) {
    assert.throws(() => parseAttachments([image(data)]), /Invalid image attachment data/);
  }
});

test("attachment parsing enforces one aggregate inline-data budget per message", () => {
  const half = paddedPngData(MAX_ATTACHMENT_INLINE_BYTES / 2);
  assert.equal(parseAttachments([image(half, "one"), image(half, "two")])?.length, 2);
  assert.throws(
    () =>
      parseAttachments([
        image(half, "one"),
        image(half, "two"),
        image(ONE_PIXEL_PNG.toString("base64"), "extra"),
      ]),
    /aggregate inline-data limit/,
  );

  const oneMiB = paddedPngData(1024 * 1024);
  assert.throws(
    () =>
      parseAttachments(Array.from({ length: 20 }, (_, index) => image(oneMiB, `image-${index}`))),
    /aggregate inline-data limit/,
  );
});

test("legacy-valid large attachment history survives sanitization for unrelated rewrites", () => {
  const data = paddedPngData(MAX_IMAGE_BYTES);
  const legacy = [image(data, "one"), image(data, "two"), image(data, "three")];
  assert.throws(() => parseAttachments(legacy), /aggregate inline-data limit/);
  assert.equal(safeStoredAttachments(legacy)?.length, 3);
});

test("new append parsing requires exact kind-specific fields", () => {
  const raster = image(ONE_PIXEL_PNG.toString("base64"));
  assert.throws(
    () => parseAttachments([{ ...raster, text: "unexpected" }]),
    /Invalid attachment fields/u,
  );
  assert.throws(
    () =>
      parseAttachments([
        {
          id: "text",
          name: "note.txt",
          mimeType: "text/plain",
          kind: "text",
          size: 4,
          text: "note",
          data: "unexpected",
        },
      ]),
    /Invalid attachment fields/u,
  );
});

test("new append parsing rejects SVG and raster MIME-byte mismatches", () => {
  const svgData = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>').toString("base64");
  assert.throws(
    () =>
      parseAttachments([
        {
          id: "svg",
          name: "payload.svg",
          mimeType: "image/svg+xml",
          kind: "image",
          size: Buffer.byteLength(svgData, "base64"),
          data: svgData,
        },
      ]),
    /Invalid image attachment data/u,
  );
  assert.throws(
    () => parseAttachments([image(ONE_PIXEL_GIF.toString("base64"), "mismatch")]),
    /do not match the declared image type/u,
  );
});

test("stored attachment sanitization keeps the former image envelope compatibility separate", () => {
  const svgData = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>').toString("base64");
  const legacy = {
    id: "legacy-svg",
    name: "legacy.svg",
    mimeType: "image/svg+xml",
    kind: "image",
    size: Buffer.byteLength(svgData, "base64"),
    data: svgData,
    formerOptionalMetadata: true,
  };
  assert.throws(() => parseAttachments([legacy]), /Invalid attachment fields/u);
  assert.equal(safeStoredAttachments([legacy])?.[0]?.mimeType, "image/svg+xml");
});
