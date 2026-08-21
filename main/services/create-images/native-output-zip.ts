import { createWriteStream } from "node:fs";
import { randomUUID } from "node:crypto";
import { mkdtemp, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import * as yazl from "yazl";
import type { ContentAddressedAssetStore } from "./asset-store-core.js";

export const CREATE_IMAGES_MAX_OUTPUT_ZIP_BYTES = 512 * 1024 * 1024;

function collisionSafeName(index: number, assetId: string, mediaType: string): string {
  const extension = mediaType === "image/png" ? "png" : "jpg";
  return `Aiden image ${String(index + 1).padStart(2, "0")}-${assetId.slice(0, 8)}.${extension}`;
}

/** Main-owned, bounded ZIP export. No source or destination path crosses IPC. */
export async function writeCreateImagesOutputZip(
  assets: ContentAddressedAssetStore,
  assetIds: readonly string[],
  destination: string,
): Promise<void> {
  const metadata = await Promise.all(assetIds.map((assetId) => assets.getAvailable(assetId)));
  if (metadata.some((asset) => asset === undefined)) {
    throw new Error("One or more retained images are unavailable.");
  }
  const totalBytes = metadata.reduce((total, asset) => total + (asset?.byteLength ?? 0), 0);
  if (totalBytes < 1 || totalBytes > CREATE_IMAGES_MAX_OUTPUT_ZIP_BYTES) {
    throw new Error("The selected images exceed the 512 MB ZIP export limit.");
  }
  const stage = await mkdtemp(path.join(tmpdir(), "aiden-create-images-output-"));
  const temporaryDestination = `${destination}.${randomUUID()}.tmp`;
  try {
    const zip = new yazl.ZipFile();
    for (const [index, assetId] of assetIds.entries()) {
      const asset = metadata[index]!;
      const name = collisionSafeName(index, assetId, asset.mediaType);
      const stagedPath = path.join(stage, name);
      await assets.exportAssetToFile(assetId, stagedPath);
      zip.addFile(stagedPath, name, { compress: false, mode: 0o100600, mtime: new Date(0) });
    }
    const output = createWriteStream(temporaryDestination, { flags: "wx", mode: 0o600 });
    const writing = pipeline(zip.outputStream, output);
    zip.end();
    await writing;
    await rename(temporaryDestination, destination);
  } finally {
    await rm(temporaryDestination, { force: true });
    await rm(stage, { recursive: true, force: true });
  }
}
