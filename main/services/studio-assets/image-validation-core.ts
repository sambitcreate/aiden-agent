import { displayImageDimensions, validateDisplayImageDimensions } from "../display-image-extension.js";
import {
  STUDIO_ASSET_LIMITS,
  StudioAssetError,
  type StudioAssetLimits,
  type StudioAssetMediaType,
} from "./contract.js";

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

function ascii(bytes: Uint8Array, start: number, end: number): string {
  return String.fromCharCode(...bytes.subarray(start, end));
}

/** Content decides the type; extensions and declared MIME types never do. */
export function sniffStudioImageType(bytes: Uint8Array): StudioAssetMediaType | undefined {
  if (bytes.length >= 8 && PNG_SIGNATURE.every((byte, index) => bytes[index] === byte)) return "image/png";
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes.length >= 12 && ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 12) === "WEBP") return "image/webp";
  return undefined;
}

export function validateStudioImage(
  bytes: Uint8Array,
  declaredMimeType: string | undefined,
  limits: Pick<StudioAssetLimits, "maxEdge" | "maxPixels"> = STUDIO_ASSET_LIMITS,
): { mediaType: StudioAssetMediaType; width: number; height: number } {
  const mediaType = sniffStudioImageType(bytes);
  if (!mediaType) {
    throw new StudioAssetError("invalid_image", "Only PNG, JPEG and WebP images are supported.");
  }
  const declared = declaredMimeType?.split(";", 1)[0]?.trim().toLowerCase();
  if (declared !== undefined && declared !== mediaType && !(declared === "image/jpg" && mediaType === "image/jpeg")) {
    throw new StudioAssetError("invalid_image", "The declared image type does not match its contents.");
  }
  const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const dimensions = displayImageDimensions(buffer, mediaType);
  if (!dimensions || dimensions.width < 1 || dimensions.height < 1) {
    throw new StudioAssetError("invalid_image", "The image is malformed.");
  }
  if (
    dimensions.width > limits.maxEdge ||
    dimensions.height > limits.maxEdge ||
    dimensions.width * dimensions.height > limits.maxPixels
  ) {
    throw new StudioAssetError("too_large", "The image is too large to decode safely.");
  }
  try {
    validateDisplayImageDimensions(buffer, mediaType, "The image");
  } catch (error) {
    throw new StudioAssetError(
      "invalid_image",
      error instanceof Error ? error.message : "The image is malformed.",
    );
  }
  return { mediaType, width: dimensions.width, height: dimensions.height };
}
