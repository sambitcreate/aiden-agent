// React's JSX dev runtime with one addition: every host element (a string
// type, such as "div") gets `data-aiden-src="ws:<path>:<line>"`, the
// workspace-relative file and line it was written at, so design mode can map
// an element on the canvas back to its source. vite.config.js points
// `react/jsx-dev-runtime` here for every file but this one.
import { Fragment, jsxDEV as reactJsxDEV } from "react/jsx-dev-runtime";

export { Fragment };

declare const __AIDEN_WORKSPACE_ROOTS__: readonly string[];

type Source = { fileName?: unknown; lineNumber?: unknown } | undefined | null;

const MAX_STAMP = 256;

/**
 * The stamp for a source location: "ws:" plus the POSIX path relative to the
 * first workspace root `fileName` is inside, then ":line". Null for anything
 * outside every root, a path with `..`, or a stamp longer than 256 characters.
 */
export function aidenSourceStamp(source: Source, roots: readonly string[]): string | null {
  if (!source || typeof source.fileName !== "string" || typeof source.lineNumber !== "number") return null;
  if (!Number.isInteger(source.lineNumber) || source.lineNumber < 1) return null;
  const fileName = source.fileName.replace(/\\/gu, "/").split("?")[0]!;
  for (const raw of roots) {
    const root = raw.replace(/\\/gu, "/").replace(/\/+$/u, "");
    if (!root || !fileName.startsWith(`${root}/`)) continue;
    const relative = fileName.slice(root.length + 1);
    const parts = relative.split("/");
    if (parts.some((part) => part === "" || part === "." || part === "..")) return null;
    const stamp = `ws:${relative}:${source.lineNumber}`;
    return stamp.length > MAX_STAMP ? null : stamp;
  }
  return null;
}

const roots = typeof __AIDEN_WORKSPACE_ROOTS__ === "undefined" ? [] : __AIDEN_WORKSPACE_ROOTS__;

/** React's jsxDEV, stamping host elements first. */
export function jsxDEV(type: unknown, props: Record<string, unknown>, key: unknown, isStaticChildren: unknown, source: Source, self: unknown) {
  if (typeof type === "string" && props && typeof props === "object" && !("data-aiden-src" in props)) {
    const stamp = aidenSourceStamp(source, roots);
    if (stamp) props = { ...props, "data-aiden-src": stamp };
  }
  return (reactJsxDEV as (...args: unknown[]) => unknown)(type, props, key, isStaticChildren, source, self);
}
