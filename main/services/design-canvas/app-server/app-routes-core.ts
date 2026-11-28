// Route discovery's pure rules (design mode v2 Phase 3b, S78–S81): each
// framework's file convention mapped to Next-style bracket patterns, two
// small readers for `routeTree.gen.ts` and `app/routes.ts`, and the merge with
// `.aiden/canvas.json`. Nothing here touches disk or runs the person's code;
// `app-routes.ts` is the bounded walker that feeds it. The readers work over
// one O(n) token pass with no regular expressions over the file text.

import type { FrameworkId } from "../../../../renderer/shared/design-app.js";
import {
  fillRoute,
  isConcreteRoute,
  isRoutePattern,
  patternParams,
  type AppRouteEntry,
  type AppRouteList,
} from "../../../../renderer/shared/design-canvas/app-routes.js";

export type RouteConvention = "next-app" | "next-pages" | "tanstack" | "react-router-flat" | "astro";

export const ROUTE_LIMITS = { depth: 10, entries: 2000, routes: 500, fileBytes: 262_144, listed: 200 } as const;

const READER_DEPTH = 16;
const DEFAULT_MAX_TOKENS = 50_000;

const CONVENTIONS: Partial<Record<FrameworkId, readonly RouteConvention[]>> = {
  next: Object.freeze(["next-app", "next-pages"] as const),
  "tanstack-start": Object.freeze(["tanstack"] as const),
  "tanstack-router": Object.freeze(["tanstack"] as const),
  "react-router": Object.freeze(["react-router-flat"] as const),
  remix: Object.freeze(["react-router-flat"] as const),
  astro: Object.freeze(["astro"] as const),
};
const NONE: readonly RouteConvention[] = Object.freeze([]);

/** The file conventions read for a framework (S80); none for every other id. */
export function conventionsFor(framework: FrameworkId | undefined): readonly RouteConvention[] {
  return (framework && CONVENTIONS[framework]) || NONE;
}

// ---- One file to one pattern (S80's single-file rule) ----

const NEXT_EXTENSIONS = new Set(["tsx", "jsx", "ts", "js", "mdx"]);
const TANSTACK_EXTENSIONS = new Set(["tsx", "jsx", "ts", "js"]);
const FLAT_EXTENSIONS = new Set(["tsx", "jsx", "ts", "js", "mdx", "md"]);
const ASTRO_EXTENSIONS = new Set(["astro", "md", "mdx", "html"]);
const NEXT_PAGES_SPECIAL = new Set(["_app", "_document", "_error", "404", "500"]);

function splitExtension(name: string, allowed: ReadonlySet<string>): string | null {
  const dot = name.lastIndexOf(".");
  if (dot <= 0) return null;
  return allowed.has(name.slice(dot + 1)) ? name.slice(0, dot) : null;
}

function under(relPath: string, roots: readonly string[]): string[] | null {
  if (relPath.includes("\\")) return null;
  for (const root of roots) {
    if (relPath.startsWith(`${root}/`)) {
      const parts = relPath.slice(root.length + 1).split("/");
      return parts.every((part) => part.length > 0) ? parts : null;
    }
  }
  return null;
}

function toPattern(segments: readonly string[]): string | null {
  const pattern = `/${segments.join("/")}`;
  return isRoutePattern(pattern) ? pattern : null;
}

function nextAppRoute(relPath: string): string | null {
  const parts = under(relPath, ["app", "src/app"]);
  if (!parts) return null;
  const file = parts.pop()!;
  if (splitExtension(file, NEXT_EXTENSIONS) !== "page") return null;
  const segments: string[] = [];
  for (const folder of parts) {
    if (folder.startsWith("_") || folder.startsWith("@") || folder.startsWith("(.")) return null;
    if (folder.startsWith("(") && folder.endsWith(")")) continue;
    segments.push(folder);
  }
  return toPattern(segments);
}

function nextPagesRoute(relPath: string): string | null {
  const parts = under(relPath, ["pages", "src/pages"]);
  if (!parts || parts[0] === "api") return null;
  const base = splitExtension(parts.pop()!, NEXT_EXTENSIONS);
  if (base === null) return null;
  if (parts.length === 0 && NEXT_PAGES_SPECIAL.has(base)) return null;
  return toPattern(base === "index" ? parts : [...parts, base]);
}

