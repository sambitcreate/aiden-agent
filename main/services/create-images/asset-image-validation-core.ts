import path from "node:path";

export type SafeAssetMediaType = "image/jpeg" | "image/png";
export type SafeAssetExtension = "jpg" | "png";

export interface AssetImageLimits {
  maxWidth: number;
  maxHeight: number;
  maxPixels: number;
}

export interface ValidatedImageDescriptor {
  mediaType: SafeAssetMediaType;
  extension: SafeAssetExtension;
  width: number;
  height: number;
  pixels: number;
}

export class AssetImageValidationError extends Error {
  constructor(
    public readonly code:
      | "unsupported_format"
      | "mime_mismatch"
      | "extension_mismatch"
      | "truncated_image"
      | "malformed_image"
      | "image_dimensions_exceeded",
    message: string,
  ) {
    super(message);
    this.name = "AssetImageValidationError";
  }
}

const PNG_SIGNATURE = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]);
const CRC32_TABLE = Uint32Array.from({ length: 256 }, (_, value) => {
  let crc = value;
  for (let bit = 0; bit < 8; bit += 1) {
    crc = (crc >>> 1) ^ (crc & 1 ? 0xedb8_8320 : 0);
  }
  return crc >>> 0;
});
const PNG_BIT_DEPTHS: Readonly<Record<number, readonly number[]>> = {
  0: [1, 2, 4, 8, 16],
  2: [8, 16],
  3: [1, 2, 4, 8],
  4: [8, 16],
  6: [8, 16],
};

function readU32(bytes: Uint8Array, offset: number): number {
  return (
    bytes[offset]! * 0x1_000_000 +
    bytes[offset + 1]! * 0x1_0000 +
    bytes[offset + 2]! * 0x100 +
    bytes[offset + 3]!
  );
}

function crc32(bytes: Uint8Array, start: number, end: number): number {
  let crc = 0xffff_ffff;
  for (let index = start; index < end; index += 1) {
    crc = (crc >>> 8) ^ CRC32_TABLE[(crc ^ bytes[index]!) & 0xff]!;
  }
  return (crc ^ 0xffff_ffff) >>> 0;
}

function assertDimensions(width: number, height: number, limits: AssetImageLimits): void {
  const pixels = width * height;
  if (
    !Number.isSafeInteger(width) ||
    !Number.isSafeInteger(height) ||
    width < 1 ||
    height < 1 ||
    width > limits.maxWidth ||
    height > limits.maxHeight ||
    !Number.isSafeInteger(pixels) ||
    pixels > limits.maxPixels
  ) {
    throw new AssetImageValidationError(
      "image_dimensions_exceeded",
      "The image dimensions exceed Aiden's configured safety limit.",
    );
  }
}

function isPng(bytes: Uint8Array): boolean {
  return PNG_SIGNATURE.every((byte, index) => bytes[index] === byte);
}

