import type { ImageContent } from "@earendil-works/pi-ai";
import { hasCanonicalBase64Padding, validateDisplayImageDimensions } from "./display-image-extension.js";

export const MAX_GENERATED_IMAGES = 4;
export const MAX_GENERATED_IMAGE_BYTES = 8 * 1024 * 1024;
const OUTPUT_MIME_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"];
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/u;

export interface ParsedGeneratedImages {
  images: ImageContent[];
  sizes: { bytes: number; pixels: number; width: number; height: number }[];
  description: string;
  truncated: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/**
 * Validates provider image output, or reference images, with one decode per image.
 * "reject" (chat generate_image and its references) fails past 4 images or 8 MiB.
 * "truncate" (Create Images) keeps the first valid images that fit and flags the
 * rest, so a paid attempt is never failed for returning extra interim images.
 */
export function parseGeneratedImages(
  output: unknown,
  options: { name?: string; overflow?: "reject" | "truncate" } = {},
): ParsedGeneratedImages {
  const name = options.name ?? "Generated image";
  const truncate = options.overflow === "truncate";
  if (!Array.isArray(output) || output.length > 64) throw new Error("Invalid image-generation output.");
  const images: ImageContent[] = [];
  const sizes: ParsedGeneratedImages["sizes"] = [];
  let bytes = 0;
  let description = "";
  let truncated = false;
  for (const raw of output) {
    if (!isRecord(raw)) {
      if (truncate) continue;
      throw new Error("Invalid image-generation content.");
    }
    if (raw.type === "text") {
      if (typeof raw.text !== "string" || Buffer.byteLength(raw.text, "utf8") > 32_768) {
        // A paid result is not failed for an unusable caption.
        if (truncate) continue;
        throw new Error("Invalid image description.");
      }
      description += raw.text.slice(0, Math.max(0, 8192 - description.length));
      continue;
    }
    try {
      if (
        raw.type !== "image" ||
        typeof raw.data !== "string" ||
        typeof raw.mimeType !== "string" ||
        !OUTPUT_MIME_TYPES.includes(raw.mimeType) ||
        raw.data.length > Math.ceil(MAX_GENERATED_IMAGE_BYTES / 3) * 4 ||
        raw.data.length % 4 !== 0 ||
        !BASE64.test(raw.data)
      ) {
        throw new Error("Invalid generated image data.");
      }
      if (!hasCanonicalBase64Padding(raw.data)) throw new Error("Invalid generated image encoding.");
      const data = Buffer.from(raw.data, "base64");
      if (bytes + data.length > MAX_GENERATED_IMAGE_BYTES || images.length >= MAX_GENERATED_IMAGES) {
        if (truncate) {
          truncated = true;
          continue;
        }
        throw new Error("Generated images exceed the 4-image or 8 MiB output limit.");
      }
      const size = validateDisplayImageDimensions(data, raw.mimeType, name);
      bytes += data.length;
      images.push({ type: "image", data: raw.data, mimeType: raw.mimeType });
      sizes.push({ bytes: data.length, pixels: size.width * size.height, width: size.width, height: size.height });
    } catch (error) {
      if (!truncate) throw error;
      // Truncate mode skips a malformed interim image instead of failing the paid result.
    }
  }
  if (images.length === 0) throw new Error("The model returned no generated images.");
  return { images, sizes, description, truncated };
}