function astroRoute(relPath: string): string | null {
  const parts = under(relPath, ["src/pages"]);
  if (!parts || parts.some((part) => part.startsWith("_"))) return null;
  const base = splitExtension(parts.pop()!, ASTRO_EXTENSIONS);
  if (base === null) return null;
  return toPattern(base === "index" ? parts : [...parts, base]);
}

/** A flat route name split on `.`, keeping `[...]` escapes whole; null for an unclosed escape. */
function splitFlat(name: string): string[] | null {
  const tokens: string[] = [];
  let current = "";
  let escaped = false;
  for (const character of name) {
    if (escaped) {
      current += character;
      if (character === "]") escaped = false;
    } else if (character === "[") {
      current += character;
      escaped = true;
    } else if (character === ".") {
      tokens.push(current);
      current = "";
    } else {
      current += character;
    }
  }
  if (escaped) return null;
  tokens.push(current);
  return tokens.every((token) => token.length > 0) ? tokens : null;
}

function unescapeFlat(token: string): string | null {
  const literal = token.replace(/\[([^\]]*)\]/gu, "$1");
  return literal.length === 0 || literal.includes("[") || literal.includes("]") || literal === "." || literal === ".." ? null : literal;
}

const FLAT_PARAM = /^[A-Za-z_][A-Za-z0-9_-]{0,63}$/u;

type FlatToken = { kind: "index" | "drop" | "pathless" | "ignored" } | { kind: "segment"; value: string };

/** One flat token (Remix / React Router, TanStack) as a route segment, or what it is instead. */
function flatToken(token: string, style: "remix" | "tanstack"): FlatToken | null {
  if (style === "remix" ? token === "_index" : token === "index") return { kind: "index" };
  if (style === "tanstack" && token.startsWith("-")) return { kind: "ignored" };
  if (token === "$") return { kind: "segment", value: "[...splat]" };
  if (token.startsWith("$")) return FLAT_PARAM.test(token.slice(1)) ? { kind: "segment", value: `[${token.slice(1)}]` } : null;
  if (style === "tanstack" && token.startsWith("{-$") && token.endsWith("}")) {
    const name = token.slice(3, -1);
    return FLAT_PARAM.test(name) ? { kind: "segment", value: `[[...${name}]]` } : null;
  }
  if (token.startsWith("(") && token.endsWith(")")) {
    const inner = token.slice(1, -1);
    // Remix: `($lang)` is an optional parameter and `(en)` an optional segment; TanStack: `(group)` is a route group.
    if (style === "remix" && inner.startsWith("$")) return FLAT_PARAM.test(inner.slice(1)) ? { kind: "segment", value: `[[...${inner.slice(1)}]]` } : null;
    return { kind: "drop" };
  }
  if (token.startsWith("_")) return { kind: "pathless" };
  const literal = unescapeFlat(token.endsWith("_") ? token.slice(0, -1) : token);
  return literal === null ? null : { kind: "segment", value: literal };
}

type FlatFile = { key: string[]; index: boolean; route: string | null };

/** A flat-convention file's node key (its raw tokens, markers removed) and its route. */
function flatFile(convention: "tanstack" | "react-router-flat", relPath: string): FlatFile | null {
  let tokens: string[];
  if (convention === "react-router-flat") {
    const parts = under(relPath, ["app/routes"]);
    if (!parts || parts.length > 2) return null;
    let name: string | null;
    if (parts.length === 2) {
      name = splitExtension(parts[1], FLAT_EXTENSIONS) === "route" ? parts[0] : null;
    } else {
      name = splitExtension(parts[0], FLAT_EXTENSIONS);
    }
    const split = name === null ? null : splitFlat(name);
    if (!split) return null;
    tokens = split;
  } else {
    const parts = under(relPath, ["src/routes"]);
    if (!parts) return null;
    const base = splitExtension(parts.pop()!, TANSTACK_EXTENSIONS);
    if (base === null || base === "__root") return null;
    tokens = [];
    for (const part of [...parts, base]) {
      const split = splitFlat(part);
      if (!split) return null;
      tokens.push(...split);
    }
    if (tokens.length > 1 && tokens[tokens.length - 1] === "lazy") tokens.pop();
    // `dashboard/route.tsx` and `posts.route.tsx` configure their folder's or name's own route.
    if (tokens.length > 1 && tokens[tokens.length - 1] === "route") tokens.pop();
  }
  const style = convention === "react-router-flat" ? "remix" : "tanstack";
  const segments: string[] = [];
  let index = false;
  let lastKind: FlatToken["kind"] = "segment";
  for (let position = 0; position < tokens.length; position += 1) {
    const mapped = flatToken(tokens[position], style);
    if (!mapped || mapped.kind === "ignored") return null;
    lastKind = mapped.kind;
    if (mapped.kind === "index") {
      if (position !== tokens.length - 1) return null;
      index = true;
    } else if (mapped.kind === "segment") {
      segments.push(mapped.value);
    }
  }
  // A file whose last token is pathless (`_auth.tsx`) or a group is a layout, never a page.
  if (lastKind === "pathless" || lastKind === "drop") return { key: tokens, index, route: null };
  const key = index ? tokens.slice(0, -1) : tokens;
  return { key, index, route: toPattern(segments) };
}

