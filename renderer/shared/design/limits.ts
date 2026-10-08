/** Project-scoped Design Studio quotas (ADR-DS §3, owner-approved 2026-10-07). */

export const MAX_DESIGN_REVISION_BYTES = 256 * 1024;
export const MAX_DESIGN_REVISIONS_PER_SCREEN = 100;
export const MAX_DESIGN_REVISIONS_PER_PROJECT = 400;
export const MAX_DESIGN_SCREENS_PER_PROJECT = 64;
export const MAX_DESIGN_PROJECT_BYTES = 64 * 1024 * 1024;
export const MAX_DESIGN_PROJECTS = 250;
export const MAX_DESIGN_TOTAL_BYTES = 2 * 1024 * 1024 * 1024;
export const MAX_DESIGN_MANIFEST_BYTES = 1024 * 1024;
export const MAX_DESIGN_RUN_RECORDS = 100;
export const MAX_DESIGN_PROJECT_TITLE_CHARS = 120;
export const MAX_DESIGN_PROMPT_CHARS = 16_000;

/** Explore defaults to 3 directions (range 2–4); Refine renders exactly 1. */
export const DEFAULT_DESIGN_EXPLORE_COUNT = 3;

/** Bounded context builder (ADR-DS §4). */
export const MAX_DESIGN_CONTEXT_BYTES = 128 * 1024;
export const MAX_DESIGN_BASE_CONTEXT_BYTES = 96 * 1024;
export const MAX_DESIGN_CONTEXT_TARGETS = 5;
export const MAX_DESIGN_CONTEXT_TARGET_BYTES = 2 * 1024;

/** A Resume lists the set's existing direction titles as untrusted context (owner decision 2026-10-07). */
export const MAX_DESIGN_EXISTING_DIRECTIONS = 4;
export const MAX_DESIGN_EXISTING_DIRECTION_CHARS = 200;
