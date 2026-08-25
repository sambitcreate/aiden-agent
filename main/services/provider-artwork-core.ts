export const PROVIDER_ARTWORK_MAX_SOURCE_BYTES = 512 * 1024;

export function decodeProviderArtworkSource(value: unknown): {
  bytes: Buffer;
  kind: "png" | "svg";
  safeSvg?: string;
  pixelSize?: { width: number; height: number };
} {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Choose a PNG or SVG provider icon.");
  }
  const record = value as Record<string, unknown>;
  const name = typeof record.name === "string" ? record.name.toLowerCase() : "";
  const dataBase64 = typeof record.dataBase64 === "string" ? record.dataBase64 : "";
  if (!dataBase64 || dataBase64.length > Math.ceil(PROVIDER_ARTWORK_MAX_SOURCE_BYTES / 3) * 4 + 4) {
    throw new Error("Provider artwork must be 512 KB or smaller.");
  }
  if (dataBase64.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/u.test(dataBase64)) {
    throw new Error("Choose a valid .png or .svg file.");
  }
  const bytes = Buffer.from(dataBase64, "base64");
  if (bytes.length === 0 || bytes.length > PROVIDER_ARTWORK_MAX_SOURCE_BYTES) {
    throw new Error("Provider artwork must be 512 KB or smaller.");
  }
  if (
    name.endsWith(".png") &&
    bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  ) {
    if (bytes.length < 24 || bytes.subarray(12, 16).toString("ascii") !== "IHDR") {
      throw new Error("The PNG file is invalid.");
    }
    const width = bytes.readUInt32BE(16);
    const height = bytes.readUInt32BE(20);
    if (width === 0 || height === 0 || width > 8_192 || height > 8_192) {
      throw new Error("Provider artwork dimensions are invalid.");
    }
    return { bytes, kind: "png", pixelSize: { width, height } };
  }
  if (!name.endsWith(".svg")) throw new Error("Choose a valid .png or .svg file.");
  const source = bytes.toString("utf8").trim();
  if (source.includes("\uFFFD") || !/<svg(?:\s|>)/iu.test(source)) {
    throw new Error("The SVG file is invalid.");
  }
  if (
    /<!DOCTYPE|<!ENTITY|<\?xml-stylesheet|<script|<foreignObject|<iframe|<object|<embed|<image|<use|\bon[a-z]+\s*=|\b(?:href|xlink:href)\s*=|\burl\s*\(|@import\b/iu.test(source)
  ) {
    throw new Error("SVG provider icons cannot contain scripts or external resources.");
  }
  return { bytes, kind: "svg", safeSvg: source };
}
