import { nativeImage } from "../platform.js";
import {
  PROVIDER_ARTWORK_MAX_PNG_BYTES,
  type ProviderArtwork,
} from "../../renderer/shared/provider-artwork.js";
import { decodeProviderArtworkSource } from "./provider-artwork-core.js";
const TARGET_EDGE = 64;

export function normalizeProviderArtworkInput(value: unknown): ProviderArtwork {
  const source = decodeProviderArtworkSource(value);
  if (
    source.pixelSize &&
    (source.pixelSize.width > 8_192 || source.pixelSize.height > 8_192)
  ) {
    throw new Error("Provider artwork dimensions are invalid.");
  }
  const image = source.kind === "png"
    ? nativeImage.createFromBuffer(source.bytes, { scaleFactor: 1 })
    : nativeImage.createFromDataURL(
        `data:image/svg+xml;base64,${Buffer.from(source.safeSvg!, "utf8").toString("base64")}`,
      );
  if (image.isEmpty()) throw new Error("Aiden could not decode that provider icon.");
  const size = image.getSize();
  if (size.width <= 0 || size.height <= 0 || size.width > 8_192 || size.height > 8_192) {
    throw new Error("Provider artwork dimensions are invalid.");
  }
  const scale = Math.min(1, TARGET_EDGE / Math.max(size.width, size.height));
  const normalized = scale < 1
    ? image.resize({
        width: Math.max(1, Math.round(size.width * scale)),
        height: Math.max(1, Math.round(size.height * scale)),
        quality: "best",
      })
    : image;
  const png = normalized.toPNG();
  if (png.length === 0 || png.length > PROVIDER_ARTWORK_MAX_PNG_BYTES) {
    throw new Error("The normalized provider icon is too complex. Choose a simpler image.");
  }
  return { mimeType: "image/png", dataBase64: png.toString("base64") };
}
