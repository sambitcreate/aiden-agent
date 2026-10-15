import { nativeImage } from "../platform.js";
import { createProviderArtworkNormalizer } from "./provider-artwork-core.js";

const providerArtwork = createProviderArtworkNormalizer({
  fromPng: (bytes) => nativeImage.createFromBuffer(bytes, { scaleFactor: 1 }),
  fromSvgDataUrl: (dataUrl) => nativeImage.createFromDataURL(dataUrl),
});

export const normalizeProviderArtworkInput = providerArtwork.normalizeInput;

/** Persist only artwork that already matches the display contract, or re-encode it. */
export const persistableProviderArtwork = providerArtwork.persistable;
