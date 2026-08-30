import { createHash, randomUUID } from "node:crypto";
import { realpathSync, statSync } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import { Type } from "@earendil-works/pi-ai";
import type { ChatImageArtifactV1 } from "../../renderer/shared/chat-artifacts.js";
import { CHAT_ARTIFACT_VERSION } from "../../renderer/shared/chat-artifacts.js";
import { MAX_ATTACHMENTS_PER_MESSAGE } from "../../renderer/shared/attachment-contract.js";
import { isImageAttachmentPath, readPickedAttachments } from "./attachments.js";
import type { PiAgentRuntimeExtension } from "./pi-agent-runtime-harness.js";
import { declarePiRuntimeReplay } from "./pi-runtime-tool.js";

export const DISPLAY_IMAGE_EXTENSION_ID = "aiden.gui.display-image";
export const DISPLAY_IMAGE_TOOL_NAME = "display_image";
export const MAX_DISPLAY_IMAGE_DIMENSION = 16_384;
export const MAX_DISPLAY_IMAGE_PIXELS = 20_000_000;
export const MAX_DISPLAY_IMAGE_PIXELS_PER_RESPONSE = 40_000_000;
export const MAX_DISPLAY_IMAGE_PIXELS_PER_CHAT = 64_000_000;
export const MAX_DISPLAY_IMAGE_BYTES_PER_RESPONSE = 8 * 1024 * 1024;
export const MAX_DISPLAY_IMAGE_BYTES_PER_CHAT = 32 * 1024 * 1024;
export const MAX_DISPLAY_IMAGES_PER_CHAT = 100;

const WINDOWS_ABSOLUTE_PATH = /^[a-z]:[\\/]/iu;
const DISPLAY_IMAGE_MIME_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "image/bmp",
]);

export interface DisplayImageExtensionOptions {
  workspaceRoot: string;
  /** Stable only for this generation; combined with the Pi call id for artifact identity. */
  artifactNamespace?: string;
  existingChatImageBytes?: number;
  existingChatImageCount?: number;
  existingChatImagePixels?: number;
  onArtifact: (
    artifact: ChatImageArtifactV1,
    presentation: Readonly<ImageDimensions>,
  ) => boolean | void | Promise<boolean | void>;
  /** Test seam for deterministic cancellation immediately before presentation. */
  beforeArtifact?: () => void | Promise<void>;
}

export interface DisplayImageExtensionRuntime {
  extension: PiAgentRuntimeExtension;
}

interface ImageDimensions {
  width: number;
  height: number;
}

export interface DisplayImageExtensionScope {
  usageSource?: string;
  interactionSurface?: string;
  assistantMode: boolean;
  workspaceRoot?: string;
  permission: string;
  excluded: boolean;
}

/** Keep the GUI tool on ordinary attended workspace chat only. */
export function shouldEnableDisplayImageExtension(scope: DisplayImageExtensionScope): boolean {
  return (
    scope.usageSource === "chat" &&
    scope.interactionSurface !== "telegram" &&
    !scope.assistantMode &&
    Boolean(scope.workspaceRoot) &&
    scope.permission !== "none" &&
    !scope.excluded
  );
}

export function displayedAssistantImageUsage(
  messages: readonly {
    role: string;
    attachments?: readonly {
      kind: string;
      size: number;
      mimeType?: string;
      data?: string;
    }[];
  }[],
): { bytes: number; count: number; pixels: number } {
  let bytes = 0;
  let count = 0;
  let pixels = 0;
  for (const message of messages) {
    if (message.role !== "assistant") continue;
    for (const attachment of message.attachments ?? []) {
      if (
        attachment.kind !== "image" ||
        !Number.isSafeInteger(attachment.size) ||
        attachment.size < 1
      ) {
        continue;
      }
      bytes = Math.min(Number.MAX_SAFE_INTEGER, bytes + attachment.size);
      count += 1;
      let decodedPixels = MAX_DISPLAY_IMAGE_PIXELS;
      if (typeof attachment.data === "string" && typeof attachment.mimeType === "string") {
        const dimensions = displayImageDimensions(
          Buffer.from(attachment.data, "base64"),
          attachment.mimeType,
        );
        if (dimensions) {
          const measured = dimensions.width * dimensions.height;
          decodedPixels = Number.isSafeInteger(measured)
            ? Math.min(measured, MAX_DISPLAY_IMAGE_PIXELS_PER_CHAT)
            : MAX_DISPLAY_IMAGE_PIXELS_PER_CHAT;
        }
      }
      pixels = Math.min(MAX_DISPLAY_IMAGE_PIXELS_PER_CHAT, pixels + decodedPixels);
    }
  }
  return { bytes, count, pixels };
}

