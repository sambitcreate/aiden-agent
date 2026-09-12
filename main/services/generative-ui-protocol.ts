import { randomBytes } from "node:crypto";
import { protocol, type Session } from "electron";
import {
  generativeUiGuestCsp,
  GENERATIVE_UI_PREVIEW_HOST,
  GENERATIVE_UI_PROTOCOL_SCHEME,
  generativeUiHostLibraryNameFromUrl,
  generativeUiPreviewTokenFromUrl,
} from "../../renderer/shared/generative-ui.js";
import { readGenerativeUiHostLibrary } from "./generative-ui-host-libraries.js";

let schemesRegistered = false;
let handlerRegistered = false;

const PREVIEW_TTL_MS = 30 * 60 * 1000;
const previews = new Map<
  string,
  { body: string; contentSecurityPolicy: string; expiresAt: number }
>();

function prunePreviews(now = Date.now()): void {
  for (const [token, preview] of previews) {
    if (preview.expiresAt <= now) previews.delete(token);
  }
}

export function registerGenerativeUiPreviewDocument(
  body: string,
  options: { designStudio?: boolean } = {},
): string {
  prunePreviews();
  const token = randomBytes(32).toString("hex");
  previews.set(token, {
    body,
    contentSecurityPolicy: generativeUiGuestCsp(options.designStudio === true),
    expiresAt: Date.now() + PREVIEW_TTL_MS,
  });
  return `${GENERATIVE_UI_PROTOCOL_SCHEME}://${GENERATIVE_UI_PREVIEW_HOST}/${token}`;
}

export function registerGenerativeUiScheme(): void {
  if (schemesRegistered) return;
  protocol.registerSchemesAsPrivileged([
    {
      scheme: GENERATIVE_UI_PROTOCOL_SCHEME,
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: false,
        corsEnabled: false,
        stream: true,
      },
    },
  ]);
  schemesRegistered = true;
}

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

export function registerGenerativeUiProtocol(_session?: Session): void {
  if (handlerRegistered) return;
  protocol.handle(GENERATIVE_UI_PROTOCOL_SCHEME, async (request) => {
    const library = generativeUiHostLibraryNameFromUrl(request.url);
    if (library) {
      const file = await readGenerativeUiHostLibrary(library);
      if (!file) {
        return new Response("Not found", {
          status: 404,
          headers: { "content-type": "text/plain" },
        });
      }
      return utf8Response(new Uint8Array(file.bytes), file.mimeType, {
        "cache-control": "public, max-age=31536000, immutable",
      });
    }
    const token = generativeUiPreviewTokenFromUrl(request.url);
    if (!token) {
      return new Response("Not found", { status: 404, headers: { "content-type": "text/plain" } });
    }
    prunePreviews();
    const preview = previews.get(token);
    if (!preview) {
      return new Response("Not found", { status: 404, headers: { "content-type": "text/plain" } });
    }
    return utf8Response(preview.body, "text/html; charset=utf-8", {
      "content-security-policy": preview.contentSecurityPolicy,
    });
  });
  handlerRegistered = true;
}
