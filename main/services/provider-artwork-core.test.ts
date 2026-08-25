import assert from "node:assert/strict";
import test from "node:test";
import { decodeProviderArtworkSource } from "./provider-artwork-core.js";

test("provider artwork accepts PNG and inert SVG sources", () => {
  assert.equal(
    decodeProviderArtworkSource({
      name: "icon.png",
      dataBase64:
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
    }).kind,
    "png",
  );
  assert.equal(
    decodeProviderArtworkSource({
      name: "icon.svg",
      dataBase64: Buffer.from('<svg viewBox="0 0 10 10"><path d="M0 0h10v10z"/></svg>').toString("base64"),
    }).kind,
    "svg",
  );
});

test("provider artwork rejects active or externally-referenced SVG content", () => {
  for (const source of [
    '<svg><script>alert(1)</script></svg>',
    '<svg><image href="https://example.test/icon.png"/></svg>',
    '<svg><path onload="alert(1)"/></svg>',
  ]) {
    assert.throws(
      () => decodeProviderArtworkSource({
        name: "icon.svg",
        dataBase64: Buffer.from(source).toString("base64"),
      }),
      /cannot contain scripts or external resources/u,
    );
  }
});

test("provider artwork rejects malformed base64 and oversized PNG dimensions before decoding", () => {
  assert.throws(
    () => decodeProviderArtworkSource({ name: "icon.svg", dataBase64: "not base64!" }),
    /valid/u,
  );
  const pngHeader = Buffer.alloc(24);
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(pngHeader);
  Buffer.from("IHDR", "ascii").copy(pngHeader, 12);
  pngHeader.writeUInt32BE(8_193, 16);
  pngHeader.writeUInt32BE(64, 20);
  assert.throws(
    () => decodeProviderArtworkSource({ name: "icon.png", dataBase64: pngHeader.toString("base64") }),
    /dimensions/u,
  );
});
