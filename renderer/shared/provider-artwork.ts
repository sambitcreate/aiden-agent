export const PROVIDER_ARTWORK_MAX_PNG_BYTES = 32 * 1024;

export interface ProviderArtwork {
  mimeType: "image/png";
  dataBase64: string;
}

export function normalizeProviderArtwork(value: unknown): ProviderArtwork | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (record.mimeType !== "image/png" || typeof record.dataBase64 !== "string") {
    return undefined;
  }
  if (
    record.dataBase64.length === 0 ||
    record.dataBase64.length > Math.ceil(PROVIDER_ARTWORK_MAX_PNG_BYTES / 3) * 4 + 4 ||
    !record.dataBase64.startsWith("iVBORw0KGgo") ||
    !/^[A-Za-z0-9+/]+={0,2}$/u.test(record.dataBase64)
  ) {
    return undefined;
  }
  const decodedBytes = Math.floor((record.dataBase64.length * 3) / 4) -
    (record.dataBase64.endsWith("==") ? 2 : record.dataBase64.endsWith("=") ? 1 : 0);
  if (decodedBytes <= 0 || decodedBytes > PROVIDER_ARTWORK_MAX_PNG_BYTES) return undefined;
  try {
    const decoded = atob(record.dataBase64);
    if (
      decoded.length < 24 ||
      decoded.slice(0, 8) !== "\u0089PNG\r\n\u001a\n" ||
      decoded.slice(12, 16) !== "IHDR"
    ) {
      return undefined;
    }
    const dimension = (offset: number) =>
      ((decoded.charCodeAt(offset) << 24) >>> 0) +
      (decoded.charCodeAt(offset + 1) << 16) +
      (decoded.charCodeAt(offset + 2) << 8) +
      decoded.charCodeAt(offset + 3);
    const width = dimension(16);
    const height = dimension(20);
    if (width === 0 || height === 0 || width > 64 || height > 64) return undefined;
  } catch {
    return undefined;
  }
  return { mimeType: "image/png", dataBase64: record.dataBase64 };
}

export function providerArtworkDataUrl(artwork: ProviderArtwork): string {
  return `data:${artwork.mimeType};base64,${artwork.dataBase64}`;
}
