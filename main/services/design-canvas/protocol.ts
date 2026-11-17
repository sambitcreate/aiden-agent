// The aiden-design request handler. Pure apart from its injected reads, so the
// tests call it with real files; `registerDesignProtocol` only wires it to
// Electron's `protocol.handle`.

import { constants as fsConstants } from "node:fs";
import * as fs from "node:fs/promises";
import { DESIGN_SCHEME } from "../../../renderer/shared/design-canvas/url.js";
import { readGenerativeUiHostLibrary } from "../generative-ui-host-libraries.js";
import { DESIGN_BRIDGE_SOURCE } from "./bridge-source.js";
import type { DesignGrantRegistry } from "./grants.js";
import { DESIGN_MAX_FILE_BYTES, resolveDesignFile } from "./resolve-core.js";

/** Every aiden-design response carries this policy: no network, no frames, no forms. */
export const DESIGN_CONTENT_SECURITY_POLICY =
  "default-src 'none'; script-src aiden-design: 'unsafe-inline'; style-src aiden-design: 'unsafe-inline'; img-src aiden-design: data: blob:; font-src aiden-design: data:; media-src aiden-design: blob:; connect-src 'none'; frame-src 'none'; form-action 'none'; base-uri 'none'";

export const DESIGN_BRIDGE_PATH = "__aiden/bridge.js";
const LIBRARY_PREFIX = "__aiden/lib/";
const LIBRARY_NAME = /^[a-z0-9][a-z0-9.-]{0,63}$/u;
const SCHEME_PREFIX = `${DESIGN_SCHEME}://`;

export type DesignLibrary = { bytes: Uint8Array; mimeType: string };

export type DesignResponseDeps = {
  grants: Pick<DesignGrantRegistry, "resolve">;
  readFile(absolute: string): Promise<Buffer>;
  readLibrary(name: string): Promise<DesignLibrary | null>;
};

const STATUS_TEXT: Record<number, string> = {
  403: "Forbidden",
  404: "Not found",
  405: "Method not allowed",
  413: "Too large",
};

function headers(contentType: string): Record<string, string> {
  return {
    "content-type": contentType,
    "content-security-policy": DESIGN_CONTENT_SECURITY_POLICY,
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  };
}

function failure(status: 403 | 404 | 405 | 413): Response {
  return new Response(STATUS_TEXT[status], {
    status,
    headers: headers("text/plain; charset=utf-8"),
  });
}

function ok(body: Uint8Array | string, contentType: string, head: boolean): Response {
  const bytes = typeof body === "string" ? Buffer.from(body, "utf8") : Buffer.from(body);
  return new Response(head ? null : bytes, { status: 200, headers: headers(contentType) });
}

/**
 * Splits the raw URL by hand: WHATWG parsing would already have collapsed an
 * encoded `..`, and the resolver must see exactly what was asked for.
 */
