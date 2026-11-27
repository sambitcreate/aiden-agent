// An app's routes as main lists them and the picker shows them (design mode
// v2 Phase 3b, S79, S81). Every discovered route is written in one syntax,
// Next's brackets: `[name]` for one segment, `[...name]` for a catch-all and
// `[[...name]]` for an optional catch-all. A pattern is a route only once
// every bracket is filled. Pure; shared by main and the renderer.

import { consentDisplayText, type FrameworkId } from "../design-app.js";
import { isAppRoute } from "./app-frame.js";

export type AppRouteEntry = { route: string; pattern?: string; source: "config" | "discovered" };

export type AppRouteList = {
  appRoot: string;
  framework?: FrameworkId;
  source: "discovered" | "config" | "fallback";
  truncated: boolean;
  routes: AppRouteEntry[];
};

export type RouteParam = { name: string; catchAll: boolean; optional: boolean };

const PARAM_NAME = /^[A-Za-z_][A-Za-z0-9_-]{0,63}$/u;
const PARAM_SEGMENT_CHARS = 200;

function segmentParam(segment: string): RouteParam | null | undefined {
  if (!segment.includes("[") && !segment.includes("]")) return undefined;
  let optional = false;
  let catchAll = false;
  let inner = segment;
  if (inner.startsWith("[[") && inner.endsWith("]]")) {
    optional = true;
    inner = inner.slice(2, -2);
  } else if (inner.startsWith("[") && inner.endsWith("]")) {
    inner = inner.slice(1, -1);
  } else {
    return null;
  }
  if (inner.startsWith("...")) {
    catchAll = true;
    inner = inner.slice(3);
  }
  if (optional && !catchAll) return null;
  return PARAM_NAME.test(inner) ? { name: inner, catchAll, optional } : null;
}

function patternSegments(value: string): string[] | null {
  if (typeof value !== "string" || !value.startsWith("/") || value.includes("?") || value.includes("#")) return null;
  if (value === "/") return [];
  const segments = value.slice(1).split("/");
  for (const segment of segments) {
    if (segment === "" || segment === "." || segment === "..") return null;
  }
  return segments;
}

/** A route template: `/`-rooted, whole-segment brackets only, no query or fragment. A concrete route is a pattern with no brackets. */
export function isRoutePattern(value: string): boolean {
  const segments = patternSegments(value);
  if (!segments) return false;
  const names = new Set<string>();
  const probe: string[] = [];
  for (const segment of segments) {
    const param = segmentParam(segment);
    if (param === null) return false;
    if (param) {
      if (names.has(param.name)) return false;
      names.add(param.name);
      probe.push("x");
    } else {
      probe.push(segment);
    }
  }
  return isAppRoute(`/${probe.join("/")}`);
}

/** A route an app frame can show: a valid app route with no unfilled bracket. */
export function isConcreteRoute(value: string): boolean {
  return isAppRoute(value) && !value.includes("[") && !value.includes("]");
}

/** The parameters of a pattern, in order; `[]` for a concrete route or a non-pattern. */
export function patternParams(pattern: string): RouteParam[] {
  if (!isRoutePattern(pattern)) return [];
  const params: RouteParam[] = [];
  for (const segment of patternSegments(pattern) ?? []) {
    const param = segmentParam(segment);
    if (param) params.push(param);
  }
  return params;
}

function isValueSegment(segment: string): boolean {
  return (
    segment.length > 0 &&
    segment.length <= PARAM_SEGMENT_CHARS &&
    segment !== "." &&
    segment !== ".." &&
    consentDisplayText(segment) === segment &&
    // eslint-disable-next-line no-control-regex -- control characters are what this refuses.
    !/[\u0000-\u001f\u007f]/u.test(segment)
  );
}

/** A parameter's value: one segment, or (for a catch-all) segments joined by `/`, each non-empty, not `.`/`..`, ≤ 200 characters and free of hidden characters. */
export function isParamValue(value: string, catchAll: boolean): boolean {
  if (typeof value !== "string") return false;
  const segments = catchAll ? value.split("/") : [value];
  if (!catchAll && value.includes("/")) return false;
  return segments.every(isValueSegment);
}

/** The route a pattern names once filled, each segment percent-encoded; null for a missing or unsafe value. */
export function fillRoute(pattern: string, values: Record<string, string>): string | null {
  if (!isRoutePattern(pattern)) return null;
  const out: string[] = [];
  for (const segment of patternSegments(pattern) ?? []) {
    const param = segmentParam(segment);
    if (!param) {
      out.push(segment);
      continue;
    }
    const value = Object.prototype.hasOwnProperty.call(values, param.name) ? values[param.name] : undefined;
    if (param.optional && (value === undefined || value === "")) continue;
    if (typeof value !== "string" || !isParamValue(value, param.catchAll)) return null;
    out.push(...value.split("/").map((part) => encodeURIComponent(part)));
  }
  const route = `/${out.join("/")}`;
  return isConcreteRoute(route) ? route : null;
}
