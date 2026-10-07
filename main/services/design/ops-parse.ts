// Exact-shape parsers for renderer-supplied Design Studio payloads.
import { hasExactKeys, isRecord } from "../../shared/guards.js";
import {
  MAX_DESIGN_CONTEXT_TARGETS,
  MAX_DESIGN_CONTEXT_TARGET_BYTES,
  MAX_DESIGN_PROJECT_TITLE_CHARS,
  MAX_DESIGN_SCREENS_PER_PROJECT,
} from "../../../renderer/shared/design/limits.js";
import {
  DESIGN_FRAME_PRESETS,
  type DesignAspect,
  type DesignContextChip,
  type DesignElementSelection,
  type DesignProjectOp,
  type DesignRunRequest,
  type DesignScreenFrame,
  type DesignViewport,
} from "../../../renderer/shared/design/types.js";

const DESIGN_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/u;
const TAG_NAME = /^[a-z][a-z0-9-]{0,31}$/u;
const ELEMENT_ID = /^[A-Za-z0-9._:-]{1,120}$/u;
const ROLE = /^[a-z][a-z-]{0,63}$/u;
const COORDINATE_LIMIT = 1_000_000;
const ASPECTS: ReadonlySet<string> = new Set(["layout", "color", "typography", "content"]);

/** Ids become directory and file names, so dots and slashes are never allowed. */
export function isDesignId(value: unknown): value is string {
  return typeof value === "string" && DESIGN_ID.test(value);
}

/**
 * True for text that must never reach a title, label or prompt: ASCII and C1 controls, line and
 * paragraph separators, bidi embedding/override/isolate controls, and malformed UTF-16.
 */
export function hasControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || (code >= 0x7f && code <= 0x9f)) return true;
    if (code === 0x2028 || code === 0x2029) return true;
    if ((code >= 0x202a && code <= 0x202e) || (code >= 0x2066 && code <= 0x2069)) return true;
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return true;
    }
  }
  return false;
}

function boundedText(value: unknown, max: number): string | undefined {
  if (typeof value !== "string" || value.length === 0 || value.length > max) return undefined;
  return hasControlCharacter(value) ? undefined : value;
}

export function parseDesignTitle(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  return boundedText(value.trim(), MAX_DESIGN_PROJECT_TITLE_CHARS);
}

function finiteBetween(value: unknown, min: number, max: number): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= min && value <= max;
}

function coordinate(value: unknown): value is number {
  return finiteBetween(value, -COORDINATE_LIMIT, COORDINATE_LIMIT);
}

export function parseDesignViewport(value: unknown): DesignViewport | undefined {
  if (!isRecord(value) || !hasExactKeys(value, ["x", "y", "zoom"])) return undefined;
  if (!coordinate(value.x) || !coordinate(value.y) || !finiteBetween(value.zoom, 0.05, 8)) {
    return undefined;
  }
  return { x: value.x, y: value.y, zoom: value.zoom };
}

export function parseDesignScreenFrame(value: unknown): DesignScreenFrame | undefined {
  if (!isRecord(value) || !hasExactKeys(value, ["preset", "width", "height"])) return undefined;
  const { preset, width, height } = value;
  if (!finiteBetween(width, 240, 3840) || !finiteBetween(height, 240, 4320)) return undefined;
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height)) return undefined;
  if (preset === "custom") return { preset, width, height };
  if (preset !== "desktop" && preset !== "tablet" && preset !== "phone") return undefined;
  const expected = DESIGN_FRAME_PRESETS[preset];
  return width === expected.width && height === expected.height
    ? { preset, width, height }
    : undefined;
}

function idsOnly(
  value: Record<string, unknown>,
  keys: readonly string[],
): Record<string, string> | undefined {
  if (!hasExactKeys(value, ["op", ...keys])) return undefined;
  const ids: Record<string, string> = {};
  for (const key of keys) {
    const candidate = value[key];
    if (!isDesignId(candidate)) return undefined;
    ids[key] = candidate;
  }
  return ids;
}

function parseLayoutNodes(value: unknown): { id: string; x: number; y: number }[] | undefined {
  if (!Array.isArray(value) || value.length > MAX_DESIGN_SCREENS_PER_PROJECT) return undefined;
  const seen = new Set<string>();
  const nodes: { id: string; x: number; y: number }[] = [];
  for (const node of value) {
    if (!isRecord(node) || !hasExactKeys(node, ["id", "x", "y"])) return undefined;
    if (!isDesignId(node.id) || seen.has(node.id) || !coordinate(node.x) || !coordinate(node.y)) {
      return undefined;
    }
    seen.add(node.id);
    nodes.push({ id: node.id, x: node.x, y: node.y });
  }
  return nodes;
}

