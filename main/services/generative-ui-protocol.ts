import { protocol, type Session } from "electron";
import {
  GENERATIVE_UI_PROTOCOL_SCHEME,
  generativeUiHostLibraryNameFromUrl,
  generativeUiPreviewTokenFromUrl,
} from "../../renderer/shared/generative-ui.js";
import { readGenerativeUiHostLibrary } from "./generative-ui-host-libraries.js";
import { generativeUiPreviewResponse } from "./generative-ui-preview-store.js";

export {
  openGenerativeUiDraftStream,
  registerGenerativeUiPreviewDocument,
} from "./generative-ui-preview-store.js";

let handlerRegistered = false;

function utf8Response(
  body: string | Uint8Array,
  mimeType: string,
  extraHeaders?: Record<string, string>,
): Response {
  const bytes = typeof body === "string" ? Buffer.from(body, "utf8") : Buffer.from(body);
  return new Response(bytes, {
    status: 200,
    headers: {
      "content-type": mimeType,
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      ...extraHeaders,
    },
  });
}

function notFound(): Response {
  return new Response("Not found", { status: 404, headers: { "content-type": "text/plain" } });
}

export function registerGenerativeUiProtocol(_session?: Session): void {
  if (handlerRegistered) return;
  protocol.handle(GENERATIVE_UI_PROTOCOL_SCHEME, async (request) => {
    const library = generativeUiHostLibraryNameFromUrl(request.url);
    if (library) {
      const file = await readGenerativeUiHostLibrary(library);
      if (!file) return notFound();
      return utf8Response(new Uint8Array(file.bytes), file.mimeType, {
        "cache-control": "public, max-age=31536000, immutable",
      });
    }
    const token = generativeUiPreviewTokenFromUrl(request.url);
    if (!token) return notFound();
    return generativeUiPreviewResponse(token) ?? notFound();
  });
  handlerRegistered = true;
}
