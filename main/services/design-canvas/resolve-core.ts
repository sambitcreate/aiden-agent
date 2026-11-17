// Maps an aiden-design URL path onto a file under a granted workspace root.
// Lexical refusals come first and touch no disk; containment is then decided
// on real paths, so a symlink can never lead outside the root.

import * as fs from "node:fs/promises";
import path from "node:path";
import { isPathInside } from "../../shared/path-containment.js";

export { designUrl } from "../../../renderer/shared/design-canvas/url.js";

export type DesignResolveResult =
  | { ok: true; absolute: string; mimeType: string; size: number }
  | { ok: false; status: 403 | 404 | 413 };

export const DESIGN_MAX_FILE_BYTES = 8 * 1024 * 1024;

const MIME_TYPES: Readonly<Record<string, string>> = Object.freeze({
  ".html": "text/html; charset=utf-8",
  ".htm": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
});

const NOT_FOUND = { ok: false, status: 404 } as const;
const FORBIDDEN = { ok: false, status: 403 } as const;

function mimeTypeFor(name: string): string | undefined {
  const extension = path.posix.extname(name).toLowerCase();
  return Object.prototype.hasOwnProperty.call(MIME_TYPES, extension)
    ? MIME_TYPES[extension]
    : undefined;
}

/**
 * Splits the still-encoded URL path into decoded segments, or null when any
 * segment is malformed, empty, `.`/`..`, or decodes to a separator or NUL.
 */
function decodeSegments(urlPath: string): string[] | null {
  const raw = urlPath.startsWith("/") ? urlPath.slice(1) : urlPath;
  if (raw === "") return null;
  const segments: string[] = [];
  for (const encoded of raw.split("/")) {
    let segment: string;
    try {
      segment = decodeURIComponent(encoded);
    } catch {
      return null;
    }
    if (
      segment === "" ||
      segment === "." ||
      segment === ".." ||
      segment.includes("/") ||
      segment.includes("\\") ||
      segment.includes("\u0000")
    ) {
      return null;
    }
    segments.push(segment);
  }
  return segments;
}

/** `urlPath` is the raw path after the grant, before any `?` or `#`. */
export async function resolveDesignFile(
  workspaceRoot: string,
  urlPath: string,
): Promise<DesignResolveResult> {
  const segments = decodeSegments(urlPath);
  if (!segments) return NOT_FOUND;
  if (segments.some((segment) => segment.startsWith("."))) return FORBIDDEN;
  const name = segments[segments.length - 1]!;
  if (path.posix.extname(name) !== "" && !mimeTypeFor(name)) return FORBIDDEN;

  let realRoot: string;
  let realTarget: string;
  try {
    realRoot = await fs.realpath(workspaceRoot);
    realTarget = await fs.realpath(path.join(realRoot, ...segments));
  } catch {
    return NOT_FOUND;
  }
  if (!isPathInside(realRoot, realTarget, { allowRoot: false })) return NOT_FOUND;
  // The real file is what gets served: a link inside the root may still name a
  // dotfile or a type outside the allow-list.
  const realSegments = path.relative(realRoot, realTarget).split(path.sep);
  if (realSegments.some((segment) => segment.startsWith("."))) return NOT_FOUND;
  const mimeType = mimeTypeFor(realTarget);
  if (!mimeType) return NOT_FOUND;

  let stat: Awaited<ReturnType<typeof fs.stat>>;
  try {
    stat = await fs.stat(realTarget);
  } catch {
    return NOT_FOUND;
  }
  if (!stat.isFile()) return NOT_FOUND;
  if (stat.size > DESIGN_MAX_FILE_BYTES) return { ok: false, status: 413 };
  return { ok: true, absolute: realTarget, mimeType, size: stat.size };
}
