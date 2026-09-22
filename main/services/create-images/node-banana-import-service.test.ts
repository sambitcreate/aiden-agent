import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { CreateImagesService } from "./create-images-service.js";
import { CreateImagesNodeBananaServiceError } from "./node-banana-import-service.js";

function crc32(bytes: Uint8Array): number {
  let crc = 0xffff_ffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb8_8320 : 0);
  }
  return (crc ^ 0xffff_ffff) >>> 0;
}

function u32(value: number): Uint8Array {
  return Uint8Array.from([
    (value >>> 24) & 0xff,
    (value >>> 16) & 0xff,
    (value >>> 8) & 0xff,
    value & 0xff,
  ]);
}

function concat(...parts: readonly Uint8Array[]): Uint8Array {
  const result = new Uint8Array(parts.reduce((sum, part) => sum + part.byteLength, 0));
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.byteLength;
  }
  return result;
}

function pngChunk(type: string, data: Uint8Array): Uint8Array {
  const typeBytes = new TextEncoder().encode(type);
  return concat(u32(data.byteLength), typeBytes, data, u32(crc32(concat(typeBytes, data))));
}

function makePng(): Uint8Array {
  const header = new Uint8Array(13);
  header.set(u32(1));
  header.set(u32(1), 4);
  header[8] = 8;
  header[9] = 6;
  return concat(
    Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk("IHDR", header),
    pngChunk("IDAT", Uint8Array.from([0x78, 0x9c, 0, 0, 0, 0, 0, 1])),
    pngChunk("IEND", new Uint8Array()),
  );
}

function service(root: string): CreateImagesService {
  return new CreateImagesService(root, {
    assetStore: {
      deepValidator: {
        async validate({ descriptor }) {
          return { width: descriptor.width, height: descriptor.height };
        },
      },
      thumbnailGenerator: {
        async generate() {
          return { bytes: makePng(), width: 1, height: 1, mediaType: "image/png" as const };
        },
      },
      now: () => Date.parse("2026-08-19T12:00:00.000Z"),
    },
  });
}

test("Node Banana file import externalizes validated images and reports every rewritten node", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "aiden-node-banana-import-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const createImages = service(root);
  await createImages.initialize();
  const source = path.join(root, "node-banana.json");
  const png = Buffer.from(makePng()).toString("base64");
  await fs.writeFile(
    source,
    JSON.stringify({
      version: 1,
      name: "Imported edit",
      directoryPath: "/private/source",
      providers: { gemini: { apiKey: "do-not-import" } },
      nodes: [
        {
          id: "image-1",
          type: "imageInput",
          position: { x: 0, y: 100 },
          data: {
            filename: "reference.png",
            image: `data:image/png;base64,${png}`,
            imageRef: "/private/source/reference.png",
          },
        },
        {
          id: "prompt-1",
          type: "prompt",
          position: { x: 0, y: 300 },
          data: { prompt: "Make it yellow" },
        },
        {
          id: "generate-1",
          type: "nanoBanana",
          position: { x: 360, y: 180 },
          data: {
            aspectRatio: "1:1",
            resolution: "1K",
            model: "gemini-3.1-flash-image-preview",
            apiKey: "do-not-import",
          },
        },
        {
          id: "output-1",
          type: "output",
          position: { x: 720, y: 180 },
          data: { image: `data:image/png;base64,${png}` },
        },
        { id: "video-1", type: "generateVideo", position: {}, data: {} },
      ],
      edges: [
        { source: "image-1", target: "generate-1", targetHandle: "image" },
        { source: "prompt-1", target: "generate-1", targetHandle: "text" },
        { source: "generate-1", target: "output-1", targetHandle: "image" },
      ],
    }),
    { mode: 0o600 },
  );

  const result = await createImages.nodeBananaImports.importFromFile(source);
  assert.equal(result.sourceFileName, "node-banana.json");
  assert.equal(result.importedAssetCount, 1);
  assert.equal(result.report.importedEmbeddedImageCount, 1);
  assert.equal(result.report.skippedNodeCount, 1);
  assert.equal(result.report.entries.length, 5);
  assert.equal(Object.prototype.hasOwnProperty.call(result, "filePath"), false);
  const imageNode = result.workflow.nodes.find((node) => node.type === "image-input");
  assert.equal(imageNode?.type, "image-input");
  assert.equal(result.workflow.assetRefs.length, 1);
  assert.equal(imageNode?.data.assetId, result.workflow.assetRefs[0]);
  assert.ok(await createImages.assets.getAvailable(result.workflow.assetRefs[0]!));
  assert.ok(await createImages.workflows.get(result.workflow.id));
  const serialized = JSON.stringify(result.workflow);
  assert.equal(serialized.includes("do-not-import"), false);
  assert.equal(serialized.includes("/private/source"), false);
  assert.equal(serialized.includes("data:image"), false);
});

test("Node Banana file import rejects invalid JSON without publishing a workflow", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "aiden-node-banana-invalid-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const createImages = service(root);
  await createImages.initialize();
  const source = path.join(root, "invalid.json");
  await fs.writeFile(source, "{broken", { mode: 0o600 });
  const before = await createImages.workflows.list();
  await assert.rejects(
    createImages.nodeBananaImports.importFromFile(source),
    (error: unknown) => error instanceof CreateImagesNodeBananaServiceError,
  );
  assert.deepEqual(await createImages.workflows.list(), before);
});
