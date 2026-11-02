// Pixel dimensions read from the header of a base64 raster image, so the
// transcript can reserve an image's box before it decodes (no layout shift
// while scrolling a long history). Only a bounded prefix is decoded.

export interface ImagePixelSize {
  width: number;
  height: number;
}

/** JPEG metadata can precede the frame header; scan at most this many bytes. */
const MAX_HEADER_BYTES = 64 * 1024;
const MAX_SIDE = 65_535;

function prefixBytes(base64: string, byteCount: number): Uint8Array | undefined {
  const chars = Math.min(base64.length, Math.ceil(byteCount / 3) * 4);
  try {
    const binary = atob(base64.slice(0, chars - (chars % 4)));
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    return bytes;
  } catch {
    return undefined;
  }
}

const u16be = (b: Uint8Array, o: number) => (b[o]! << 8) | b[o + 1]!;
const u16le = (b: Uint8Array, o: number) => b[o]! | (b[o + 1]! << 8);
const u24le = (b: Uint8Array, o: number) => b[o]! | (b[o + 1]! << 8) | (b[o + 2]! << 16);
const u32be = (b: Uint8Array, o: number) => ((b[o]! << 24) >>> 0) + ((b[o + 1]! << 16) | (b[o + 2]! << 8) | b[o + 3]!);

function png(b: Uint8Array): ImagePixelSize | undefined {
  if (b.length < 24 || b[0] !== 0x89 || b[1] !== 0x50 || b[12] !== 0x49 || b[15] !== 0x52) return undefined;
  return { width: u32be(b, 16), height: u32be(b, 20) };
}

function gif(b: Uint8Array): ImagePixelSize | undefined {
  if (b.length < 10 || b[0] !== 0x47 || b[1] !== 0x49 || b[2] !== 0x46) return undefined;
  return { width: u16le(b, 6), height: u16le(b, 8) };
}

function bmp(b: Uint8Array): ImagePixelSize | undefined {
  if (b.length < 26 || b[0] !== 0x42 || b[1] !== 0x4d) return undefined;
  const view = new DataView(b.buffer, b.byteOffset, b.byteLength);
  return { width: Math.abs(view.getInt32(18, true)), height: Math.abs(view.getInt32(22, true)) };
}

function webp(b: Uint8Array): ImagePixelSize | undefined {
  if (b.length < 30 || String.fromCharCode(...b.subarray(0, 4)) !== "RIFF" || String.fromCharCode(...b.subarray(8, 12)) !== "WEBP")
    return undefined;
  const chunk = String.fromCharCode(...b.subarray(12, 16));
  if (chunk === "VP8 ") return { width: u16le(b, 26) & 0x3fff, height: u16le(b, 28) & 0x3fff };
  if (chunk === "VP8L") {
    const bits = b[21]! | (b[22]! << 8) | (b[23]! << 16) | (b[24]! << 24);
    return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
  }
  if (chunk === "VP8X") return { width: u24le(b, 24) + 1, height: u24le(b, 27) + 1 };
  return undefined;
}

function jpeg(b: Uint8Array): ImagePixelSize | undefined {
  if (b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8) return undefined;
  let offset = 2;
  while (offset + 9 < b.length) {
    if (b[offset] !== 0xff) return undefined;
    const marker = b[offset + 1]!;
    if (marker === 0xff) {
      offset += 1;
      continue;
    }
    const length = u16be(b, offset + 2);
    // SOF0–SOF15 except DHT (C4), JPG (C8) and DAC (CC).
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { width: u16be(b, offset + 7), height: u16be(b, offset + 5) };
    }
    if (length < 2) return undefined;
    offset += 2 + length;
  }
  return undefined;
}

/** Undefined when the header is unreadable or the mime type has no reader here. */
export function imagePixelSize(mimeType: string, base64: string): ImagePixelSize | undefined {
  const reader =
    mimeType === "image/png" ? png
    : mimeType === "image/gif" ? gif
    : mimeType === "image/webp" ? webp
    : mimeType === "image/bmp" ? bmp
    : mimeType === "image/jpeg" ? jpeg
    : undefined;
  if (!reader) return undefined;
  const bytes = prefixBytes(base64, mimeType === "image/jpeg" ? MAX_HEADER_BYTES : 64);
  const size = bytes ? reader(bytes) : undefined;
  if (!size) return undefined;
  const valid = (side: number) => Number.isInteger(side) && side > 0 && side <= MAX_SIDE;
  return valid(size.width) && valid(size.height) ? size : undefined;
}