function validatePng(bytes: Uint8Array, limits: AssetImageLimits): ValidatedImageDescriptor {
  if (bytes.byteLength < 33) {
    throw new AssetImageValidationError("truncated_image", "The PNG file is truncated.");
  }
  let offset = PNG_SIGNATURE.byteLength;
  let width = 0;
  let height = 0;
  let colorType = -1;
  let sawHeader = false;
  let sawPalette = false;
  let sawImageData = false;
  let sawEnd = false;
  let chunkCount = 0;
  while (offset < bytes.byteLength) {
    if (offset + 12 > bytes.byteLength) {
      throw new AssetImageValidationError("truncated_image", "The PNG chunk header is truncated.");
    }
    const length = readU32(bytes, offset);
    const typeStart = offset + 4;
    const dataStart = offset + 8;
    const dataEnd = dataStart + length;
    const chunkEnd = dataEnd + 4;
    if (!Number.isSafeInteger(chunkEnd) || chunkEnd > bytes.byteLength) {
      throw new AssetImageValidationError("truncated_image", "The PNG chunk body is truncated.");
    }
    const type = String.fromCharCode(...bytes.subarray(typeStart, typeStart + 4));
    if (!/^[A-Za-z]{4}$/u.test(type)) {
      throw new AssetImageValidationError(
        "malformed_image",
        "The PNG contains an invalid chunk type.",
      );
    }
    if (crc32(bytes, typeStart, dataEnd) !== readU32(bytes, dataEnd)) {
      throw new AssetImageValidationError("malformed_image", "The PNG contains a corrupt chunk.");
    }
    chunkCount += 1;
    if (chunkCount > 10_000) {
      throw new AssetImageValidationError("malformed_image", "The PNG contains too many chunks.");
    }
    if (!sawHeader && type !== "IHDR") {
      throw new AssetImageValidationError(
        "malformed_image",
        "The PNG header is not the first chunk.",
      );
    }
    if (type === "IHDR") {
      if (sawHeader || length !== 13) {
        throw new AssetImageValidationError("malformed_image", "The PNG header is malformed.");
      }
      width = readU32(bytes, dataStart);
      height = readU32(bytes, dataStart + 4);
      const bitDepth = bytes[dataStart + 8]!;
      colorType = bytes[dataStart + 9]!;
      if (
        !PNG_BIT_DEPTHS[colorType]?.includes(bitDepth) ||
        bytes[dataStart + 10] !== 0 ||
        bytes[dataStart + 11] !== 0 ||
        (bytes[dataStart + 12] !== 0 && bytes[dataStart + 12] !== 1)
      ) {
        throw new AssetImageValidationError(
          "malformed_image",
          "The PNG header uses unsupported values.",
        );
      }
      assertDimensions(width, height, limits);
      sawHeader = true;
    } else if (type === "PLTE") {
      if (sawImageData || length < 3 || length > 768 || length % 3 !== 0) {
        throw new AssetImageValidationError("malformed_image", "The PNG palette is malformed.");
      }
      sawPalette = true;
    } else if (type === "IDAT") {
      if (colorType === 3 && !sawPalette) {
        throw new AssetImageValidationError("malformed_image", "The indexed PNG has no palette.");
      }
      sawImageData = true;
    } else if (type === "IEND") {
      if (length !== 0 || !sawImageData || chunkEnd !== bytes.byteLength) {
        throw new AssetImageValidationError("malformed_image", "The PNG end marker is malformed.");
      }
      sawEnd = true;
    } else if (/^[A-Z]/u.test(type) || type === "acTL" || type === "fcTL" || type === "fdAT") {
      throw new AssetImageValidationError(
        "unsupported_format",
        "Only static PNG images with known critical chunks are supported.",
      );
    }
    offset = chunkEnd;
    if (sawEnd) break;
  }
  if (!sawHeader || !sawImageData || !sawEnd) {
    throw new AssetImageValidationError("truncated_image", "The PNG file is incomplete.");
  }
  return { mediaType: "image/png", extension: "png", width, height, pixels: width * height };
}

