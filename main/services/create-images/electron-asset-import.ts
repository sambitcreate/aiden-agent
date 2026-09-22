import { constants } from "node:fs";
import * as fs from "node:fs/promises";
import path from "node:path";
import { readRegularFile } from "../regular-file-read.js";
import {
  AssetImageValidationError,
  sanitizeAssetDisplayName,
} from "./asset-image-validation-core.js";
import {
  AssetStoreError,
  DEFAULT_ASSET_STORE_LIMITS,
  type AssetIngestRequest,
  type AssetIngestResult,
} from "./asset-store-core.js";
import {
  createImagesCanonicalValidationName,
  createImagesImportSourcePolicy,
} from "./asset-import-normalization-core.js";

interface CreateImagesImportAssetStore {
  ingest(
    source: AsyncIterable<Uint8Array>,
    request: AssetIngestRequest,
  ): Promise<AssetIngestResult>;
}

export class CreateImagesImageImportError extends Error {
  constructor(
    public readonly code: "animated_image" | "normalization_failed" | "vector_image",
    message: string,
  ) {
    super(message);
    this.name = "CreateImagesImageImportError";
  }
}

export interface CreateImagesImageNormalizer {
  normalize(filePath: string): Promise<{ bytes: Uint8Array; width: number; height: number }>;
}

const defaultNormalizer: CreateImagesImageNormalizer = {
  async normalize(filePath) {
    // Keep Electron's privileged module out of pure Node test/runtime imports;
    // conversion is loaded only when a non-canonical raster actually needs it.
    const { runImageUtility } = await import("./electron-asset-image-utility.js");
    let result: { bytes?: Uint8Array; width: number; height: number };
    try {
      result = await runImageUtility({
        operation: "normalize",
        filePath,
        maxInputBytes: DEFAULT_ASSET_STORE_LIMITS.maxImportBytes,
        maxWidth: DEFAULT_ASSET_STORE_LIMITS.maxWidth,
        maxHeight: DEFAULT_ASSET_STORE_LIMITS.maxHeight,
        maxPixels: DEFAULT_ASSET_STORE_LIMITS.maxPixels,
        maxOutputBytes: DEFAULT_ASSET_STORE_LIMITS.maxImportBytes,
      });
    } catch (chromiumError) {
      if (process.platform !== "darwin") throw chromiumError;
      const { normalizeImageWithMacosImageIo } = await import("./macos-image-normalizer.js");
      return normalizeImageWithMacosImageIo(filePath, {
        maxInputBytes: DEFAULT_ASSET_STORE_LIMITS.maxImportBytes,
        maxOutputBytes: DEFAULT_ASSET_STORE_LIMITS.maxImportBytes,
        maxWidth: DEFAULT_ASSET_STORE_LIMITS.maxWidth,
        maxHeight: DEFAULT_ASSET_STORE_LIMITS.maxHeight,
        maxPixels: DEFAULT_ASSET_STORE_LIMITS.maxPixels,
      });
    }
    if (!result.bytes) throw new Error("The image normalizer returned no bytes.");
    return { bytes: result.bytes.slice(), width: result.width, height: result.height };
  },
};

async function* selectedFile(filePath: string): AsyncGenerator<Uint8Array> {
  const noFollow = "O_NOFOLLOW" in constants ? constants.O_NOFOLLOW : 0;
  const handle = await fs.open(filePath, constants.O_RDONLY | constants.O_NONBLOCK | noFollow);
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw new Error("The selected image is not a regular file.");
    const stream = handle.createReadStream({ autoClose: false });
    for await (const chunk of stream) {
      yield new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength);
    }
  } finally {
    await handle.close().catch(() => undefined);
  }
}

async function* bytesSource(bytes: Uint8Array): AsyncGenerator<Uint8Array> {
  yield bytes;
}

function importRequest(displayName: string | undefined): AssetIngestRequest {
  return { origin: { kind: "import" }, ...(displayName ? { displayName } : {}) };
}

export async function ingestCreateImagesImageFile(
  assets: CreateImagesImportAssetStore,
  filePath: string,
  options: {
    normalizer?: CreateImagesImageNormalizer;
    maxInputBytes?: number;
  } = {},
): Promise<AssetIngestResult> {
  const displayName = sanitizeAssetDisplayName(path.basename(filePath));
  try {
    return await assets.ingest(selectedFile(filePath), importRequest(displayName));
  } catch (error) {
    if (!(error instanceof AssetImageValidationError)) throw error;
    const maxInputBytes = options.maxInputBytes ?? DEFAULT_ASSET_STORE_LIMITS.maxImportBytes;
    let original: Uint8Array;
    try {
      original = await readRegularFile(filePath, maxInputBytes);
    } catch (readError) {
      if ((readError as NodeJS.ErrnoException).code === "EFBIG") {
        throw new AssetStoreError(
          "asset_ingest_too_large",
          `The image exceeds the ${maxInputBytes}-byte ingest limit.`,
        );
      }
      throw readError;
    }
    const policy = createImagesImportSourcePolicy(original, displayName);
    if (policy.kind === "reject") {
      throw new CreateImagesImageImportError(
        policy.reason === "animated" ? "animated_image" : "vector_image",
        policy.reason === "animated"
          ? "Animated images are not supported."
          : "Vector images are not supported.",
      );
    }
    if (policy.kind === "canonical") {
      if (error.code !== "extension_mismatch") throw error;
      return assets.ingest(selectedFile(filePath), {
        ...importRequest(displayName),
        validationDisplayName: createImagesCanonicalValidationName(
          displayName,
          policy.format === "jpeg" ? "jpg" : "png",
        ),
      });
    }
    if (error.code !== "unsupported_format" && error.code !== "extension_mismatch") throw error;
    let normalized: { bytes: Uint8Array; width: number; height: number };
    try {
      normalized = await (options.normalizer ?? defaultNormalizer).normalize(filePath);
    } catch {
      throw new CreateImagesImageImportError(
        "normalization_failed",
        "The isolated image converter could not decode this file.",
      );
    }
    if (
      normalized.bytes.byteLength < 1 ||
      normalized.bytes.byteLength > DEFAULT_ASSET_STORE_LIMITS.maxImportBytes ||
      !Number.isSafeInteger(normalized.width) ||
      !Number.isSafeInteger(normalized.height) ||
      normalized.width < 1 ||
      normalized.height < 1 ||
      normalized.width > DEFAULT_ASSET_STORE_LIMITS.maxWidth ||
      normalized.height > DEFAULT_ASSET_STORE_LIMITS.maxHeight ||
      normalized.width * normalized.height > DEFAULT_ASSET_STORE_LIMITS.maxPixels
    ) {
      throw new CreateImagesImageImportError(
        "normalization_failed",
        "The isolated image converter returned an invalid image.",
      );
    }
    return assets.ingest(bytesSource(normalized.bytes), {
      ...importRequest(displayName),
      declaredMimeType: "image/png",
      validationDisplayName: createImagesCanonicalValidationName(displayName, "png"),
    });
  }
}
