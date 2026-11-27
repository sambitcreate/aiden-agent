// Live app frames (design mode v2 Phase 3a, D15 and D16): the pure rules the
// renderer, main and the canvas tools share. An app frame names an app root
// and a route; main decides the origin at mount time, so no URL is stored.

import { consentDisplayText } from "../design-app.js";
import { isDesignRelativePath } from "./schema.js";

/** Height of a frame's title bar; a page or app frame's content box is the rest. */
export const DESIGN_FRAME_HEADER_PX = 36;

/** The iframe's sandbox (S10): no modals, popups, downloads or top navigation. */
export const APP_FRAME_SANDBOX = "allow-scripts allow-same-origin allow-forms";

const DENIED_FEATURES = [
  "camera",
  "microphone",
  "geolocation",
  "display-capture",
  "clipboard-read",
  "clipboard-write",
  "payment",
  "usb",
  "serial",
  "hid",
  "bluetooth",
  "midi",
  "publickey-credentials-get",
  "publickey-credentials-create",
  "screen-wake-lock",
  "xr-spatial-tracking",
  "picture-in-picture",
  "fullscreen",
  "window-management",
  "local-fonts",
  "idle-detection",
  "storage-access",
  "web-share",
  "otp-credentials",
  "identity-credentials-get",
  "direct-sockets",
  "autoplay",
  // A page's own focus() can't take focus until the person clicks into it (S75, K1). Takes
  // effect only with Blink's BlockingFocusWithoutUserActivation, which main turns on with the flag.
  "focus-without-user-activation",
] as const;

/** The iframe's Permissions Policy: every listed feature off (defence in depth beside main's permission layer). */
export const APP_FRAME_ALLOW = DENIED_FEATURES.map((feature) => `${feature} 'none'`).join("; ");

export const APP_FRAME_LIMITS = {
  routeChars: 2048,
  minViewport: 200,
  maxViewport: 4000,
  minScale: 0.05,
  maxScale: 2,
  labelChars: 60,
  sourcePathChars: 512,
} as const;

const NAME_PREFIX = "aiden-app:";
const FRAME_ID = /^[A-Za-z0-9._-]{1,128}$/u;
const MOUNT_TOKEN = /^[A-Za-z0-9_-]{16,64}$/u;
// eslint-disable-next-line no-control-regex -- control characters are what this refuses.
const CONTROL = /[\u0000-\u001f\u007f]/u;

/** A route of the app: `/`-rooted, same-origin, no fragment, no hidden characters, at most 2 048 characters. */
export function isAppRoute(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > APP_FRAME_LIMITS.routeChars) return false;
  if (!value.startsWith("/") || value.startsWith("//") || value.includes("\\") || value.includes("#")) return false;
  if (CONTROL.test(value) || consentDisplayText(value) !== value) return false;
  try {
    return new URL(value, "http://x.invalid").origin === "http://x.invalid";
  } catch {
    return false;
  }
}

/** A stored route with its fragment dropped, or null when it isn't a route. */
export function appRouteFrom(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const hash = value.indexOf("#");
  const route = hash >= 0 ? value.slice(0, hash) : value;
  return isAppRoute(route) ? route : null;
}

/** The workspace folder (`.`) or a plain relative folder. */
export function isAppRoot(value: unknown): value is string {
  return value === "." || isDesignRelativePath(value);
}

export function roundAppScale(scale: number): number {
  return Math.round(scale * 10_000) / 10_000;
}

export function isAppViewportSide(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= APP_FRAME_LIMITS.minViewport &&
    value <= APP_FRAME_LIMITS.maxViewport
  );
}

export function isAppScale(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= APP_FRAME_LIMITS.minScale && value <= APP_FRAME_LIMITS.maxScale;
}

/** The frame's box on the canvas: the viewport times the scale, rounded, plus the title row (S62). */
export function appFrameBox(viewport: { width: number; height: number }, scale: number): { w: number; h: number } {
  return {
    w: Math.round(viewport.width * scale),
    h: Math.round(viewport.height * scale) + DESIGN_FRAME_HEADER_PX,
  };
}