/** The pattern one route file maps to, without seeing its siblings (S80); null for every non-page. */
export function routeFromFile(convention: RouteConvention, relPath: string): string | null {
  switch (convention) {
    case "next-app":
      return nextAppRoute(relPath);
    case "next-pages":
      return nextPagesRoute(relPath);
    case "astro":
      return astroRoute(relPath);
    case "tanstack":
    case "react-router-flat":
      return flatFile(convention, relPath)?.route ?? null;
  }
}

function startsWith(longer: readonly string[], prefix: readonly string[]): boolean {
  return longer.length > prefix.length && prefix.every((token, position) => longer[position] === token);
}

/**
 * Each page file of a whole tree, in order, with its pattern and whether the
 * tree makes it a layout: a flat file (TanStack, React Router) with child or
 * index routes. Non-pages are left out.
 */
export function routeFileEntries(convention: RouteConvention, relPaths: readonly string[]): { relPath: string; route: string; layout: boolean }[] {
  if (convention !== "tanstack" && convention !== "react-router-flat") {
    return relPaths.flatMap((relPath) => {
      const route = routeFromFile(convention, relPath);
      return route === null ? [] : [{ relPath, route, layout: false }];
    });
  }
  const files = relPaths
    .map((relPath) => ({ relPath, file: flatFile(convention, relPath) }))
    .filter((entry): entry is { relPath: string; file: FlatFile } => entry.file !== null);
  const out: { relPath: string; route: string; layout: boolean }[] = [];
  for (const { relPath, file } of files) {
    if (file.route === null) continue;
    const layout =
      !file.index &&
      files.some(({ file: other }) => other !== file && (startsWith(other.key, file.key) || (other.index && other.key.join("\0") === file.key.join("\0"))));
    out.push({ relPath, route: file.route, layout });
  }
  return out;
}

/** Every pattern of a whole tree: like `routeFromFile`, but a layout with child or index routes is dropped. */
export function routesFromFiles(convention: RouteConvention, relPaths: readonly string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const entry of routeFileEntries(convention, relPaths)) {
    if (entry.layout || seen.has(entry.route)) continue;
    seen.add(entry.route);
    out.push(entry.route);
  }
  return out;
}

// ---- The tokenizer (S78, M8.4) ----

/** One token. With `scanTsTokens`'s `offsets`, a `str` token also has its span in the text, quotes included. */
export type TsToken = { kind: "id" | "str" | "punct"; value: string; start?: number; end?: number };

const isIdStart = (code: number) => (code >= 65 && code <= 90) || (code >= 97 && code <= 122) || code === 95 || code === 36;
const isIdPart = (code: number) => isIdStart(code) || (code >= 48 && code <= 57);
const isSpace = (code: number) => code === 32 || code === 9 || code === 10 || code === 13 || code === 11 || code === 12 || code === 0xfeff || code === 0xa0;

/** The index after a string literal opened at `start`, its decoded value, or null when it never closes on its line. */
function readString(text: string, start: number): { end: number; value: string } | null {
  const quote = text[start];
  let value = "";
  let position = start + 1;
  while (position < text.length) {
    const character = text[position];
    if (character === quote) return { end: position + 1, value };
    if (character === "\n" || character === "\r") return null;
    if (character === "\\") {
      const next = text[position + 1];
      if (next === undefined) return null;
      if (next === "n") value += "\n";
      else if (next === "t") value += "\t";
      else if (next === "r") value += "\r";
      else if (next === "0") value += "\0";
      else if (next === "\n") value += "";
      else if (next === "u" || next === "x") {
        // Kept escaped: an escape in a route literal is never something discovery needs.
        value += `\\${next}`;
      } else value += next;
      position += 2;
      continue;
    }
    value += character;
    position += 1;
  }
  return null;
}

