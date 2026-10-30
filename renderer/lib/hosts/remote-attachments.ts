import { isCanonicalRasterImageMimeType, MAX_INLINE_IMAGE_BYTES } from "../../shared/attachment-contract";
import { bytesToBase64 } from "../live-pcm-capture";
import type { Attachment } from "../types";
import type { HostChatAttachmentUpload } from "./host-chat-adapter";

/** The host stages at most this many uploads for one turn. */
export const MAX_REMOTE_ATTACHMENTS_PER_TURN = 10;
const MAX_REMOTE_TEXT_CHARACTERS = 100_000;
const MAX_REMOTE_NAME_CHARACTERS = 255;

/** Text types the host accepts as they are; any other text file is sent as plain text. */
const REMOTE_TEXT_MIME_TYPES = new Set([
  "text/plain",
  "text/markdown",
  "text/csv",
  "application/json",
  "application/xml",
  "application/yaml",
  "application/x-yaml",
  "application/javascript",
  "application/typescript",
]);

export class RemoteAttachmentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RemoteAttachmentError";
  }
}

/** The host refuses slashes and control characters in a display name. */
function remoteName(name: string): string {
  const cleaned = Array.from(name.trim().replace(/[/\\\p{Cc}]/gu, "_"))
    .slice(0, MAX_REMOTE_NAME_CHARACTERS)
    .join("")
    .trim();
  return cleaned || "attachment";
}

/**
 * Converts the files this Mac read for the composer into the uploads a
 * paired host accepts, or explains which one it cannot take. Nothing here
 * touches the host; the caller uploads the result.
 */
export function remoteAttachmentUploads(attachments: readonly Attachment[]): HostChatAttachmentUpload[] {
  if (attachments.length > MAX_REMOTE_ATTACHMENTS_PER_TURN) {
    throw new RemoteAttachmentError(`Another Mac takes up to ${MAX_REMOTE_ATTACHMENTS_PER_TURN} attachments per message.`);
  }
  return attachments.map((attachment): HostChatAttachmentUpload => {
    const name = remoteName(attachment.name);
    if (attachment.kind === "image") {
      const mimeType = attachment.mimeType.toLowerCase();
      if (mimeType !== "image/png" && mimeType !== "image/jpeg") {
        throw new RemoteAttachmentError(`${attachment.name} can't be sent to another Mac. Use a PNG or JPEG image.`);
      }
      if (!attachment.data) throw new RemoteAttachmentError(`${attachment.name} could not be read.`);
      if (attachment.size > MAX_INLINE_IMAGE_BYTES) {
        throw new RemoteAttachmentError(`${attachment.name} is too large to send to another Mac.`);
      }
      return { name, mimeType, kind: "image", data: attachment.data };
    }
    if (attachment.text === undefined) throw new RemoteAttachmentError(`${attachment.name} could not be read.`);
    const mimeType = attachment.mimeType.toLowerCase();
    return {
      name,
      mimeType: REMOTE_TEXT_MIME_TYPES.has(mimeType) ? mimeType : "text/plain",
      kind: "text",
      // The composer already truncates text files; this keeps the host's cap exact.
      text: Array.from(attachment.text).slice(0, MAX_REMOTE_TEXT_CHARACTERS).join(""),
    };
  });
}

type RemoteImageType = "image/png" | "image/jpeg";

/** A decoded picture, ready to be drawn again at any size. */
export interface DecodedImage {
  width: number;
  height: number;
  /** Encodes the picture at this size; `null` when the browser cannot. */
  encode(width: number, height: number, mimeType: RemoteImageType): Promise<Uint8Array | null>;
  close(): void;
}

/** Decodes image bytes, or resolves `null` for a picture this Mac cannot read. */
export type RemoteImageDecoder = (bytes: Uint8Array, mimeType: string) => Promise<DecodedImage | null>;

/** Each try draws the picture smaller, by its longest side, until it fits the host's limit. */
const REMOTE_IMAGE_SCALES = [1, 0.75, 0.5, 0.35, 0.25] as const;
const REMOTE_JPEG_QUALITY = 0.86;

function base64Bytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function renamed(name: string, mimeType: RemoteImageType): string {
  const extension = mimeType === "image/png" ? ".png" : ".jpg";
  const stem = name.replace(/\.[A-Za-z0-9]{1,8}$/u, "");
  return `${stem || "image"}${extension}`;
}