/** The largest 4-decimal scale at or below `scale` whose box fits `maxSize`. */
export function fitAppScale(viewport: { width: number; height: number }, scale: number, maxSize: number): number {
  let fitted = roundAppScale(scale);
  const box = appFrameBox(viewport, fitted);
  if (box.w <= maxSize && box.h <= maxSize) return fitted;
  fitted = Math.min(fitted, Math.floor((maxSize / viewport.width) * 10_000) / 10_000, Math.floor(((maxSize - DESIGN_FRAME_HEADER_PX) / viewport.height) * 10_000) / 10_000);
  while (fitted > APP_FRAME_LIMITS.minScale) {
    const next = appFrameBox(viewport, fitted);
    if (next.w <= maxSize && next.h <= maxSize) break;
    fitted = roundAppScale(fitted - 0.0001);
  }
  return fitted;
}

/** The viewport an app frame is drawn at when it names none. */
export const APP_DEFAULT_VIEWPORT = { width: 1280, height: 800 } as const;

/**
 * An app frame's scale after a corner resize to `w` × `h` (D15, S62): the
 * aspect stays, so the width (else the height, less the title row) decides
 * it, rounded to 4 decimals, kept in range and inside `maxSize`.
 */
export function appResizeScale(
  viewport: { width: number; height: number } | undefined,
  w: number | undefined,
  h: number | undefined,
  maxSize: number,
): number {
  const shown = viewport ?? APP_DEFAULT_VIEWPORT;
  const raw = w !== undefined ? w / shown.width : ((h ?? 0) - DESIGN_FRAME_HEADER_PX) / shown.height;
  const scale = Math.min(APP_FRAME_LIMITS.maxScale, Math.max(APP_FRAME_LIMITS.minScale, roundAppScale(raw)));
  return fitAppScale(shown, scale, maxSize);
}

/** The scale an app frame draws at when it names none. */
export const APP_DEFAULT_SCALE = 0.5;

/** A side of an app frame an edge drag moves (3c, S89). */
export type AppResizeSide = "left" | "right" | "top" | "bottom";
/** What a resize of an app frame changes: a corner keeps the viewport and scales (D15), an edge reflows (S89). */
export type AppResizeMode = "corner" | AppResizeSide;

/** The largest viewport side, from `limit` down, whose box side fits `room` at `scale`. */
function largestSide(scale: number, room: number, limit: number): number {
  let side = Math.min(limit, Math.floor(room / scale));
  while (side > APP_FRAME_LIMITS.minViewport && Math.round(side * scale) > room) side -= 1;
  return Math.max(APP_FRAME_LIMITS.minViewport, side);
}

function viewportSide(raw: number, scale: number, room: number): number {
  const rounded = Number.isFinite(raw) ? Math.round(raw) : APP_FRAME_LIMITS.minViewport;
  return Math.min(largestSide(scale, room, APP_FRAME_LIMITS.maxViewport), Math.max(APP_FRAME_LIMITS.minViewport, rounded));
}

/**
 * An app frame after an edge drag (3c, S89): the dragged side's viewport
 * length follows the box at the frame's own scale, kept to 200–4000 and to
 * `maxSize`; the box is then recomputed (S62), and a left or top drag keeps
 * the opposite edge where it was, even when the drag went past the clamp.
 */
export function appEdgeResize(
  frame: { x: number; y: number; w: number; h: number; viewport?: { width: number; height: number }; scale?: number },
  side: AppResizeSide,
  drag: { x?: number; y?: number; w?: number; h?: number },
  maxSize: number,
): { x: number; y: number; w: number; h: number; viewport: { width: number; height: number } } {
  const scale = frame.scale ?? APP_DEFAULT_SCALE;
  const own = frame.viewport ?? APP_DEFAULT_VIEWPORT;
  const viewport =
    side === "left" || side === "right"
      ? { width: viewportSide((drag.w ?? frame.w) / scale, scale, maxSize), height: own.height }
      : { width: own.width, height: viewportSide(((drag.h ?? frame.h) - DESIGN_FRAME_HEADER_PX) / scale, scale, maxSize - DESIGN_FRAME_HEADER_PX) };
  const box = appFrameBox(viewport, scale);
  return {
    x: side === "left" ? frame.x + frame.w - box.w : frame.x,
    y: side === "top" ? frame.y + frame.h - box.h : frame.y,
    ...box,
    viewport,
  };
}

