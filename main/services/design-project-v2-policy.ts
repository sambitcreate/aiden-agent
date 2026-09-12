/** Main-owned semantic policies used by the Design Project V2 contract. */

import type {
  DesignProjectTitlePolicyV2,
  DesignProjectViewport,
  DesignScreenFramePresetV2,
  DesignScreenPresentationV2,
} from "../../renderer/shared/design-projects.js";

export type {
  DesignProjectTitlePolicyV2,
  DesignScreenFramePresetV2,
  DesignScreenFrameV2,
  DesignScreenPresentationV2,
  DesignScreenSurfaceV2,
} from "../../renderer/shared/design-projects.js";

export const DEFAULT_BLANK_DESIGN_PROJECT_TITLE = "Untitled Design";
export const MAX_DESIGN_SCREEN_FRAME_DIMENSION = 16_384;

const MAX_TITLE_CHARACTERS = 160;
const MAX_TITLE_BYTES = 512;
const SAFE_OPAQUE_ID = /^[A-Za-z0-9._:@+-]+$/u;

export interface DesignProjectTitleStateV2 {
  title: string;
  titlePolicy: DesignProjectTitlePolicyV2;
}

const PRESET_FRAMES: Readonly<
  Record<Exclude<DesignScreenFramePresetV2, "custom">, Readonly<{ width: number; height: number }>>
> = {
  desktop: { width: 1200, height: 760 },
  tablet: { width: 768, height: 900 },
  phone: { width: 390, height: 844 },
};

export const DEFAULT_NEW_DESIGN_SCREEN_PRESENTATION: DesignScreenPresentationV2 = {
  surface: "unknown",
  frame: { preset: "desktop", width: 1_200, height: 760 },
};

function exactKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  required: readonly string[] = allowed,
): boolean {
  const allowedSet = new Set(allowed);
  return (
    Object.keys(value).every((key) => allowedSet.has(key)) &&
    required.every((key) => Object.prototype.hasOwnProperty.call(value, key))
  );
}

function normalizeTitle(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const title = value.normalize("NFKC").trim();
  if (
    title.length === 0 ||
    Array.from(title).length > MAX_TITLE_CHARACTERS ||
    Buffer.byteLength(title, "utf8") > MAX_TITLE_BYTES
  ) {
    return undefined;
  }
  for (let index = 0; index < title.length; index += 1) {
    const code = title.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) return undefined;
  }
  return title;
}

function normalizeOpaqueId(value: unknown): string | undefined {
  return typeof value === "string" &&
    value.length > 0 &&
    value.length <= 256 &&
    value.normalize("NFKC") === value &&
    SAFE_OPAQUE_ID.test(value)
    ? value
    : undefined;
}

function requireTitle(value: unknown): string {
  const title = normalizeTitle(value);
  if (!title) throw new Error("Invalid Design Project title.");
  return title;
}

function requireOpaqueId(value: unknown, label: string): string {
  const id = normalizeOpaqueId(value);
  if (!id) throw new Error(`Invalid ${label}.`);
  return id;
}

function validScreenCount(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

export function normalizeDesignProjectTitlePolicyV2(
  value: unknown,
): DesignProjectTitlePolicyV2 | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const policy = value as Record<string, unknown>;
  if (policy.state === "auto-eligible" || policy.state === "manual") {
    return exactKeys(policy, ["state"]) ? { state: policy.state } : undefined;
  }
  if (
    policy.state !== "auto-applied" ||
    !exactKeys(policy, ["state", "sourceLineageId", "sourceMediaId"])
  ) {
    return undefined;
  }
  const sourceLineageId = normalizeOpaqueId(policy.sourceLineageId);
  const sourceMediaId = normalizeOpaqueId(policy.sourceMediaId);
  return sourceLineageId && sourceMediaId
    ? { state: "auto-applied", sourceLineageId, sourceMediaId }
    : undefined;
}

export function normalizeDesignProjectTitleStateV2(
  value: unknown,
): DesignProjectTitleStateV2 | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const state = value as Record<string, unknown>;
  if (!exactKeys(state, ["title", "titlePolicy"])) return undefined;
  const title = normalizeTitle(state.title);
  const titlePolicy = normalizeDesignProjectTitlePolicyV2(state.titlePolicy);
  if (!title || !titlePolicy) return undefined;
  if (titlePolicy.state === "auto-eligible" && title !== DEFAULT_BLANK_DESIGN_PROJECT_TITLE) {
    return undefined;
  }
  return { title, titlePolicy };
}