/**
 * The image as a PNG or JPEG within the host's limit. A photo becomes a JPEG;
 * a picture that may be transparent stays a PNG unless, at that size, only a
 * JPEG fits.
 */
async function remoteReadyImage(attachment: Attachment, decode: RemoteImageDecoder): Promise<Attachment> {
  const mimeType = attachment.mimeType.toLowerCase();
  const fits = attachment.size <= MAX_INLINE_IMAGE_BYTES;
  if ((mimeType === "image/png" || mimeType === "image/jpeg") && fits) return attachment;
  if (!attachment.data || !isCanonicalRasterImageMimeType(mimeType)) return attachment;
  // Chromium cannot decode HEIC, so this Mac cannot redraw one.
  if (mimeType === "image/heic" || mimeType === "image/heif") {
    throw new RemoteAttachmentError(
      `${attachment.name} is a HEIC photo, which can't be sent to another Mac yet. Export it as a JPEG and attach it again.`,
    );
  }
  const image = await decode(base64Bytes(attachment.data), mimeType).catch(() => null);
  if (!image) {
    throw new RemoteAttachmentError(`${attachment.name} can't be sent to another Mac. Save it as a PNG or JPEG and attach it again.`);
  }
  try {
    const targets: RemoteImageType[] = mimeType === "image/jpeg" ? ["image/jpeg"] : ["image/png", "image/jpeg"];
    // Size first: a picture keeps as much of its resolution as fits, as a JPEG when only that fits.
    for (const scale of REMOTE_IMAGE_SCALES) {
      for (const target of targets) {
        const width = Math.max(1, Math.round(image.width * scale));
        const height = Math.max(1, Math.round(image.height * scale));
        const bytes = await image.encode(width, height, target);
        if (bytes && bytes.byteLength > 0 && bytes.byteLength <= MAX_INLINE_IMAGE_BYTES) {
          return {
            ...attachment,
            name: renamed(attachment.name, target),
            mimeType: target,
            size: bytes.byteLength,
            data: bytesToBase64(bytes),
          };
        }
      }
    }
  } finally {
    image.close();
  }
  throw new RemoteAttachmentError(`${attachment.name} is too large to send to another Mac.`);
}

/** Decodes with the browser and redraws on a canvas; JPEG gets a white backdrop for transparent pixels. */
export const browserImageDecoder: RemoteImageDecoder = async (bytes, mimeType) => {
  // An animated GIF or WebP keeps only its first frame.
  const bitmap = await createImageBitmap(new Blob([bytes as BlobPart], { type: mimeType }), {
    imageOrientation: "from-image",
  });
  return {
    width: bitmap.width,
    height: bitmap.height,
    async encode(width, height, target) {
      const canvas = new OffscreenCanvas(width, height);
      const context = canvas.getContext("2d");
      if (!context) return null;
      if (target === "image/jpeg") {
        context.fillStyle = "#ffffff";
        context.fillRect(0, 0, width, height);
      }
      context.imageSmoothingQuality = "high";
      context.drawImage(bitmap, 0, 0, width, height);
      const blob = await canvas.convertToBlob({ type: target, quality: REMOTE_JPEG_QUALITY });
      return new Uint8Array(await blob.arrayBuffer());
    },
    close: () => bitmap.close(),
  };
};

/**
 * The uploads a paired host accepts, after redrawing any image it would refuse
 * (WebP, GIF, BMP, or over its size limit) as a PNG or JPEG, as the phones
 * do before they send. A HEIC photo, or a picture this Mac cannot decode, is
 * explained instead.
 */
export async function prepareRemoteAttachmentUploads(
  attachments: readonly Attachment[],
  decode: RemoteImageDecoder = browserImageDecoder,
): Promise<HostChatAttachmentUpload[]> {
  if (attachments.length > MAX_REMOTE_ATTACHMENTS_PER_TURN) return remoteAttachmentUploads(attachments);
  const ready: Attachment[] = [];
  for (const attachment of attachments) {
    ready.push(attachment.kind === "image" ? await remoteReadyImage(attachment, decode) : attachment);
  }
  return remoteAttachmentUploads(ready);
}
