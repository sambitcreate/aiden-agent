// Which file owns an app page, what its copy is called, and TanStack's route
// literal (design mode v2 Phase 3c, S95, S101). Pure: paths are POSIX and
// relative to the app root (`appRelPath`) unless they say workspace; nothing
// here touches disk or runs the person's code. `app-page-files.ts` is the
// disk side, and the route rules themselves are 3b's (`app-routes-core.ts`).

import path from "node:path";
import { scanTsTokens, type RouteConvention, type TsToken } from "./app-routes-core.js";

/** Why a page can't be copied or trashed (S95's table). */
export type AppPageRefusal =
  | "config-router"
  | "dynamic"
  | "layout"
  | "no-file"
  | "several-files"
  | "special-files"
  | "relative-imports"
  | "route-literal"
  | "too-many"
  | "too-large"
  | "not-regular"
  | "truncated"
  | "read-only";

/** A route file, by its path relative to the app root and the convention that made it a page. */
export type OwnerFile = { appRelPath: string; convention: RouteConvention };

const posix = path.posix;

/** A path relative to the app root, as a path relative to the workspace: `.` keeps it, anything else prefixes it. */
export function workspaceRelPath(appRoot: string, appRelPath: string): string {
  return appRoot === "." ? appRelPath : `${appRoot}/${appRelPath}`;
}

