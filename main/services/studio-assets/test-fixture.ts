// Test-only images. Aiden validates raster structure and header dimensions
// without decoding, so these need valid chunk layout but no real pixels.

export function pngBytes(width: number, height: number, seed = 0): Uint8Array {
  const chunk = (type: string, data: Buffer) => {
    const out = Buffer.alloc(12 + data.length);
    out.writeUInt32BE(data.length, 0);
    out.write(type, 4, "ascii");
    data.copy(out, 8);
    return out;
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 6;
  return new Uint8Array(
    Buffer.concat([
      Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
      chunk("IHDR", header),
      chunk("IDAT", Buffer.from([seed & 0xff, (seed >> 8) & 0xff])),
      chunk("IEND", Buffer.alloc(0)),
    ]),
  );
}

/** Minimal JPEG: SOI, one baseline SOF0 frame header, EOI. */
export function jpegBytes(width: number, height: number): Uint8Array {
  const frame = Buffer.alloc(13);
  frame.writeUInt16BE(11, 0); // segment length, including these two bytes
  frame[2] = 8; // sample precision
  frame.writeUInt16BE(height, 3);
  frame.writeUInt16BE(width, 5);
  frame[7] = 1; // one component: id, sampling factors, quantization table
  frame[8] = 1;
  frame[9] = 0x11;
  return new Uint8Array(
    Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xc0]), frame, Buffer.from([0xff, 0xd9])]),
  );
}

/** A RIFF/WEBP container holding exactly the given chunks (padded to even length). */
export function webpContainerBytes(chunks: Array<{ type: string; data: Buffer }>): Uint8Array {
  const body = Buffer.concat(
    chunks.map(({ type, data }) => {
      const header = Buffer.alloc(8);
      header.write(type, 0, "ascii");
      header.writeUInt32LE(data.length, 4);
      return Buffer.concat([header, data, Buffer.alloc(data.length & 1)]);
    }),
  );
  const riff = Buffer.alloc(12);
  riff.write("RIFF", 0, "ascii");
  riff.writeUInt32LE(4 + body.length, 4);
  riff.write("WEBP", 8, "ascii");
  return new Uint8Array(Buffer.concat([riff, body]));
}

/** Minimal lossless (VP8L) or lossy (VP8) WebP carrying only the header dimensions. */
export function webpBytes(width: number, height: number, format: "VP8L" | "VP8" = "VP8L"): Uint8Array {
  if (format === "VP8L") {
    const data = Buffer.alloc(6);
    data[0] = 0x2f;
    data.writeUInt32LE(((width - 1) & 0x3fff) | (((height - 1) & 0x3fff) << 14), 1);
    return webpContainerBytes([{ type: "VP8L", data }]);
  }
  const data = Buffer.alloc(10);
  data.set([0x9d, 0x01, 0x2a], 3);
  data.writeUInt16LE(width, 6);
  data.writeUInt16LE(height, 8);
  return webpContainerBytes([{ type: "VP8 ", data }]);
}

export function fakeThumbnailer() {
  const calls: number[] = [];
  let failures = 0;
  return {
    calls,
    failNext() {
      failures += 1;
    },
    thumbnailer: {
      async render({ edge }: { bytes: Uint8Array; edge: 256 | 512 }) {
        calls.push(edge);
        if (failures > 0) {
          failures -= 1;
          throw new Error("decode failed");
        }
        return { bytes: pngBytes(edge, edge, 7), width: edge, height: edge };
      },
    },
  };
}
