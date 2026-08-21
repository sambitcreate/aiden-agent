import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import path from "node:path";
import test from "node:test";
import * as yauzl from "yauzl";
import type { ContentAddressedAssetStore } from "./asset-store-core.js";
import {
  CREATE_IMAGES_MAX_OUTPUT_ZIP_BYTES,
  writeCreateImagesOutputZip,
} from "./native-output-zip.js";

const FIRST = "a".repeat(64);
const SECOND = "b".repeat(64);

function fakeAssets(
  records: Readonly<Record<string, { mediaType: "image/png" | "image/jpeg"; bytes: Uint8Array }>>,
): ContentAddressedAssetStore {
  return {
    async getAvailable(assetId: string) {
      const record = records[assetId];
      return record
        ? {
            assetId,
            mediaType: record.mediaType,
            byteLength: record.bytes.byteLength,
            width: 1,
            height: 1,
            createdAt: "2026-08-21T12:00:00.000Z",
            origin: { kind: "import" as const },
            referenceCount: 1,
            thumbnailSizes: [],
          }
        : undefined;
    },
    async exportAssetToFile(assetId: string, destination: string) {
      const record = records[assetId];
      if (!record) throw new Error("missing");
      await fs.writeFile(destination, record.bytes, { flag: "wx", mode: 0o600 });
    },
  } as unknown as ContentAddressedAssetStore;
}

test("native output ZIP uses collision-safe inert names and preserves selected order", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "aiden-output-zip-test-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const destination = path.join(directory, "selected.zip");
  await writeCreateImagesOutputZip(
    fakeAssets({
      [FIRST]: { mediaType: "image/png", bytes: Uint8Array.of(1, 2, 3) },
      [SECOND]: { mediaType: "image/jpeg", bytes: Uint8Array.of(4, 5) },
    }),
    [FIRST, FIRST, SECOND],
    destination,
  );

  const zip = await yauzl.openPromise(destination, { lazyEntries: true });
  t.after(() => zip.close());
  const names: string[] = [];
  for await (const entry of zip.eachEntry()) names.push(entry.fileName);
  assert.deepEqual(names, [
    "Aiden image 01-aaaaaaaa.png",
    "Aiden image 02-aaaaaaaa.png",
    "Aiden image 03-bbbbbbbb.jpg",
  ]);
  assert.equal(names.every((name) => !name.includes("/") && !name.includes("..")), true);
});

test("native output ZIP fails closed for missing, empty, and oversized selections", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "aiden-output-zip-bounds-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const destination = path.join(directory, "blocked.zip");
  await assert.rejects(
    writeCreateImagesOutputZip(fakeAssets({}), [FIRST], destination),
    /unavailable/u,
  );
  await assert.rejects(writeCreateImagesOutputZip(fakeAssets({}), [], destination), /512 MB/u);

  const store = {
    async getAvailable(assetId: string) {
      return {
        assetId,
        mediaType: "image/png" as const,
        byteLength: CREATE_IMAGES_MAX_OUTPUT_ZIP_BYTES + 1,
      };
    },
  } as unknown as ContentAddressedAssetStore;
  await assert.rejects(writeCreateImagesOutputZip(store, [FIRST], destination), /512 MB/u);
  await assert.rejects(fs.access(destination));
});
