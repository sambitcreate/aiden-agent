import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { AssetImageValidationError } from "./asset-image-validation-core.js";
import type { AssetIngestRequest, AssetIngestResult } from "./asset-store-core.js";
import {
  CreateImagesImageImportError,
  ingestCreateImagesImageFile,
  type CreateImagesImageNormalizer,
} from "./electron-asset-import.js";

async function collect(source: AsyncIterable<Uint8Array>): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let length = 0;
  for await (const chunk of source) {
    chunks.push(chunk.slice());
    length += chunk.byteLength;
  }
  const result = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

function result(request: AssetIngestRequest, bytes: Uint8Array): AssetIngestResult {
  return {
    asset: {
      assetId: "a".repeat(64),
      mediaType: "image/png",
      byteLength: bytes.byteLength,
      width: 1,
      height: 1,
      createdAt: "2026-08-18T00:00:00.000Z",
      ...(request.displayName ? { displayName: request.displayName } : {}),
      origin: request.origin,
      referenceCount: 0,
      thumbnailSizes: [],
    },
    deduplicated: false,
    quotaWarning: false,
    totalAssetBytes: bytes.byteLength,
  };
}

async function fixture(
  name: string,
  contents: Uint8Array,
): Promise<{ directory: string; file: string }> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "aiden-image-import-"));
  const file = path.join(directory, name);
  await fs.writeFile(file, contents);
  return { directory, file };
}

test("keeps a canonical import on the direct content-addressed path", async (context) => {
  const png = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const source = await fixture("direct.png", png);
  context.after(() => fs.rm(source.directory, { recursive: true, force: true }));
  let normalizeCalls = 0;
  const store = {
    async ingest(input: AsyncIterable<Uint8Array>, request: AssetIngestRequest) {
      const imported = await collect(input);
      assert.deepEqual(imported, png);
      assert.equal(request.displayName, "direct.png");
      return result(request, imported);
    },
  };
  await ingestCreateImagesImageFile(store, source.file, {
    normalizer: {
      async normalize() {
        normalizeCalls += 1;
        throw new Error("unused");
      },
    },
  });
  assert.equal(normalizeCalls, 0);
});

test("normalizes a supported static raster in the isolated decoder and preserves its label", async (context) => {
  const webp = new TextEncoder().encode("RIFF\u0004\u0000\u0000\u0000WEBPVP8 ");
  const normalized = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const source = await fixture("reference.webp", webp);
  context.after(() => fs.rm(source.directory, { recursive: true, force: true }));
  const requests: AssetIngestRequest[] = [];
  const seen: Uint8Array[] = [];
  const store = {
    async ingest(input: AsyncIterable<Uint8Array>, request: AssetIngestRequest) {
      requests.push(request);
      seen.push(await collect(input));
      if (requests.length === 1) {
        throw new AssetImageValidationError("unsupported_format", "unsupported");
      }
      return result(request, seen[seen.length - 1]!);
    },
  };
  const normalizer: CreateImagesImageNormalizer = {
    async normalize(filePath) {
      assert.equal(filePath, source.file);
      return { bytes: normalized, width: 1, height: 1 };
    },
  };
  const imported = await ingestCreateImagesImageFile(store, source.file, { normalizer });
  assert.equal(imported.asset.displayName, "reference.webp");
  assert.deepEqual(seen, [webp, normalized]);
  assert.deepEqual(requests[1], {
    origin: { kind: "import" },
    displayName: "reference.webp",
    declaredMimeType: "image/png",
    validationDisplayName: "reference.png",
  });
});

test("corrects a canonical extension mismatch without invoking conversion", async (context) => {
  const png = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const source = await fixture("mislabeled.webp", png);
  context.after(() => fs.rm(source.directory, { recursive: true, force: true }));
  let call = 0;
  let secondRequest: AssetIngestRequest | undefined;
  const store = {
    async ingest(input: AsyncIterable<Uint8Array>, request: AssetIngestRequest) {
      const imported = await collect(input);
      call += 1;
      if (call === 1) throw new AssetImageValidationError("extension_mismatch", "mismatch");
      secondRequest = request;
      return result(request, imported);
    },
  };
  await ingestCreateImagesImageFile(store, source.file, {
    normalizer: {
      async normalize() {
        throw new Error("must not normalize");
      },
    },
  });
  assert.equal(secondRequest?.validationDisplayName, "mislabeled.png");
});

test("rejects vector and animated images before conversion", async (context) => {
  for (const [name, contents, code] of [
    ["vector.svg", new TextEncoder().encode("<svg/>"), "vector_image"],
    [
      "animated.webp",
      new TextEncoder().encode("RIFF\u0004\u0000\u0000\u0000WEBPANIM\u0000\u0000\u0000\u0000"),
      "animated_image",
    ],
  ] as const) {
    const source = await fixture(name, contents);
    context.after(() => fs.rm(source.directory, { recursive: true, force: true }));
    const store = {
      async ingest(input: AsyncIterable<Uint8Array>) {
        await collect(input);
        throw new AssetImageValidationError("unsupported_format", "unsupported");
      },
    };
    await assert.rejects(
      ingestCreateImagesImageFile(store, source.file, {
        normalizer: {
          async normalize() {
            throw new Error("must not normalize");
          },
        },
      }),
      (error: unknown) => error instanceof CreateImagesImageImportError && error.code === code,
    );
  }
});

test("does not convert malformed canonical images or accept invalid normalized bounds", async (context) => {
  const malformed = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const source = await fixture("malformed.png", malformed);
  context.after(() => fs.rm(source.directory, { recursive: true, force: true }));
  const store = {
    async ingest(input: AsyncIterable<Uint8Array>) {
      await collect(input);
      throw new AssetImageValidationError("malformed_image", "malformed");
    },
  };
  await assert.rejects(
    ingestCreateImagesImageFile(store, source.file, {
      normalizer: {
        async normalize() {
          throw new Error("must not normalize");
        },
      },
    }),
    (error: unknown) =>
      error instanceof AssetImageValidationError && error.code === "malformed_image",
  );
});