/** The index after a block comment opened at `start`, or -1 when it never closes. */
function skipBlockComment(text: string, start: number): number {
  const end = text.indexOf("*/", start + 2);
  return end < 0 ? -1 : end + 2;
}

/** The index after a template literal opened at `start`, `${…}` and nested templates included, or -1. No call-stack recursion. */
function skipTemplate(text: string, start: number): number {
  const stack: number[] = [-1]; // -1: inside template text; n ≥ 0: inside `${…}` at brace depth n
  let position = start + 1;
  while (position < text.length) {
    const top = stack[stack.length - 1];
    const character = text[position];
    if (top < 0) {
      if (character === "\\") position += 2;
      else if (character === "`") {
        stack.pop();
        position += 1;
        if (stack.length === 0) return position;
      } else if (character === "$" && text[position + 1] === "{") {
        stack.push(0);
        position += 2;
      } else position += 1;
      continue;
    }
    if (character === "'" || character === '"') {
      const string = readString(text, position);
      if (!string) return -1;
      position = string.end;
    } else if (character === "/" && text[position + 1] === "/") {
      const end = text.indexOf("\n", position);
      position = end < 0 ? text.length : end;
    } else if (character === "/" && text[position + 1] === "*") {
      position = skipBlockComment(text, position);
      if (position < 0) return -1;
    } else if (character === "`") {
      stack.push(-1);
      position += 1;
    } else if (character === "{") {
      stack[stack.length - 1] = top + 1;
      position += 1;
    } else if (character === "}") {
      if (top === 0) stack.pop();
      else stack[stack.length - 1] = top - 1;
      position += 1;
    } else position += 1;
  }
  return -1;
}

/**
 * One forward pass over TS/JS text: identifiers, strings (escapes decoded) and
 * punctuation; comments and template literals skipped; null when unterminated
 * or past `maxTokens`. With `offsets`, each `str` token also carries `start`
 * and `end`, so `text.slice(start, end)` is its quoted source.
 */
export function scanTsTokens(text: string, maxTokens = DEFAULT_MAX_TOKENS, options: { offsets?: boolean } = {}): TsToken[] | null {
  const tokens: TsToken[] = [];
  let position = 0;
  const push = (token: TsToken) => {
    tokens.push(token);
    return tokens.length <= maxTokens;
  };
  while (position < text.length) {
    const code = text.charCodeAt(position);
    const character = text[position];
    if (isSpace(code)) {
      position += 1;
    } else if (character === "/" && text[position + 1] === "/") {
      const end = text.indexOf("\n", position);
      position = end < 0 ? text.length : end;
    } else if (character === "/" && text[position + 1] === "*") {
      position = skipBlockComment(text, position);
      if (position < 0) return null;
    } else if (character === "'" || character === '"') {
      const string = readString(text, position);
      if (!string) return null;
      const token: TsToken = options.offsets ? { kind: "str", value: string.value, start: position, end: string.end } : { kind: "str", value: string.value };
      if (!push(token)) return null;
      position = string.end;
    } else if (character === "`") {
      position = skipTemplate(text, position);
      if (position < 0) return null;
    } else if (isIdPart(code)) {
      const start = position;
      while (position < text.length && isIdPart(text.charCodeAt(position))) position += 1;
      if (!push({ kind: "id", value: text.slice(start, position) })) return null;
    } else if (character === "." && text[position + 1] === "." && text[position + 2] === ".") {
      if (!push({ kind: "punct", value: "..." })) return null;
      position += 3;
    } else {
      if (!push({ kind: "punct", value: character })) return null;
      position += 1;
    }
  }
  return tokens;
}

// ---- The two readers ----