function uint24LE(bytes: Buffer, offset: number): number {
  return bytes[offset]! | (bytes[offset + 1]! << 8) | (bytes[offset + 2]! << 16);
}

function skipGifSubBlocks(bytes: Buffer, start: number): number | undefined {
  let offset = start;
  while (offset < bytes.length) {
    const size = bytes[offset]!;
    offset += 1;
    if (size === 0) return offset;
    if (offset + size > bytes.length) return undefined;
    offset += size;
  }
  return undefined;
}

function isSingleFrameGif(bytes: Buffer): boolean {
  if (bytes.length < 14 || bytes[bytes.length - 1] !== 0x3b) return false;
  const canvasWidth = bytes.readUInt16LE(6);
  const canvasHeight = bytes.readUInt16LE(8);
  if (canvasWidth < 1 || canvasHeight < 1) return false;
  const packed = bytes[10]!;
  let offset = 13;
  if ((packed & 0x80) !== 0) offset += 3 * 2 ** ((packed & 0x07) + 1);
  let frames = 0;
  while (offset < bytes.length) {
    const marker = bytes[offset++]!;
    if (marker === 0x3b) return frames === 1 && offset === bytes.length;
    if (marker === 0x21) {
      if (offset >= bytes.length) return false;
      offset += 1;
      const next = skipGifSubBlocks(bytes, offset);
      if (next === undefined) return false;
      offset = next;
      continue;
    }
    if (marker !== 0x2c || offset + 9 > bytes.length) return false;
    frames += 1;
    if (frames > 1) return false;
    const left = bytes.readUInt16LE(offset);
    const top = bytes.readUInt16LE(offset + 2);
    const width = bytes.readUInt16LE(offset + 4);
    const height = bytes.readUInt16LE(offset + 6);
    if (width < 1 || height < 1 || left + width > canvasWidth || top + height > canvasHeight) {
      return false;
    }
    const imagePacked = bytes[offset + 8]!;
    offset += 9;
    if ((imagePacked & 0x80) !== 0) offset += 3 * 2 ** ((imagePacked & 0x07) + 1);
    if (offset >= bytes.length) return false;
    offset += 1;
    const next = skipGifSubBlocks(bytes, offset);
    if (next === undefined) return false;
    offset = next;
  }
  return false;
}

function hasValidPngStructure(bytes: Buffer): boolean {
  let offset = 8;
  let sawHeader = false;
  let sawData = false;
  while (offset + 12 <= bytes.length) {
    const length = bytes.readUInt32BE(offset);
    const end = offset + 12 + length;
    if (end > bytes.length) return false;
    const type = bytes.toString("ascii", offset + 4, offset + 8);
    if (type === "acTL" || type === "fcTL" || type === "fdAT") return false;
    if (!sawHeader) {
      if (type !== "IHDR" || length !== 13) return false;
      sawHeader = true;
    } else if (type === "IHDR") {
      return false;
    }
    if (type === "IDAT") sawData = true;
    if (type === "IEND") return length === 0 && sawData && end === bytes.length;
    offset = end;
  }
  return false;
}

function webpChunkDimensions(
  bytes: Buffer,
  type: string,
  payloadOffset: number,
  length: number,
): ImageDimensions | undefined {
  if (type === "VP8L" && length >= 5 && bytes[payloadOffset] === 0x2f) {
    const packed = bytes.readUInt32LE(payloadOffset + 1);
    return {
      width: (packed & 0x3fff) + 1,
      height: ((packed >>> 14) & 0x3fff) + 1,
    };
  }
  if (
    type === "VP8 " &&
    length >= 10 &&
    bytes[payloadOffset + 3] === 0x9d &&
    bytes[payloadOffset + 4] === 0x01 &&
    bytes[payloadOffset + 5] === 0x2a
  ) {
    return {
      width: bytes.readUInt16LE(payloadOffset + 6) & 0x3fff,
      height: bytes.readUInt16LE(payloadOffset + 8) & 0x3fff,
    };
  }
  return undefined;
}

