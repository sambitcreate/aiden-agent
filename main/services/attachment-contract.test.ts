import assert from "node:assert/strict";
import test from "node:test";
import { MAX_ATTACHMENT_INLINE_BYTES } from "../../renderer/shared/attachment-contract.js";
import { parseAttachments, safeStoredAttachments } from "./attachment-contract.js";
import { MAX_IMAGE_BYTES } from "./attachments.js";

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
  const data = Buffer.alloc(MAX_IMAGE_BYTES).toString("base64");
  const parsed = parseAttachments([image(data)]);
  assert.equal(parsed?.[0].size, MAX_IMAGE_BYTES);
});

test("attachment parsing rejects malformed and non-canonical Base64 padding", () => {
  for (const data of ["AA=A", "A===", "AAAA=", "AB==", "AAB="]) {
    assert.throws(() => parseAttachments([image(data)]), /Invalid image attachment data/);
  }
});

test("attachment parsing enforces one aggregate inline-data budget per message", () => {
  const half = Buffer.alloc(MAX_ATTACHMENT_INLINE_BYTES / 2).toString("base64");
  assert.equal(parseAttachments([image(half, "one"), image(half, "two")])?.length, 2);
  assert.throws(
    () => parseAttachments([image(half, "one"), image(half, "two"), image("AA==", "extra")]),
    /aggregate inline-data limit/,
  );

  const oneMiB = Buffer.alloc(1024 * 1024).toString("base64");
  assert.throws(
    () =>
      parseAttachments(
        Array.from({ length: 20 }, (_, index) => image(oneMiB, `image-${index}`)),
      ),
    /aggregate inline-data limit/,
  );
});

test("legacy-valid large attachment history survives sanitization for unrelated rewrites", () => {
  const data = Buffer.alloc(MAX_IMAGE_BYTES).toString("base64");
  const legacy = [image(data, "one"), image(data, "two"), image(data, "three")];
  assert.throws(() => parseAttachments(legacy), /aggregate inline-data limit/);
  assert.equal(safeStoredAttachments(legacy)?.length, 3);
});
