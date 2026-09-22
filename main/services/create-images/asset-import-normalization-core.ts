import path from "node:path";

export type CreateImagesImportSourcePolicy =
  | { kind: "canonical"; format: "jpeg" | "png" }
  | { kind: "normalize"; format: string }
  | { kind: "reject"; reason: "animated" | "vector" };

function ascii(bytes: Uint8Array, start: number, end: number): string {
  return String.fromCharCode(...bytes.subarray(start, Math.min(end, bytes.byteLength)));
}

function littleEndianU32(bytes: Uint8Array, offset: number): number {
  return (
    bytes[offset]! +
    bytes[offset + 1]! * 0x100 +
    bytes[offset + 2]! * 0x1_0000 +
    bytes[offset + 3]! * 0x1_000_000
  );
}

function animatedWebp(bytes: Uint8Array): boolean {
  let offset = 12;
  let chunks = 0;
  while (offset + 8 <= bytes.byteLength && chunks < 10_000) {
    const type = ascii(bytes, offset, offset + 4);
    const length = littleEndianU32(bytes, offset + 4);
    if (!Number.isSafeInteger(length)) return false;
    if (type === "ANIM" || type === "ANMF") return true;
    const next = offset + 8 + length + (length % 2);
    if (!Number.isSafeInteger(next) || next <= offset || next > bytes.byteLength) return false;
    offset = next;
    chunks += 1;
  }
  return false;
}

function skipGifSubBlocks(bytes: Uint8Array, start: number): number | undefined {
  let offset = start;
  let blocks = 0;
  while (offset < bytes.byteLength && blocks < 100_000) {
    const length = bytes[offset]!;
    offset += 1;
    if (length === 0) return offset;
    if (offset + length > bytes.byteLength) return undefined;
    offset += length;
    blocks += 1;
  }
  return undefined;
}

/** Return true only when a structurally-walkable GIF contains multiple frames. */
function animatedGif(bytes: Uint8Array): boolean {
  if (bytes.byteLength < 13) return false;
  let offset = 13;
  const globalColorTable = (bytes[10]! & 0x80) !== 0;
  if (globalColorTable) offset += 3 * 2 ** ((bytes[10]! & 0x07) + 1);
  let frames = 0;
  let blocks = 0;
  while (offset < bytes.byteLength && blocks < 100_000) {
    const marker = bytes[offset]!;
    offset += 1;
    if (marker === 0x3b) return false;
    if (marker === 0x21) {
      if (offset >= bytes.byteLength) return false;
      offset += 1;
      const next = skipGifSubBlocks(bytes, offset);
      if (next === undefined) return false;
      offset = next;
    } else if (marker === 0x2c) {
      if (offset + 9 > bytes.byteLength) return false;
      const localColorTable = (bytes[offset + 8]! & 0x80) !== 0;
      const localColorTableBytes = localColorTable ? 3 * 2 ** ((bytes[offset + 8]! & 0x07) + 1) : 0;
      offset += 9 + localColorTableBytes;
      if (offset >= bytes.byteLength) return false;
      offset += 1;
      const next = skipGifSubBlocks(bytes, offset);
      if (next === undefined) return false;
      offset = next;
      frames += 1;
      if (frames > 1) return true;
    } else {
      return false;
    }
    blocks += 1;
  }
  return false;
}

function looksLikeSvg(bytes: Uint8Array): boolean {
  const prefix = new TextDecoder("utf-8", { fatal: false, ignoreBOM: true })
    .decode(bytes.subarray(0, Math.min(bytes.byteLength, 16 * 1024)))
    .toLowerCase();
  return /<svg(?:\s|>)/u.test(prefix);
}

function extension(value: string | undefined): string {
  return value ? path.extname(value).slice(1).toLowerCase() : "";
}

/**
 * Classify only policy-sensitive formats. The disposable Chromium decoder is
 * the authority for whether every other static raster can actually be decoded.
 */
export function createImagesImportSourcePolicy(
  bytes: Uint8Array,
  displayName?: string,
): CreateImagesImportSourcePolicy {
  const fileExtension = extension(displayName);
  if (fileExtension === "svg" || fileExtension === "svgz" || looksLikeSvg(bytes)) {
    return { kind: "reject", reason: "vector" };
  }
  if (ascii(bytes, 0, 6) === "GIF87a" || ascii(bytes, 0, 6) === "GIF89a") {
    return animatedGif(bytes)
      ? { kind: "reject", reason: "animated" }
      : { kind: "normalize", format: "gif" };
  }
  if (fileExtension === "gif") {
    return { kind: "normalize", format: "gif" };
  }
  if (
    bytes.byteLength >= 8 &&
    bytes[0] === 0x89 &&
    ascii(bytes, 1, 4) === "PNG" &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  ) {
    return { kind: "canonical", format: "png" };
  }
  if (bytes[0] === 0xff && bytes[1] === 0xd8) {
    return { kind: "canonical", format: "jpeg" };
  }
  if (bytes.byteLength >= 12 && ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 12) === "WEBP") {
    return animatedWebp(bytes)
      ? { kind: "reject", reason: "animated" }
      : { kind: "normalize", format: "webp" };
  }
  if (bytes.byteLength >= 12 && ascii(bytes, 4, 8) === "ftyp") {
    const brand = ascii(bytes, 8, 12).toLowerCase();
    if (["avis", "hevc", "hevx", "msf1"].includes(brand)) {
      return { kind: "reject", reason: "animated" };
    }
    return { kind: "normalize", format: brand || "isobmff" };
  }
  if (bytes[0] === 0x42 && bytes[1] === 0x4d) {
    return { kind: "normalize", format: "bmp" };
  }
  if (bytes[0] === 0 && bytes[1] === 0 && bytes[2] === 1 && bytes[3] === 0) {
    return { kind: "normalize", format: "ico" };
  }
  if (ascii(bytes, 0, 4) === "II*\0" || ascii(bytes, 0, 4) === "MM\0*") {
    return { kind: "normalize", format: "tiff" };
  }
  return { kind: "normalize", format: fileExtension || "unknown" };
}

export function createImagesCanonicalValidationName(
  displayName: string | undefined,
  extension: "jpg" | "png",
): string {
  const base = path.basename((displayName || "image").replace(/\\/gu, "/"));
  const parsed = path.parse(base);
  const stem = (parsed.name || "image").slice(0, 239 - extension.length);
  return `${stem}.${extension}`;
}
