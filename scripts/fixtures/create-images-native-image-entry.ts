import * as fs from "node:fs/promises";
import { app } from "electron";
import { validateImageBytes } from "../../main/services/create-images/asset-image-validation-core";
import {
  electronAssetDeepValidator,
  electronAssetThumbnailGenerator,
} from "../../main/services/create-images/electron-asset-images";

async function main(): Promise<void> {
  const imagePath = process.argv[2];
  const thumbnailPath = process.argv[3];
  if (!imagePath || !thumbnailPath) throw new Error("Native image canary requires two paths.");
  app.on("window-all-closed", () => undefined);
  await app.whenReady();
  const before = await process.getProcessMemoryInfo();
  const bytes = new Uint8Array(await fs.readFile(imagePath));
  const descriptor = validateImageBytes(bytes, "image/png", "large-reference.png", {
    maxWidth: 32_768,
    maxHeight: 32_768,
    maxPixels: 16_000_000,
  });
  const decoded = await electronAssetDeepValidator.validate({
    filePath: imagePath,
    descriptor,
    byteLength: bytes.byteLength,
  });
  const thumbnail = await electronAssetThumbnailGenerator.generate({
    sourcePath: imagePath,
    source: descriptor,
    maxDimension: 512,
    maxOutputBytes: 4 * 1024 * 1024,
  });
  await fs.writeFile(thumbnailPath, thumbnail.bytes, { flag: "wx", mode: 0o600 });
  const thumbnailDescriptor = validateImageBytes(
    thumbnail.bytes,
    "image/png",
    "thumbnail.png",
    { maxWidth: 512, maxHeight: 512, maxPixels: 512 * 512 },
  );
  const thumbnailDecoded = await electronAssetDeepValidator.validate({
    filePath: thumbnailPath,
    descriptor: thumbnailDescriptor,
    byteLength: thumbnail.bytes.byteLength,
  });
  const after = await process.getProcessMemoryInfo();
  process.stdout.write(
    `AIDEN_CREATE_IMAGES_NATIVE_IMAGE=${JSON.stringify({
      inputBytes: bytes.byteLength,
      width: decoded.width,
      height: decoded.height,
      thumbnailBytes: thumbnail.bytes.byteLength,
      thumbnailWidth: thumbnailDecoded.width,
      thumbnailHeight: thumbnailDecoded.height,
      privateMemoryGrowthKb: Math.max(0, after.private - before.private),
    })}\n`,
  );
  app.quit();
}

void main().catch((error: unknown) => {
  process.stderr.write(
    `${error instanceof Error ? error.stack ?? error.message : "Native image canary failed."}\n`,
  );
  process.exitCode = 1;
  app.quit();
});