/** A TanStack full path (`/posts/$postId`, `/files/$`, `/posts/`) as a pattern, or null. */
function tanStackKey(key: string): string | null {
  const parts = key.split("/").filter((part) => part.length > 0);
  const segments: string[] = [];
  for (const part of parts) {
    if (part === "$") segments.push("[...splat]");
    else if (part.startsWith("{-$") && part.endsWith("}")) segments.push(`[[...${part.slice(3, -1)}]]`);
    else if (part.startsWith("$")) segments.push(`[${part.slice(1)}]`);
    else segments.push(part);
  }
  return toPattern(segments);
}

/** The keys of `interface FileRoutesByFullPath { … }` in a generated `routeTree.gen.ts`, as patterns; null when it isn't there or doesn't read. */
export function parseTanStackRouteTree(text: string): string[] | null {
  const tokens = scanTsTokens(text);
  if (!tokens) return null;
  let position = -1;
  for (let index = 0; index + 2 < tokens.length; index += 1) {
    if (tokens[index].value === "interface" && tokens[index + 1].value === "FileRoutesByFullPath" && tokens[index + 2].value === "{") {
      position = index + 3;
      break;
    }
  }
  if (position < 0) return null;
  const out: string[] = [];
  const seen = new Set<string>();
  while (position < tokens.length) {
    const token = tokens[position];
    if (token.value === "}" && token.kind === "punct") return out;
    if (token.kind !== "str" || tokens[position + 1]?.value !== ":") return null;
    const key = token.value;
    position += 2;
    // The value is a type (`typeof IndexRoute`); skip to the member's end.
    let depth = 0;
    while (position < tokens.length) {
      const value = tokens[position];
      if (value.kind === "punct" && (value.value === "{" || value.value === "(" || value.value === "[" || value.value === "<")) depth += 1;
      else if (value.kind === "punct" && (value.value === ")" || value.value === "]" || value.value === ">")) depth -= 1;
      else if (value.kind === "punct" && value.value === "}") {
        if (depth === 0) break;
        depth -= 1;
      } else if (depth === 0 && value.kind === "punct" && (value.value === ";" || value.value === ",")) {
        position += 1;
        break;
      } else if (depth === 0 && value.kind === "str" && tokens[position + 1]?.value === ":") break;
      if (depth < 0 || depth > READER_DEPTH) return null;
      position += 1;
    }
    if (key.length === 0) continue;
    const pattern = tanStackKey(key);
    if (pattern !== null && !seen.has(pattern)) {
      seen.add(pattern);
      out.push(pattern);
    }
  }
  return null;
}

/** A React Router path (`:slug`, `concerts/:city`, `*`, `:lang?`) as pattern segments, or null. */
function reactRouterSegments(path: string): string[] | null {
  const segments: string[] = [];
  for (const part of path.split("/")) {
    if (part === "") continue;
    if (part === "*") segments.push("[...splat]");
    else if (part.startsWith(":")) {
      const optional = part.endsWith("?");
      const name = part.slice(1, optional ? -1 : undefined);
      if (!FLAT_PARAM.test(name)) return null;
      segments.push(optional ? `[[...${name}]]` : `[${name}]`);
    } else if (part.endsWith("?")) continue;
    else segments.push(part);
  }
  return segments;
}

const STATEMENT_STARTS = new Set(["export", "import", "const", "let", "var", "function", "class", "type", "interface", "declare"]);

class ConfigReader {
  routes: string[] = [];
  flat = false;
  /** Anything beside or around the flat routes: a prefix, layout, index or route call. */
  mixed = false;
  position = 0;
  constructor(private readonly tokens: TsToken[]) {}

  private peek(offset = 0): TsToken | undefined {
    return this.tokens[this.position + offset];
  }

  private take(value: string, kind?: TsToken["kind"]): boolean {
    const token = this.peek();
    if (!token || token.value !== value || (kind && token.kind !== kind)) return false;
    this.position += 1;
    return true;
  }

  private string(): string | null {
    const token = this.peek();
    if (token?.kind !== "str") return null;
    this.position += 1;
    return token.value;
  }

  /** Skips a `{ … }` options object of literals; false when it doesn't close. */
  private skipObject(): boolean {
    let depth = 0;
    while (this.position < this.tokens.length) {
      const token = this.tokens[this.position];
      this.position += 1;
      if (token.kind === "punct" && token.value === "{") depth += 1;
      else if (token.kind === "punct" && token.value === "}") {
        depth -= 1;
        if (depth === 0) return true;
      } else if (token.kind === "punct" && (token.value === "(" || token.value === "[" || token.value === "`")) return false;
      if (depth > READER_DEPTH) return false;
    }
    return false;
  }

