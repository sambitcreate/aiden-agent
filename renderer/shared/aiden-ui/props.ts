import type { AidenUiActionV1, AidenUiExprV1, AidenUiPropValueV1 } from "./types.js";

/**
 * Reading a compiled tree's prop values and data, shared by the renderer, the
 * plain-text fallback and the workspace artifact page check.
 */

export function isExpr(value: AidenUiPropValueV1 | undefined): value is AidenUiExprV1 {
  return Boolean(value) && typeof value === "object" && "op" in value;
}

export function isAction(value: AidenUiPropValueV1 | undefined): value is AidenUiActionV1 {
  return Boolean(value) && typeof value === "object" && "act" in value;
}

export function asString(value: unknown): string {
  if (value === undefined || value === null) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : "";
  if (typeof value === "boolean") return value ? "true" : "false";
  return "";
}

/** A visual's `<Data>` bindings, or none when they are missing or not an object. */
export function parseAidenUiData(dataJson: string | undefined): Record<string, unknown> {
  if (!dataJson) return {};
  try {
    const parsed = JSON.parse(dataJson) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}
