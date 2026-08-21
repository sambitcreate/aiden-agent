import { ipcRenderer } from "electron";
import type { CreateImagesAnnotationShape } from "./shared/create-images/schema.js";

const DECODER_CHANNEL = "create-images:image-decoder-port";

interface DecoderRequest {
  id: string;
  operation: "normalize" | "thumbnail" | "validate" | "annotate";
  bytes: Uint8Array;
  maxDimension?: number;
  maxWidth?: number;
  maxHeight?: number;
  maxPixels?: number;
  maxOutputBytes?: number;
  shapes?: CreateImagesAnnotationShape[];
}

function boundedInteger(value: unknown, maximum: number): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 1 && (value as number) <= maximum;
}

function validOperationDetails(request: Partial<DecoderRequest>): boolean {
  if (request.operation === "validate") return true;
  if (request.operation === "annotate") {
    return (
      boundedInteger(request.maxPixels, 64_000_000) &&
      boundedInteger(request.maxOutputBytes, 64 * 1024 * 1024) &&
      Array.isArray(request.shapes) &&
      request.shapes.length <= 256 &&
      request.shapes.every(
        (shape) =>
          typeof shape === "object" &&
          shape !== null &&
          typeof shape.id === "string" &&
          /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u.test(shape.id) &&
          ["rectangle", "ellipse", "arrow", "freehand", "text"].includes(shape.type) &&
          Number.isFinite(shape.x) &&
          Number.isFinite(shape.y) &&
          Number.isFinite(shape.strokeWidth),
      )
    );
  }
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

const ANNOTATION_COLORS: Readonly<Record<string, string>> = Object.freeze({
  accent: "#1677ff",
  red: "#e5484d",
  green: "#30a46c",
  yellow: "#f5d90a",
  white: "#ffffff",
  black: "#111111",
});

function drawAnnotationShape(
  context: OffscreenCanvasRenderingContext2D,
  shape: CreateImagesAnnotationShape,
  width: number,
  height: number,
): void {
  const scale = Math.max(0.25, Math.min(width, height) / 1_024);
  const offsetX = shape.x * width;
  const offsetY = shape.y * height;
  context.save();
  context.strokeStyle = ANNOTATION_COLORS[shape.stroke] ?? ANNOTATION_COLORS.accent!;
  context.fillStyle = "transparent";
  context.lineWidth = Math.max(0.5, shape.strokeWidth * scale);
  context.lineCap = "round";
  context.lineJoin = "round";
  if (shape.type === "rectangle") {
    if (shape.fill) context.fillStyle = ANNOTATION_COLORS[shape.fill] ?? "transparent";
    if (shape.fill) context.fillRect(offsetX, offsetY, shape.width * width, shape.height * height);
    context.strokeRect(offsetX, offsetY, shape.width * width, shape.height * height);
  } else if (shape.type === "ellipse") {
    context.beginPath();
    context.ellipse(
      offsetX + (shape.width * width) / 2,
      offsetY + (shape.height * height) / 2,
      Math.abs(shape.width * width) / 2,
      Math.abs(shape.height * height) / 2,
      0,
      0,
      Math.PI * 2,
    );
    if (shape.fill) {
      context.fillStyle = ANNOTATION_COLORS[shape.fill] ?? "transparent";
      context.fill();
    }
    context.stroke();
  } else if (shape.type === "text") {
    context.fillStyle = ANNOTATION_COLORS[shape.stroke] ?? ANNOTATION_COLORS.accent!;
    context.font = `${Math.max(8, shape.fontSize * scale)}px -apple-system, BlinkMacSystemFont, sans-serif`;
    context.textBaseline = "top";
    context.fillText(shape.text, offsetX, offsetY, width);
  } else {
    const points = shape.points;
    context.beginPath();
    context.moveTo(offsetX + points[0]! * width, offsetY + points[1]! * height);
    for (let index = 2; index < points.length; index += 2) {
      context.lineTo(offsetX + points[index]! * width, offsetY + points[index + 1]! * height);
    }
    context.stroke();
    if (shape.type === "arrow") {
      const endX = offsetX + points[2]! * width;
      const endY = offsetY + points[3]! * height;
      const startX = offsetX + points[0]! * width;
      const startY = offsetY + points[1]! * height;
      const angle = Math.atan2(endY - startY, endX - startX);
      const head = Math.max(8, context.lineWidth * 4);
      context.beginPath();
      context.moveTo(endX, endY);
      context.lineTo(endX - head * Math.cos(angle - Math.PI / 6), endY - head * Math.sin(angle - Math.PI / 6));
      context.moveTo(endX, endY);
      context.lineTo(endX - head * Math.cos(angle + Math.PI / 6), endY - head * Math.sin(angle + Math.PI / 6));
      context.stroke();
    }
  }
  context.restore();
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
      request.operation === "annotate" &&
      bitmap.width * bitmap.height > request.maxPixels!
    ) {
      throw new Error("Annotation source dimensions exceed the pixel limit.");
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
      request.operation === "normalize" || request.operation === "annotate"
        ? 1
        : Math.min(1, request.maxDimension! / Math.max(bitmap.width, bitmap.height));
    const width = Math.max(1, Math.round(bitmap.width * scale));
    const height = Math.max(1, Math.round(bitmap.height * scale));
    const canvas = new OffscreenCanvas(width, height);
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Canvas unavailable.");
    context.drawImage(bitmap, 0, 0, width, height);
    if (request.operation === "annotate") {
      for (const shape of request.shapes!) drawAnnotationShape(context, shape, width, height);
    }
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
