// The messages a live app frame's bridge sends the canvas (design mode v2
// Phase 3a, D12, S11), read defensively. The bridge runs in the app's own
// page, which runs first and can replace any global, so every field is checked
// and bounded and anything unknown or oversized is dropped. See
// `app-bridge-source.ts` in main for the other side.

import { parseDesignBridgeMessage, type DesignBridgeMessage } from "./bridge-messages.js";

export const APP_BRIDGE_LIMITS = {
  route: 2048,
  message: 500,
  component: 120,
  owners: 8,
  path: 512,
  line: 10_000_000,
  requestId: 128,
} as const;

/**
 * A page's breakpoints (Phase 3c, S91): up to `count` whole widths in CSS px,
 * from `min` to `max`, strictly ascending. The bridge keeps 200–4000 before
 * posting; the wider range here only bounds what a page can claim.
 */
export const APP_BREAKPOINT_LIMITS = { min: 1, max: 8000, count: 24 } as const;

export type AppBridgeErrorKind = "error" | "rejection" | "overlay" | "module";
export type AppBridgeSourceAt = { path: string; line: number };

export type AppBridgeMessage =
  | { type: "ready" }
  | { type: "route"; path: string }
  | { type: "error"; kind: AppBridgeErrorKind; message: string; at?: AppBridgeSourceAt }
  | { type: "hmr" }
  | { type: "escape" }
  | { type: "breakpoints"; widths: number[] }
  | { type: "source"; requestId: string; component?: string; owners: string[]; path?: string; line?: number }
  | Extract<DesignBridgeMessage, { type: "picked" | "anchors" }>;

/** A message to an app frame's bridge. */
export type AppBridgeCommand =
  | { type: "set-scheme"; dark: boolean }
  | { type: "source-at"; requestId: string; x: number; y: number }
  | { type: "hover-at"; x: number; y: number; wide?: boolean }
  | { type: "hover-at"; clear: true }
  | { type: "pick-at"; requestId: string; x: number; y: number; wide?: boolean }
  | { type: "locate"; requestId: string; items: { commentId: string; selector: string; text: string; tag: string }[] }
  | { type: "highlight"; commentId: string; selector?: string }
  | { type: "highlight"; clear: true };

const PREFIX = "aiden-app:";
const ERROR_KINDS = new Set<string>(["error", "rejection", "overlay", "module"]);
/** The origins an app frame can have: plain http on a loopback host, with a port. */
const APP_ORIGIN = /^http:\/\/(?:127\.0\.0\.1|localhost|\[::1\]):\d{1,5}$/u;

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function bounded(value: unknown, max: number): string | null {
  return typeof value === "string" && value.length > 0 && value.length <= max ? value : null;
}

function lineNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value > 0 && value <= APP_BRIDGE_LIMITS.line ? value : null;
}

function hasControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

/**
 * A page-reported source path the canvas may show: relative POSIX, under the
 * app root, with no `..`, no Vite-internal prefix, no query or fragment. Any
 * main-side use resolves it again inside the app root.
 */
export function isAppSourcePath(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > APP_BRIDGE_LIMITS.path) return false;
  if (value.startsWith("/") || value.includes("\\") || /[?#]/u.test(value) || hasControlCharacter(value)) return false;
  if (/^(?:@fs|@id|node_modules)(?:\/|$)/u.test(value)) return false;
  return !value.split("/").some((segment) => segment === ".." || segment === "." || segment === "");
}

function sourceAt(value: unknown): AppBridgeSourceAt | null {
  const raw = record(value);
  if (!raw || !isAppSourcePath(raw.path)) return null;
  const line = lineNumber(raw.line);
  return line === null ? null : { path: raw.path, line };
}

function breakpointWidths(value: unknown): number[] | null {
  if (!Array.isArray(value) || value.length > APP_BREAKPOINT_LIMITS.count) return null;
  const widths: number[] = [];
  for (const width of value) {
    if (typeof width !== "number" || !Number.isInteger(width)) return null;
    if (width < APP_BREAKPOINT_LIMITS.min || width > APP_BREAKPOINT_LIMITS.max) return null;
    if (widths.length > 0 && width <= widths[widths.length - 1]!) return null;
    widths.push(width);
  }
  return widths;
}

/**
 * Parses a message posted from an app frame. `origin` is the message event's
 * origin; anything that isn't a loopback app origin is dropped.
 */
export function parseAppBridgeMessage(data: unknown, origin: string): AppBridgeMessage | null {
  if (!APP_ORIGIN.test(origin)) return null;
  const raw = record(data);
  if (!raw || typeof raw.type !== "string" || !raw.type.startsWith(PREFIX)) return null;
  const type = raw.type.slice(PREFIX.length);
  if (type === "ready" || type === "hmr" || type === "escape") return { type };
  if (type === "route") {
    const path = bounded(raw.path, APP_BRIDGE_LIMITS.route);
    return path && path.startsWith("/") ? { type, path } : null;
  }
  if (type === "error") {
    if (typeof raw.kind !== "string" || !ERROR_KINDS.has(raw.kind)) return null;
    if (typeof raw.message !== "string" || raw.message.length > APP_BRIDGE_LIMITS.message) return null;
    const message: AppBridgeMessage = { type, kind: raw.kind as AppBridgeErrorKind, message: raw.message };
    // A frame outside the app's own files is left out; the error still shows.
    const at = raw.at === undefined ? null : sourceAt(raw.at);
    if (at) message.at = at;
    return message;
  }
  if (type === "breakpoints") {
    const widths = breakpointWidths(raw.widths);
    return widths ? { type, widths } : null;
  }
  if (type === "source") {
    const requestId = bounded(raw.requestId, APP_BRIDGE_LIMITS.requestId);
    if (!requestId || !Array.isArray(raw.owners) || raw.owners.length > APP_BRIDGE_LIMITS.owners) return null;
    const owners: string[] = [];
    for (const owner of raw.owners) {
      const name = bounded(owner, APP_BRIDGE_LIMITS.component);
      if (!name) return null;
      owners.push(name);
    }
    const source: Extract<AppBridgeMessage, { type: "source" }> = { type, requestId, owners };
    if (raw.component !== undefined) {
      const component = bounded(raw.component, APP_BRIDGE_LIMITS.component);
      if (!component) return null;
      source.component = component;
    }
    // A line means nothing without its file, and a bad path drops both.
    if (raw.path !== undefined && isAppSourcePath(raw.path)) {
      source.path = raw.path;
      const line = lineNumber(raw.line);
      if (line !== null) source.line = line;
    }
    return source;
  }
  if (type === "picked" || type === "anchors") {
    const parsed = parseDesignBridgeMessage({ ...raw, type: `aiden-design:${type}` });
    return parsed && (parsed.type === "picked" || parsed.type === "anchors") ? parsed : null;
  }
  return null;
}

/**
 * Posts a command to an app frame. The frame has its app's origin, so the
 * message is addressed to it: if the frame has navigated elsewhere, nothing
 * is delivered.
 */
export function postToAppPage(target: Window | null | undefined, origin: string, command: AppBridgeCommand): void {
  if (!target || !APP_ORIGIN.test(origin)) return;
  try {
    target.postMessage({ ...command, type: `${PREFIX}${command.type}` }, origin);
  } catch {
    // A frame that went away cannot be told anything.
  }
}
