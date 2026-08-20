import { ipcRenderer } from "electron";

const DECODER_CHANNEL = "create-images:image-decoder-port";

interface DecoderRequest {
  id: string;
  operation: "normalize" | "thumbnail" | "validate";
  bytes: Uint8Array;
  maxDimension?: number;
  maxWidth?: number;
  maxHeight?: number;
  maxPixels?: number;
  maxOutputBytes?: number;
}

function boundedInteger(value: unknown, maximum: number): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 1 && (value as number) <= maximum;
}

function validOperationDetails(request: Partial<DecoderRequest>): boolean {
  if (request.operation === "validate") return true;
  if (request.operation === "thumbnail") {
    return (
      boundedInteger(request.maxDimension, 4_096) &&
      boundedInteger(request.maxOutputBytes, 64 * 1024 * 1024)
    );
  }
  if (request.operation !== "normalize") return false;
  return (
    boundedInteger(request.maxWidth, 32_768) &&
    boundedInteger(request.maxHeight, 32_768) &&
    boundedInteger(request.maxPixels, 64_000_000) &&
    boundedInteger(request.maxOutputBytes, 64 * 1024 * 1024)
  );
}

function validRequest(value: unknown): value is DecoderRequest {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const request = value as Partial<DecoderRequest>;
  return (
    typeof request.id === "string" &&
    /^[A-Za-z0-9_-]{16,128}$/u.test(request.id) &&
    request.bytes instanceof Uint8Array &&
    request.bytes.byteLength >= 1 &&
    request.bytes.byteLength <= 64 * 1024 * 1024 &&
    validOperationDetails(request)
  );
}

async function decode(request: DecoderRequest) {
  const input = new Uint8Array(request.bytes.byteLength);
  input.set(request.bytes);
  const blob = new Blob([input.buffer]);
  const bitmap = await createImageBitmap(blob);
  try {
    if (request.operation === "validate") {
      return { id: request.id, ok: true, width: bitmap.width, height: bitmap.height };
    }
    if (
      request.operation === "normalize" &&
      (bitmap.width > request.maxWidth! ||
        bitmap.height > request.maxHeight! ||
        bitmap.width * bitmap.height > request.maxPixels!)
    ) {
      throw new Error("Image dimensions exceed the import limit.");
    }
    const scale =
      request.operation === "normalize"
        ? 1
        : Math.min(1, request.maxDimension! / Math.max(bitmap.width, bitmap.height));
    const width = Math.max(1, Math.round(bitmap.width * scale));
    const height = Math.max(1, Math.round(bitmap.height * scale));
    const canvas = new OffscreenCanvas(width, height);
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Canvas unavailable.");
    context.drawImage(bitmap, 0, 0, width, height);
    const output = await canvas.convertToBlob({ type: "image/png" });
    if (output.size < 1 || output.size > request.maxOutputBytes!) {
      throw new Error("Thumbnail exceeds its limit.");
    }
    return {
      id: request.id,
      ok: true,
      width,
      height,
      bytes: new Uint8Array(await output.arrayBuffer()),
    };
  } finally {
    bitmap.close();
  }
}

ipcRenderer.once(DECODER_CHANNEL, (event) => {
  const port = event.ports[0];
  if (!port) return;
  port.onmessage = (message) => {
    if (!validRequest(message.data)) return;
    void decode(message.data)
      .then((result) => port.postMessage(result))
      .catch(() => port.postMessage({ id: message.data.id, ok: false }));
  };
  port.start();
});
