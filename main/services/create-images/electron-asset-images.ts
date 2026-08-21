import type {
  AssetDeepValidator,
  AssetThumbnailGenerator,
} from "./asset-store-core.js";
import { runImageUtility } from "./electron-asset-image-utility.js";
import type { CreateImagesAnnotationRasterizer } from "./run-service.js";

export const electronAssetDeepValidator: AssetDeepValidator = {
  async validate({ filePath }) {
    const size = await runImageUtility({ operation: "validate", filePath });
    if (!Number.isSafeInteger(size.width) || !Number.isSafeInteger(size.height)) {
      throw new Error("The native image decoder returned invalid dimensions.");
    }
    return size;
  },
};

export const electronAssetThumbnailGenerator: AssetThumbnailGenerator = {
  async generate({ sourcePath, maxDimension, maxOutputBytes }) {
    const result = await runImageUtility({
      operation: "thumbnail",
      filePath: sourcePath,
      maxDimension,
      maxOutputBytes,
    });
    const bytes = result.bytes;
    if (!bytes) throw new Error("The image decoder returned no thumbnail bytes.");
    if (bytes.byteLength < 1 || bytes.byteLength > maxOutputBytes) {
      throw new Error("The generated thumbnail exceeds its byte limit.");
    }
    return {
      bytes: bytes.slice(),
      width: result.width,
      height: result.height,
      mediaType: "image/png",
    };
  },
};

export const electronAnnotationRasterizer: CreateImagesAnnotationRasterizer = {
  async rasterize({ sourcePath, shapes }) {
    const result = await runImageUtility({
      operation: "annotate",
      filePath: sourcePath,
      shapes,
      maxPixels: 64_000_000,
      maxOutputBytes: 64 * 1024 * 1024,
    });
    if (!result.bytes) throw new Error("The annotation rasterizer returned no PNG bytes.");
    return {
      bytes: result.bytes.slice(),
      width: result.width,
      height: result.height,
    };
  },
};