const UNSUPPORTED_SOF = new Set([0xc1, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);

function validateJpeg(bytes: Uint8Array, limits: AssetImageLimits): ValidatedImageDescriptor {
  if (bytes.byteLength < 8 || bytes[0] !== 0xff || bytes[1] !== 0xd8) {
    throw new AssetImageValidationError("truncated_image", "The JPEG file is truncated.");
  }
  let offset = 2;
  let width = 0;
  let height = 0;
  let sawFrame = false;
  let sawScan = false;
  let inEntropy = false;
  while (offset < bytes.byteLength) {
    if (!inEntropy) {
      if (bytes[offset] !== 0xff) {
        throw new AssetImageValidationError(
          "malformed_image",
          "The JPEG marker stream is malformed.",
        );
      }
      while (bytes[offset] === 0xff) offset += 1;
    } else {
      while (offset < bytes.byteLength && bytes[offset] !== 0xff) offset += 1;
      if (offset >= bytes.byteLength) break;
      while (bytes[offset] === 0xff) offset += 1;
      if (bytes[offset] === 0x00) {
        offset += 1;
        continue;
      }
      if (bytes[offset]! >= 0xd0 && bytes[offset]! <= 0xd7) {
        offset += 1;
        continue;
      }
      inEntropy = false;
    }
    if (offset >= bytes.byteLength) break;
    const marker = bytes[offset]!;
    offset += 1;
    if (marker === 0xd9) {
      if (!sawFrame || !sawScan || offset !== bytes.byteLength) {
        throw new AssetImageValidationError("malformed_image", "The JPEG end marker is malformed.");
      }
      return {
        mediaType: "image/jpeg",
        extension: "jpg",
        width,
        height,
        pixels: width * height,
      };
    }
    if (marker === 0xd8 || marker === 0x00 || (marker >= 0xd0 && marker <= 0xd7)) {
      throw new AssetImageValidationError(
        "malformed_image",
        "The JPEG contains an invalid marker.",
      );
    }
    if (offset + 2 > bytes.byteLength) {
      throw new AssetImageValidationError(
        "truncated_image",
        "The JPEG segment header is truncated.",
      );
    }
    const length = bytes[offset]! * 256 + bytes[offset + 1]!;
    if (length < 2 || offset + length > bytes.byteLength) {
      throw new AssetImageValidationError("truncated_image", "The JPEG segment is truncated.");
    }
    const dataStart = offset + 2;
    if (marker === 0xc0 || marker === 0xc2) {
      if (sawFrame || length < 11 || bytes[dataStart] !== 8) {
        throw new AssetImageValidationError("malformed_image", "The JPEG frame is malformed.");
      }
      height = bytes[dataStart + 1]! * 256 + bytes[dataStart + 2]!;
      width = bytes[dataStart + 3]! * 256 + bytes[dataStart + 4]!;
      const components = bytes[dataStart + 5]!;
      if (![1, 3, 4].includes(components) || length !== 8 + components * 3) {
        throw new AssetImageValidationError(
          "malformed_image",
          "The JPEG frame components are malformed.",
        );
      }
      assertDimensions(width, height, limits);
      sawFrame = true;
    } else if (UNSUPPORTED_SOF.has(marker)) {
      throw new AssetImageValidationError(
        "unsupported_format",
        "Only baseline and progressive 8-bit JPEG images are supported.",
      );
    }
    if (marker === 0xda) {
      if (!sawFrame) {
        throw new AssetImageValidationError("malformed_image", "The JPEG scan precedes its frame.");
      }
      sawScan = true;
      inEntropy = true;
    }
    offset += length;
  }
  throw new AssetImageValidationError(
    "truncated_image",
    "The JPEG file has no complete end marker.",
  );
}

function normalizedDeclaredMime(value: string | undefined): string | undefined {
  return value?.split(";", 1)[0]?.trim().toLowerCase();
}

export function sanitizeAssetDisplayName(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const base = [...path.basename(value.replace(/\\/gu, "/"))]
    .filter((character) => character.codePointAt(0)! >= 32 && character.codePointAt(0) !== 127)
    .join("")
    .trim();
  if (!base) return undefined;
  return base.slice(0, 255);
}

export function validateImageBytes(
  bytes: Uint8Array,
  declaredMimeType: string | undefined,
  displayName: string | undefined,
  limits: AssetImageLimits,
): ValidatedImageDescriptor {
  const descriptor = isPng(bytes)
    ? validatePng(bytes, limits)
    : bytes[0] === 0xff && bytes[1] === 0xd8
      ? validateJpeg(bytes, limits)
      : (() => {
          throw new AssetImageValidationError(
            "unsupported_format",
            "Only validated static PNG and JPEG images are supported.",
          );
        })();
  const mime = normalizedDeclaredMime(declaredMimeType);
  if (mime !== undefined && mime !== descriptor.mediaType) {
    throw new AssetImageValidationError(
      "mime_mismatch",
      "The declared media type does not match the image contents.",
    );
  }
  const safeName = sanitizeAssetDisplayName(displayName);
  const extension = safeName ? path.extname(safeName).slice(1).toLowerCase() : undefined;
  if (
    extension &&
    !(
      (descriptor.mediaType === "image/png" && extension === "png") ||
      (descriptor.mediaType === "image/jpeg" && (extension === "jpg" || extension === "jpeg"))
    )
  ) {
    throw new AssetImageValidationError(
      "extension_mismatch",
      "The filename extension does not match the image contents.",
    );
  }
  return descriptor;
}
