import assert from "node:assert/strict";
import test from "node:test";
import {
  authorizeCreateImagesAssetRequest,
  createImagesProtocolDocumentId,
  parseCreateImagesAssetProtocolToken,
} from "./asset-protocol-core.js";

test("asset protocol accepts only the canonical opaque grant URL", () => {
  const token = "A".repeat(43);
  assert.equal(parseCreateImagesAssetProtocolToken(`aiden-asset://asset/${token}`), token);
  for (const url of [
    `aiden-asset://other/${token}`,
    `aiden-asset://asset/${token}?path=/tmp/private`,
    `aiden-asset://asset/${token}/extra`,
    "aiden-asset://asset/../../etc/passwd",
    "file:///tmp/private",
  ]) {
    assert.equal(parseCreateImagesAssetProtocolToken(url), undefined, url);
  }
});

test("asset protocol document identity accepts only a live main frame", () => {
  const frame = { processId: 12, routingId: 34, frameToken: "frame", parent: null, detached: false };
  assert.equal(createImagesProtocolDocumentId(frame), "12:34:frame");
  assert.equal(createImagesProtocolDocumentId({ ...frame, parent: {} }), undefined);
  assert.equal(createImagesProtocolDocumentId({ ...frame, detached: true }), undefined);
});

test("asset protocol authorization requires a GET image request from the exact main document", () => {
  const frame = {
    processId: 4,
    routingId: 8,
    frameToken: "frame-token",
    parent: null,
    detached: false,
  };
  let observed: readonly unknown[] = [];
  const allowed = authorizeCreateImagesAssetRequest(
    {
      url: `aiden-asset://asset/${"a".repeat(43)}`,
      method: "GET",
      resourceType: "image",
      webContentsId: 12,
      frame,
    },
    (...values) => {
      observed = values;
      return true;
    },
  );
  assert.equal(allowed, true);
  assert.deepEqual(observed, ["a".repeat(43), 12, "4:8:frame-token"]);
  assert.equal(
    authorizeCreateImagesAssetRequest(
      {
        url: `aiden-asset://asset/${"a".repeat(43)}`,
        method: "POST",
        resourceType: "image",
        webContentsId: 12,
        frame,
      },
      () => true,
    ),
    false,
  );
});