export function parseDesignProjectOp(value: unknown): DesignProjectOp | undefined {
  if (!isRecord(value) || typeof value.op !== "string") return undefined;
  switch (value.op) {
    case "rename": {
      if (!hasExactKeys(value, ["op", "title"])) return undefined;
      const title = parseDesignTitle(value.title);
      return title === undefined ? undefined : { op: "rename", title };
    }
    case "setLayout": {
      if (!hasExactKeys(value, ["op", "viewport", "nodes"])) return undefined;
      const viewport = parseDesignViewport(value.viewport);
      const nodes = parseLayoutNodes(value.nodes);
      return viewport && nodes ? { op: "setLayout", viewport, nodes } : undefined;
    }
    case "setActiveRevision": {
      const ids = idsOnly(value, ["screenId", "revisionId"]);
      return ids
        ? { op: "setActiveRevision", screenId: ids.screenId!, revisionId: ids.revisionId! }
        : undefined;
    }
    case "setScreenFrame": {
      if (!hasExactKeys(value, ["op", "screenId", "frame"]) || !isDesignId(value.screenId)) {
        return undefined;
      }
      const frame = parseDesignScreenFrame(value.frame);
      return frame ? { op: "setScreenFrame", screenId: value.screenId, frame } : undefined;
    }
    case "chooseDirection": {
      const ids = idsOnly(value, ["directionSetId", "screenId"]);
      return ids
        ? { op: "chooseDirection", directionSetId: ids.directionSetId!, screenId: ids.screenId! }
        : undefined;
    }
    case "archiveDirectionSet": {
      if (
        !hasExactKeys(value, ["op", "directionSetId", "archived"]) ||
        !isDesignId(value.directionSetId) ||
        typeof value.archived !== "boolean"
      ) {
        return undefined;
      }
      return { op: "archiveDirectionSet", directionSetId: value.directionSetId, archived: value.archived };
    }
    case "deleteScreen": {
      const ids = idsOnly(value, ["screenId"]);
      return ids ? { op: "deleteScreen", screenId: ids.screenId! } : undefined;
    }
    case "settleRun": {
      // Discard is the only settlement: a run's accepted designs are published when it ends.
      if (
        !hasExactKeys(value, ["op", "runId", "decision"]) ||
        !isDesignId(value.runId) ||
        value.decision !== "discard"
      ) {
        return undefined;
      }
      return { op: "settleRun", runId: value.runId, decision: "discard" };
    }
    default:
      return undefined;
  }
}

export function parseDesignRunRequest(value: unknown): DesignRunRequest | undefined {
  if (!isRecord(value)) return undefined;
  if (value.op === "refine") {
    if (!hasExactKeys(value, ["op", "screenId", "baseRevisionId"])) return undefined;
    if (!isDesignId(value.screenId) || !isDesignId(value.baseRevisionId)) return undefined;
    return { op: "refine", screenId: value.screenId, baseRevisionId: value.baseRevisionId };
  }
  if (value.op !== "explore") return undefined;
  if (
    !hasExactKeys(value, ["op", "count", "creativeRange", "aspects"], ["baseRevisionId", "resumeRunId"])
  ) {
    return undefined;
  }
  const { count, creativeRange } = value;
  if (count !== 2 && count !== 3 && count !== 4) return undefined;
  if (creativeRange !== "close" && creativeRange !== "balanced" && creativeRange !== "bold") {
    return undefined;
  }
  if (!Array.isArray(value.aspects) || value.aspects.length > ASPECTS.size) return undefined;
  const aspects: DesignAspect[] = [];
  for (const aspect of value.aspects) {
    if (typeof aspect !== "string" || !ASPECTS.has(aspect) || aspects.includes(aspect as DesignAspect)) {
      return undefined;
    }
    aspects.push(aspect as DesignAspect);
  }
  if (value.baseRevisionId !== undefined && !isDesignId(value.baseRevisionId)) return undefined;
  if (value.resumeRunId !== undefined && !isDesignId(value.resumeRunId)) return undefined;
  return {
    op: "explore",
    count,
    creativeRange,
    aspects,
    ...(value.baseRevisionId === undefined ? {} : { baseRevisionId: value.baseRevisionId }),
    ...(value.resumeRunId === undefined ? {} : { resumeRunId: value.resumeRunId }),
  };
}

export function parseDesignElementSelection(value: unknown): DesignElementSelection | undefined {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ["tagName", "label", "selector"], ["elementId", "role", "text"])
  ) {
    return undefined;
  }
  if (typeof value.tagName !== "string" || !TAG_NAME.test(value.tagName)) return undefined;
  const label = typeof value.label === "string" ? boundedText(value.label.trim(), 120) : undefined;
  const selector = boundedText(value.selector, 512);
  if (label === undefined || selector === undefined) return undefined;
  const element: DesignElementSelection = { tagName: value.tagName, label, selector };
  if (value.elementId !== undefined) {
    if (typeof value.elementId !== "string" || !ELEMENT_ID.test(value.elementId)) return undefined;
    element.elementId = value.elementId;
  }
  if (value.role !== undefined) {
    if (typeof value.role !== "string" || !ROLE.test(value.role)) return undefined;
    element.role = value.role;
  }
  if (value.text !== undefined) {
    const text = boundedText(value.text, 500);
    if (text === undefined) return undefined;
    element.text = text;
  }
  if (Buffer.byteLength(JSON.stringify(element), "utf8") > MAX_DESIGN_CONTEXT_TARGET_BYTES) {
    return undefined;
  }
  return element;
}

export function parseDesignContextChips(value: unknown): DesignContextChip[] | undefined {
  // Repeats are collapsed, so the raw list may exceed the target budget; it is still bounded.
  if (!Array.isArray(value) || value.length > MAX_DESIGN_CONTEXT_TARGETS * 4) return undefined;
  const chips: DesignContextChip[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    if (!isRecord(item) || !isDesignId(item.screenId) || !isDesignId(item.revisionId)) {
      return undefined;
    }
    let chip: DesignContextChip;
    if (item.kind === "screen" && hasExactKeys(item, ["kind", "screenId", "revisionId"])) {
      chip = { kind: "screen", screenId: item.screenId, revisionId: item.revisionId };
    } else if (
      item.kind === "element" &&
      hasExactKeys(item, ["kind", "screenId", "revisionId", "element"])
    ) {
      const element = parseDesignElementSelection(item.element);
      if (!element) return undefined;
      chip = { kind: "element", screenId: item.screenId, revisionId: item.revisionId, element };
    } else {
      return undefined;
    }
    const key = JSON.stringify(chip);
    if (seen.has(key)) continue;
    seen.add(key);
    chips.push(chip);
    if (chips.length > MAX_DESIGN_CONTEXT_TARGETS) return undefined;
  }
  return chips;
}
