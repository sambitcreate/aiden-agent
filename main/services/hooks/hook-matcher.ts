/**
 * Claude Code matcher semantics:
 * - empty or `*` matches everything;
 * - a value made only of `[A-Za-z0-9_\- ,|]` is an exact list split on `|` or `,`;
 * - anything else is a regular expression anchored to the whole name.
 * A tool matches when its Aiden name or any Claude alias matches.
 */

import { toolNameSpellings } from "./hook-aliases.js";

export type CompiledHookMatcher =
  | { kind: "all" }
  | { kind: "list"; names: ReadonlySet<string> }
  | { kind: "regex"; regex: RegExp };

export type HookMatcherCompileResult =
  | { ok: true; matcher: CompiledHookMatcher }
  | { ok: false; reason: string };

const EXACT_LIST = /^[A-Za-z0-9_\- ,|]+$/u;
const MAX_MATCHER_LENGTH = 512;

export function compileHookMatcher(matcher: string | undefined): HookMatcherCompileResult {
  const value = (matcher ?? "").trim();
  if (value === "" || value === "*") return { ok: true, matcher: { kind: "all" } };
  if (value.length > MAX_MATCHER_LENGTH) return { ok: false, reason: `The matcher is longer than ${MAX_MATCHER_LENGTH} characters.` };
  if (EXACT_LIST.test(value)) {
    const names = value.split(/[|,]/u).map((name) => name.trim()).filter(Boolean);
    if (names.length === 0) return { ok: true, matcher: { kind: "all" } };
    return { ok: true, matcher: { kind: "list", names: new Set(names) } };
  }
  try {
    return { ok: true, matcher: { kind: "regex", regex: new RegExp(`^(?:${value})$`) } };
  } catch (error) {
    return { ok: false, reason: `The matcher is not a valid regular expression: ${error instanceof Error ? error.message : String(error)}` };
  }
}

function matchesValue(matcher: CompiledHookMatcher, value: string): boolean {
  switch (matcher.kind) {
    case "all":
      return true;
    case "list":
      return matcher.names.has(value);
    case "regex":
      return matcher.regex.test(value);
  }
}

/** Does `matcher` select this tool, by its Aiden name or a Claude alias? */
export function matcherMatchesTool(matcher: CompiledHookMatcher, toolName: string): boolean {
  return toolNameSpellings(toolName).some((spelling) => matchesValue(matcher, spelling));
}

/** Does `matcher` select a plain value (a SessionStart source, a PreCompact trigger)? */
export function matcherMatchesValue(matcher: CompiledHookMatcher, value: string | undefined): boolean {
  if (matcher.kind === "all") return true;
  if (value === undefined) return false;
  return matchesValue(matcher, value);
}

/** Convenience: compile and match; an invalid matcher matches nothing. */
export function hookMatcherMatches(matcher: string | undefined, toolName: string): boolean {
  const compiled = compileHookMatcher(matcher);
  return compiled.ok && matcherMatchesTool(compiled.matcher, toolName);
}