export function createDesignProjectTitleState(input: {
  title?: unknown;
  origin: "blank" | "manual";
}): DesignProjectTitleStateV2 {
  if (input.origin === "blank") {
    const title = requireTitle(input.title ?? DEFAULT_BLANK_DESIGN_PROJECT_TITLE);
    if (title !== DEFAULT_BLANK_DESIGN_PROJECT_TITLE) {
      throw new Error("Only the blank Design Project title can be auto-eligible.");
    }
    return {
      title,
      titlePolicy: { state: "auto-eligible" },
    };
  }
  return { title: requireTitle(input.title), titlePolicy: { state: "manual" } };
}

/** V1 title provenance is unknowable, so migration conservatively protects it as manual. */
export function migrateDesignProjectTitleStateFromV1(title: unknown): DesignProjectTitleStateV2 {
  return { title: requireTitle(title), titlePolicy: { state: "manual" } };
}

export function applyManualDesignProjectTitle(
  _current: DesignProjectTitleStateV2,
  title: unknown,
): DesignProjectTitleStateV2 {
  return { title: requireTitle(title), titlePolicy: { state: "manual" } };
}

/**
 * Apply one candidate only across the first successful Screen publication
 * boundary. Retries and later publications cannot silently rename a project.
 */
export function applyFirstPublishedScreenTitle(input: {
  current: DesignProjectTitleStateV2;
  candidateTitle: unknown;
  successfulScreenCountBefore: number;
  successfulScreenCountAfter: number;
  sourceLineageId: unknown;
  sourceMediaId: unknown;
}): DesignProjectTitleStateV2 {
  if (input.current.titlePolicy.state !== "auto-eligible") return input.current;
  if (
    !validScreenCount(input.successfulScreenCountBefore) ||
    !validScreenCount(input.successfulScreenCountAfter) ||
    input.successfulScreenCountAfter < input.successfulScreenCountBefore
  ) {
    throw new Error("Invalid successful Screen publication counts.");
  }
  if (input.successfulScreenCountBefore !== 0 || input.successfulScreenCountAfter === 0) {
    return input.current;
  }
  const title = normalizeTitle(input.candidateTitle);
  if (!title) {
    // Eligibility is a one-shot transition tied to the first successful
    // Screen publication. An unusable generated label must not let a later
    // Screen silently rename the project after recovery removes the first.
    return { title: input.current.title, titlePolicy: { state: "manual" } };
  }
  const sourceLineageId = requireOpaqueId(input.sourceLineageId, "title source lineage identity");
  const sourceMediaId = requireOpaqueId(input.sourceMediaId, "title source media identity");
  return {
    title,
    titlePolicy: { state: "auto-applied", sourceLineageId, sourceMediaId },
  };
}

function normalizeFrameDimension(value: unknown): number | undefined {
  return Number.isSafeInteger(value) &&
    (value as number) >= 1 &&
    (value as number) <= MAX_DESIGN_SCREEN_FRAME_DIMENSION
    ? (value as number)
    : undefined;
}

export function normalizeDesignScreenPresentationV2(
  value: unknown,
): DesignScreenPresentationV2 | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const presentation = value as Record<string, unknown>;
  if (
    !exactKeys(presentation, ["surface", "frame"]) ||
    (presentation.surface !== "app" &&
      presentation.surface !== "web" &&
      presentation.surface !== "unknown") ||
    !presentation.frame ||
    typeof presentation.frame !== "object" ||
    Array.isArray(presentation.frame)
  ) {
    return undefined;
  }
  const frame = presentation.frame as Record<string, unknown>;
  if (
    !exactKeys(frame, ["preset", "width", "height"]) ||
    (frame.preset !== "phone" &&
      frame.preset !== "tablet" &&
      frame.preset !== "desktop" &&
      frame.preset !== "custom")
  ) {
    return undefined;
  }
  const width = normalizeFrameDimension(frame.width);
  const height = normalizeFrameDimension(frame.height);
  if (!width || !height) return undefined;
  if (frame.preset !== "custom") {
    const expected = PRESET_FRAMES[frame.preset];
    if (width !== expected.width || height !== expected.height) return undefined;
  }
  return {
    surface: presentation.surface,
    frame: { preset: frame.preset, width, height },
  };
}

/** Preserve V1 preview geometry while assigning a conservative primary surface. */
export function migrateDesignScreenPresentationFromViewport(
  viewport: DesignProjectViewport,
): DesignScreenPresentationV2 {
  const frame = PRESET_FRAMES[viewport];
  return {
    surface: "unknown",
    frame: { preset: viewport, width: frame.width, height: frame.height },
  };
}
