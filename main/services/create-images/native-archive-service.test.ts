import assert from "node:assert/strict";
import { createWriteStream } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import test from "node:test";
import * as yazl from "yazl";
import { CREATE_IMAGES_ARCHIVE_MANIFEST_PATH } from "../../../renderer/shared/create-images/archive.js";
import { createStarterWorkflow } from "../../../renderer/shared/create-images/schema.js";
import { CreateImagesService } from "./create-images-service.js";
import { CreateImagesNativeArchiveError } from "./native-archive-service.js";

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

async function* chunks(bytes: Uint8Array): AsyncGenerator<Uint8Array> {
  yield bytes;
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

async function writeDuplicateManifestArchive(filePath: string): Promise<void> {
  const zip = new yazl.ZipFile();
  zip.addBuffer(Buffer.from("{}"), CREATE_IMAGES_ARCHIVE_MANIFEST_PATH, { compress: false });
  zip.addBuffer(Buffer.from("{}"), CREATE_IMAGES_ARCHIVE_MANIFEST_PATH, { compress: false });
  const writing = pipeline(zip.outputStream, createWriteStream(filePath, { mode: 0o600 }));
  zip.end();
  await writing;
}

test("native archive export/import round-trips a workflow and referenced image without paths", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "aiden-native-archive-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const createImages = service(root);
  await createImages.initialize();
  const image = await createImages.assets.ingest(chunks(makePng()), {
    origin: { kind: "import" },
    declaredMimeType: "image/png",
    displayName: "reference.png",
  });
  const workflow = createStarterWorkflow({
    workflowId: "archive-source",
    promptNodeId: "prompt-1",
    generationNodeId: "generate-1",
    outputNodeId: "output-1",
    promptEdgeId: "edge-1",
    outputEdgeId: "edge-2",
    now: "2026-08-19T12:00:00.000Z",
  });
  workflow.nodes.push({
    id: "image-1",
    type: "image-input",
    position: { x: 0, y: 320 },
    data: { assetId: image.asset.assetId, label: "Reference" },
  });
  workflow.assetRefs = [image.asset.assetId];
  await createImages.mutateWorkflow(workflow.id, workflow.assetRefs, () =>
    createImages.workflows.create(workflow),
  );

  const archivePath = path.join(root, "exported.aiden-images");
  const exported = await createImages.archives.exportToFile({
    workflowId: workflow.id,
    expectedRevision: 1,
    destination: archivePath,
  });
  assert.deepEqual(exported, {
    workflowId: workflow.id,
    revision: 1,
    fileName: "exported.aiden-images",
    assetCount: 1,
  });
  assert.equal(Object.prototype.hasOwnProperty.call(exported, "filePath"), false);
  assert.ok((await fs.stat(archivePath)).size > image.asset.byteLength);

  const imported = await createImages.archives.importFromFile(archivePath);
  assert.notEqual(imported.workflow.id, workflow.id);
  assert.equal(imported.workflow.revision, 1);
  assert.deepEqual(imported.workflow.assetRefs, [image.asset.assetId]);
  assert.equal(imported.importedAssetCount, 1);
  assert.equal(imported.sourceFileName, "exported.aiden-images");
  assert.equal(Object.prototype.hasOwnProperty.call(imported, "filePath"), false);
  assert.ok(await createImages.workflows.get(imported.workflow.id));
  assert.equal(
    (await createImages.assets.getAvailable(image.asset.assetId))?.assetId,
    image.asset.assetId,
  );
});

test("native archive import rejects invalid bytes without publishing a workflow", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "aiden-native-archive-invalid-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const createImages = service(root);
  await createImages.initialize();
  const archivePath = path.join(root, "hostile.aiden-images");
  await fs.writeFile(archivePath, "not a zip", { mode: 0o600 });
  const before = await createImages.workflows.list();
  await assert.rejects(
    createImages.archives.importFromFile(archivePath),
    (error: unknown) =>
      error instanceof CreateImagesNativeArchiveError && error.code === "archive_invalid",
  );
  assert.deepEqual(await createImages.workflows.list(), before);
});

test("native archive import rejects a duplicate manifest before publication", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "aiden-native-archive-duplicate-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const createImages = service(root);
  await createImages.initialize();
  const archivePath = path.join(root, "duplicate-manifest.aiden-images");
  await writeDuplicateManifestArchive(archivePath);
  const before = await createImages.workflows.list();

  await assert.rejects(
    createImages.archives.importFromFile(archivePath),
    (error: unknown) =>
      error instanceof CreateImagesNativeArchiveError && error.code === "archive_invalid",
  );
  assert.deepEqual(await createImages.workflows.list(), before);
});