function inspectWebp(bytes: Buffer): ImageDimensions | undefined {
  if (
    bytes.length < 20 ||
    bytes.toString("ascii", 0, 4) !== "RIFF" ||
    bytes.toString("ascii", 8, 12) !== "WEBP" ||
    bytes.readUInt32LE(4) + 8 !== bytes.length
  ) {
    return undefined;
  }
  let offset = 12;
  let canvas: ImageDimensions | undefined;
  let image: ImageDimensions | undefined;
  while (offset + 8 <= bytes.length) {
    const type = bytes.toString("ascii", offset, offset + 4);
    const length = bytes.readUInt32LE(offset + 4);
    const payloadOffset = offset + 8;
    const end = payloadOffset + length;
    const paddedEnd = end + (length & 1);
    if (end > bytes.length || paddedEnd > bytes.length) return undefined;
    if (type === "ANIM" || type === "ANMF") return undefined;
    if (type === "VP8X") {
      if (canvas || length !== 10 || (bytes[payloadOffset]! & 0x02) !== 0) return undefined;
      canvas = {
        width: uint24LE(bytes, payloadOffset + 4) + 1,
        height: uint24LE(bytes, payloadOffset + 7) + 1,
      };
    }
    if (type === "VP8 " || type === "VP8L") {
      if (image) return undefined;
      image = webpChunkDimensions(bytes, type, payloadOffset, length);
      if (!image) return undefined;
    }
    offset = paddedEnd;
  }
  if (offset !== bytes.length || !image) return undefined;
  if (canvas && (canvas.width !== image.width || canvas.height !== image.height)) {
    return undefined;
  }
  return canvas ?? image;
}

function hasValidWebpStructure(bytes: Buffer): boolean {
  return inspectWebp(bytes) !== undefined;
}

function hasValidRasterStructure(bytes: Buffer, mimeType: string): boolean {
  if (mimeType === "image/png") return hasValidPngStructure(bytes);
  if (mimeType === "image/jpeg") {
    return (
      bytes.length >= 4 && bytes[bytes.length - 2] === 0xff && bytes[bytes.length - 1] === 0xd9
    );
  }
  if (mimeType === "image/gif") return isSingleFrameGif(bytes);
  if (mimeType === "image/webp") return hasValidWebpStructure(bytes);
  if (mimeType === "image/bmp") {
    return (
      bytes.length >= 26 &&
      bytes.readUInt32LE(2) === bytes.length &&
      bytes.readUInt32LE(10) < bytes.length
    );
  }
  return false;
}

