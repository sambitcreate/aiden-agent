// `aiden-attachment://image/<chatId>/<sha256>`: one stored chat image, read
// from its own file. The window loads images this way instead of receiving
// their base64 bytes with the chat over IPC.
//
// A link is honoured only while the chat still lists an image with that hash,
// and only for the raster types the transcript draws. The bytes never change
// for a hash, so the response may be cached for good and carries the hash as
// its ETag.

import { isCanonicalRasterImageMimeType } from "../../renderer/shared/attachment-contract.js";
import { isImageSha256 } from "./chat-image-store.js";
import { CHAT_ATTACHMENT_SCHEME } from "./custom-schemes-core.js";

const IMAGE_HOST = "image";
const SAFE_CHAT_ID = /^[A-Za-z0-9._:-]{1,160}$/u;

export interface ChatAttachmentSource {
  /** The type and size of an image file the chat lists, or undefined. */
  findStoredImage(chatId: string, sha256: string): Promise<{ mimeType: string; size: number } | undefined>;
  readImage(sha256: string, size: number): Promise<Uint8Array | undefined>;
}

export function chatImageUrl(chatId: string, sha256: string): string {
  return `${CHAT_ATTACHMENT_SCHEME}://${IMAGE_HOST}/${encodeURIComponent(chatId)}/${sha256}`;
}

/** The chat and hash of an exact image link, or undefined. */
export function parseChatImageUrl(url: string): { chatId: string; sha256: string } | undefined {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return undefined;
  }
  if (
    parsed.protocol !== `${CHAT_ATTACHMENT_SCHEME}:` ||
    parsed.hostname !== IMAGE_HOST ||
    parsed.port ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash
  ) {
    return undefined;
  }
  const segments = parsed.pathname.split("/");
  if (segments.length !== 3 || segments[0] !== "") return undefined;
  let chatId: string;
  try {
    chatId = decodeURIComponent(segments[1]!);
  } catch {
    return undefined;
  }
  const sha256 = segments[2]!;
  if (!SAFE_CHAT_ID.test(chatId) || !isImageSha256(sha256)) return undefined;
  return { chatId, sha256 };
}

function failure(status: 304 | 404 | 405 | 500, headers: Record<string, string> = {}): Response {
  return new Response(status === 304 ? null : status === 404 ? "Not found" : status === 405 ? "Method not allowed" : "Internal error", {
    status,
    headers: status === 304 ? headers : { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store", ...headers },
  });
}

export function createChatAttachmentRequestHandler(
  source: ChatAttachmentSource,
): (request: Request) => Promise<Response> {
  return async (request) => {
    if (request.method !== "GET" && request.method !== "HEAD") return failure(405);
    const target = parseChatImageUrl(request.url);
    if (!target) return failure(404);
    let bytes: Uint8Array | undefined;
    try {
      const attachment = await source.findStoredImage(target.chatId, target.sha256);
      if (!attachment || !isCanonicalRasterImageMimeType(attachment.mimeType)) return failure(404);
      const etag = `"${target.sha256}"`;
      const cache = {
        etag,
        "cache-control": "private, max-age=31536000, immutable",
      };
      if (request.headers.get("if-none-match") === etag) return failure(304, cache);
      bytes = await source.readImage(target.sha256, attachment.size);
      if (!bytes) return failure(404);
      return new Response(request.method === "HEAD" ? null : Buffer.from(bytes), {
        status: 200,
        headers: {
          ...cache,
          "content-type": attachment.mimeType,
          "content-length": String(bytes.byteLength),
          "content-disposition": "inline",
          "x-content-type-options": "nosniff",
        },
      });
    } catch {
      // Never echo paths or file errors to the renderer.
      return failure(500);
    }
  };
}