/** A frame's route split into the page's path (no trailing `/`, except `/` itself) and its query and hash, kept for the copy. */
export function pagePath(route: string): { path: string; query: string } {
  const cut = route.search(/[?#]/u);
  let page = cut < 0 ? route : route.slice(0, cut);
  while (page.length > 1 && page.endsWith("/")) page = page.slice(0, -1);
  return { path: page, query: cut < 0 ? "" : route.slice(cut) };
}

const VARIANT_SUFFIX = /-v[2-9]$/u;

/** A name without its trailing `-v2`…`-v9`; unchanged when stripping would leave nothing. */
function stripVariant(name: string): string {
  const stripped = name.replace(VARIANT_SUFFIX, "");
  return stripped.length > 0 ? stripped : name;
}

function withVariant(name: string, n: number): string {
  return `${stripVariant(name)}-v${n}`;
}

/** The path a page's variants are named from: the last segment without `-v2`…`-v9`, and `/` as `/index`. */
export function variantBase(page: string): string {
  if (page === "/") return "/index";
  const slash = page.lastIndexOf("/");
  return page.slice(0, slash + 1) + stripVariant(page.slice(slash + 1));
}

/** Whether a concrete path is one a bracket pattern serves. */
function patternMatches(pattern: string, page: string): boolean {
  const want = pattern === "/" ? [] : pattern.slice(1).split("/");
  const have = page === "/" ? [] : page.slice(1).split("/");
  for (let index = 0; index < want.length; index += 1) {
    const segment = want[index];
    if (segment.startsWith("[[...")) return true;
    if (segment.startsWith("[...")) return have.length > index;
    if (index >= have.length) return false;
    if (segment.startsWith("[")) continue;
    if (segment !== have[index]) return false;
  }
  return want.length === have.length;
}

/** The one file that owns a page's path, or why there isn't one: a static pattern first, then a layout, then a dynamic match. */
export function ownerOf(
  page: string,
  walk: { files: ReadonlyMap<string, OwnerFile[]>; layouts: ReadonlySet<string> },
): { owner: OwnerFile } | { refused: "dynamic" | "layout" | "no-file" | "several-files" } {
  const exact = walk.files.get(page);
  if (exact && exact.length > 0) return exact.length === 1 ? { owner: exact[0] } : { refused: "several-files" };
  if (walk.layouts.has(page)) return { refused: "layout" };
  for (const pattern of [...walk.files.keys(), ...walk.layouts]) {
    if (pattern.includes("[") && patternMatches(pattern, page)) return { refused: "dynamic" };
  }
  return { refused: "no-file" };
}

/** Flat-route markers that configure the token before them rather than naming a segment. */
const FLAT_MARKERS = new Set(["index", "_index", "route", "lazy"]);

/**
 * Where the `n`th copy of `owner` might go, in S95's order. The caller takes
 * the first whose `routeFromFile` is the wanted path; `newFolder` (relative to
 * the app root) is a folder the copy may need created.
 *
 * 1. the stem with the suffix (`pricing.tsx` → `pricing-v2.tsx`);
 * 2. the token before a trailing `index`, `_index`, `route` or `lazy`
 *    (`blog.index.tsx` → `blog-v2.index.tsx`), or a lone index marker as
 *    `index-vN` (Remix `_index.tsx` → `index-v2.tsx`);
 * 3. the folder renamed (`app/pricing/page.tsx` → `app/pricing-v2/page.tsx`);
 * 4. a child `index-vN` folder (`app/page.tsx` → `app/index-v2/page.tsx`).
 */
export function variantPathCandidates(owner: OwnerFile, n: number): { appRelPath: string; newFolder?: string }[] {
  const dir = posix.dirname(owner.appRelPath);
  const name = posix.basename(owner.appRelPath);
  const inDir = (file: string) => (dir === "." ? file : `${dir}/${file}`);
  const dot = name.lastIndexOf(".");
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const extension = dot > 0 ? name.slice(dot) : "";
  const out: { appRelPath: string; newFolder?: string }[] = [];
  out.push({ appRelPath: inDir(`${withVariant(stem, n)}${extension}`) });
  const tokens = stem.split(".");
  if (tokens.length >= 2 && FLAT_MARKERS.has(tokens[tokens.length - 1])) {
    tokens[tokens.length - 2] = withVariant(tokens[tokens.length - 2], n);
    out.push({ appRelPath: inDir(`${tokens.join(".")}${extension}`) });
  } else if (stem === "index" || stem === "_index") {
    out.push({ appRelPath: inDir(`index-v${n}${extension}`) });
  }
  if (dir !== ".") {
    const parent = posix.dirname(dir);
    const renamed = parent === "." ? withVariant(posix.basename(dir), n) : `${parent}/${withVariant(posix.basename(dir), n)}`;
    out.push({ appRelPath: `${renamed}/${name}`, newFolder: renamed });
  }
  const child = inDir(`index-v${n}`);
  out.push({ appRelPath: `${child}/${name}`, newFolder: child });
  const seen = new Set<string>();
  return out.filter((candidate) => !seen.has(candidate.appRelPath) && seen.add(candidate.appRelPath));
}

const NEXT_SPECIAL = new Set(["layout", "template", "loading", "error", "not-found"]);
const NEXT_SPECIAL_EXTENSIONS = new Set(["tsx", "jsx", "ts", "js", "mdx"]);

/**
 * Whether a Next App Router copy would lose its folder's special files: only
 * a copy into another folder that isn't inside the owner's (a sibling,
 * candidate 3) loses them; a child folder (candidate 4) inherits them.
 * `siblings` are the names of the files in the owner's folder.
 */
export function specialFilesLost(owner: OwnerFile, candidate: { newFolder?: string }, siblings: readonly string[]): boolean {
  if (owner.convention !== "next-app" || !candidate.newFolder) return false;
  if (posix.dirname(candidate.newFolder) === posix.dirname(owner.appRelPath)) return false;
  return siblings.some((sibling) => {
    const name = posix.basename(sibling);
    const dot = name.lastIndexOf(".");
    return dot > 0 && NEXT_SPECIAL.has(name.slice(0, dot)) && NEXT_SPECIAL_EXTENSIONS.has(name.slice(dot + 1));
  });
}

function isRelativeSpecifier(specifier: string): boolean {
  return specifier === "." || specifier === ".." || specifier.startsWith("./") || specifier.startsWith("../");
}

/** An Astro file's `---` frontmatter: "" when it has none, null when it opens and never closes. */
function astroFrontmatter(source: string): string | null {
  const text = source.startsWith("\ufeff") ? source.slice(1) : source;
  const start = text.length - text.trimStart().length;
  if (!text.startsWith("---", start)) return "";
  const open = text.indexOf("\n", start);
  if (open < 0) return null;
  for (let line = open + 1; line < text.length; ) {
    const next = text.indexOf("\n", line);
    const end = next < 0 ? text.length : next;
    if (text.slice(line, end).trimEnd() === "---") return text.slice(open + 1, line);
    if (next < 0) break;
    line = next + 1;
  }
  return null;
}

/**
 * Whether moving a file from `fromDir` to `toDir` would change what any of its
 * relative imports resolve to: `import "…"`, `import … from "…"`,
 * `export … from "…"`, `import("…")` and `require("…")`. Fails closed (true)
 * when the text doesn't scan, or a dynamic `import(…)`/`require(…)` names
 * something other than one string. For `.astro`, only the frontmatter is read.
 */
export function relativeImportsMoved(source: string, fromDir: string, toDir: string, kind: "ts" | "astro"): boolean {
  if (posix.normalize(fromDir) === posix.normalize(toDir)) return false;
  const code = kind === "astro" ? astroFrontmatter(source) : source;
  if (code === null) return true;
  const tokens = scanTsTokens(code);
  if (!tokens) return true;
  const moves = (specifier: string) =>
    isRelativeSpecifier(specifier) && posix.normalize(posix.join(fromDir, specifier)) !== posix.normalize(posix.join(toDir, specifier));
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token.kind !== "id") continue;
    const next = tokens[index + 1];
    if ((token.value === "from" || token.value === "import") && next?.kind === "str") {
      if (moves(next.value)) return true;
    } else if ((token.value === "import" || token.value === "require") && next?.kind === "punct" && next.value === "(") {
      const argument = tokens[index + 2];
      const close = tokens[index + 3];
      if (argument?.kind !== "str" || close?.kind !== "punct" || (close.value !== ")" && close.value !== ",")) return true;
      if (moves(argument.value)) return true;
    }
  }
  return false;
}

