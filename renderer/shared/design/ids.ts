// Design Studio ids and enum values that main and the renderer both validate.
// Defined once, so the renderer client and main's parsers cannot drift apart.
import type { DesignProjectHealth, DesignRunStatus } from "./types.js";

/** A letter or digit, then up to 63 of [A-Za-z0-9_-]. Ids become file names: no dots or slashes. */
export const DESIGN_ID_PATTERN = "[A-Za-z0-9][A-Za-z0-9_-]{0,63}";
const DESIGN_ID = new RegExp(`^${DESIGN_ID_PATTERN}$`, "u");

export function isDesignId(value: unknown): value is string {
  return typeof value === "string" && DESIGN_ID.test(value);
}

// Keyed by each union, so a new status or health value does not compile until it is listed here.
const RUN_STATUS_KEYS: Record<DesignRunStatus, true> = {
  running: true,
  complete: true,
  partial: true,
  cancelled: true,
  interrupted: true,
  failed: true,
};
const PROJECT_HEALTH_KEYS: Record<DesignProjectHealth, true> = { ok: true, unreadable: true, interrupted: true };

export const DESIGN_RUN_STATUSES = Object.keys(RUN_STATUS_KEYS) as DesignRunStatus[];
export const DESIGN_PROJECT_HEALTH = Object.keys(PROJECT_HEALTH_KEYS) as DesignProjectHealth[];

/** Why main refused a Design Studio call. */
export const DESIGN_FAILURE_REASONS = ["invalid", "quota", "busy", "not_found", "stale", "unavailable"] as const;
export type DesignFailureReason = (typeof DESIGN_FAILURE_REASONS)[number];