  /** `[await] flatRoutes()` as the default export itself; options (another folder) aren't read. */
  flatDefault(): boolean {
    this.take("await", "id");
    return this.take("flatRoutes", "id") && this.take("(", "punct") && this.take(")", "punct");
  }

  /** A type after `satisfies` or `as`: `Name`, `A.B`, `Name[]`. */
  private typeName(): boolean {
    if (this.peek()?.kind !== "id") return false;
    this.position += 1;
    while (this.peek()?.value === "." && this.peek(1)?.kind === "id") this.position += 2;
    while (this.peek()?.value === "[" && this.peek(1)?.value === "]") this.position += 2;
    return true;
  }

  /** After the default export's value: an optional `satisfies`/`as` type, then `;`, the end, or the next statement. Anything else chains code onto it. */
  endsExport(): boolean {
    if ((this.take("satisfies", "id") || this.take("as", "id")) && !this.typeName()) return false;
    const next = this.peek();
    if (!next || this.take(";", "punct")) return true;
    return next.kind === "id" && STATEMENT_STARTS.has(next.value);
  }

  private flatCall(): boolean {
    if (this.take("(", "punct")) {
      if (!this.take("await", "id") || !this.flatCall() || !this.take(")", "punct")) return false;
      return true;
    }
    // Options (another folder, other ignored files) change what the walker would read, so only `flatRoutes()` is read.
    return this.take("flatRoutes", "id") && this.take("(", "punct") && this.take(")", "punct");
  }

  /** `[ element, … ]` under `prefix`; false on anything it can't read. */
  array(prefix: readonly string[], depth: number): boolean {
    if (depth > READER_DEPTH || !this.take("[", "punct")) return false;
    while (!this.take("]", "punct")) {
      if (!this.element(prefix, depth)) return false;
      if (!this.take(",", "punct") && this.peek()?.value !== "]") return false;
    }
    return true;
  }

  private add(segments: readonly string[]): boolean {
    const pattern = toPattern(segments);
    if (pattern === null) return false;
    if (!this.routes.includes(pattern)) this.routes.push(pattern);
    return true;
  }

  /** After a call's required arguments: `[, { … }] [, [children]] )`. Returns whether children were read, or null. */
  private tail(prefix: readonly string[], depth: number, allowChildren: boolean): boolean | null {
    let children = false;
    while (this.take(",", "punct")) {
      const next = this.peek();
      if (next?.value === ")") break;
      if (next?.value === "{") {
        if (!this.skipObject()) return null;
      } else if (next?.value === "[" && allowChildren && !children) {
        const before = this.routes.length;
        if (!this.array(prefix, depth + 1)) return null;
        children = this.routes.length > before || this.flat;
      } else return null;
    }
    return this.take(")", "punct") ? children : null;
  }

  /** `prefix("a", [ … ])`, spread or (as some configs write it) not. */
  private prefixCall(prefix: readonly string[], depth: number): boolean {
    this.position += 1;
    if (!this.take("(", "punct")) return false;
    const path = this.string();
    const segments = path === null ? null : reactRouterSegments(path);
    if (!segments || !this.take(",", "punct") || !this.array([...prefix, ...segments], depth + 1)) return false;
    this.take(",", "punct");
    return this.take(")", "punct");
  }

  private element(prefix: readonly string[], depth: number): boolean {
    if (this.take("...", "punct")) {
      if (this.peek()?.value === "prefix") {
        this.mixed = true;
        return this.prefixCall(prefix, depth);
      }
      if (!this.flatCall()) return false;
      this.flat = true;
      return true;
    }
    this.mixed = true;
    if (this.peek()?.value === "prefix" && this.peek()?.kind === "id") return this.prefixCall(prefix, depth);
    const name = this.peek();
    if (name?.kind !== "id" || this.peek(1)?.value !== "(") return false;
    this.position += 2;
    if (name.value === "index") {
      if (this.string() === null) return false;
      if (this.tail(prefix, depth, false) === null) return false;
      return this.add(prefix);
    }
    if (name.value === "route") {
      const path = this.string();
      const segments = path === null ? null : reactRouterSegments(path);
      if (!segments || !this.take(",", "punct") || this.string() === null) return false;
      const own = [...prefix, ...segments];
      const children = this.tail(own, depth, true);
      if (children === null) return false;
      return children ? true : this.add(own);
    }
    if (name.value === "layout") {
      if (this.string() === null) return false;
      return this.tail(prefix, depth, true) !== null;
    }
    return false;
  }
}

