import type { TranscriptImage } from "../../renderer/shared/transcript-images.js";
import { validateStudioImage } from "./studio-assets/image-validation-core.js";
import { fetchPublicBytes, normalizeWebFetchUrl, WebFetchError, type WebFetchOptions } from "./web-fetch-transport.js";

export const TRANSCRIPT_IMAGE_MAX_BYTES = 8 * 1024 * 1024;
const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/webp"]);

/** Strictly external URLs; never resolve a model's relative path against a local document. */
export function transcriptImageUrl(value: unknown): URL {
  if (typeof value !== "string" || !/^(?:https?:\/\/|\/\/)/iu.test(value)) {
    throw new Error("Only public HTTP and HTTPS image URLs can be loaded.");
  }
  return normalizeWebFetchUrl(value.startsWith("//") ? `https:${value}` : value);
}

/** No Chromium request, cookies, provider keys, or document referrer leave the renderer. */
export async function fetchTranscriptImage(value: unknown, options: WebFetchOptions = {}): Promise<TranscriptImage> {
  const url = transcriptImageUrl(value);
  try {
    const result = await fetchPublicBytes(url, {
      accept: "image/png,image/jpeg,image/webp",
      readableMediaType: (type) => IMAGE_TYPES.has(type),
    }, { ...options, maxBytes: Math.min(options.maxBytes ?? TRANSCRIPT_IMAGE_MAX_BYTES, TRANSCRIPT_IMAGE_MAX_BYTES) });
    if (result.truncated) throw new Error("This image is larger than the 8 MB limit.");
    const image = validateStudioImage(result.bytes, result.mediaType);
    return { mimeType: image.mediaType, width: image.width, height: image.height, data: result.bytes.toString("base64") };
  } catch (error) {
    if (error instanceof WebFetchError) {
      if (error.kind === "blocked-address") throw new Error("Images on this computer or a private network cannot be loaded.");
      if (error.kind === "unsupported-content") throw new Error("Only PNG, JPEG and WebP images can be loaded. GIF, BMP and SVG are not supported here.");
      throw new Error("This image could not be loaded. The site may be unavailable or redirecting to an unsupported address.");
    }
    throw error;
  }
}
