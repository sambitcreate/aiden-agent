import assert from "node:assert/strict";
import test from "node:test";
import { crc32, deflateSync } from "node:zlib";

import { createProviderPayloadParser } from "../handlers/provider-payload.js";
import { normalizeProviderArtwork } from "../../renderer/shared/provider-artwork.js";
import {
  createProviderArtworkNormalizer,
  type ProviderArtworkImage,
  type ProviderArtworkImageCodec,
} from "./provider-artwork-core.js";

function chunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

/** A real (grayscale, 8-bit) PNG of the given dimensions. */
function encodePng(width: number, height: number, noise = false): Buffer {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 0;
  const rows = Buffer.alloc((width + 1) * height);
  if (noise) for (let i = 0; i < rows.length; i += 1) rows[i] = (i * 2_654_435_761) >>> 24;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(rows)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

function pngSize(dataBase64: string): { width: number; height: number } {
  const bytes = Buffer.from(dataBase64, "base64");
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

class FakeImage implements ProviderArtworkImage {
  constructor(
    readonly width: number,
    readonly height: number,
    private readonly encode: (width: number, height: number) => Buffer = encodePng,
  ) {}
  isEmpty(): boolean {
    return this.width === 0 || this.height === 0;
  }
  getSize() {
    return { width: this.width, height: this.height };
  }
  resize(options: { width: number; height: number }): ProviderArtworkImage {
    return new FakeImage(options.width, options.height, this.encode);
  }
  toPNG(): Buffer {
    return this.encode(this.width, this.height);
  }
}

/** Stands in for nativeImage: decodes PNG headers and the SVG width/height it is handed. */
function fakeCodec(encode?: (width: number, height: number) => Buffer) {
  const calls: Array<{ kind: "png" | "svg"; svg?: string }> = [];
  const codec: ProviderArtworkImageCodec = {
    fromPng(bytes) {
      calls.push({ kind: "png" });
      return new FakeImage(bytes.readUInt32BE(16), bytes.readUInt32BE(20), encode);
    },
    fromSvgDataUrl(dataUrl) {
      const prefix = "data:image/svg+xml;base64,";
      assert.ok(dataUrl.startsWith(prefix));
      const svg = Buffer.from(dataUrl.slice(prefix.length), "base64").toString("utf8");
      calls.push({ kind: "svg", svg });
      const width = Number(/\bwidth="(\d+)"/u.exec(svg)?.[1] ?? 0);
      const height = Number(/\bheight="(\d+)"/u.exec(svg)?.[1] ?? 0);
      return new FakeImage(width, height, encode);
    },
  };
  return { codec, calls };
}

const svgUpload = (svg: string) => ({
  name: "Logo.SVG",
  dataBase64: Buffer.from(svg, "utf8").toString("base64"),
});

test("an uploaded SVG is rasterized from its validated source into a 64px display PNG", () => {
  const { codec, calls } = fakeCodec();
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="256" height="128"><rect width="256" height="128"/></svg>';

  const artwork = createProviderArtworkNormalizer(codec).normalizeInput(svgUpload(`\n  ${svg}\n`));

  assert.deepEqual(calls, [{ kind: "svg", svg }]);
  assert.equal(artwork.mimeType, "image/png");
  assert.deepEqual(normalizeProviderArtwork(artwork), artwork);
  assert.deepEqual(pngSize(artwork.dataBase64), { width: 64, height: 32 });
});

test("unsafe or malformed uploads are rejected before reaching the image decoder", () => {
  const { codec, calls } = fakeCodec();
  const normalizer = createProviderArtworkNormalizer(codec);
  for (const input of [
    svgUpload('<svg width="10" height="10"><script>alert(1)</script></svg>'),
    svgUpload('<svg width="10" height="10"><image href="https://example.test/a.png"/></svg>'),
    svgUpload('<svg width="10" height="10" style="fill:url(https://example.test/x)"/>'),
    svgUpload("<html>not an icon</html>"),
    { name: "icon.gif", dataBase64: encodePng(8, 8).toString("base64") },
    { name: "icon.png", dataBase64: "not base64!" },
    null,
    "icon.png",
  ]) {
    assert.throws(() => normalizer.normalizeInput(input));
  }
  // Stored artwork is only ever re-encoded as PNG, so stored SVG or junk is dropped.
  for (const stored of [
    { mimeType: "image/svg+xml", dataBase64: svgUpload('<svg width="9" height="9"/>').dataBase64 },
    { mimeType: "image/png", dataBase64: "" },
    { mimeType: "image/png" },
    [],
  ]) {
    assert.equal(normalizer.persistable(stored), undefined);
  }
  assert.deepEqual(calls, []);
});

test("artwork the decoder cannot read or that stays too large after resizing is rejected", () => {
  const empty = createProviderArtworkNormalizer(fakeCodec().codec);
  assert.throws(
    () => empty.normalizeInput(svgUpload('<svg viewBox="0 0 10 10"><path d="M0 0h10"/></svg>')),
    /could not decode/u,
  );

  const noisy = createProviderArtworkNormalizer(fakeCodec((w, h) => encodePng(w * 4, h * 4, true)).codec);
  assert.throws(
    () => noisy.normalizeInput({ name: "icon.png", dataBase64: encodePng(512, 512).toString("base64") }),
    /too complex/u,
  );
});

test("stored artwork that already meets the display contract is kept without re-encoding", () => {
  const { codec, calls } = fakeCodec();
  const stored = { mimeType: "image/png", dataBase64: encodePng(32, 32).toString("base64") };

  assert.deepEqual(createProviderArtworkNormalizer(codec).persistable(stored), stored);
  assert.deepEqual(calls, []);
});

test("oversize stored artwork is re-encoded to the display contract instead of dropped", () => {
  const { codec } = fakeCodec();
  const stored = { mimeType: "image/png", dataBase64: encodePng(512, 256).toString("base64") };
  assert.equal(normalizeProviderArtwork(stored), undefined, "fixture must violate the display contract");

  const recovered = createProviderArtworkNormalizer(codec).persistable(stored);

  assert.ok(recovered);
  assert.deepEqual(normalizeProviderArtwork(recovered), recovered);
  assert.deepEqual(pngSize(recovered.dataBase64), { width: 64, height: 32 });
});

test("a provider save payload persists recovered artwork and drops only unusable artwork", () => {
  const parse = createProviderPayloadParser({
    persistableArtwork: createProviderArtworkNormalizer(fakeCodec().codec).persistable,
  });
  const payload = (artwork: unknown) => ({
    id: "custom:acme",
    label: "Acme",
    kind: "openai",
    baseUrl: "https://api.acme.example/v1",
    models: ["acme-1"],
    needsKey: true,
    artwork,
  });

  const oversize = { mimeType: "image/png", dataBase64: encodePng(200, 200).toString("base64") };
  const saved = parse(payload(oversize));
  assert.ok(saved.artwork, "oversize artwork must not be dropped on save");
  assert.deepEqual(pngSize(saved.artwork.dataBase64), { width: 64, height: 64 });

  const unsafe = parse(payload({ mimeType: "image/svg+xml", dataBase64: "PHN2Zz48L3N2Zz4=" }));
  assert.equal(unsafe.artwork, undefined);
  assert.equal(unsafe.label, "Acme", "unusable artwork does not reject the provider itself");
  assert.equal(parse(payload(undefined)).artwork, undefined);
});