/** The box bounds an edge control gives xyflow, so its own values never pass the viewport's limits (S89). */
export function appEdgeBounds(
  scale: number,
  minSize: number,
  maxSize: number,
): { minWidth: number; maxWidth: number; minHeight: number; maxHeight: number } {
  const min = Math.round(APP_FRAME_LIMITS.minViewport * scale);
  const max = Math.round(APP_FRAME_LIMITS.maxViewport * scale);
  return {
    minWidth: Math.max(minSize, min),
    maxWidth: Math.min(maxSize, max),
    minHeight: Math.max(minSize, min + DESIGN_FRAME_HEADER_PX),
    maxHeight: Math.min(maxSize, max + DESIGN_FRAME_HEADER_PX),
  };
}

/**
 * An app frame shown at another viewport (S85, S92): it keeps its scale,
 * lowered only as far as its box needs to fit `maxSize`.
 */
export function withAppViewport(
  frame: { viewport?: { width: number; height: number }; scale?: number },
  viewport: { width: number; height: number },
  maxSize: number,
): { viewport: { width: number; height: number }; scale: number; w: number; h: number } {
  const scale = fitAppScale(viewport, frame.scale ?? APP_DEFAULT_SCALE, maxSize);
  return { viewport: { width: viewport.width, height: viewport.height }, scale, ...appFrameBox(viewport, scale) };
}

/** The iframe's `name`: the frame id and a one-use mount token (D2). Throws for an id it can't carry. */
export function appFrameName(frameId: string, mountToken: string): string {
  if (!FRAME_ID.test(frameId)) throw new Error("This frame id can't name a live app frame.");
  if (!MOUNT_TOKEN.test(mountToken)) throw new Error("The mount token isn't valid.");
  return `${NAME_PREFIX}${frameId}:${mountToken}`;
}

export function parseAppFrameName(name: string): { frameId: string; mountToken: string } | null {
  if (typeof name !== "string" || !name.startsWith(NAME_PREFIX)) return null;
  const parts = name.slice(NAME_PREFIX.length).split(":");
  if (parts.length !== 2) return null;
  const [frameId, mountToken] = parts as [string, string];
  return FRAME_ID.test(frameId) && MOUNT_TOKEN.test(mountToken) ? { frameId, mountToken } : null;
}

/** Whether a frame id can name a live app frame's iframe. */
export function isAppFrameId(frameId: string): boolean {
  return FRAME_ID.test(frameId);
}

/**
 * A path the page reported (D12): relative POSIX, no `..` or `.` segment, not
 * under `@fs/`, `@id/` or `node_modules/`, no query or fragment, at most 512
 * characters. Main resolves it with `realpath` inside the app root before use.
 */
export function isAppSourcePath(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > APP_FRAME_LIMITS.sourcePathChars) return false;
  if (value.includes("?") || value.includes("#")) return false;
  if (/^(?:@fs|@id|node_modules)(?:\/|$)/u.test(value)) return false;
  return isDesignRelativePath(value);
}

/** The same-origin module path a bridge reported, relative to the origin, or null (D12). */
export function appSourcePath(origin: string, url: string): string | null {
  if (typeof url !== "string" || !url.startsWith(`${origin}/`)) return null;
  let rest = url.slice(origin.length);
  const cut = rest.search(/[?#]/u);
  if (cut >= 0) rest = rest.slice(0, cut);
  let decoded: string;
  try {
    decoded = decodeURIComponent(rest);
  } catch {
    return null;
  }
  const segments = decoded.split("/").slice(1);
  if (segments.some((segment) => segment === ".." || segment === ".")) return null;
  const path = segments.join("/");
  return isAppSourcePath(path) ? path : null;
}
