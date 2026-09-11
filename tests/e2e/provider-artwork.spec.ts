import { deflateSync } from "node:zlib";
import { expect, test } from "./fixtures";

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const PROVIDER_ID = "custom:e2e-retina-artwork";
type ProviderArtworkBridge = Window & {
  aidenAPI: {
    ipc: { invoke<T>(channel: string, ...args: unknown[]): Promise<T> };
  };
};

function crc32(value: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of value) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data = Buffer.alloc(0)): Buffer {
  const typeBytes = Buffer.from(type, "ascii");
  const result = Buffer.alloc(12 + data.length);
  result.writeUInt32BE(data.length, 0);
  typeBytes.copy(result, 4);
  data.copy(result, 8);
  result.writeUInt32BE(crc32(Buffer.concat([typeBytes, data])), 8 + data.length);
  return result;
}

function colorPng(width: number, height: number): Buffer {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 6;
  const pixels = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y += 1) {
    const row = y * (width * 4 + 1);
    pixels[row] = 0;
    for (let x = 0; x < width; x += 1) {
      const offset = row + 1 + x * 4;
      pixels[offset] = x < width / 2 ? 232 : 20;
      pixels[offset + 1] = y < height / 2 ? 70 : 170;
      pixels[offset + 2] = x < width / 2 ? 45 : 235;
      pixels[offset + 3] = 255;
    }
  }
  return Buffer.concat([
    PNG_SIGNATURE,
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(pixels)),
    chunk("IEND"),
  ]);
}

function pngDimensions(dataBase64: string): { width: number; height: number; bytes: number } {
  const png = Buffer.from(dataBase64, "base64");
  return {
    width: png.readUInt32BE(16),
    height: png.readUInt32BE(20),
    bytes: png.length,
  };
}

test.use({ portableConfigSeed: "empty" });

test("oversized Retina provider artwork survives native normalization and relaunch", async ({ aiden }) => {
  const source = colorPng(128, 128).toString("base64");
  const saved = await aiden.page.evaluate(
    async ({ providerId, dataBase64 }) => (window as unknown as ProviderArtworkBridge).aidenAPI.ipc.invoke<{
      artwork?: { mimeType: "image/png"; dataBase64: string };
    }>("providers:save", {
      id: providerId,
      kind: "openai",
      label: "Retina artwork test",
      artwork: { mimeType: "image/png", dataBase64 },
      baseUrl: "http://127.0.0.1:1234/v1",
      models: ["e2e-artwork-model"],
      needsKey: false,
    }),
    { providerId: PROVIDER_ID, dataBase64: source },
  );

  expect(saved.artwork).toBeDefined();
  expect(saved.artwork?.mimeType).toBe("image/png");
  const normalized = pngDimensions(saved.artwork!.dataBase64);
  expect(normalized.width).toBe(64);
  expect(normalized.height).toBe(64);
  expect(normalized.bytes).toBeLessThanOrEqual(32 * 1024);

  const decodedSize = await aiden.page.evaluate(async (dataBase64) => {
    const image = new Image();
    image.src = `data:image/png;base64,${dataBase64}`;
    await image.decode();
    return { width: image.naturalWidth, height: image.naturalHeight };
  }, saved.artwork!.dataBase64);
  expect(decodedSize).toEqual({ width: 64, height: 64 });

  const relaunched = await aiden.relaunch();
  const listed = await relaunched.evaluate(
    async (providerId) => {
      const providers = await (window as unknown as ProviderArtworkBridge).aidenAPI.ipc.invoke<Array<{
        id: string;
        artwork?: { mimeType: "image/png"; dataBase64: string };
      }>>("providers:list");
      return providers.find((provider) => provider.id === providerId);
    },
    PROVIDER_ID,
  );
  expect(listed?.artwork).toEqual(saved.artwork);
});
