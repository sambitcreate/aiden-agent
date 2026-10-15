import { nativeImage } from "../../platform.js";
import type { StudioAssetThumbnailer } from "./store.js";

/** Chromium decode, longest-edge resize, PNG re-encode. Failures fall back to the original in the store. */
export function createNativeStudioThumbnailer(): StudioAssetThumbnailer {
  return {
    async render({ bytes, edge }) {
      if (!nativeImage || typeof nativeImage.createFromBuffer !== "function") {
        throw new Error("Image decoding is unavailable.");
      }
      const decoded = nativeImage.createFromBuffer(
        Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength),
        { scaleFactor: 1 },
      );
      if (decoded.isEmpty()) throw new Error("The image could not be decoded.");
      const size = decoded.getSize(1);
      const scale = Math.min(1, edge / Math.max(size.width, size.height));
      const width = Math.max(1, Math.round(size.width * scale));
      const height = Math.max(1, Math.round(size.height * scale));
      const resized = decoded.resize({ width, height, quality: "good" });
      if (resized.isEmpty()) throw new Error("The image could not be resized.");
      return { bytes: resized.toPNG({ scaleFactor: 1 }), width, height };
    },
  };
}