const TANSTACK_ROUTES = "src/routes/";
const TANSTACK_EXTENSIONS = new Set(["tsx", "jsx", "ts", "js"]);

/** A flat name split on `.`, keeping `[…]` escapes whole; null for an empty token or an unclosed escape. */
function splitDots(name: string): string[] | null {
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
    } else current += character;
  }
  tokens.push(current);
  return !escaped && tokens.every((token) => token.length > 0) ? tokens : null;
}

/**
 * The path TanStack's generator writes into a route file's
 * `createFileRoute(…)` (S101): the path under `src/routes/` without its
 * extension, split on `.` and `/`, a trailing `lazy` then `route` dropped,
 * and a trailing `index` as its parent plus `/`. Null for a path that isn't a
 * TanStack route file.
 */
export function tanstackRouteId(appRelPath: string): string | null {
  if (!appRelPath.startsWith(TANSTACK_ROUTES)) return null;
  const rest = appRelPath.slice(TANSTACK_ROUTES.length);
  const dot = rest.lastIndexOf(".");
  if (dot <= rest.lastIndexOf("/") + 1 || !TANSTACK_EXTENSIONS.has(rest.slice(dot + 1))) return null;
  const tokens: string[] = [];
  for (const part of rest.slice(0, dot).split("/")) {
    const split = splitDots(part);
    if (!split) return null;
    tokens.push(...split);
  }
  if (tokens.length > 1 && tokens[tokens.length - 1] === "lazy") tokens.pop();
  if (tokens.length > 1 && tokens[tokens.length - 1] === "route") tokens.pop();
  if (tokens[tokens.length - 1] === "index") {
    const parent = tokens.slice(0, -1);
    return parent.length === 0 ? "/" : `/${parent.join("/")}/`;
  }
  return `/${tokens.join("/")}`;
}

const ROUTE_CALLS = new Set(["createFileRoute", "createLazyFileRoute"]);
const REFUSED = { refused: "route-literal" } as const;

function isPunct(token: TsToken | undefined, value: string): boolean {
  return token?.kind === "punct" && token.value === value;
}

/**
 * A TanStack route file's bytes with its one `createFileRoute(from)` (or
 * `createLazyFileRoute`) literal replaced by `to`, in the same quotes, and
 * every other byte unchanged (S101). No call site gives the same bytes.
 * Refuses when the bytes aren't UTF-8 that re-encodes exactly, the text
 * doesn't scan, the call is aliased (`createFileRoute as …`, or a namespace
 * import of a `@tanstack/` package), there's more than one call site, or the
 * call's argument isn't exactly one plain `'from'`/`"from"` string. A member
 * call (`router.createFileRoute(`) isn't a call site.
 */
export function rewriteTanstackLiteral(bytes: Buffer, from: string, to: string): { bytes: Buffer } | { refused: "route-literal" } {
  if (/['"\\\r\n\u2028\u2029]/u.test(to)) return REFUSED;
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    return REFUSED;
  }
  if (!Buffer.from(text, "utf8").equals(bytes)) return REFUSED;
  // A file that never spells either function can't name its path with one, so
  // it is copied as is, even when the tokenizer can't read it (JSX text with
  // an apostrophe ends its scan).
  if (![...ROUTE_CALLS].some((name) => text.includes(name))) return { bytes };
  const tokens = scanTsTokens(text, undefined, { offsets: true });
  if (!tokens) return REFUSED;
  let site = -1;
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token.kind !== "id") continue;
    // `import * as Router from "@tanstack/react-router"`: its calls can't be seen by name.
    if (
      token.value === "import" &&
      isPunct(tokens[index + 1], "*") &&
      tokens[index + 2]?.value === "as" &&
      tokens[index + 4]?.value === "from" &&
      tokens[index + 5]?.kind === "str" &&
      tokens[index + 5].value.startsWith("@tanstack/")
    ) {
      return REFUSED;
    }
    if (!ROUTE_CALLS.has(token.value)) continue;
    const next = tokens[index + 1];
    if (next?.kind === "id" && next.value === "as") return REFUSED;
    if (isPunct(tokens[index - 1], ".")) continue;
    if (!isPunct(next, "(")) continue;
    if (site >= 0) return REFUSED;
    site = index;
  }
  if (site < 0) return { bytes };
  const literal = tokens[site + 2];
  if (literal?.kind !== "str" || !isPunct(tokens[site + 3], ")") || literal.value !== from) return REFUSED;
  if (literal.start === undefined || literal.end === undefined) return REFUSED;
  const raw = text.slice(literal.start, literal.end);
  const quote = raw[0];
  if ((quote !== "'" && quote !== '"') || raw[raw.length - 1] !== quote || raw.includes("\\") || raw.slice(1, -1) !== from) return REFUSED;
  const before = Buffer.byteLength(text.slice(0, literal.start), "utf8");
  const length = Buffer.byteLength(raw, "utf8");
  return { bytes: Buffer.concat([bytes.subarray(0, before), Buffer.from(`${quote}${to}${quote}`, "utf8"), bytes.subarray(before + length)]) };
}
