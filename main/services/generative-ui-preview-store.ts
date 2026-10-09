import { randomBytes } from "node:crypto";
import {
  GENERATIVE_UI_GUEST_CSP,
  GENERATIVE_UI_PREVIEW_HOST,
  GENERATIVE_UI_PROTOCOL_SCHEME,
  generativeUiDraftCsp,
} from "../../renderer/shared/generative-ui.js";
import {
  generativeUiDraftDocumentHead,
  type GenerativeUiThemeTokens,
} from "./generative-ui-html.js";

/**
 * One-time `aiden-genui://preview/<token>` documents. Kept free of Electron
 * so the protocol handler's responses can be tested directly.
 */
const PREVIEW_TTL_MS = 30 * 60 * 1000;
/** A draft nobody opened is abandoned after this long. */
const DRAFT_TTL_MS = 2 * 60 * 1000;

type PreviewEntry =
  | { kind: "static"; body: string; expiresAt: number }
  | { kind: "draft"; stream: ReadableStream<Uint8Array>; csp: string; expiresAt: number; close: () => void };

const previews = new Map<string, PreviewEntry>();

function prunePreviews(now = Date.now()): void {
  for (const [token, preview] of previews) {
    if (preview.expiresAt > now) continue;
    previews.delete(token);
    if (preview.kind === "draft") preview.close();
  }
}

function previewUrl(token: string): string {
  return `${GENERATIVE_UI_PROTOCOL_SCHEME}://${GENERATIVE_UI_PREVIEW_HOST}/${token}`;
}

function htmlHeaders(csp: string): Record<string, string> {
  return {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    "content-security-policy": csp,
  };
}

export function registerGenerativeUiPreviewDocument(body: string): string {
  prunePreviews();
  const token = randomBytes(32).toString("hex");
  previews.set(token, { kind: "static", body, expiresAt: Date.now() + PREVIEW_TTL_MS });
  return previewUrl(token);
}

export interface GenerativeUiDraftStream {
  src: string;
  append(chunk: string): void;
  close(): void;
}

/**
 * A draft preview whose body grows as the model streams `render_artifact`
 * HTML. It is served once (to the frame that opens it); model scripts are
 * blocked by a nonce-only policy until the final artifact replaces it.
 */
export function openGenerativeUiDraftStream(
  title: string,
  theme: GenerativeUiThemeTokens | undefined,
): GenerativeUiDraftStream {
  prunePreviews();
  const token = randomBytes(32).toString("hex");
  const nonce = randomBytes(16).toString("base64");
  const encoder = new TextEncoder();
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  let closed = false;
  const stream = new ReadableStream<Uint8Array>({
    start(streamController) {
      controller = streamController;
      controller.enqueue(encoder.encode(generativeUiDraftDocumentHead(title, theme, nonce)));
    },
  });
  const close = () => {
    if (closed) return;
    closed = true;
    try {
      controller.close();
    } catch {
      // Already errored or cancelled by the reader.
    }
  };
  previews.set(token, {
    kind: "draft",
    stream,
    csp: generativeUiDraftCsp(nonce),
    expiresAt: Date.now() + DRAFT_TTL_MS,
    close,
  });
  return {
    src: previewUrl(token),
    append(chunk) {
      if (closed || !chunk) return;
      try {
        controller.enqueue(encoder.encode(chunk));
      } catch {
        closed = true;
      }
    },
    close,
  };
}

/** The protocol response for a preview token, or undefined for 404. */
export function generativeUiPreviewResponse(token: string): Response | undefined {
  prunePreviews();
  const preview = previews.get(token);
  if (!preview) return undefined;
  if (preview.kind === "draft") {
    previews.delete(token);
    return new Response(preview.stream, { status: 200, headers: htmlHeaders(preview.csp) });
  }
  return new Response(Buffer.from(preview.body, "utf8"), {
    status: 200,
    headers: htmlHeaders(GENERATIVE_UI_GUEST_CSP),
  });
}
