// The design app's route rule: TanStack's flat-file convention, concrete
// routes only (Aiden's main process maps route files the same way). No imports.
//
// `index.tsx` is `/`, `a.b.tsx` and `a/b.tsx` are `/a/b`, a trailing `.index`
// or `/index` is its parent, `[.]` escapes a dot, a trailing `_` only
// un-nests, and a pathless `_layout` or `(group)` above a page adds nothing.
// Files that would be a pattern, a layout or nothing (`$x`, `{-$x}`, a last
// `_x` or `(group)`, `__root`, `-x`) give null, and so does anything a URL
// can't hold. mock-route-path.test.ts holds this to main's rule.

const EXTENSIONS = ["tsx", "jsx", "ts", "js"];
// eslint-disable-next-line no-control-regex -- control and hidden characters are what this refuses.
const HIDDEN = /[\u0000-\u001f\u007f\p{Cf}\p{Zl}\p{Zp}\p{Variation_Selector}\p{Default_Ignorable_Code_Point}]/u;

function splitTokens(name: string): string[] | null {
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
  if (escaped) return null;
  tokens.push(current);
  return tokens.every((token) => token.length > 0) ? tokens : null;
}

/** The route a file in src/routes maps to (`settings.tsx` → `/settings`), or null when it isn't a concrete page. */
export function routePath(file: string): string | null {
  if (file.includes("\\")) return null;
  const parts = file.split("/");
  if (parts.some((part) => part.length === 0)) return null;
  const last = parts.pop()!;
  const dot = last.lastIndexOf(".");
  if (dot <= 0 || !EXTENSIONS.includes(last.slice(dot + 1))) return null;
  const base = last.slice(0, dot);
  if (base === "__root") return null;
  const tokens: string[] = [];
  for (const part of [...parts, base]) {
    const split = splitTokens(part);
    if (!split) return null;
    tokens.push(...split);
  }
  if (tokens.length > 1 && tokens[tokens.length - 1] === "lazy") tokens.pop();
  if (tokens.length > 1 && tokens[tokens.length - 1] === "route") tokens.pop();
  const segments: string[] = [];
  let lastLayout = false;
  for (let at = 0; at < tokens.length; at++) {
    const token = tokens[at]!;
    lastLayout = false;
    if (token === "index") {
      if (at !== tokens.length - 1) return null;
      continue;
    }
    // `-x` is ignored by the router; `$x` and `{-$x}` are patterns, which no one fills here.
    if (token.startsWith("-") || token.startsWith("$") || (token.startsWith("{-$") && token.endsWith("}"))) return null;
    // A group (`(marketing)`) or a pathless layout (`_auth`) adds no segment; as the file's last token it's a layout, no page.
    if ((token.startsWith("(") && token.endsWith(")")) || token.startsWith("_")) {
      lastLayout = true;
      continue;
    }
    const raw = token.endsWith("_") ? token.slice(0, -1) : token;
    const literal = raw.replace(/\[([^\]]*)\]/gu, "$1");
    if (literal.length === 0 || literal.includes("[") || literal.includes("]")) return null;
    if (/^(?:\.|%2e){1,2}$/iu.test(literal) || /[?#/\\]/u.test(literal) || HIDDEN.test(literal)) return null;
    segments.push(literal);
  }
  if (lastLayout) return null;
  const route = `/${segments.join("/")}`;
  return route.length > 2048 ? null : route;
}
