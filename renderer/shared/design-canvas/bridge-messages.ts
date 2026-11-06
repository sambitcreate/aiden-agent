// The messages a design page's bridge script sends the canvas, read
// defensively: a page runs whatever its file says, so every field is checked
// and bounded before the canvas uses it. See `bridge-source.ts` in main for
// the other side.

import type { DesignLocateResult, DesignPageElement } from "./comments.js";
import { isSourceStamp, type DesignRect } from "./schema.js";

export type DesignBridgeMessage =
  | { type: "ready" | "resize"; docHeight: number }
  | { type: "scroll"; x: number; y: number }
  | { type: "picked"; requestId: string; element: DesignPageElement | null; point: [number, number] }
  | { type: "anchors"; requestId: string; results: Record<string, DesignLocateResult> };

const PREFIX = "aiden-design:";
const MAX_COORD = 10_000_000;
const MAX_SELECTOR_CHARS = 2000;
const MAX_TEXT_CHARS = 200;
const MAX_TAG_CHARS = 64;
const MAX_ID_CHARS = 128;
const MAX_RESULTS = 200;
const MAX_CANDIDATES = 150;

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function coord(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && Math.abs(value) <= MAX_COORD ? value : null;
}

function id(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 && value.length <= MAX_ID_CHARS ? value : null;
}

function rect(value: unknown): DesignRect | null {
  const box = record(value);
  if (!box) return null;
  const x = coord(box.x);
  const y = coord(box.y);
  const w = coord(box.w);
  const h = coord(box.h);
  if (x === null || y === null || w === null || h === null || w < 0 || h < 0) return null;
  return { x, y, w, h };
}

function element(value: unknown): DesignPageElement | null {
  const raw = record(value);
  if (!raw) return null;
  const box = rect(raw.rect);
  if (!box || typeof raw.selector !== "string" || typeof raw.text !== "string" || typeof raw.tag !== "string") return null;
  if (!/^[a-z][a-z0-9-]*$/u.test(raw.tag) || raw.tag.length > MAX_TAG_CHARS) return null;
  const found: DesignPageElement = {
    selector: raw.selector.slice(0, MAX_SELECTOR_CHARS),
    text: raw.text.slice(0, MAX_TEXT_CHARS),
    tag: raw.tag,
    rect: box,
  };
  if (typeof raw.sourcePath === "string" && isSourceStamp(raw.sourcePath)) found.sourcePath = raw.sourcePath;
  const commentId = id(raw.commentId);
  if (commentId) found.commentId = commentId;
  return found;
}

function locateResult(value: unknown): DesignLocateResult | null {
  const raw = record(value);
  if (!raw) return null;
  const result: DesignLocateResult = { candidates: [] };
  if (raw.byId !== undefined) {
    const byId = element(raw.byId);
    if (byId) result.byId = byId;
  }
  if (Array.isArray(raw.candidates)) {
    for (const candidate of raw.candidates.slice(0, MAX_CANDIDATES)) {
      const found = element(candidate);
      if (found) result.candidates.push({ ...found, selectorMatch: record(candidate)?.selectorMatch === true });
    }
  }
  return result;
}

export function parseDesignBridgeMessage(data: unknown): DesignBridgeMessage | null {
  const raw = record(data);
  if (!raw || typeof raw.type !== "string" || !raw.type.startsWith(PREFIX)) return null;
  const type = raw.type.slice(PREFIX.length);
  if (type === "ready" || type === "resize") {
    const docHeight = coord(raw.docHeight);
    return docHeight === null || docHeight < 0 ? null : { type, docHeight };
  }
  if (type === "scroll") {
    const x = coord(raw.x);
    const y = coord(raw.y);
    return x === null || y === null ? null : { type, x, y };
  }
  if (type === "picked") {
    const requestId = id(raw.requestId);
    const point = Array.isArray(raw.point) && raw.point.length === 2 ? [coord(raw.point[0]), coord(raw.point[1])] : null;
    if (!requestId || !point || point[0] === null || point[1] === null) return null;
    const picked = raw.element === null ? null : element(raw.element);
    if (raw.element !== null && !picked) return null;
    return { type, requestId, element: picked, point: [point[0], point[1]] };
  }
  if (type === "anchors") {
    const requestId = id(raw.requestId);
    const results = record(raw.results);
    if (!requestId || !results) return null;
    const parsed: Record<string, DesignLocateResult> = {};
    for (const [key, value] of Object.entries(results).slice(0, MAX_RESULTS)) {
      const result = id(key) ? locateResult(value) : null;
      if (result) parsed[key] = result;
    }
    return { type, requestId, results: parsed };
  }
  return null;
}

/** A message to a page's bridge. */
export type DesignBridgeCommand =
  | { type: "hover-at"; x: number; y: number; wide?: boolean }
  | { type: "hover-at"; clear: true }
  | { type: "pick-at"; requestId: string; x: number; y: number; wide?: boolean }
  | { type: "locate"; requestId: string; items: { commentId: string; selector: string; text: string; tag: string }[] }
  | { type: "highlight"; commentId: string; selector?: string }
  | { type: "highlight"; clear: true };

/** Posts a command to a page. Pages are sandboxed without an origin, so the target is `*`. */
export function postToDesignPage(target: Window | null | undefined, command: DesignBridgeCommand): void {
  if (!target) return;
  try {
    target.postMessage({ ...command, type: `${PREFIX}${command.type}` }, "*");
  } catch {
    // A frame that went away cannot be told anything.
  }
}