function jpegDimensions(bytes: Buffer): ImageDimensions | undefined {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return undefined;
  let offset = 2;
  while (offset + 3 < bytes.length) {
    if (bytes[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    while (offset < bytes.length && bytes[offset] === 0xff) offset += 1;
    const marker = bytes[offset++];
    if (marker === undefined || marker === 0xd9 || marker === 0xda) break;
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (offset + 1 >= bytes.length) break;
    const segmentLength = bytes.readUInt16BE(offset);
    if (segmentLength < 2 || offset + segmentLength > bytes.length) break;
    const isStartOfFrame = marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker);
    if (isStartOfFrame && segmentLength >= 7) {
      return {
        height: bytes.readUInt16BE(offset + 3),
        width: bytes.readUInt16BE(offset + 5),
      };
    }
    offset += segmentLength;
  }
  return undefined;
}

/** Read dimensions from bounded raster headers before Chromium decodes the image. */
export function displayImageDimensions(
  bytes: Buffer,
  mimeType: string,
): ImageDimensions | undefined {
  if (mimeType === "image/png" && bytes.length >= 24) {
    return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
  }
  if (mimeType === "image/jpeg") return jpegDimensions(bytes);
  if (mimeType === "image/gif" && bytes.length >= 10) {
    return { width: bytes.readUInt16LE(6), height: bytes.readUInt16LE(8) };
  }
  if (mimeType === "image/bmp" && bytes.length >= 26) {
    const dibBytes = bytes.readUInt32LE(14);
    if (dibBytes === 12) {
      return { width: bytes.readUInt16LE(18), height: bytes.readUInt16LE(20) };
    }
    return {
      width: Math.abs(bytes.readInt32LE(18)),
      height: Math.abs(bytes.readInt32LE(22)),
    };
  }
  if (mimeType === "image/webp" && bytes.length >= 20) {
    return inspectWebp(bytes);
  }
  return undefined;
}

export function validateDisplayImageDimensions(
  bytes: Buffer,
  mimeType: string,
  name: string,
): ImageDimensions {
  if (!DISPLAY_IMAGE_MIME_TYPES.has(mimeType)) {
    throw new Error(`${name} uses an image format Aiden cannot display inline yet.`);
  }
  const dimensions = displayImageDimensions(bytes, mimeType);
  if (
    !dimensions ||
    dimensions.width < 1 ||
    dimensions.height < 1 ||
    !hasValidRasterStructure(bytes, mimeType)
  ) {
    throw new Error(`${name} is malformed or has unsupported image data.`);
  }
  if (
    dimensions.width > MAX_DISPLAY_IMAGE_DIMENSION ||
    dimensions.height > MAX_DISPLAY_IMAGE_DIMENSION ||
    dimensions.width * dimensions.height > MAX_DISPLAY_IMAGE_PIXELS
  ) {
    throw new Error(
      `${name} is too large to decode safely (max ${MAX_DISPLAY_IMAGE_PIXELS.toLocaleString("en-US")} pixels).`,
    );
  }
  return dimensions;
}

function resolveWorkspaceImage(
  root: string,
  suppliedPath: string,
): {
  absolute: string;
  relative: string;
} {
  if (
    suppliedPath.length === 0 ||
    suppliedPath.length > 4096 ||
    suppliedPath.includes("\0") ||
    path.isAbsolute(suppliedPath) ||
    WINDOWS_ABSOLUTE_PATH.test(suppliedPath)
  ) {
    throw new Error("display_image requires a relative workspace image path.");
  }
  const absolute = path.resolve(root, suppliedPath);
  const relative = path.relative(root, absolute);
  if (
    relative === "" ||
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    throw new Error(`Path "${suppliedPath}" is outside the workspace folder.`);
  }
  if (!isImageAttachmentPath(absolute)) {
    throw new Error(`${suppliedPath} is not a supported raster image path.`);
  }
  return { absolute, relative };
}

function sameIdentity(
  left: { dev: number; ino: number },
  right: { dev: number; ino: number },
): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

/** Create one chat-scoped Pi contribution; no tool is installed process-globally. */
export function createDisplayImageExtensionRuntime(
  options: DisplayImageExtensionOptions,
): DisplayImageExtensionRuntime {
  const lexicalRoot = path.resolve(options.workspaceRoot);
  const canonicalRoot = realpathSync(lexicalRoot);
  const rootIdentity = statSync(canonicalRoot);
  if (!rootIdentity.isDirectory()) throw new Error("The workspace root is not a directory.");
  const existingChatImageBytes = options.existingChatImageBytes ?? 0;
  const existingChatImageCount = options.existingChatImageCount ?? 0;
  const existingChatImagePixels = options.existingChatImagePixels ?? 0;
  if (
    !Number.isSafeInteger(existingChatImageBytes) ||
    existingChatImageBytes < 0 ||
    !Number.isSafeInteger(existingChatImageCount) ||
    existingChatImageCount < 0 ||
    !Number.isSafeInteger(existingChatImagePixels) ||
    existingChatImagePixels < 0
  ) {
    throw new Error("Invalid existing chat image usage.");
  }
  const artifactNamespace = options.artifactNamespace ?? randomUUID();

  let displayedCount = 0;
  let displayedBytes = 0;
  let displayedPixels = 0;
  let serial = Promise.resolve();

  const assertWorkspaceRoot = async (): Promise<void> => {
    const [currentCanonical, currentIdentity] = await Promise.all([
      fs.realpath(lexicalRoot),
      fs.stat(lexicalRoot),
    ]);
    if (
      currentCanonical !== canonicalRoot ||
      !currentIdentity.isDirectory() ||
      !sameIdentity(currentIdentity, rootIdentity)
    ) {
      throw new Error("The authorized workspace root changed during this generation.");
    }
  };

  const tool: AgentTool = declarePiRuntimeReplay(
    {
      name: DISPLAY_IMAGE_TOOL_NAME,
      label: "Display Image",
      description:
        "Display an existing raster image from the workspace inline in Aiden's current chat. Use this after creating or rendering an image, or whenever the user asks to see one. Paths are relative to the workspace root.",
      parameters: Type.Object({
        path: Type.String({
          description: "Raster image path relative to the workspace folder.",
          minLength: 1,
          maxLength: 4096,
        }),
      }),
      execute: async (toolCallId, params, signal): Promise<AgentToolResult<null>> => {
        const previous = serial;
        let release!: () => void;
        serial = new Promise<void>((resolve) => {
          release = resolve;
        });
        await previous;
        try {
          if (signal?.aborted) throw new Error("Image display was cancelled.");
          if (displayedCount >= MAX_ATTACHMENTS_PER_MESSAGE) {
            throw new Error(
              `Up to ${MAX_ATTACHMENTS_PER_MESSAGE} images can be displayed in one response.`,
            );
          }
          if (existingChatImageCount + displayedCount >= MAX_DISPLAY_IMAGES_PER_CHAT) {
            throw new Error(
              `This chat has reached its ${MAX_DISPLAY_IMAGES_PER_CHAT}-image inline display limit.`,
            );
          }
          const remainingBytes = Math.min(
            MAX_DISPLAY_IMAGE_BYTES_PER_RESPONSE - displayedBytes,
            MAX_DISPLAY_IMAGE_BYTES_PER_CHAT - existingChatImageBytes - displayedBytes,
          );
          if (remainingBytes < 1) {
            throw new Error("Inline images reached this response or chat's storage limit.");
          }
          const suppliedPath = (params as { path: string }).path;
          // Read beneath the already-pinned canonical root so an authorized
          // workspace opened through a symlink remains usable. Descendant
          // symlinks are still rejected by the hardened attachment reader.
          const resolved = resolveWorkspaceImage(canonicalRoot, suppliedPath);
          await assertWorkspaceRoot();
          const [attachment] = await readPickedAttachments([resolved.absolute], {
            maxBatchBytes: remainingBytes,
            isActive: () => !signal?.aborted,
          });
          await assertWorkspaceRoot();
          if (!attachment || attachment.kind !== "image" || !attachment.data) {
            throw new Error(`${suppliedPath} could not be prepared as an inline image.`);
          }
          const dimensions = validateDisplayImageDimensions(
            Buffer.from(attachment.data, "base64"),
            attachment.mimeType,
            attachment.name,
          );
          const imagePixels = dimensions.width * dimensions.height;
          if (displayedPixels + imagePixels > MAX_DISPLAY_IMAGE_PIXELS_PER_RESPONSE) {
            throw new Error("Inline images reached this response's decoded-pixel limit.");
          }
          if (
            existingChatImagePixels + displayedPixels + imagePixels >
            MAX_DISPLAY_IMAGE_PIXELS_PER_CHAT
          ) {
            throw new Error("This chat has reached its inline-image decoded-pixel limit.");
          }
          await options.beforeArtifact?.();
          if (signal?.aborted) throw new Error("Image display was cancelled.");
          const artifact: ChatImageArtifactV1 = {
            version: CHAT_ARTIFACT_VERSION,
            kind: "image",
            attachment: {
              id: createHash("sha256")
                .update(artifactNamespace)
                .update("\0")
                .update(toolCallId)
                .digest("hex"),
              name: attachment.name,
              mimeType: attachment.mimeType,
              kind: "image",
              size: attachment.size,
              data: attachment.data,
            },
          };
          const presented = (await options.onArtifact(artifact, dimensions)) !== false;
          if (presented) {
            displayedCount += 1;
            displayedBytes += attachment.size;
            displayedPixels += imagePixels;
          }
          return {
            content: [
              {
                type: "text",
                text: `Displayed ${resolved.relative} inline (${dimensions.width}×${dimensions.height}).`,
              },
            ],
            details: null,
          };
        } finally {
          release();
        }
      },
    },
    // Replaying a presentation side effect could duplicate an assistant artifact.
    "never",
  );

  return {
    extension: {
      id: DISPLAY_IMAGE_EXTENSION_ID,
      systemPrompt:
        "Aiden can display existing workspace raster images inline with the display_image tool. Use it when the user asks to see an image or when showing a visual artifact is useful. Do not claim inline image display is unavailable while this tool is present.",
      tools: [tool],
    },
  };
}

export function createDisplayImageExtension(
  options: DisplayImageExtensionOptions,
): PiAgentRuntimeExtension {
  return createDisplayImageExtensionRuntime(options).extension;
}