function parseDesignUrl(url: string): { grant: string; path: string } | null {
  if (
    typeof url !== "string" ||
    url.slice(0, SCHEME_PREFIX.length).toLowerCase() !== SCHEME_PREFIX
  ) {
    return null;
  }
  const rest = url.slice(SCHEME_PREFIX.length);
  const end = rest.search(/[?#]/u);
  const withoutQuery = end === -1 ? rest : rest.slice(0, end);
  const slash = withoutQuery.indexOf("/");
  if (slash <= 0) return null;
  return { grant: withoutQuery.slice(0, slash), path: withoutQuery.slice(slash + 1) };
}

/** Index just past the first match's closing `>`, or -1. */
function afterTag(html: string, pattern: RegExp): number {
  const match = pattern.exec(html);
  if (!match) return -1;
  const close = html.indexOf(">", match.index);
  return close === -1 ? -1 : close + 1;
}

/**
 * Puts the bridge right after `<head …>`; without one, after `<html …>`, then
 * after a leading doctype, else first. Works on latin1 so every byte of the
 * design's own markup is kept exactly.
 */
export function injectDesignBridge(bytes: Uint8Array, grant: string): Buffer {
  const html = Buffer.from(bytes).toString("latin1");
  const tag = `<script src="${SCHEME_PREFIX}${grant}/${DESIGN_BRIDGE_PATH}"></script>`;
  let at = afterTag(html, /<head(?=[\s>/])/iu);
  if (at === -1) at = afterTag(html, /<html(?=[\s>/])/iu);
  if (at === -1) at = afterTag(html, /^\s*<!doctype(?=[\s>])/iu);
  if (at === -1) at = 0;
  return Buffer.from(html.slice(0, at) + tag + html.slice(at), "latin1");
}

export async function designResponse(
  request: { url: string; method?: string },
  deps: DesignResponseDeps,
): Promise<Response> {
  const method = (request.method ?? "GET").toUpperCase();
  const parsed = parseDesignUrl(request.url);
  if (!parsed) return failure(404);
  const grant = deps.grants.resolve(parsed.grant);
  if (!grant) return failure(404);
  if (method !== "GET" && method !== "HEAD") return failure(405);
  const head = method === "HEAD";

  if (parsed.path === DESIGN_BRIDGE_PATH) {
    return ok(DESIGN_BRIDGE_SOURCE, "text/javascript; charset=utf-8", head);
  }
  if (parsed.path.startsWith("__aiden/")) {
    const name = parsed.path.startsWith(LIBRARY_PREFIX)
      ? parsed.path.slice(LIBRARY_PREFIX.length)
      : "";
    if (!LIBRARY_NAME.test(name) || name.includes("..")) return failure(404);
    const library = await deps.readLibrary(name);
    return library ? ok(library.bytes, library.mimeType, head) : failure(404);
  }

  const resolved = await resolveDesignFile(grant.workspaceRoot, parsed.path);
  if (!resolved.ok) return failure(resolved.status);
  let bytes: Buffer;
  try {
    bytes = await deps.readFile(resolved.absolute);
  } catch {
    return failure(404);
  }
  if (bytes.byteLength > DESIGN_MAX_FILE_BYTES) return failure(413);
  const body = resolved.mimeType.startsWith("text/html")
    ? injectDesignBridge(bytes, parsed.grant)
    : bytes;
  return ok(body, resolved.mimeType, head);
}

/**
 * Opens without following a final symlink and reads at most the size cap, so a
 * file swapped for a link or grown after resolving is still refused.
 */
export async function readDesignFile(absolute: string): Promise<Buffer> {
  const handle = await fs.open(absolute, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw new Error("Not a file.");
    if (stat.size > DESIGN_MAX_FILE_BYTES) throw new Error("Too large.");
    const buffer = Buffer.alloc(stat.size);
    let offset = 0;
    while (offset < buffer.length) {
      const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    return offset === buffer.length ? buffer : buffer.subarray(0, offset);
  } finally {
    await handle.close();
  }
}

async function readDesignLibrary(name: string): Promise<DesignLibrary | null> {
  const library = await readGenerativeUiHostLibrary(name);
  return library ? { bytes: new Uint8Array(library.bytes), mimeType: library.mimeType } : null;
}

const registeredTargets = new WeakSet<object>();

/** Wires the handler to Electron's `protocol`. Call once, after app ready, with design mode on. */
export function registerDesignProtocol(deps: {
  protocol: { handle(scheme: string, handler: (request: Request) => Promise<Response>): void };
  grants: Pick<DesignGrantRegistry, "resolve">;
  readFile?: (absolute: string) => Promise<Buffer>;
  readLibrary?: (name: string) => Promise<DesignLibrary | null>;
}): void {
  if (registeredTargets.has(deps.protocol)) return;
  const handlerDeps: DesignResponseDeps = {
    grants: deps.grants,
    readFile: deps.readFile ?? readDesignFile,
    readLibrary: deps.readLibrary ?? readDesignLibrary,
  };
  deps.protocol.handle(DESIGN_SCHEME, (request) =>
    designResponse({ url: request.url, method: request.method }, handlerDeps).catch(() =>
      failure(404),
    ),
  );
  registeredTargets.add(deps.protocol);
}
