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