/**
 * A literal `app/routes.ts` (`index()`, `route()`, `layout()`, `prefix()`
 * calls with string literals) as patterns; `{flat: true}` for `flatRoutes()`,
 * with `mixed` when other calls sit beside or around it (so a file's route is
 * not just its name); null for any other code.
 */
export function parseReactRouterConfig(text: string): { routes: string[] } | { flat: true; mixed?: true } | null {
  const tokens = scanTsTokens(text);
  if (!tokens) return null;
  let start = -1;
  for (let index = 0; index + 1 < tokens.length; index += 1) {
    if (tokens[index].kind === "id" && tokens[index].value === "export" && tokens[index + 1].kind === "id" && tokens[index + 1].value === "default") {
      start = index + 2;
      break;
    }
  }
  if (start < 0) return null;
  const reader = new ConfigReader(tokens);
  reader.position = start;
  if (tokens[start]?.value !== "[") return reader.flatDefault() && reader.endsExport() ? { flat: true } : null;
  if (!reader.array([], 0) || !reader.endsExport()) return null;
  if (!reader.flat) return { routes: reader.routes };
  return reader.mixed ? { flat: true, mixed: true } : { flat: true };
}

// ---- The merge with canvas.json (S81) ----

function patternDepth(pattern: string): number {
  return pattern === "/" ? 0 : pattern.split("/").length - 1;
}

function compareDiscovered(left: string, right: string): number {
  const leftDynamic = left.includes("[") ? 1 : 0;
  const rightDynamic = right.includes("[") ? 1 : 0;
  if (leftDynamic !== rightDynamic) return leftDynamic - rightDynamic;
  const depth = patternDepth(left) - patternDepth(right);
  if (depth !== 0) return depth;
  return left < right ? -1 : left > right ? 1 : 0;
}

/** The list the picker and `design_app routes` show: `/` first, then canvas.json's `routes` (replacing discovery) or the sorted discovered patterns, each single-parameter pattern followed by its filled `params`. */
export function mergeRouteList(input: {
  appRoot: string;
  framework?: FrameworkId;
  discovered: { patterns: string[]; truncated: boolean } | null;
  config?: { routes?: string[]; params?: Record<string, string[]> };
}): AppRouteList {
  const configRoutes = input.config?.routes;
  const source: AppRouteList["source"] = configRoutes ? "config" : input.discovered ? "discovered" : "fallback";
  const entrySource: AppRouteEntry["source"] = configRoutes ? "config" : "discovered";
  const candidates = configRoutes ? configRoutes : [...(input.discovered?.patterns ?? [])].sort(compareDiscovered);
  const params = input.config?.params ?? {};
  const entries: AppRouteEntry[] = [];
  const seen = new Set<string>();
  const push = (entry: AppRouteEntry) => {
    if (seen.has(entry.route)) return;
    seen.add(entry.route);
    entries.push(entry);
  };
  push({ route: "/", source: entrySource });
  for (const candidate of candidates) {
    if (isConcreteRoute(candidate)) {
      push({ route: candidate, source: entrySource });
      continue;
    }
    if (!isRoutePattern(candidate)) continue;
    push({ route: candidate, pattern: candidate, source: entrySource });
    const names = patternParams(candidate);
    const values = Object.prototype.hasOwnProperty.call(params, candidate) ? params[candidate] : undefined;
    if (names.length !== 1 || !Array.isArray(values)) continue;
    for (const value of values) {
      const filled = fillRoute(candidate, { [names[0].name]: value });
      if (filled !== null) push({ route: filled, pattern: candidate, source: "config" });
    }
  }
  const truncated = (source === "discovered" && input.discovered?.truncated === true) || entries.length > ROUTE_LIMITS.listed;
  return {
    appRoot: input.appRoot,
    ...(input.framework ? { framework: input.framework } : {}),
    source,
    truncated,
    routes: entries.slice(0, ROUTE_LIMITS.listed),
  };
}
